import type { ClientBase } from 'pg';

export type Role = 'owner' | 'manager' | 'waiter';
export type LoginMethod = 'password' | 'pin';

export interface PasswordCandidate {
  userId: string;
  restaurantId: string;
  passwordHash: string;
  totpSecretEnc: string | null;
}

export interface PinCandidate {
  userId: string;
  restaurantId: string;
  deviceId: string;
  pinHash: string;
}

export interface SessionUser {
  userId: string;
  restaurantId: string;
  role: Role;
  fullName: string;
  method: LoginMethod;
  twoStepEnabled: boolean;
  expiresAt: Date;
}

export type AuthEventKind =
  | 'login_succeeded'
  | 'login_failed'
  | 'login_rate_limited'
  | 'logout'
  | 'logout_everywhere'
  | 'password_changed'
  | 'password_reset_by_manager'
  | 'pin_reset_by_manager'
  | 'two_step_enabled'
  | 'two_step_disabled'
  | 'recovery_code_used'
  | 'device_paired'
  | 'device_revoked'
  | 'staff_created'
  | 'staff_disabled';

export interface AuthEvent {
  restaurantId?: string | null;
  userId?: string | null;
  kind: AuthEventKind;
  method?: LoginMethod | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: string | null;
}

// Every function here calls one of the narrow login functions defined in 003/004_auth*.sql.

// Login lookups: no restaurant selected ------------------------------------------
export async function passwordCandidate(db: ClientBase, email: string): Promise<PasswordCandidate | null> {
  const { rows } = await db.query('select * from auth_password_candidate($1)', [email]);
  const r = rows[0];
  return r
    ? { userId: r.user_id, restaurantId: r.restaurant_id, passwordHash: r.password_hash, totpSecretEnc: r.totp_secret_enc }
    : null;
}

export async function pinCandidate(db: ClientBase, deviceTokenHash: string, userId: string): Promise<PinCandidate | null> {
  const { rows } = await db.query('select * from auth_pin_candidate($1, $2)', [deviceTokenHash, userId]);
  const r = rows[0];
  return r ? { userId: r.user_id, restaurantId: r.restaurant_id, deviceId: r.device_id, pinHash: r.pin_hash } : null;
}

export async function useTotpStep(db: ClientBase, userId: string, step: number): Promise<boolean> {
  const { rows } = await db.query('select auth_totp_use_step($1, $2) as ok', [userId, step]);
  return rows[0].ok === true;
}

export async function useRecoveryCode(db: ClientBase, userId: string, codeHash: string): Promise<boolean> {
  const { rows } = await db.query('select auth_recovery_use($1, $2) as ok', [userId, codeHash]);
  return rows[0].ok === true;
}

export async function startSession(
  db: ClientBase,
  s: { userId: string; method: LoginMethod; deviceId: string | null; tokenHash: string; ttlHours: number; idleMinutes: number },
): Promise<Date> {
  const { rows } = await db.query(
    `select auth_start_session($1, $2, $3, $4, make_interval(hours => $5), make_interval(mins => $6)) as expires_at`,
    [s.userId, s.method, s.deviceId, s.tokenHash, s.ttlHours, s.idleMinutes],
  );
  return rows[0].expires_at;
}

export async function resolveSession(db: ClientBase, tokenHash: string): Promise<SessionUser | null> {
  const { rows } = await db.query('select * from auth_resolve_session($1)', [tokenHash]);
  const r = rows[0];
  return r
    ? {
        userId: r.user_id,
        restaurantId: r.restaurant_id,
        role: r.role,
        fullName: r.full_name,
        method: r.method,
        twoStepEnabled: r.two_step_enabled,
        expiresAt: r.expires_at,
      }
    : null;
}

export async function endSession(db: ClientBase, tokenHash: string): Promise<void> {
  await db.query('select auth_end_session($1)', [tokenHash]);
}

export async function deviceStaff(db: ClientBase, deviceTokenHash: string): Promise<{ userId: string; fullName: string }[]> {
  const { rows } = await db.query('select * from auth_device_staff($1)', [deviceTokenHash]);
  return rows.map((r) => ({ userId: r.user_id, fullName: r.full_name }));
}

