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
  it.each(['credentials', 'pins', 'devices', 'sessions', 'rate_limits', 'totp_factors', 'recovery_codes'])('cannot read %s directly', (table) =>
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
      await client.query(`select auth_start_session($1, 'password', null, 'tok', interval '1 hour', interval '30 minutes')`, [owner]);
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
        client.query(`select auth_start_session($1, 'pin', $2, 'tok', interval '1 hour', interval '30 minutes')`, [a.waiter, b.device]),
      ).rejects.toThrow(/tablet not valid/);
    }));

  it('unpairing a tablet ends the PIN sessions opened on it', () =>
    inTransaction(async () => {
      const a = await seed('a');
      await actAs(null);
      await client.query(`select auth_start_session($1, 'pin', $2, 'tok', interval '1 hour', interval '30 minutes')`, [a.waiter, a.device]);
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
      await client.query(`select auth_start_session($1, 'password', null, 'tok', interval '1 hour', interval '30 minutes')`, [owner]);
      await client.query(`select auth_end_session('tok')`);
      expect(await one(`select * from auth_resolve_session('tok')`)).toBeUndefined();
      await expect(
        client.query(`select auth_start_session($1, 'password', null, 'tok2', interval '30 days', interval '1 hour')`, [owner]),
      ).rejects.toThrow(/out of range/);
    }));
});

describe('sessions end when idle', () => {
  it('a session nobody used for longer than its idle time stops working', () =>
    inTransaction(async () => {
      const { owner } = await seed('a');
      await actAs(null);
      await client.query(`select auth_start_session($1, 'password', null, 'tok', interval '12 hours', interval '30 minutes')`, [owner]);
      expect(await one(`select * from auth_resolve_session('tok')`)).toBeDefined();
      await client.query('reset role');
      await client.query(`update sessions set last_seen_at = now() - interval '31 minutes' where token_hash = 'tok'`);
      await actAs(null);
      expect(await one(`select * from auth_resolve_session('tok')`)).toBeUndefined();
    }));

  it('using a session keeps it alive', () =>
    inTransaction(async () => {
      const { owner } = await seed('a');
      await actAs(null);
      await client.query(`select auth_start_session($1, 'password', null, 'tok', interval '12 hours', interval '30 minutes')`, [owner]);
      await client.query('reset role');
      await client.query(`update sessions set last_seen_at = now() - interval '20 minutes' where token_hash = 'tok'`);
      await actAs(null);
      await client.query(`select * from auth_resolve_session('tok')`);
      await client.query('reset role');
      const seen = (await one(`select last_seen_at > now() - interval '1 minute' as fresh from sessions where token_hash = 'tok'`)).fresh;
      expect(seen).toBe(true);
    }));
});

describe('attempt counters', () => {
  it('counts hits in a time window and says when the maximum is passed', () =>
    inTransaction(async () => {
      await actAs(null);
      const hit = async () => (await one(`select auth_limit_hit('k', 3, interval '15 minutes') as over`)).over;
      const reached = async () => (await one(`select auth_limit_reached('k', 3, interval '15 minutes') as r`)).r;
      expect([await hit(), await hit()]).toEqual([false, false]);
      expect(await reached()).toBe(false);
      expect(await hit()).toBe(false);
      expect(await reached()).toBe(true);
      expect(await hit()).toBe(true);
      await client.query(`select auth_limit_clear('k')`);
      expect(await reached()).toBe(false);
    }));

  it('starts again once the time window is over', () =>
    inTransaction(async () => {
      await actAs(null);
      for (let i = 0; i < 4; i++) await client.query(`select auth_limit_hit('k', 3, interval '15 minutes')`);
      await client.query('reset role');
      await client.query(`update rate_limits set window_start = now() - interval '16 minutes' where key = 'k'`);
      await actAs(null);
      expect((await one(`select auth_limit_reached('k', 3, interval '15 minutes') as r`)).r).toBe(false);
      expect((await one(`select auth_limit_hit('k', 3, interval '15 minutes') as over`)).over).toBe(false);
    }));
});

