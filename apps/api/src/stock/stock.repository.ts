import type { ClientBase } from 'pg';
import { assertMillimes, assertQuantity, type BaseUnit } from '@app/shared';

// Every function here must run inside db.withRestaurant(...): row-level security limits
// all rows to the current restaurant, and new rows get it from current_restaurant().
// Quantities are whole numbers in the product's base unit (grams, millilitres, pieces).

export type StoragePlace = 'fridge' | 'freezer' | 'dry_store' | 'bar' | 'other';
export type WasteReason = 'spoiled' | 'expired' | 'burnt' | 'dropped' | 'other';
export type MovementKind = 'purchase' | 'usage' | 'waste' | 'count_adjustment';

export interface Pack {
  id: string;
  name: string;
  quantityBase: number;
}

export interface StockItem {
  id: string;
  name: string;
  baseUnit: BaseUnit;
  storagePlace: StoragePlace;
  alertLevelBase: number | null;
  archived: boolean;
  // Sum of the whole journal. Can be negative when a delivery was not entered yet.
  quantityBase: number;
  belowAlert: boolean;
  lastCountAt: Date | null;
  // Price of the latest delivery entered with a price, to estimate the stock value.
  lastCost: { costMillimes: number; quantityBase: number } | null;
  // quantityBase x last price per unit, rounded to the millime. Null without a price.
  estimatedValueMillimes: number | null;
  packs: Pack[];
}

export class StockError extends Error {
  constructor(
    readonly kind: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

// Turns database errors into clear messages.
async function friendly<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof StockError) throw err;
    const { code, message } = err as { code?: string; message?: string };
    if (code === '23505') throw new StockError('conflict', 'This name is already used');
    if (message === 'Unknown stock item') throw new StockError('not_found', 'No such product in stock');
    if (message === 'Unknown pack size') throw new StockError('invalid', 'Unknown pack size for this product');
    if (message === 'This product is archived') throw new StockError('conflict', 'This product is archived');
    if (code === '23503') throw new StockError('invalid', 'Unknown product or pack size');
    throw err;
  }
}

// Stock value = quantity x (last price / last delivered quantity), rounded to the millime.
function estimatedValue(quantityBase: number, lastCost: StockItem['lastCost']): number | null {
  if (!lastCost || lastCost.quantityBase <= 0) return null;
  const value = (quantityBase * lastCost.costMillimes) / lastCost.quantityBase;
  return Math.sign(value) * Math.round(Math.abs(value));
}

const ITEMS_SQL = `
  select i.id, i.name, i.base_unit, i.storage_place, i.alert_level_base, i.archived_at is not null as archived,
         coalesce(m.total, 0) as quantity_base, m.last_count_at,
         lc.cost_millimes as last_cost, lc.quantity_base as last_cost_quantity
  from stock_items i
  left join (
    select stock_item_id, sum(quantity_base) as total,
           max(occurred_at) filter (where kind = 'count_adjustment') as last_count_at
    from stock_movements group by stock_item_id
  ) m on m.stock_item_id = i.id
  left join lateral (
    select cost_millimes, quantity_base from stock_movements
    where stock_item_id = i.id and kind = 'purchase' and cost_millimes is not null
    order by occurred_at desc, seq desc limit 1
  ) lc on true`;

function toItem(r: Record<string, unknown>, packs: Pack[]): StockItem {
  const quantityBase = Number(r.quantity_base);
  const alert = r.alert_level_base === null ? null : Number(r.alert_level_base);
  const lastCost =
    r.last_cost === null || r.last_cost === undefined
      ? null
      : { costMillimes: Number(r.last_cost), quantityBase: Number(r.last_cost_quantity) };
  return {
    id: r.id as string,
    name: r.name as string,
    baseUnit: r.base_unit as BaseUnit,
    storagePlace: r.storage_place as StoragePlace,
    alertLevelBase: alert,
    archived: r.archived as boolean,
    quantityBase,
    belowAlert: alert !== null && quantityBase < alert,
    lastCountAt: (r.last_count_at as Date | null) ?? null,
    lastCost,
    estimatedValueMillimes: estimatedValue(quantityBase, lastCost),
    packs,
  };
}

async function packsByItem(db: ClientBase): Promise<Map<string, Pack[]>> {
  const { rows } = await db.query(
    `select id, stock_item_id, name, quantity_base from stock_item_packs
     where archived_at is null order by quantity_base, lower(name)`,
  );
  const map = new Map<string, Pack[]>();
  for (const r of rows) {
    const pack = { id: r.id as string, name: r.name as string, quantityBase: Number(r.quantity_base) };
    map.set(r.stock_item_id, [...(map.get(r.stock_item_id) ?? []), pack]);
  }
  return map;
}

