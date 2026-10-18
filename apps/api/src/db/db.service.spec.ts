import { afterAll, describe, expect, it } from 'vitest';
import { DbService } from './db.service';

const db = new DbService();
afterAll(() => db.onModuleDestroy());

const ID = '11111111-1111-1111-1111-111111111111';

describe('DbService.withRestaurant', () => {
  it('connects as the limited runtime role, not an admin', async () => {
    const user = await db.withRestaurant(ID, async (c) => (await c.query('select current_user as u')).rows[0].u);
    expect(user).toBe('app_runtime');
  });

  it('sets the restaurant for the duration of the work', async () => {
    const seen = await db.withRestaurant(
      ID,
      async (c) => (await c.query(`select current_setting('app.restaurant_id', true) as id`)).rows[0].id,
    );
    expect(seen).toBe(ID);
  });

  it('rejects an invalid restaurant id before touching the database', async () => {
    await expect(db.withRestaurant('not-a-uuid', async () => 1)).rejects.toThrow(/Invalid restaurant id/);
  });

  it('passes errors through after rolling back', async () => {
    await expect(
      db.withRestaurant(ID, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('DbService safety checks', () => {
  it('refuses to run as a superuser, because that would bypass tenant isolation', async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://app:app@localhost:15432/restaurant';
    const unsafe = new DbService();
    try {
      await expect(unsafe.withRestaurant(ID, async () => 1)).rejects.toThrow(/Unsafe database role/);
    } finally {
      await unsafe.onModuleDestroy();
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });

  it('refuses to start in production without DATABASE_URL', () => {
    const savedUrl = process.env.DATABASE_URL;
    const savedEnv = process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new DbService()).toThrow(/DATABASE_URL must be set/);
    } finally {
      process.env.NODE_ENV = savedEnv;
      if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    }
  });
});
