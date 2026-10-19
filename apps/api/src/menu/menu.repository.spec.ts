import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as menu from './menu.repository.js';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgresql://app:app@localhost:15432/restaurant';

let client: Client;
beforeAll(async () => {
  client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

// Everything is rolled back, so nothing stays in the append-only price history.
async function inTransaction(fn: () => Promise<void>) {
  await client.query('begin');
  try {
    await fn();
  } finally {
    await client.query('rollback');
  }
}

async function seed(label: string) {
  const r = (await client.query(`insert into restaurants (name) values ($1) returning id`, [label])).rows[0].id as string;
  const u = (await client.query(`insert into users (restaurant_id, full_name, role) values ($1, 'Chef', 'owner') returning id`, [r])).rows[0].id as string;
  return { r, u };
}

async function actAs(restaurantId: string) {
  await client.query('set local role app_runtime');
  await client.query(`select set_config('app.restaurant_id', $1, true)`, [restaurantId]);
}

// A failed statement would cancel the whole test transaction; a savepoint undoes only it.
async function failing(work: () => Promise<unknown>): Promise<unknown> {
  await client.query('savepoint try_it');
  try {
    await work();
  } catch (err) {
    await client.query('rollback to savepoint try_it');
    return err;
  }
  await client.query('release savepoint try_it');
  throw new Error('Expected this to fail');
}

async function asAdmin() {
  await client.query('reset role');
}

describe('menu', () => {
  it('creates categories and dishes, with the price split into before-VAT and VAT', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const plats = await menu.createCategory(client, 'Plats', 1);
      const boissons = await menu.createCategory(client, 'Boissons', 2);
      await menu.createItem(client, { categoryId: plats, name: 'Couscous agneau', position: 0, priceTtcMillimes: 11_900, vatRateBp: 1900, changedBy: u });
      await menu.createItem(client, { categoryId: boissons, name: 'Thé à la menthe', position: 0, priceTtcMillimes: 2_500, vatRateBp: 700, changedBy: u });

      const list = await menu.listMenu(client, false);
      expect(list.map((c) => c.name)).toEqual(['Plats', 'Boissons']);
      expect(list[0].items[0].price).toMatchObject({ priceTtcMillimes: 11_900, vatRateBp: 1900, htMillimes: 10_000, vatMillimes: 1_900 });
      // 2,500 / 1.07 = 2,336.45... -> 2,336 before VAT, 164 VAT.
      expect(list[1].items[0].price).toMatchObject({ htMillimes: 2_336, vatMillimes: 164 });
    }));

  it('refuses two dishes or categories with the same name, whatever the capital letters', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const c = await menu.createCategory(client, 'Plats', 0);
      expect(await failing(() => menu.createCategory(client, 'PLATS', 0))).toMatchObject({ kind: 'conflict' });
      await menu.createItem(client, { categoryId: c, name: 'Brik', position: 0, priceTtcMillimes: 3000, vatRateBp: 1900, changedBy: u });
      expect(await failing(() => menu.createItem(client, { categoryId: c, name: 'brik', position: 0, priceTtcMillimes: 3000, vatRateBp: 1900, changedBy: u }))).toMatchObject({ kind: 'conflict' });
    }));

  it('a price change adds to the history instead of replacing the old price', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const c = await menu.createCategory(client, 'Plats', 0);
      const item = await menu.createItem(client, { categoryId: c, name: 'Ojja', position: 0, priceTtcMillimes: 8000, vatRateBp: 1900, changedBy: u });
      expect(await menu.setPrice(client, item, 8000, 1900, u)).toEqual({ changed: false });
      await asAdmin();
      // Make the first price clearly older, as it would be in real life.
      await client.query('alter table menu_item_prices disable trigger menu_item_prices_append_only');
      await client.query(`update menu_item_prices set valid_from = now() - interval '1 day' where item_id = $1`, [item]);
      await client.query('alter table menu_item_prices enable trigger menu_item_prices_append_only');
      await actAs(r);
      expect(await menu.setPrice(client, item, 9500, 1900, u)).toEqual({ changed: true });

      const history = await menu.priceHistory(client, item);
      expect(history.map((h) => h.priceTtcMillimes)).toEqual([9500, 8000]);
      expect(history[0].changedBy).toBe('Chef');
      expect((await menu.listMenu(client, false))[0].items[0].price?.priceTtcMillimes).toBe(9500);
    }));

  it('nobody can edit or delete a past price, not even the admin', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const c = await menu.createCategory(client, 'Plats', 0);
      await menu.createItem(client, { categoryId: c, name: 'Lablabi', position: 0, priceTtcMillimes: 4000, vatRateBp: 1900, changedBy: u });
      expect(String(await failing(() => client.query('update menu_item_prices set price_ttc_millimes = 1')))).toMatch(/permission denied/);
      await asAdmin();
      expect(String(await failing(() => client.query('delete from menu_item_prices')))).toMatch(/append-only/);
    }));

  it('archived dishes leave the menu, keep their history, and can come back', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const c = await menu.createCategory(client, 'Desserts', 0);
      const item = await menu.createItem(client, { categoryId: c, name: 'Makroudh', position: 0, priceTtcMillimes: 1500, vatRateBp: 1900, changedBy: u });
      expect(await failing(() => menu.archiveCategory(client, c))).toMatchObject({ kind: 'conflict' });
      await menu.setArchived(client, item, true);
      expect((await menu.listMenu(client, false))[0].items).toEqual([]);
      expect((await menu.listMenu(client, true))[0].items[0].archived).toBe(true);
      expect(await failing(() => menu.setPrice(client, item, 2000, 1900, u))).toMatchObject({ kind: 'not_found' });
      await menu.setArchived(client, item, false);
      expect((await menu.listMenu(client, false))[0].items).toHaveLength(1);
    }));

  it('a dish cannot be put in another restaurant\'s category, and menus never mix', () =>
    inTransaction(async () => {
      const a = await seed('A');
      const b = await seed('B');
      await actAs(b.r);
      const catB = await menu.createCategory(client, 'Plats B', 0);
      await menu.createItem(client, { categoryId: catB, name: 'Secret B', position: 0, priceTtcMillimes: 1000, vatRateBp: 1900, changedBy: b.u });
      await actAs(a.r);
      expect(await menu.listMenu(client, true)).toEqual([]);
      expect(await failing(() => menu.createItem(client, { categoryId: catB, name: 'Intrus', position: 0, priceTtcMillimes: 1000, vatRateBp: 1900, changedBy: a.u }))).toMatchObject({ kind: 'invalid' });
    }));

  it('refuses fractional millimes and impossible VAT rates', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const c = await menu.createCategory(client, 'Plats', 0);
      expect(String(await failing(() => menu.createItem(client, { categoryId: c, name: 'X', position: 0, priceTtcMillimes: 12.5, vatRateBp: 1900, changedBy: u })))).toMatch(/./);
      expect(String(await failing(() => menu.createItem(client, { categoryId: c, name: 'Y', position: 0, priceTtcMillimes: 1000, vatRateBp: 20_000, changedBy: u })))).toMatch(/./);
    }));
});