// Products in the order they sit in the restaurant: by storage place, then by name.
export async function listItems(db: ClientBase, includeArchived: boolean): Promise<StockItem[]> {
  const { rows } = await db.query(
    `${ITEMS_SQL}
     where $1 or i.archived_at is null
     order by array_position(array['fridge','freezer','dry_store','bar','other'], i.storage_place), lower(i.name)`,
    [includeArchived],
  );
  const packs = await packsByItem(db);
  return rows.map((r) => toItem(r, packs.get(r.id) ?? []));
}

export async function getItem(db: ClientBase, id: string): Promise<StockItem> {
  const { rows } = await db.query(`${ITEMS_SQL} where i.id = $1`, [id]);
  if (rows.length === 0) throw new StockError('not_found', 'No such product in stock');
  const packs = await packsByItem(db);
  return toItem(rows[0], packs.get(id) ?? []);
}

export interface NewItem {
  name: string;
  baseUnit: BaseUnit;
  storagePlace: StoragePlace;
  alertLevelBase?: number | null;
}

export function createItem(db: ClientBase, item: NewItem): Promise<string> {
  if (item.alertLevelBase != null) assertQuantity(item.alertLevelBase);
  return friendly(async () => {
    const { rows } = await db.query(
      `insert into stock_items (restaurant_id, name, base_unit, storage_place, alert_level_base)
       values (current_restaurant(), $1, $2, $3, $4) returning id`,
      [item.name, item.baseUnit, item.storagePlace, item.alertLevelBase ?? null],
    );
    return rows[0].id as string;
  });
}

// The unit is never changed here, on purpose: the product's whole history is counted in it.
export function updateItem(
  db: ClientBase,
  id: string,
  changes: { name?: string; storagePlace?: StoragePlace; alertLevelBase?: number | null },
): Promise<void> {
  if (changes.alertLevelBase != null) assertQuantity(changes.alertLevelBase);
  return friendly(async () => {
    const { rowCount } = await db.query(
      `update stock_items set
         name = coalesce($2, name),
         storage_place = coalesce($3, storage_place),
         alert_level_base = case when $4::boolean then $5::bigint else alert_level_base end,
         updated_at = now()
       where id = $1 and archived_at is null`,
      [id, changes.name ?? null, changes.storagePlace ?? null, changes.alertLevelBase !== undefined, changes.alertLevelBase ?? null],
    );
    if (rowCount === 0) throw new StockError('not_found', 'No such product in stock');
  });
}

// Products are never deleted (their history stays): they are archived, and can come back.
export function setArchived(db: ClientBase, id: string, archived: boolean): Promise<void> {
  return friendly(async () => {
    const { rowCount } = await db.query(
      `update stock_items set archived_at = ${archived ? 'now()' : 'null'}, updated_at = now()
       where id = $1 and archived_at is ${archived ? 'null' : 'not null'}`,
      [id],
    );
    if (rowCount === 0) throw new StockError('not_found', archived ? 'No such product in stock' : 'No such archived product');
  });
}

export function addPack(db: ClientBase, itemId: string, name: string, quantityBase: number): Promise<string> {
  assertQuantity(quantityBase);
  return friendly(async () => {
    const item = await db.query(`select base_unit from stock_items where id = $1 and archived_at is null`, [itemId]);
    if (item.rowCount === 0) throw new StockError('not_found', 'No such product in stock');
    const { rows } = await db.query(
      `insert into stock_item_packs (restaurant_id, stock_item_id, name, quantity_base)
       values (current_restaurant(), $1, $2, $3) returning id`,
      [itemId, name, quantityBase],
    );
    return rows[0].id as string;
  });
}

export async function archivePack(db: ClientBase, itemId: string, packId: string): Promise<void> {
  const { rowCount } = await db.query(
    `update stock_item_packs set archived_at = now() where id = $1 and stock_item_id = $2 and archived_at is null`,
    [packId, itemId],
  );
  if (rowCount === 0) throw new StockError('not_found', 'No such pack size');
}

export type NewMovement =
  | {
      kind: 'purchase';
      // Either a quantity in the base unit, or a number of packs.
      quantityBase?: number;
      packId?: string;
      packCount?: number;
      costMillimes?: number;
      note?: string;
    }
  | { kind: 'usage'; quantityBase: number; note?: string }
  | { kind: 'waste'; quantityBase: number; reason: WasteReason; note?: string };