// Attempt limits -------------------------------------------------------------------
export async function limitReached(db: ClientBase, key: string, max: number, windowMinutes: number): Promise<boolean> {
  const { rows } = await db.query('select auth_limit_reached($1, $2, make_interval(mins => $3)) as r', [key, max, windowMinutes]);
  return rows[0].r === true;
}

export async function limitHit(db: ClientBase, key: string, max: number, windowMinutes: number): Promise<boolean> {
  const { rows } = await db.query('select auth_limit_hit($1, $2, make_interval(mins => $3)) as over', [key, max, windowMinutes]);
  return rows[0].over === true;
}

export async function limitClear(db: ClientBase, key: string): Promise<void> {
  await db.query('select auth_limit_clear($1)', [key]);
}

export async function limitCleanup(db: ClientBase): Promise<void> {
  await db.query('select auth_limit_cleanup()');
}

// Login history ------------------------------------------------------------------
export async function logEvent(db: ClientBase, e: AuthEvent): Promise<void> {
  await db.query('select auth_log($1, $2, $3, $4, $5, $6, $7)', [
    e.restaurantId ?? null,
    e.userId ?? null,
    e.kind,
    e.method ?? null,
    e.ip ?? null,
    e.userAgent ?? null,
    e.detail ?? null,
  ]);
}

// Must run inside db.withRestaurant(...) -------------------------------------------
export async function listEvents(db: ClientBase, limit: number) {
  const { rows } = await db.query(
    `select e.occurred_at, e.kind, e.method, e.ip, e.user_agent, e.detail, e.user_id, u.full_name
     from auth_events e left join users u on u.id = e.user_id
     order by e.occurred_at desc, e.id desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    occurredAt: r.occurred_at,
    kind: r.kind as AuthEventKind,
    method: r.method,
    ip: r.ip,
    userAgent: r.user_agent,
    detail: r.detail,
    userId: r.user_id,
    fullName: r.full_name,
  }));
}

export async function registerDevice(db: ClientBase, name: string, tokenHash: string, createdBy: string): Promise<string> {
  const { rows } = await db.query('select auth_register_device($1, $2, $3) as id', [name, tokenHash, createdBy]);
  return rows[0].id;
}

export async function listDevices(db: ClientBase) {
  const { rows } = await db.query('select * from auth_list_devices()');
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, revokedAt: r.revoked_at }));
}

export async function revokeDevice(db: ClientBase, deviceId: string): Promise<boolean> {
  const { rows } = await db.query('select auth_revoke_device($1) as ok', [deviceId]);
  return rows[0].ok === true;
}

export async function setPassword(db: ClientBase, userId: string, email: string, hash: string): Promise<void> {
  await db.query('select auth_set_password($1, $2, $3)', [userId, email, hash]);
}

export async function replacePassword(db: ClientBase, userId: string, hash: string): Promise<void> {
  await db.query('select auth_replace_password($1, $2)', [userId, hash]);
}

export async function currentPasswordHash(db: ClientBase, userId: string): Promise<string | null> {
  const { rows } = await db.query('select auth_current_password_hash($1) as h', [userId]);
  return rows[0].h ?? null;
}

export async function setPin(db: ClientBase, userId: string, hash: string): Promise<void> {
  await db.query('select auth_set_pin($1, $2)', [userId, hash]);
}

export async function revokeUserSessions(db: ClientBase, userId: string, keepTokenHash: string | null): Promise<number> {
  const { rows } = await db.query('select auth_revoke_user_sessions($1, $2) as n', [userId, keepTokenHash]);
  return rows[0].n;
}

export async function totpBegin(db: ClientBase, userId: string, secretEnc: string): Promise<void> {
  await db.query('select auth_totp_begin($1, $2)', [userId, secretEnc]);
}

export async function totpSecret(db: ClientBase, userId: string): Promise<{ secretEnc: string; confirmed: boolean } | null> {
  const { rows } = await db.query('select * from auth_totp_secret($1)', [userId]);
  const r = rows[0];
  return r ? { secretEnc: r.secret_enc, confirmed: r.confirmed } : null;
}

export async function totpConfirm(db: ClientBase, userId: string, step: number, recoveryHashes: string[]): Promise<void> {
  await db.query('select auth_totp_confirm($1, $2, $3)', [userId, step, recoveryHashes]);
}

export async function totpDisable(db: ClientBase, userId: string): Promise<void> {
  await db.query('select auth_totp_disable($1)', [userId]);
}
