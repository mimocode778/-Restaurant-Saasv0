import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { authSecretKey } from '../config.js';
import { DbService } from '../db/db.service.js';
import * as repo from './auth.repository.js';
import type { LoginMethod, SessionUser } from './auth.repository.js';
import { passwordProblem } from './password-policy.js';
import { burnTime, hashSecret, hashToken, newToken, verifySecret } from './secrets.js';
import {
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUrl,
} from './two-step.js';

// How long a login lasts: at most one long shift, and it ends sooner if nobody uses it.
export const SESSION = {
  password: { ttlHours: 12, idleMinutes: 120 },
  pin: { ttlHours: 12, idleMinutes: 30 },
} as const;

// Attempt limits. "per network" counts every try; the others count wrong tries only.
export const LIMITS = {
  passwordPerNetwork: { max: 30, minutes: 15 },
  passwordPerAccountAndNetwork: { max: 5, minutes: 15 },
  passwordPerAccount: { max: 20, minutes: 60 },
  pinPerNetwork: { max: 60, minutes: 15 },
  pinPerWaiterAndTablet: { max: 5, minutes: 15 },
  pinPerWaiter: { max: 15, minutes: 60 },
  currentPasswordCheck: { max: 5, minutes: 15 },
} as const;

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: Omit<SessionUser, 'expiresAt'>;
}

export interface PasswordLoginInput {
  email: string;
  password: string;
  twoStepCode?: string;
  recoveryCode?: string;
}

type Outcome =
  | { kind: 'ok'; result: LoginResult }
  | { kind: 'limited' }
  | { kind: 'failed'; message: string }
  | { kind: 'two_step_required' };

// Counter names are fingerprints, so the database does not store emails or addresses here.
const key = (...parts: (string | null)[]) => createHash('sha256').update(parts.map((p) => p ?? '-').join('\u0000')).digest('hex');

