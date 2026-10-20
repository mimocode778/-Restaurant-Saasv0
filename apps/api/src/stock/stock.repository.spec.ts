import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as stock from './stock.repository.js';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgresql://app:app@localhost:15432/restaurant';

let client: Client;
beforeAll(async () => {
  client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

// Everything is rolled back, so nothing stays in the append-only stock journal.
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
  const u = (await client.query(`insert into users (restaurant_id, full_name, role) values ($1, 'Gérant', 'manager') returning id`, [r])).rows[0].id as string;
  return { r, u };
}

async function actAs(restaurantId: string) {
  await client.query('set local role app_runtime');
  await client.query(`select set_config('app.restaurant_id', $1, true)`, [restaurantId]);
}

async function asAdmin() {
  await client.query('reset role');
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

function today(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(d);
}

describe('stock products', () => {
  it('lists products by storage place, then by name, starting at zero', () =>
    inTransaction(async () => {
      const { r } = await seed('A');
      await actAs(r);
      await stock.createItem(client, { name: 'Sucre', baseUnit: 'g', storagePlace: 'dry_store' });
      await stock.createItem(client, { name: 'Mozzarella', baseUnit: 'g', storagePlace: 'fridge', alertLevelBase: 5000 });
      await stock.createItem(client, { name: 'Crevettes', baseUnit: 'g', storagePlace: 'freezer' });
      const list = await stock.listItems(client, false);
      expect(list.map((i) => i.name)).toEqual(['Mozzarella', 'Crevettes', 'Sucre']);
      expect(list[0]).toMatchObject({ quantityBase: 0, alertLevelBase: 5000, belowAlert: true, lastCost: null, estimatedValueMillimes: null });
    }));

  it('refuses two products with the same name, whatever the capital letters, but an archived name can be reused', () =>
    inTransaction(async () => {
      const { r } = await seed('A');
      await actAs(r);
      const id = await stock.createItem(client, { name: 'Tomates', baseUnit: 'g', storagePlace: 'fridge' });
      expect(await failing(() => stock.createItem(client, { name: 'TOMATES', baseUnit: 'g', storagePlace: 'fridge' }))).toMatchObject({ kind: 'conflict' });
      await stock.setArchived(client, id, true);
      await stock.createItem(client, { name: 'Tomates', baseUnit: 'g', storagePlace: 'fridge' });
      // The old one cannot come back while a new one has its name.
      expect(await failing(() => stock.setArchived(client, id, false))).toMatchObject({ kind: 'conflict' });
    }));

  it('changes name, place and alert level, but never the unit', () =>
    inTransaction(async () => {
      const { r } = await seed('A');
      await actAs(r);
      const id = await stock.createItem(client, { name: 'Huile', baseUnit: 'ml', storagePlace: 'other', alertLevelBase: 2000 });
      await stock.updateItem(client, id, { name: "Huile d'olive", storagePlace: 'dry_store', alertLevelBase: null });
      expect(await stock.getItem(client, id)).toMatchObject({ name: "Huile d'olive", storagePlace: 'dry_store', alertLevelBase: null, baseUnit: 'ml' });
      const err = await failing(() => client.query(`update stock_items set base_unit = 'g' where id = $1`, [id]));
      expect(String(err)).toMatch(/permission denied/);
    }));
});

describe('stock movements', () => {
  it('records deliveries by quantity or in packs, with their price, and estimates the stock value', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const id = await stock.createItem(client, { name: 'Eau minérale', baseUnit: 'ml', storagePlace: 'bar' });
      const crate = await stock.addPack(client, id, 'Caisse de 12 x 1 L', 12_000);
      // 2 crates for 9,600 TND: the database computes 24,000 ml from the pack size.
      const byPack = await stock.recordMovement(client, id, { kind: 'purchase', packId: crate, packCount: 2, costMillimes: 9_600 }, u);
      expect(byPack).toMatchObject({ quantityBase: 24_000, stockAfterBase: 24_000, belowZero: false });
      await stock.recordMovement(client, id, { kind: 'purchase', quantityBase: 6_000 }, u);
      const item = await stock.getItem(client, id);
      expect(item.quantityBase).toBe(30_000);
      expect(item.packs).toEqual([{ id: crate, name: 'Caisse de 12 x 1 L', quantityBase: 12_000 }]);
      // Last price: 9,600 millimes for 24,000 ml -> 30,000 ml are worth 12,000 millimes.
      expect(item.lastCost).toEqual({ costMillimes: 9_600, quantityBase: 24_000 });
      expect(item.estimatedValueMillimes).toBe(12_000);
    }));

  it('takes usage and waste out, lets stock go below zero, and warns', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const id = await stock.createItem(client, { name: 'Farine', baseUnit: 'g', storagePlace: 'dry_store', alertLevelBase: 3_000 });
      await stock.recordMovement(client, id, { kind: 'purchase', quantityBase: 5_000 }, u);
      const used = await stock.recordMovement(client, id, { kind: 'usage', quantityBase: 2_500 }, u);
      expect(used).toMatchObject({ quantityBase: -2_500, stockAfterBase: 2_500, belowAlert: true, belowZero: false });
      const wasted = await stock.recordMovement(client, id, { kind: 'waste', quantityBase: 3_000, reason: 'spoiled', note: 'Humidité' }, u);
      expect(wasted).toMatchObject({ quantityBase: -3_000, stockAfterBase: -500, belowZero: true });
    }));

  it('a stocktake records the counted quantity and the database computes the difference', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const mozza = await stock.createItem(client, { name: 'Mozzarella', baseUnit: 'g', storagePlace: 'fridge' });
      const sucre = await stock.createItem(client, { name: 'Sucre', baseUnit: 'g', storagePlace: 'dry_store' });
      await stock.recordMovement(client, mozza, { kind: 'purchase', quantityBase: 10_000 }, u);
      await stock.recordMovement(client, sucre, { kind: 'purchase', quantityBase: 4_000 }, u);
      const result = await stock.recordCount(client, [
        { stockItemId: mozza, countedBase: 8_500 },
        { stockItemId: sucre, countedBase: 4_000 },
      ], 'Inventaire du lundi', u);
      expect(result).toEqual([
        { stockItemId: mozza, countedBase: 8_500, differenceBase: -1_500 },
        { stockItemId: sucre, countedBase: 4_000, differenceBase: 0 },
      ]);
      const item = await stock.getItem(client, mozza);
      expect(item.quantityBase).toBe(8_500);
      expect(item.lastCountAt).toBeInstanceOf(Date);
      // Both lines of one stocktake share the same time.
      const times = (await client.query(`select distinct occurred_at from stock_movements where kind = 'count_adjustment'`)).rows;
      expect(times).toHaveLength(1);
      const hist = await stock.history(client, mozza, 10);
      expect(hist[0]).toMatchObject({ kind: 'count_adjustment', countedBase: 8_500, quantityBase: -1_500, note: 'Inventaire du lundi', recordedBy: 'Gérant' });
    }));

  it('refuses a product counted twice in one stocktake', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const id = await stock.createItem(client, { name: 'Lait', baseUnit: 'ml', storagePlace: 'fridge' });
      expect(await failing(() => stock.recordCount(client, [{ stockItemId: id, countedBase: 1 }, { stockItemId: id, countedBase: 2 }], undefined, u))).toMatchObject({ kind: 'invalid' });
    }));

  it('the report shows what was really used between two counts', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      // The example of the guide: count 10 kg, +20 kg delivered, 1 kg thrown away, count 8 kg -> 21 kg used.
      const id = await stock.createItem(client, { name: 'Mozzarella', baseUnit: 'g', storagePlace: 'fridge' });
      await stock.recordMovement(client, id, { kind: 'purchase', quantityBase: 10_000, costMillimes: 180_000 }, u);
      await stock.recordCount(client, [{ stockItemId: id, countedBase: 10_000 }], undefined, u);
      await stock.recordMovement(client, id, { kind: 'purchase', quantityBase: 20_000, costMillimes: 360_000 }, u);
      await stock.recordMovement(client, id, { kind: 'waste', quantityBase: 1_000, reason: 'expired' }, u);
      await stock.recordCount(client, [{ stockItemId: id, countedBase: 8_000 }], undefined, u);

      const [line] = await stock.report(client, today(), today());
      expect(line).toMatchObject({
        name: 'Mozzarella',
        openingBase: 0,
        purchasedBase: 30_000,
        purchaseCostMillimes: 540_000,
        wastedBase: 1_000,
        usedBase: 21_000,
        closingBase: 8_000,
      });
      // Tomorrow, everything is in the opening stock.
      const [next] = await stock.report(client, today(1), today(1));
      expect(next).toMatchObject({ openingBase: 8_000, purchasedBase: 0, usedBase: 0, closingBase: 8_000 });
      expect(await failing(() => stock.report(client, today(1), today()))).toMatchObject({ kind: 'invalid' });
    }));
});

