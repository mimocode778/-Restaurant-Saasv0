import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertSale, salesForDay } from './sales.repository.js';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgresql://app:app@localhost:15432/restaurant';

let client: Client;
beforeAll(async () => {
  client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

// Everything a test writes is rolled back, so no rows are left in the append-only tables.
async function inTransaction(fn: () => Promise<void>) {
  await client.query('begin');
  try {
    await fn();
  } finally {
    await client.query('rollback');
  }
}

async function newRestaurant(name: string): Promise<string> {
  const r = await client.query(`insert into restaurants (name) values ($1) returning id`, [name]);
  return r.rows[0].id as string;
}

// From here on, behave like the API: limited role, working for one restaurant.
async function actAs(restaurantId: string) {
  await client.query('set local role app_runtime');
  await client.query(`select set_config('app.restaurant_id', $1, true)`, [restaurantId]);
}

const at = (iso: string) => new Date(iso);

describe('insertSale and salesForDay', () => {
  it('totals a day: tickets, gross and net', () =>
    inTransaction(async () => {
      const a = await newRestaurant('A');
      await actAs(a);
      await insertSale(client, { occurredAt: at('2026-10-19T12:00:00+01:00'), kind: 'sale', amountMillimes: 12500, source: 'manual' });
      await insertSale(client, { occurredAt: at('2026-10-19T13:00:00+01:00'), kind: 'sale', amountMillimes: 7500, source: 'manual' });
      await insertSale(client, { occurredAt: at('2026-10-19T13:05:00+01:00'), kind: 'refund', amountMillimes: -2000, source: 'manual' });
      expect(await salesForDay(client, '2026-10-19')).toEqual({ tickets: 2, grossMillimes: 20000, netMillimes: 18000 });
    }));

  it('never counts another restaurant\'s sales', () =>
    inTransaction(async () => {
      const a = await newRestaurant('A');
      const b = await newRestaurant('B');
      await client.query(
        `insert into sales_events (restaurant_id, occurred_at, kind, amount_millimes, source)
         values ($1, '2026-10-19T12:00:00+01:00', 'sale', 99000, 'manual')`,
        [b],
      );
      await actAs(a);
      await insertSale(client, { occurredAt: at('2026-10-19T12:00:00+01:00'), kind: 'sale', amountMillimes: 1000, source: 'manual' });
      expect(await salesForDay(client, '2026-10-19')).toEqual({ tickets: 1, grossMillimes: 1000, netMillimes: 1000 });
    }));

  it('rejects an amount that is not a whole number of millimes', () =>
    inTransaction(async () => {
      const a = await newRestaurant('A');
      await actAs(a);
      await expect(
        insertSale(client, { occurredAt: new Date(), kind: 'sale', amountMillimes: 12.5, source: 'manual' }),
      ).rejects.toThrow(/integer amount of millimes/);
    }));

  it('rejects the wrong sign for the kind of event', () =>
    inTransaction(async () => {
      const a = await newRestaurant('A');
      await actAs(a);
      await expect(
        insertSale(client, { occurredAt: new Date(), kind: 'sale', amountMillimes: -100, source: 'manual' }),
      ).rejects.toThrow(/cannot be negative/);
      await expect(
        insertSale(client, { occurredAt: new Date(), kind: 'refund', amountMillimes: 100, source: 'manual' }),
      ).rejects.toThrow(/must be negative/);
    }));

  it('ignores the same imported sale when it arrives twice', () =>
    inTransaction(async () => {
      const a = await newRestaurant('A');
      await actAs(a);
      const sale = { occurredAt: at('2026-10-19T12:00:00+01:00'), kind: 'sale' as const, amountMillimes: 5000, source: 'import' as const, externalRef: 'Z-001' };
      expect(await insertSale(client, sale)).toEqual({ duplicate: false });
      expect(await insertSale(client, sale)).toEqual({ duplicate: true });
      expect((await salesForDay(client, '2026-10-19')).tickets).toBe(1);
    }));

  it('uses Tunisian midnight as the day boundary', () =>
    inTransaction(async () => {
      const a = await newRestaurant('A');
      await actAs(a);
      await insertSale(client, { occurredAt: at('2026-10-19T23:30:00+01:00'), kind: 'sale', amountMillimes: 1000, source: 'manual' });
      await insertSale(client, { occurredAt: at('2026-10-20T00:30:00+01:00'), kind: 'sale', amountMillimes: 2000, source: 'manual' });
      expect((await salesForDay(client, '2026-10-19')).grossMillimes).toBe(1000);
      expect((await salesForDay(client, '2026-10-20')).grossMillimes).toBe(2000);
    }));

  it('rejects a badly formatted day', () =>
    inTransaction(async () => {
      const a = await newRestaurant('A');
      await actAs(a);
      await expect(salesForDay(client, '19/10/2026')).rejects.toThrow(/Day must look like/);
    }));
});
