import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertSale, salesForDay, type NewSale } from './sales.repository.js';

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

// A failed statement would cancel the whole test transaction; a savepoint undoes only it.
async function failing(work: () => Promise<unknown>): Promise<string> {
  await client.query('savepoint try_it');
  try {
    await work();
  } catch (err) {
    await client.query('rollback to savepoint try_it');
    return (err as Error).message;
  }
  await client.query('release savepoint try_it');
  throw new Error('Expected this to fail');
}

// A restaurant with one staff member (set up as the admin user).
async function newRestaurant(name: string): Promise<{ r: string; u: string }> {
  const r = (await client.query(`insert into restaurants (name) values ($1) returning id`, [name])).rows[0].id as string;
  const u = (await client.query(`insert into users (restaurant_id, full_name, role) values ($1, 'Staff', 'manager') returning id`, [r])).rows[0].id as string;
  return { r, u };
}

// From here on, behave like the API: limited role, working for one restaurant.
async function actAs(restaurantId: string) {
  await client.query('set local role app_runtime');
  await client.query(`select set_config('app.restaurant_id', $1, true)`, [restaurantId]);
}

const at = (iso: string) => new Date(iso);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());

describe('insertSale and salesForDay', () => {
  it('totals a day: tickets, gross and net', () =>
    inTransaction(async () => {
      const { r, u } = await newRestaurant('A');
      await actAs(r);
      const a = await insertSale(client, { kind: 'sale', amountMillimes: 12500, source: 'manual', recordedBy: u });
      await insertSale(client, { kind: 'sale', amountMillimes: 7500, source: 'manual', recordedBy: u });
      await insertSale(client, { kind: 'refund', amountMillimes: -2000, source: 'manual', recordedBy: u, refersTo: a.id });
      expect(await salesForDay(client, today())).toEqual({ tickets: 2, grossMillimes: 20000, netMillimes: 18000 });
    }));

  it('never counts another restaurant\'s sales', () =>
    inTransaction(async () => {
      const a = await newRestaurant('A');
      const b = await newRestaurant('B');
      await client.query(
        `insert into sales_events (restaurant_id, occurred_at, kind, amount_millimes, source, recorded_by)
         values ($1, now(), 'sale', 99000, 'manual', $2)`,
        [b.r, b.u],
      );
      await actAs(a.r);
      await insertSale(client, { kind: 'sale', amountMillimes: 1000, source: 'manual', recordedBy: a.u });
      expect(await salesForDay(client, today())).toEqual({ tickets: 1, grossMillimes: 1000, netMillimes: 1000 });
    }));

  it('rejects an amount that is not a whole number of millimes', () =>
    inTransaction(async () => {
      const { r, u } = await newRestaurant('A');
      await actAs(r);
      expect(await failing(() => insertSale(client, { kind: 'sale', amountMillimes: 12.5, source: 'manual', recordedBy: u }))).toMatch(
        /integer amount of millimes/,
      );
    }));

  it('rejects the wrong sign for the kind of event', () =>
    inTransaction(async () => {
      const { r, u } = await newRestaurant('A');
      await actAs(r);
      expect(await failing(() => insertSale(client, { kind: 'sale', amountMillimes: -100, source: 'manual', recordedBy: u }))).toMatch(/cannot be negative/);
      expect(await failing(() => insertSale(client, { kind: 'refund', amountMillimes: 100, source: 'manual', recordedBy: u }))).toMatch(/must be negative/);
    }));

  it('ignores the same imported sale when it arrives twice, and keeps its original time', () =>
    inTransaction(async () => {
      const { r, u } = await newRestaurant('A');
      await actAs(r);
      const sale: NewSale = { occurredAt: at('2026-10-19T12:00:00+01:00'), kind: 'sale', amountMillimes: 5000, source: 'import', externalRef: 'Z-001', recordedBy: u };
      expect((await insertSale(client, sale)).duplicate).toBe(false);
      expect(await insertSale(client, sale)).toEqual({ duplicate: true });
      expect((await salesForDay(client, '2026-10-19')).tickets).toBe(1);
    }));

  it('uses Tunisian midnight as the day boundary (imported sales)', () =>
    inTransaction(async () => {
      const { r, u } = await newRestaurant('A');
      await actAs(r);
      await insertSale(client, { occurredAt: at('2026-10-19T23:30:00+01:00'), kind: 'sale', amountMillimes: 1000, source: 'import', recordedBy: u });
      await insertSale(client, { occurredAt: at('2026-10-20T00:30:00+01:00'), kind: 'sale', amountMillimes: 2000, source: 'import', recordedBy: u });
      expect((await salesForDay(client, '2026-10-19')).grossMillimes).toBe(1000);
      expect((await salesForDay(client, '2026-10-20')).grossMillimes).toBe(2000);
    }));

  it('rejects a badly formatted day', () =>
    inTransaction(async () => {
      const { r } = await newRestaurant('A');
      await actAs(r);
      expect(await failing(() => salesForDay(client, '19/10/2026'))).toMatch(/Day must look like/);
    }));
});

