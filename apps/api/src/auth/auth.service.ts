import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../db/db.service.js';
import * as repo from './auth.repository.js';
import type { LoginMethod, SessionUser } from './auth.repository.js';
import { burnTime, hashToken, newToken, verifySecret } from './secrets.js';

// A login lasts one long shift at most, then the person logs in again.
export const SESSION_HOURS = 12;

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: Omit<SessionUser, 'expiresAt'>;
}

type Outcome = { ok: true; result: LoginResult } | { ok: false; locked: boolean };

@Injectable()
export class AuthService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  loginWithPassword(email: string, password: string): Promise<LoginResult> {
    return this.login('password', password, (c) => repo.passwordCandidate(c, email));
  }

  loginWithPin(deviceToken: string, userId: string, pin: string): Promise<LoginResult> {
    return this.login('pin', pin, (c) => repo.pinCandidate(c, hashToken(deviceToken), userId));
  }

  private async login(
    method: LoginMethod,
    secret: string,
    find: (c: PoolClient) => Promise<repo.Candidate | null>,
  ): Promise<LoginResult> {
    // The work returns an outcome instead of throwing, so a failed try is still saved
    // (throwing would cancel the transaction, and with it the failure counter).
    const outcome = await this.db.withoutRestaurant<Outcome>(async (c) => {
      const candidate = await find(c);
      if (!candidate) {
        await burnTime(secret);
        return { ok: false, locked: false };
      }
      if (candidate.lockedUntil && candidate.lockedUntil > new Date()) {
        return { ok: false, locked: true };
      }
      if (!(await verifySecret(secret, candidate.secretHash))) {
        await repo.recordFailure(c, method, candidate.userId);
        return { ok: false, locked: false };
      }
      const token = newToken();
      const tokenHash = hashToken(token);
      await repo.startSession(c, candidate.userId, method, candidate.deviceId, tokenHash, SESSION_HOURS);
      const session = await repo.resolveSession(c, tokenHash);
      if (!session) throw new Error('Session was not created');
      const { expiresAt, ...user } = session;
      return { ok: true, result: { token, expiresAt, user } };
    });

    if (outcome.ok) return outcome.result;
    if (outcome.locked) {
      throw new HttpException('Too many wrong attempts. Try again in 15 minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    throw new UnauthorizedException(method === 'password' ? 'Wrong email or password' : 'Wrong PIN');
  }

  // Returns who is logged in with this token, or null if the token is unknown, expired or revoked.
  resolve(token: string): Promise<SessionUser | null> {
    return this.db.withoutRestaurant((c) => repo.resolveSession(c, hashToken(token)));
  }

  logout(token: string): Promise<void> {
    return this.db.withoutRestaurant((c) => repo.endSession(c, hashToken(token)));
  }

  deviceStaff(deviceToken: string) {
    return this.db.withoutRestaurant((c) => repo.deviceStaff(c, hashToken(deviceToken)));
  }

  // The device token is shown once, here, and never again.
  async pairDevice(actor: SessionUser, name: string): Promise<{ deviceId: string; deviceToken: string }> {
    const deviceToken = newToken();
    const deviceId = await this.db.withRestaurant(actor.restaurantId, (c) =>
      repo.registerDevice(c, name, hashToken(deviceToken), actor.userId),
    );
    return { deviceId, deviceToken };
  }
}