export interface MovementResult {
  id: string;
  // Signed quantity of this movement, as recorded.
  quantityBase: number;
  // The product's quantity after this movement.
  stockAfterBase: number;
  belowZero: boolean;
  belowAlert: boolean;
}

async function levelOf(db: ClientBase, itemId: string): Promise<{ total: number; alert: number | null }> {
  const { rows } = await db.query(
    `select coalesce((select sum(quantity_base) from stock_movements where stock_item_id = $1), 0) as total,
            (select alert_level_base from stock_items where id = $1) as alert`,
    [itemId],
  );
  return { total: Number(rows[0].total), alert: rows[0].alert === null ? null : Number(rows[0].alert) };
}

// Records a delivery, a usage or a waste. The person typing gives positive quantities;
// the sign is set here from the kind. Time and author are set by the server.
export function recordMovement(db: ClientBase, itemId: string, movement: NewMovement, recordedBy: string): Promise<MovementResult> {
  let quantity: number;
  let packId: string | null = null;
  let packCount: number | null = null;
  let cost: number | null = null;
  let reason: WasteReason | null = null;

  if (movement.kind === 'purchase') {
    const byPack = movement.packId !== undefined;
    if (byPack === (movement.quantityBase !== undefined)) {
      throw new StockError('invalid', 'Give either a quantity or a number of packs');
    }
    if (byPack && !movement.packCount) throw new StockError('invalid', 'Give the number of packs');
    if (!byPack && movement.packCount !== undefined) throw new StockError('invalid', 'A number of packs needs a pack size');
    // With packs, the database computes the real quantity from the pack size; 1 is a placeholder.
    quantity = byPack ? 1 : assertQuantity(movement.quantityBase!);
    packId = movement.packId ?? null;
    packCount = movement.packCount ?? null;
    if (movement.costMillimes !== undefined) cost = assertMillimes(movement.costMillimes);
  } else {
    quantity = -assertQuantity(movement.quantityBase);
    if (movement.kind === 'waste') reason = movement.reason;
  }
  if (packId === null && quantity === 0) throw new StockError('invalid', 'The quantity must be more than zero');

  return friendly(async () => {
    const { rows } = await db.query(
      `insert into stock_movements
         (restaurant_id, stock_item_id, occurred_at, kind, quantity_base, pack_id, pack_count, cost_millimes, reason, note, recorded_by)
       values (current_restaurant(), $1, now(), $2, $3, $4, $5, $6, $7, $8, $9)
       returning id, quantity_base`,
      [itemId, movement.kind, quantity, packId, packCount, cost, reason, movement.note ?? null, recordedBy],
    );
    const level = await levelOf(db, itemId);
    return {
      id: rows[0].id as string,
      quantityBase: Number(rows[0].quantity_base),
      stockAfterBase: level.total,
      belowZero: level.total < 0,
      belowAlert: level.alert !== null && level.total < level.alert,
    };
  });
}

export interface CountLine {
  stockItemId: string;
  countedBase: number;
}

export interface CountResult {
  stockItemId: string;
  countedBase: number;
  // Counted minus what the journal said: negative = missing, positive = more than expected.
  differenceBase: number;
}

// A stocktake: the real quantities counted on the shelves. All lines are written in one
// transaction, so they share the same time; the database computes each difference.
export function recordCount(db: ClientBase, lines: CountLine[], note: string | undefined, recordedBy: string): Promise<CountResult[]> {
  const seen = new Set<string>();
  for (const line of lines) {
    assertQuantity(line.countedBase);
    if (seen.has(line.stockItemId)) throw new StockError('invalid', 'A product appears twice in this count');
    seen.add(line.stockItemId);
  }
  return friendly(async () => {
    const results: CountResult[] = [];
    // Same order every time (by id), so two counts at the same moment cannot block each other.
    for (const line of [...lines].sort((a, b) => a.stockItemId.localeCompare(b.stockItemId))) {
      const { rows } = await db.query(
        `insert into stock_movements
           (restaurant_id, stock_item_id, occurred_at, kind, quantity_base, counted_base, note, recorded_by)
         values (current_restaurant(), $1, now(), 'count_adjustment', 0, $2, $3, $4)
         returning quantity_base`,
        [line.stockItemId, line.countedBase, note ?? null, recordedBy],
      );
      results.push({ stockItemId: line.stockItemId, countedBase: line.countedBase, differenceBase: Number(rows[0].quantity_base) });
    }
    const order = new Map(lines.map((l, i) => [l.stockItemId, i]));
    return results.sort((a, b) => order.get(a.stockItemId)! - order.get(b.stockItemId)!);
  });
}