describe('login history', () => {
  it('a restaurant reads only its own history, and nobody can change it', () =>
    inTransaction(async () => {
      const a = await seed('a');
      const b = await seed('b');
      await actAs(null);
      await client.query(`select auth_log(null, $1, 'login_succeeded', 'password', '1.2.3.4', 'ua', null)`, [a.owner]);
      await client.query(`select auth_log(null, $1, 'login_succeeded', 'password', '5.6.7.8', 'ua', null)`, [b.owner]);
      await client.query(`select auth_log(null, null, 'login_failed', 'password', '9.9.9.9', 'ua', 'unknown email: x@y.tn')`);
      await actAs(a.r);
      const rows = (await client.query('select restaurant_id, ip from auth_events')).rows;
      expect(rows).toEqual([{ restaurant_id: a.r, ip: '1.2.3.4' }]);
      await expect(client.query(`insert into auth_events (restaurant_id, kind) values ($1, 'logout')`, [a.r])).rejects.toThrow(/permission denied/);
    }));

  it('even the admin cannot edit or delete the history', () =>
    inTransaction(async () => {
      const a = await seed('a');
      await client.query(`select auth_log(null, $1, 'logout', null, null, null, null)`, [a.owner]);
      await expect(client.query('delete from auth_events')).rejects.toThrow(/append-only/);
    }));
});

describe('two-step login data', () => {
  it('a phone-app code can only be used once, and only moving forward in time', () =>
    inTransaction(async () => {
      const a = await seed('a');
      await client.query(`insert into totp_factors (user_id, restaurant_id, secret_enc, confirmed_at, last_step) values ($1, $2, 'x', now(), 100)`, [a.owner, a.r]);
      await actAs(null);
      const use = async (step: number) => (await one(`select auth_totp_use_step($1, $2) as ok`, [a.owner, step])).ok;
      expect(await use(101)).toBe(true);
      expect(await use(101)).toBe(false);
      expect(await use(99)).toBe(false);
    }));

  it('a recovery code works once', () =>
    inTransaction(async () => {
      const a = await seed('a');
      await client.query(`insert into recovery_codes (user_id, restaurant_id, code_hash) values ($1, $2, 'h1')`, [a.owner, a.r]);
      await actAs(null);
      const use = async (h: string) => (await one(`select auth_recovery_use($1, $2) as ok`, [a.owner, h])).ok;
      expect(await use('h1')).toBe(true);
      expect(await use('h1')).toBe(false);
      expect(await use('nope')).toBe(false);
    }));

  it('cannot start a two-step setup for someone in another restaurant', () =>
    inTransaction(async () => {
      const a = await seed('a');
      const b = await seed('b');
      await actAs(a.r);
      await expect(client.query(`select auth_totp_begin($1, 'x')`, [b.owner])).rejects.toThrow(/not found in this restaurant/);
    }));
});

describe('ending sessions', () => {
  it('"log out everywhere" keeps only the current session when asked', () =>
    inTransaction(async () => {
      const a = await seed('a');
      await actAs(null);
      for (const t of ['t1', 't2', 't3']) {
        await client.query(`select auth_start_session($1, 'password', null, $2, interval '1 hour', interval '30 minutes')`, [a.owner, t]);
      }
      await actAs(a.r);
      expect((await one(`select auth_revoke_user_sessions($1, 't1') as n`, [a.owner])).n).toBe(2);
      await actAs(null);
      expect(await one(`select * from auth_resolve_session('t1')`)).toBeDefined();
      expect(await one(`select * from auth_resolve_session('t2')`)).toBeUndefined();
    }));

  it('cannot end the sessions of someone in another restaurant', () =>
    inTransaction(async () => {
      const a = await seed('a');
      const b = await seed('b');
      await actAs(a.r);
      await expect(client.query(`select auth_revoke_user_sessions($1, null)`, [b.owner])).rejects.toThrow(/not found in this restaurant/);
    }));

  it('a tablet can only be unpaired by its own restaurant', () =>
    inTransaction(async () => {
      const a = await seed('a');
      const b = await seed('b');
      await actAs(a.r);
      expect((await one(`select auth_revoke_device($1) as ok`, [b.device])).ok).toBe(false);
      expect((await one(`select auth_revoke_device($1) as ok`, [a.device])).ok).toBe(true);
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
