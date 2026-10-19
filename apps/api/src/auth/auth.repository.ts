import type { ClientBase } from 'pg';

export type Role = 'owner' | 'manager' | 'waiter';
export type LoginMethod = 'password' | 'pin';

export interface Candidate {
  userId: string;
  secretHash: string;
  lockedUntil: Date | null;
  deviceId: string | null;
}

export interface SessionUser {
  userId: string;
  restaurantId: string;
  role: Role;
  fullName: string;
  expiresAt: Date;
}

// Every function here calls one of the narrow login functions defined in 003_auth.sql.

export async function passwordCandidate(db: ClientBase, email: string): Promise<Candidate | null> {
  const { rows } = await db.query('select * from auth_password_candidate($1)', [email]);
  const r = rows[0];
  return r ? { userId: r.user_id, secretHash: r.password_hash, lockedUntil: r.locked_until, deviceId: null } : null;
}

export async function pinCandidate(db: ClientBase, deviceTokenHash: string, userId: string): Promise<Candidate | null> {
  const { rows } = await db.query('select * from auth_pin_candidate($1, $2)', [deviceTokenHash, userId]);
  const r = rows[0];
  return r ? { userId: r.user_id, secretHash: r.pin_hash, lockedUntil: r.locked_until, deviceId: r.device_id } : null;
}

export async function recordFailure(db: ClientBase, method: LoginMethod, userId: string): Promise<void> {
  await db.query('select auth_record_failure($1, $2)', [method, userId]);
}

export async function startSession(
  db: ClientBase,
  userId: string,
  method: LoginMethod,
  deviceId: string | null,
  tokenHash: string,
  ttlHours: number,
): Promise<Date> {
  const { rows } = await db.query(
    `select auth_start_session($1, $2, $3, $4, make_interval(hours => $5)) as expires_at`,
    [userId, method, deviceId, tokenHash, ttlHours],
  );
  return rows[0].expires_at;
}

export async function resolveSession(db: ClientBase, tokenHash: string): Promise<SessionUser | null> {
  const { rows } = await db.query('select * from auth_resolve_session($1)', [tokenHash]);
  const r = rows[0];
  return r
    ? { userId: r.user_id, restaurantId: r.restaurant_id, role: r.role, fullName: r.full_name, expiresAt: r.expires_at }
    : null;
}

export async function endSession(db: ClientBase, tokenHash: string): Promise<void> {
  await db.query('select auth_end_session($1)', [tokenHash]);
}

export async function deviceStaff(db: ClientBase, deviceTokenHash: string): Promise<{ userId: string; fullName: string }[]> {
  const { rows } = await db.query('select * from auth_device_staff($1)', [deviceTokenHash]);
  return rows.map((r) => ({ userId: r.user_id, fullName: r.full_name }));
}

// The functions below must run inside db.withRestaurant(...).

export async function registerDevice(db: ClientBase, name: string, tokenHash: string, createdBy: string): Promise<string> {
  const { rows } = await db.query('select auth_register_device($1, $2, $3) as id', [name, tokenHash, createdBy]);
  return rows[0].id;
}

export async function setPassword(db: ClientBase, userId: string, email: string, hash: string): Promise<void> {
  await db.query('select auth_set_password($1, $2, $3)', [userId, email, hash]);
}

export async function setPin(db: ClientBase, userId: string, hash: string): Promise<void> {
  await db.query('select auth_set_pin($1, $2)', [userId, hash]);
}