describe('trustworthy sales records', () => {
  it('a sale typed at the till always gets the server\'s time, even if another time is sent', () =>
    inTransaction(async () => {
      const { r, u } = await newRestaurant('A');
      await actAs(r);
      const { id } = await insertSale(client, { occurredAt: at('2020-01-01T12:00:00Z'), kind: 'sale', amountMillimes: 1000, source: 'manual', recordedBy: u });
      const row = (await client.query(`select occurred_at > now() - interval '1 minute' as fresh from sales_events where id = $1`, [id])).rows[0];
      expect(row.fresh).toBe(true);
    }));

  it('records who recorded each sale, and refuses a sale without anyone', () =>
    inTransaction(async () => {
      const { r, u } = await newRestaurant('A');
      await actAs(r);
      const { id } = await insertSale(client, { kind: 'sale', amountMillimes: 1000, source: 'manual', recordedBy: u });
      expect((await client.query('select recorded_by from sales_events where id = $1', [id])).rows[0].recorded_by).toBe(u);
      expect(
        await failing(() =>
          client.query(`insert into sales_events (restaurant_id, occurred_at, kind, amount_millimes, source) values ($1, now(), 'sale', 1, 'manual')`, [r]),
        ),
      ).toMatch(/recorded_by_required/);
    }));

  it('cannot record a sale in the name of someone from another restaurant', () =>
    inTransaction(async () => {
      const a = await newRestaurant('A');
      const b = await newRestaurant('B');
      await actAs(a.r);
      expect(await failing(() => insertSale(client, { kind: 'sale', amountMillimes: 1000, source: 'manual', recordedBy: b.u }))).toMatch(/foreign key/);
    }));

  it('a refund, void or discount must point to an original sale', () =>
    inTransaction(async () => {
      const { r, u } = await newRestaurant('A');
      await actAs(r);
      expect(await failing(() => insertSale(client, { kind: 'refund', amountMillimes: -100, source: 'manual', recordedBy: u }))).toMatch(/must refer to a sale/);
      expect(
        await failing(() =>
          client.query(`insert into sales_events (restaurant_id, occurred_at, kind, amount_millimes, source, recorded_by) values ($1, now(), 'refund', -100, 'manual', $2)`, [r, u]),
        ),
      ).toMatch(/must refer to a sale/);
      expect(
        await failing(() => insertSale(client, { kind: 'refund', amountMillimes: -100, source: 'manual', recordedBy: u, refersTo: '00000000-0000-0000-0000-000000000000' })),
      ).toMatch(/not found/);
    }));

  it('everything taken back from a sale can never exceed that sale', () =>
    inTransaction(async () => {
      const { r, u } = await newRestaurant('A');
      await actAs(r);
      const { id } = await insertSale(client, { kind: 'sale', amountMillimes: 10_000, source: 'manual', recordedBy: u });
      await insertSale(client, { kind: 'discount', amountMillimes: -3_000, source: 'manual', recordedBy: u, refersTo: id });
      await insertSale(client, { kind: 'refund', amountMillimes: -7_000, source: 'manual', recordedBy: u, refersTo: id });
      expect(await failing(() => insertSale(client, { kind: 'refund', amountMillimes: -1, source: 'manual', recordedBy: u, refersTo: id }))).toMatch(
        /more than the original sale/,
      );
    }));

  it('a refund cannot point to another refund, nor to another restaurant\'s sale', () =>
    inTransaction(async () => {
      const a = await newRestaurant('A');
      const b = await newRestaurant('B');
      await actAs(b.r);
      const saleB = await insertSale(client, { kind: 'sale', amountMillimes: 5_000, source: 'manual', recordedBy: b.u });
      await actAs(a.r);
      const saleA = await insertSale(client, { kind: 'sale', amountMillimes: 5_000, source: 'manual', recordedBy: a.u });
      const refund = await insertSale(client, { kind: 'refund', amountMillimes: -1_000, source: 'manual', recordedBy: a.u, refersTo: saleA.id });
      expect(await failing(() => insertSale(client, { kind: 'refund', amountMillimes: -1, source: 'manual', recordedBy: a.u, refersTo: refund.id }))).toMatch(
        /must refer to a sale/,
      );
      expect(await failing(() => insertSale(client, { kind: 'refund', amountMillimes: -1, source: 'manual', recordedBy: a.u, refersTo: saleB.id }))).toMatch(
        /not found/,
      );
    }));
});