describe('stock rules the database enforces', () => {
  it('a restaurant never sees nor touches another restaurant’s stock', () =>
    inTransaction(async () => {
      const a = await seed('A');
      const b = await seed('B');
      await actAs(a.r);
      const itemA = await stock.createItem(client, { name: 'Safran', baseUnit: 'g', storagePlace: 'dry_store' });
      const packA = await stock.addPack(client, itemA, 'Boîte', 10);
      await actAs(b.r);
      expect(await stock.listItems(client, true)).toEqual([]);
      expect(await failing(() => stock.getItem(client, itemA))).toMatchObject({ kind: 'not_found' });
      expect(await failing(() => stock.recordMovement(client, itemA, { kind: 'purchase', quantityBase: 5 }, b.u))).toMatchObject({ kind: 'not_found' });
      expect(await failing(() => stock.recordCount(client, [{ stockItemId: itemA, countedBase: 0 }], undefined, b.u))).toMatchObject({ kind: 'not_found' });
      expect(await failing(() => stock.history(client, itemA, 10))).toMatchObject({ kind: 'not_found' });
      // B's own product with A's pack size: refused.
      const itemB = await stock.createItem(client, { name: 'Safran', baseUnit: 'g', storagePlace: 'dry_store' });
      expect(await failing(() => stock.recordMovement(client, itemB, { kind: 'purchase', packId: packA, packCount: 1 }, b.u))).toMatchObject({ kind: 'invalid' });
    }));

  it('refuses a pack size of another product', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const milk = await stock.createItem(client, { name: 'Lait', baseUnit: 'ml', storagePlace: 'fridge' });
      const water = await stock.createItem(client, { name: 'Eau', baseUnit: 'ml', storagePlace: 'bar' });
      const pack = await stock.addPack(client, water, 'Pack de 6', 9_000);
      expect(await failing(() => stock.recordMovement(client, milk, { kind: 'purchase', packId: pack, packCount: 1 }, u))).toMatchObject({ kind: 'invalid' });
      await stock.archivePack(client, water, pack);
      expect(await failing(() => stock.recordMovement(client, water, { kind: 'purchase', packId: pack, packCount: 1 }, u))).toMatchObject({ kind: 'invalid' });
    }));

  it('refuses movements on an archived product', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const id = await stock.createItem(client, { name: 'Ancien produit', baseUnit: 'piece', storagePlace: 'other' });
      await stock.setArchived(client, id, true);
      expect(await failing(() => stock.recordMovement(client, id, { kind: 'usage', quantityBase: 1 }, u))).toMatchObject({ kind: 'conflict' });
    }));

  it('sets the time itself: a movement cannot be backdated, even by writing the table directly', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const id = await stock.createItem(client, { name: 'Café', baseUnit: 'g', storagePlace: 'dry_store' });
      const { rows } = await client.query(
        `insert into stock_movements (restaurant_id, stock_item_id, occurred_at, kind, quantity_base, recorded_by)
         values (current_restaurant(), $1, '2020-01-01', 'purchase', 1000, $2) returning occurred_at`,
        [id, u],
      );
      expect(new Date(rows[0].occurred_at).getFullYear()).toBeGreaterThan(2020);
    }));

  it('refuses wrong signs, waste without a reason, and editing or deleting the journal', () =>
    inTransaction(async () => {
      const { r, u } = await seed('A');
      await actAs(r);
      const id = await stock.createItem(client, { name: 'Beurre', baseUnit: 'g', storagePlace: 'fridge' });
      const insert = (kind: string, q: number, reason: string | null = null) =>
        client.query(
          `insert into stock_movements (restaurant_id, stock_item_id, occurred_at, kind, quantity_base, reason, recorded_by)
           values (current_restaurant(), $1, now(), $2, $3, $4, $5)`,
          [id, kind, q, reason, u],
        );
      expect(String(await failing(() => insert('purchase', -100)))).toMatch(/stock_movements_sign/);
      expect(String(await failing(() => insert('usage', 100)))).toMatch(/stock_movements_sign/);
      expect(String(await failing(() => insert('waste', -100)))).toMatch(/stock_movements_reason_rules/);
      expect(String(await failing(() => insert('usage', -100, 'spoiled')))).toMatch(/stock_movements_reason_rules/);
      await insert('purchase', 100);
      expect(String(await failing(() => client.query(`update stock_movements set quantity_base = 1`)))).toMatch(/permission denied|append-only/);
      await asAdmin();
      expect(String(await failing(() => client.query(`delete from stock_movements`)))).toMatch(/append-only/);
    }));
});