@Injectable()
export class AuthService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  // Login --------------------------------------------------------------------------
  async loginWithPassword(input: PasswordLoginInput, info: ClientInfo): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    const L = LIMITS;
    const netKey = key('pw-net', info.ip);
    const accNetKey = key('pw-acc-net', email, info.ip);
    const accKey = key('pw-acc', email);

    // The work returns an outcome instead of throwing, so counters and history are saved
    // even when the login fails (throwing would cancel the whole transaction).
    const outcome = await this.db.withoutRestaurant<Outcome>(async (c) => {
      await this.maybeCleanup(c);
      const log = (e: Omit<repo.AuthEvent, 'ip' | 'userAgent' | 'method'>) =>
        repo.logEvent(c, { ...e, method: 'password', ip: info.ip, userAgent: info.userAgent });

      if (
        (await repo.limitHit(c, netKey, L.passwordPerNetwork.max, L.passwordPerNetwork.minutes)) ||
        (await repo.limitReached(c, accNetKey, L.passwordPerAccountAndNetwork.max, L.passwordPerAccountAndNetwork.minutes)) ||
        (await repo.limitReached(c, accKey, L.passwordPerAccount.max, L.passwordPerAccount.minutes))
      ) {
        await log({ kind: 'login_rate_limited', detail: email });
        return { kind: 'limited' };
      }

      const fail = async (userId: string | null, why: string, message = 'Wrong email or password'): Promise<Outcome> => {
        await repo.limitHit(c, accNetKey, L.passwordPerAccountAndNetwork.max, L.passwordPerAccountAndNetwork.minutes);
        await repo.limitHit(c, accKey, L.passwordPerAccount.max, L.passwordPerAccount.minutes);
        await log({ kind: 'login_failed', userId, detail: userId ? why : `${why}: ${email}` });
        return { kind: 'failed', message };
      };

      const candidate = await repo.passwordCandidate(c, email);
      if (!candidate) {
        await burnTime(input.password);
        return fail(null, 'unknown email');
      }
      if (!(await verifySecret(input.password, candidate.passwordHash))) {
        return fail(candidate.userId, 'wrong password');
      }

      if (candidate.totpSecretEnc) {
        if (!input.twoStepCode && !input.recoveryCode) return { kind: 'two_step_required' };
        let ok = false;
        if (input.twoStepCode) {
          const step = matchTotp(decryptSecret(candidate.totpSecretEnc, authSecretKey()), input.twoStepCode);
          ok = step !== null && (await repo.useTotpStep(c, candidate.userId, step));
        } else if (input.recoveryCode) {
          ok = await repo.useRecoveryCode(c, candidate.userId, hashRecoveryCode(input.recoveryCode));
          if (ok) await log({ kind: 'recovery_code_used', userId: candidate.userId });
        }
        if (!ok) return fail(candidate.userId, 'wrong two-step code', 'Wrong code');
      }

      await repo.limitClear(c, accNetKey);
      const result = await this.openSession(c, candidate.userId, 'password', null);
      await log({ kind: 'login_succeeded', userId: candidate.userId });
      return { kind: 'ok', result };
    });
    return this.finish(outcome);
  }

  async loginWithPin(deviceToken: string, userId: string, pin: string, info: ClientInfo): Promise<LoginResult> {
    const L = LIMITS;
    const deviceHash = hashToken(deviceToken);
    const netKey = key('pin-net', info.ip);
    const pairKey = key('pin-pair', userId, deviceHash);
    const waiterKey = key('pin-acc', userId);

    const outcome = await this.db.withoutRestaurant<Outcome>(async (c) => {
      await this.maybeCleanup(c);
      const candidate = await repo.pinCandidate(c, deviceHash, userId);
      const log = (kind: repo.AuthEventKind, detail?: string) =>
        repo.logEvent(c, {
          kind,
          method: 'pin',
          userId: candidate?.userId ?? null,
          restaurantId: candidate?.restaurantId ?? null,
          ip: info.ip,
          userAgent: info.userAgent,
          detail,
        });

      if (
        (await repo.limitHit(c, netKey, L.pinPerNetwork.max, L.pinPerNetwork.minutes)) ||
        (await repo.limitReached(c, pairKey, L.pinPerWaiterAndTablet.max, L.pinPerWaiterAndTablet.minutes)) ||
        (await repo.limitReached(c, waiterKey, L.pinPerWaiter.max, L.pinPerWaiter.minutes))
      ) {
        if (candidate) await log('login_rate_limited');
        return { kind: 'limited' };
      }

      if (!candidate) {
        await burnTime(pin);
        return { kind: 'failed', message: 'Wrong PIN' };
      }
      if (!(await verifySecret(pin, candidate.pinHash))) {
        await repo.limitHit(c, pairKey, L.pinPerWaiterAndTablet.max, L.pinPerWaiterAndTablet.minutes);
        await repo.limitHit(c, waiterKey, L.pinPerWaiter.max, L.pinPerWaiter.minutes);
        await log('login_failed', 'wrong PIN');
        return { kind: 'failed', message: 'Wrong PIN' };
      }

      await repo.limitClear(c, pairKey);
      const result = await this.openSession(c, candidate.userId, 'pin', candidate.deviceId);
      await log('login_succeeded');
      return { kind: 'ok', result };
    });
    return this.finish(outcome);
  }

  private async openSession(c: PoolClient, userId: string, method: LoginMethod, deviceId: string | null): Promise<LoginResult> {
    const token = newToken();
    const tokenHash = hashToken(token);
    await repo.startSession(c, { userId, method, deviceId, tokenHash, ...SESSION[method] });
    const session = await repo.resolveSession(c, tokenHash);
    if (!session) throw new Error('Session was not created');
    const { expiresAt, ...user } = session;
    return { token, expiresAt, user };
  }

  private finish(outcome: Outcome): LoginResult {
    switch (outcome.kind) {
      case 'ok':
        return outcome.result;
      case 'limited':
        throw new HttpException('Too many attempts. Please wait 15 minutes and try again.', HttpStatus.TOO_MANY_REQUESTS);
      case 'two_step_required':
        throw new UnauthorizedException({
          message: 'Enter the 6-digit code from your phone app',
          twoStepRequired: true,
        });
      case 'failed':
        throw new UnauthorizedException(outcome.message);
    }
  }

  // Old attempt counters are removed now and then, without a separate scheduled job.
  private async maybeCleanup(c: PoolClient) {
    if (Math.random() < 0.01) await repo.limitCleanup(c);
  }

  // Sessions -----------------------------------------------------------------------
  resolve(token: string): Promise<SessionUser | null> {
    return this.db.withoutRestaurant((c) => repo.resolveSession(c, hashToken(token)));
  }

  async logout(token: string, info: ClientInfo): Promise<void> {
    await this.db.withoutRestaurant(async (c) => {
      const user = await repo.resolveSession(c, hashToken(token));
      await repo.endSession(c, hashToken(token));
      if (user) await repo.logEvent(c, { kind: 'logout', userId: user.userId, method: user.method, ...info });
    });
  }

  async logoutEverywhere(user: SessionUser, info: ClientInfo): Promise<{ endedSessions: number }> {
    return this.db.withRestaurant(user.restaurantId, async (c) => {
      const endedSessions = await repo.revokeUserSessions(c, user.userId, null);
      await repo.logEvent(c, { kind: 'logout_everywhere', userId: user.userId, ...info });
      return { endedSessions };
    });
  }

  // Password -------------------------------------------------------------------------
  // Checks the person's current password, with its own attempt limit, so a stolen
  // session cannot be used to guess the password.
  private async checkCurrentPassword(c: PoolClient, user: SessionUser, password: string): Promise<boolean> {
    const k = key('pw-current', user.userId);
    const { max, minutes } = LIMITS.currentPasswordCheck;
    if (await repo.limitReached(c, k, max, minutes)) {
      throw new HttpException('Too many attempts. Please wait 15 minutes and try again.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const hash = await repo.currentPasswordHash(c, user.userId);
    if (hash && (await verifySecret(password, hash))) {
      await repo.limitClear(c, k);
      return true;
    }
    await repo.limitHit(c, k, max, minutes);
    return false;
  }

  private requirePasswordSession(user: SessionUser) {
    if (user.method !== 'password') throw new ForbiddenException('Log in with your email and password to do this');
  }

  // Changing the password ends every other session of that person.
  async changePassword(user: SessionUser, token: string, current: string, next: string, info: ClientInfo): Promise<void> {
    this.requirePasswordSession(user);
    const problem = passwordProblem(next);
    if (problem) throw new BadRequestException(problem);
    const newHash = await hashSecret(next);
    const ok = await this.db.withRestaurant(user.restaurantId, async (c) => {
      if (!(await this.checkCurrentPassword(c, user, current))) return false;
      await repo.replacePassword(c, user.userId, newHash);
      await repo.revokeUserSessions(c, user.userId, hashToken(token));
      await repo.logEvent(c, { kind: 'password_changed', userId: user.userId, method: 'password', ...info });
      return true;
    });
    if (!ok) throw new UnauthorizedException('Your current password is wrong');
  }

  // Two-step login (owners and managers) -------------------------------------------------
  async twoStepSetup(user: SessionUser, currentPassword: string): Promise<{ secret: string; otpauthUrl: string }> {
    this.requirePasswordSession(user);
    if (user.role === 'waiter') throw new ForbiddenException('Two-step login is for owners and managers');
    const secret = newTotpSecret();
    const ok = await this.db.withRestaurant(user.restaurantId, async (c) => {
      if ((await repo.totpSecret(c, user.userId))?.confirmed) {
        throw new BadRequestException('Two-step login is already on');
      }
      if (!(await this.checkCurrentPassword(c, user, currentPassword))) return false;
      await repo.totpBegin(c, user.userId, encryptSecret(secret, authSecretKey()));
      return true;
    });
    if (!ok) throw new UnauthorizedException('Your current password is wrong');
    return { secret, otpauthUrl: otpauthUrl(secret, user.fullName) };
  }

  async twoStepConfirm(user: SessionUser, code: string, info: ClientInfo): Promise<{ recoveryCodes: string[] }> {
    this.requirePasswordSession(user);
    const recoveryCodes = newRecoveryCodes();
    const ok = await this.db.withRestaurant(user.restaurantId, async (c) => {
      const t = await repo.totpSecret(c, user.userId);
      if (!t || t.confirmed) throw new BadRequestException('Start the two-step setup first');
      const step = matchTotp(decryptSecret(t.secretEnc, authSecretKey()), code);
      if (step === null) return false;
      await repo.totpConfirm(c, user.userId, step, recoveryCodes.map(hashRecoveryCode));
      await repo.logEvent(c, { kind: 'two_step_enabled', userId: user.userId, ...info });
      return true;
    });
    if (!ok) throw new UnauthorizedException('Wrong code. Check the time on your phone is correct.');
    // Shown once: the person must write them down or print them.
    return { recoveryCodes };
  }

  async twoStepDisable(user: SessionUser, currentPassword: string, code: string, info: ClientInfo): Promise<void> {
    this.requirePasswordSession(user);
    const ok = await this.db.withRestaurant(user.restaurantId, async (c) => {
      if (!(await this.checkCurrentPassword(c, user, currentPassword))) return false;
      const t = await repo.totpSecret(c, user.userId);
      if (!t?.confirmed) throw new BadRequestException('Two-step login is not on');
      const step = matchTotp(decryptSecret(t.secretEnc, authSecretKey()), code);
      if (step === null) return false;
      await repo.totpDisable(c, user.userId);
      await repo.logEvent(c, { kind: 'two_step_disabled', userId: user.userId, ...info });
      return true;
    });
    if (!ok) throw new UnauthorizedException('Wrong password or code');
  }

  // Tablets ------------------------------------------------------------------------
  deviceStaff(deviceToken: string) {
    return this.db.withoutRestaurant((c) => repo.deviceStaff(c, hashToken(deviceToken)));
  }

  // The device token is shown once, here, and never again.
  async pairDevice(actor: SessionUser, name: string, info: ClientInfo): Promise<{ deviceId: string; deviceToken: string }> {
    const deviceToken = newToken();
    const deviceId = await this.db.withRestaurant(actor.restaurantId, async (c) => {
      const id = await repo.registerDevice(c, name, hashToken(deviceToken), actor.userId);
      await repo.logEvent(c, { kind: 'device_paired', userId: actor.userId, detail: name, ...info });
      return id;
    });
    return { deviceId, deviceToken };
  }

  listDevices(actor: SessionUser) {
    return this.db.withRestaurant(actor.restaurantId, (c) => repo.listDevices(c));
  }

  // Unpairing a tablet ends every waiter session opened on it.
  async revokeDevice(actor: SessionUser, deviceId: string, info: ClientInfo): Promise<boolean> {
    return this.db.withRestaurant(actor.restaurantId, async (c) => {
      const ok = await repo.revokeDevice(c, deviceId);
      if (ok) await repo.logEvent(c, { kind: 'device_revoked', userId: actor.userId, detail: deviceId, ...info });
      return ok;
    });
  }

  // Login history ------------------------------------------------------------------
  events(actor: SessionUser, limit: number) {
    return this.db.withRestaurant(actor.restaurantId, (c) => repo.listEvents(c, limit));
  }
}
