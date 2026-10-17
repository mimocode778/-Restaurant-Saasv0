import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.DATABASE_URL ?? 'postgresql://app:app@localhost:5433/restaurant';

let client: Client;
beforeAll(async () => {
  client = new Client({ connectionString: URL });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

// Every test runs inside a transaction that is rolled back, so no test data is left behind.
async function inTransaction(fn: () => Promise<void>) {
  await client.query('begin');
  try {
    await fn();
  } finally {
    await client.query('rollback');
  }
}

// Two restaurants, one sale each (set up as the admin user).
async function seed() {
  const a = (await client.query(`insert into restaurants (name) values ('Resto A') returning id`)).rows[0].id as string;
  const b = (await client.query(`insert into restaurants (name) values ('Resto B') returning id`)).rows[0].id as string;
  await client.query(
    `insert into sales_events (restaurant_id, occurred_at, kind, amount_millimes, source)
     values ($1, now(), 'sale', 12500, 'manual'), ($2, now(), 'sale', 99000, 'manual')`,
    [a, b],
  );
  return { a, b };
}

// From now on act like the API does: limited role, working for one restaurant.
async function actAs(restaurantId: string | null) {
  await client.query('set local role app_runtime');
  await client.query(`select set_config('app.restaurant_id', $1, true)`, [restaurantId ?? '']);
}

describe('tenant isolation', () => {
  it('a restaurant only sees its own sales', () =>
    inTransaction(async () => {
      const { a } = await seed();
      await actAs(a);
      const rows = (await client.query('select restaurant_id, amount_millimes from sales_events')).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].restaurant_id).toBe(a);
      expect(Number(rows[0].amount_millimes)).toBe(12500);
    }));

  it('sees nothing when no restaurant is selected', () =>
    inTransaction(async () => {
      await seed();
      await actAs(null);
      const rows = (await client.query('select * from sales_events')).rows;
      expect(rows).toHaveLength(0);
    }));

  it('cannot write a sale for another restaurant', () =>
    inTransaction(async () => {
      const { a, b } = await seed();
      await actAs(a);
      await expect(
        client.query(
          `insert into sales_events (restaurant_id, occurred_at, kind, amount_millimes, source)
           values ($1, now(), 'sale', 1000, 'manual')`,
          [b],
        ),
      ).rejects.toThrow(/row-level security/);
    }));
});

describe('append-only tables', () => {
  it('the app role cannot update a sale', () =>
    inTransaction(async () => {
      const { a } = await seed();
      await actAs(a);
      await expect(client.query('update sales_events set amount_millimes = 1')).rejects.toThrow(/permission denied/);
    }));

  it('the app role cannot delete a sale', () =>
    inTransaction(async () => {
      const { a } = await seed();
      await actAs(a);
      await expect(client.query('delete from sales_events')).rejects.toThrow(/permission denied/);
    }));

  it('even the admin cannot edit a sale', () =>
    inTransaction(async () => {
      await seed();
      await expect(client.query('update sales_events set amount_millimes = 1')).rejects.toThrow(/append-only/);
    }));

  it('even the admin cannot delete stock movements', () =>
    inTransaction(async () => {
      const { a } = await seed();
      const item = (
        await client.query(`insert into stock_items (restaurant_id, name, base_unit) values ($1, 'Flour', 'g') returning id`, [a])
      ).rows[0].id as string;
      await client.query(
        `insert into stock_movements (restaurant_id, stock_item_id, occurred_at, kind, quantity_base)
         values ($1, $2, now(), 'purchase', 25000)`,
        [a, item],
      );
      await expect(client.query('delete from stock_movements')).rejects.toThrow(/append-only/);
    }));
});
