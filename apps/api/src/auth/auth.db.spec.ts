import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Checks the login rules inside the database itself (003_auth.sql).
const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgresql://app:app@localhost:15432/restaurant';

let client: Client;
beforeAll(async () => {
  client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

// Everything is rolled back, so no test data is left behind.
async function inTransaction(fn: () => Promise<void>) {
  await client.query('begin');
  try {
    await fn();
  } finally {
    await client.query('rollback');
  }
}

const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0];

// A restaurant with an owner (password) and a waiter (PIN) on a paired tablet. Set up as admin.
async function seed(label: string) {
  const r = (await one(`insert into restaurants (name) values ($1) returning id`, [label])).id as string;
  const owner = (await one(`insert into users (restaurant_id, full_name, role) values ($1, 'Owner', 'owner') returning id`, [r])).id as string;
  const waiter = (await one(`insert into users (restaurant_id, full_name, role) values ($1, 'Waiter', 'waiter') returning id`, [r])).id as string;
  await client.query(`insert into credentials (user_id, restaurant_id, email, password_hash) values ($1, $2, $3, 'h')`, [owner, r, `${label}@test.tn`]);
  await client.query(`insert into pins (user_id, restaurant_id, pin_hash) values ($1, $2, 'h')`, [waiter, r]);
  const device = (await one(
    `insert into devices (restaurant_id, name, token_hash, created_by) values ($1, 'Tablet', $2, $3) returning id`,
    [r, `device-${label}`, owner],
  )).id as string;
  return { r, owner, waiter, device, deviceHash: `device-${label}`, email: `${label}@test.tn` };
}

async function actAs(restaurantId: string | null) {
  await client.query('set local role app_runtime');
  await client.query(`select set_config('app.restaurant_id', $1, true)`, [restaurantId ?? '']);
}

describe('secrets are out of reach of the API account', () => {
  it.each(['credentials', 'pins', 'devices', 'sessions'])('cannot read %s directly', (table) =>
    inTransaction(async () => {
      await seed('a');
      await actAs(null);
      await expect(client.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
    }));

  it('users no longer carry an email or any secret', () =>
    inTransaction(async () => {
      const cols = (await client.query(`select column_name from information_schema.columns where table_name = 'users'`)).rows.map((r) => r.column_name);
      expect(cols).not.toContain('email');
      expect(cols.some((c: string) => c.includes('hash'))).toBe(false);
    }));
});

describe('login lookups', () => {
  it('finds an account by email, whatever the capital letters', () =>
    inTransaction(async () => {
      const { owner } = await seed('a');
      await actAs(null);
      expect((await one(`select * from auth_password_candidate('A@TEST.tn')`)).user_id).toBe(owner);
    }));

  it('a disabled person cannot log in, and their open session stops working', () =>
    inTransaction(async () => {
      const { owner } = await seed('a');
      await actAs(null);
      await client.query(`select auth_start_session($1, 'password', null, 'tok', interval '1 hour')`, [owner]);
      expect(await one(`select * from auth_resolve_session('tok')`)).toBeDefined();
      await client.query('reset role');
      await client.query('update users set disabled_at = now() where id = $1', [owner]);
      await actAs(null);
      expect(await one(`select * from auth_password_candidate('a@test.tn')`)).toBeUndefined();
      expect(await one(`select * from auth_resolve_session('tok')`)).toBeUndefined();
    }));

  it('a PIN only works for a waiter, on a tablet of their own restaurant', () =>
    inTransaction(async () => {
      const a = await seed('a');
      const b = await seed('b');
      await actAs(null);
      expect(await one(`select * from auth_pin_candidate($1, $2)`, [a.deviceHash, a.waiter])).toBeDefined();
      expect(await one(`select * from auth_pin_candidate($1, $2)`, [b.deviceHash, a.waiter])).toBeUndefined();
      expect(await one(`select * from auth_pin_candidate('unknown', $1)`, [a.waiter])).toBeUndefined();
      expect(await one(`select * from auth_pin_candidate($1, $2)`, [a.deviceHash, a.owner])).toBeUndefined();
    }));

  it('a PIN session cannot be opened with another restaurant\'s tablet', () =>
    inTransaction(async () => {
      const a = await seed('a');
      const b = await seed('b');
      await actAs(null);
      await expect(
        client.query(`select auth_start_session($1, 'pin', $2, 'tok', interval '1 hour')`, [a.waiter, b.device]),
      ).rejects.toThrow(/tablet not valid/);
    }));

  it('unpairing a tablet ends the PIN sessions opened on it', () =>
    inTransaction(async () => {
      const a = await seed('a');
      await actAs(null);
      await client.query(`select auth_start_session($1, 'pin', $2, 'tok', interval '1 hour')`, [a.waiter, a.device]);
      expect(await one(`select * from auth_resolve_session('tok')`)).toBeDefined();
      await client.query('reset role');
      await client.query('update devices set revoked_at = now() where id = $1', [a.device]);
      await actAs(null);
      expect(await one(`select * from auth_resolve_session('tok')`)).toBeUndefined();
    }));

  it('a session ends at logout and at its expiry time', () =>
    inTransaction(async () => {
      const { owner } = await seed('a');
      await actAs(null);
      await client.query(`select auth_start_session($1, 'password', null, 'tok', interval '1 hour')`, [owner]);
      await client.query(`select auth_end_session('tok')`);
      expect(await one(`select * from auth_resolve_session('tok')`)).toBeUndefined();
      await expect(
        client.query(`select auth_start_session($1, 'password', null, 'tok2', interval '30 days')`, [owner]),
      ).rejects.toThrow(/out of range/);
    }));
});

describe('too many wrong tries', () => {
  it('blocks the account for 15 minutes after 5 wrong tries, then a success clears it', () =>
    inTransaction(async () => {
      const { owner } = await seed('a');
      await actAs(null);
      for (let i = 0; i < 4; i++) await client.query(`select auth_record_failure('password', $1)`, [owner]);
      expect((await one(`select * from auth_password_candidate('a@test.tn')`)).locked_until).toBeNull();
      await client.query(`select auth_record_failure('password', $1)`, [owner]);
      const locked = (await one(`select * from auth_password_candidate('a@test.tn')`)).locked_until as Date;
      expect(locked.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
      await client.query(`select auth_start_session($1, 'password', null, 'tok', interval '1 hour')`, [owner]);
      expect((await one(`select * from auth_password_candidate('a@test.tn')`)).locked_until).toBeNull();
    }));
});

describe('setting passwords and PINs stays inside one restaurant', () => {
  it('cannot set a password for someone in another restaurant', () =>
    inTransaction(async () => {
      const a = await seed('a');
      const b = await seed('b');
      await actAs(a.r);
      await expect(client.query(`select auth_set_password($1, 'x@test.tn', 'h')`, [b.owner])).rejects.toThrow(/not found in this restaurant/);
    }));

  it('cannot set a PIN for a waiter in another restaurant', () =>
    inTransaction(async () => {
      const a = await seed('a');
      const b = await seed('b');
      await actAs(a.r);
      await expect(client.query(`select auth_set_pin($1, 'h')`, [b.waiter])).rejects.toThrow(/not found in this restaurant/);
    }));

  it('a PIN can only be given to a waiter', () =>
    inTransaction(async () => {
      const a = await seed('a');
      await actAs(a.r);
      await expect(client.query(`select auth_set_pin($1, 'h')`, [a.owner])).rejects.toThrow(/waiter not found/);
    }));

  it('a tablet is always paired to the current restaurant', () =>
    inTransaction(async () => {
      const a = await seed('a');
      await actAs(null);
      await expect(client.query(`select auth_register_device('T', 'x', $1)`, [a.owner])).rejects.toThrow(/no restaurant selected/);
    }));
});