export interface Movement {
  id: string;
  kind: MovementKind;
  occurredAt: Date;
  quantityBase: number;
  packName: string | null;
  packCount: number | null;
  costMillimes: number | null;
  reason: WasteReason | null;
  countedBase: number | null;
  note: string | null;
  recordedBy: string | null;
}

// The latest movements of one product, newest first.
export async function history(db: ClientBase, itemId: string, limit: number): Promise<Movement[]> {
  const exists = await db.query(`select 1 from stock_items where id = $1`, [itemId]);
  if (exists.rowCount === 0) throw new StockError('not_found', 'No such product in stock');
  const { rows } = await db.query(
    `select m.id, m.kind, m.occurred_at, m.quantity_base, p.name as pack_name, m.pack_count, m.cost_millimes,
            m.reason, m.counted_base, m.note, u.full_name
     from stock_movements m
     left join stock_item_packs p on p.id = m.pack_id
     left join users u on u.id = m.recorded_by
     where m.stock_item_id = $1
     order by m.occurred_at desc, m.seq desc
     limit $2`,
    [itemId, limit],
  );
  const num = (v: unknown) => (v === null ? null : Number(v));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    occurredAt: r.occurred_at,
    quantityBase: Number(r.quantity_base),
    packName: r.pack_name,
    packCount: num(r.pack_count),
    costMillimes: num(r.cost_millimes),
    reason: r.reason,
    countedBase: num(r.counted_base),
    note: r.note,
    recordedBy: r.full_name ?? null,
  }));
}

export interface ReportLine {
  stockItemId: string;
  name: string;
  baseUnit: BaseUnit;
  openingBase: number;
  purchasedBase: number;
  purchaseCostMillimes: number;
  // Positive numbers: what was thrown away, and what was used.
  wastedBase: number;
  // used = opening + purchased - wasted - closing (usage typed by hand + stocktake differences).
  usedBase: number;
  closingBase: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// What happened to each product between two days (both included), in Tunisian time.
// Most useful between two stocktakes: "used" is then what really left the shelves.
export async function report(db: ClientBase, from: string, to: string): Promise<ReportLine[]> {
  if (!DAY.test(from) || !DAY.test(to)) throw new StockError('invalid', 'Days must look like 2026-10-19');
  if (from > to) throw new StockError('invalid', 'The first day must be before the last day');
  const { rows } = await db.query(
    `with bounds as (
       select ($1::date)::timestamp at time zone 'Africa/Tunis' as start_at,
              (($2::date + 1))::timestamp at time zone 'Africa/Tunis' as end_at
     )
     select i.id, i.name, i.base_unit,
       coalesce(sum(m.quantity_base) filter (where m.occurred_at < b.start_at), 0) as opening,
       coalesce(sum(m.quantity_base) filter (where m.occurred_at >= b.start_at and m.occurred_at < b.end_at and m.kind = 'purchase'), 0) as purchased,
       coalesce(sum(m.cost_millimes) filter (where m.occurred_at >= b.start_at and m.occurred_at < b.end_at and m.kind = 'purchase'), 0) as cost,
       coalesce(sum(m.quantity_base) filter (where m.occurred_at >= b.start_at and m.occurred_at < b.end_at and m.kind = 'waste'), 0) as wasted,
       coalesce(sum(m.quantity_base) filter (where m.occurred_at >= b.start_at and m.occurred_at < b.end_at and m.kind in ('usage', 'count_adjustment')), 0) as used,
       coalesce(sum(m.quantity_base) filter (where m.occurred_at < b.end_at), 0) as closing
     from stock_items i
     cross join bounds b
     left join stock_movements m on m.stock_item_id = i.id
     group by i.id, i.name, i.base_unit, i.storage_place, i.archived_at
     having i.archived_at is null or count(m.id) filter (where m.occurred_at >= b.start_at and m.occurred_at < b.end_at) > 0
     order by array_position(array['fridge','freezer','dry_store','bar','other'], i.storage_place), lower(i.name)`,
    [from, to],
  );
  return rows.map((r) => ({
    stockItemId: r.id,
    name: r.name,
    baseUnit: r.base_unit,
    openingBase: Number(r.opening),
    purchasedBase: Number(r.purchased),
    purchaseCostMillimes: Number(r.cost),
    // "0 - x" instead of "-x": never a "-0" on the screens.
    wastedBase: 0 - Number(r.wasted),
    usedBase: 0 - Number(r.used),
    closingBase: Number(r.closing),
  }));
}
