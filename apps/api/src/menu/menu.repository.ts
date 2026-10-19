import type { ClientBase } from 'pg';
import { assertMillimes, assertRate, splitTtc } from '@app/shared';

// Every function here must run inside db.withRestaurant(...): row-level security limits
// all rows to the current restaurant, and new rows get it from current_restaurant().

export interface Price {
  priceTtcMillimes: number;
  vatRateBp: number;
  htMillimes: number;
  vatMillimes: number;
  validFrom: Date;
}

export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  position: number;
  archived: boolean;
  price: Price | null;
}

export interface MenuCategory {
  id: string;
  name: string;
  position: number;
  archived: boolean;
  items: MenuItem[];
}

export class MenuError extends Error {
  constructor(
    readonly kind: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

function price(ttc: unknown, rate: unknown, validFrom: unknown): Price | null {
  if (ttc === null || ttc === undefined) return null;
  const t = Number(ttc);
  const r = Number(rate);
  const { ht, vat } = splitTtc(t, r);
  return { priceTtcMillimes: t, vatRateBp: r, htMillimes: ht, vatMillimes: vat, validFrom: validFrom as Date };
}

// Turns database errors about names and links into clear messages.
async function friendly<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') throw new MenuError('conflict', 'This name is already used');
    if (code === '23503') throw new MenuError('invalid', 'Unknown category');
    throw err;
  }
}

export async function listMenu(db: ClientBase, includeArchived: boolean): Promise<MenuCategory[]> {
  const cats = await db.query(
    `select id, name, position, archived_at is not null as archived from menu_categories
     where $1 or archived_at is null order by position, lower(name)`,
    [includeArchived],
  );
  const items = await db.query(
    `select i.id, i.category_id, i.name, i.description, i.position, i.archived_at is not null as archived,
            p.price_ttc_millimes, p.vat_rate_bp, p.valid_from
     from menu_items i left join menu_item_current_prices p on p.item_id = i.id
     where $1 or i.archived_at is null
     order by i.position, lower(i.name)`,
    [includeArchived],
  );
  const byCategory = new Map<string, MenuItem[]>();
  for (const r of items.rows) {
    const item: MenuItem = {
      id: r.id,
      categoryId: r.category_id,
      name: r.name,
      description: r.description,
      position: r.position,
      archived: r.archived,
      price: price(r.price_ttc_millimes, r.vat_rate_bp, r.valid_from),
    };
    byCategory.set(r.category_id, [...(byCategory.get(r.category_id) ?? []), item]);
  }
  return cats.rows.map((c) => ({
    id: c.id,
    name: c.name,
    position: c.position,
    archived: c.archived,
    items: byCategory.get(c.id) ?? [],
  }));
}

export function createCategory(db: ClientBase, name: string, position: number): Promise<string> {
  return friendly(async () => {
    const { rows } = await db.query(
      `insert into menu_categories (restaurant_id, name, position) values (current_restaurant(), $1, $2) returning id`,
      [name, position],
    );
    return rows[0].id as string;
  });
}

export function updateCategory(db: ClientBase, id: string, changes: { name?: string; position?: number }): Promise<void> {
  return friendly(async () => {
    const { rowCount } = await db.query(
      `update menu_categories set name = coalesce($2, name), position = coalesce($3, position)
       where id = $1 and archived_at is null`,
      [id, changes.name ?? null, changes.position ?? null],
    );
    if (rowCount === 0) throw new MenuError('not_found', 'No such category');
  });
}

// A category can only be archived once it has no dish left on the menu.
export async function archiveCategory(db: ClientBase, id: string): Promise<void> {
  const { rows } = await db.query(
    `select count(*)::int as n from menu_items where category_id = $1 and archived_at is null`,
    [id],
  );
  if (rows[0].n > 0) throw new MenuError('conflict', 'Archive or move its dishes first');
  const { rowCount } = await db.query(
    `update menu_categories set archived_at = now() where id = $1 and archived_at is null`,
    [id],
  );
  if (rowCount === 0) throw new MenuError('not_found', 'No such category');
}

async function activeCategory(db: ClientBase, id: string): Promise<void> {
  const { rowCount } = await db.query(`select 1 from menu_categories where id = $1 and archived_at is null`, [id]);
  if (rowCount === 0) throw new MenuError('invalid', 'Unknown category');
}

export interface NewItem {
  categoryId: string;
  name: string;
  description?: string;
  position: number;
  priceTtcMillimes: number;
  vatRateBp: number;
  changedBy: string;
}

export async function createItem(db: ClientBase, item: NewItem): Promise<string> {
  assertMillimes(item.priceTtcMillimes);
  assertRate(item.vatRateBp);
  return friendly(async () => {
    await activeCategory(db, item.categoryId);
    const { rows } = await db.query(
      `insert into menu_items (restaurant_id, category_id, name, description, position)
       values (current_restaurant(), $1, $2, $3, $4) returning id`,
      [item.categoryId, item.name, item.description ?? null, item.position],
    );
    const id = rows[0].id as string;
    await db.query(
      `insert into menu_item_prices (restaurant_id, item_id, price_ttc_millimes, vat_rate_bp, changed_by)
       values (current_restaurant(), $1, $2, $3, $4)`,
      [id, item.priceTtcMillimes, item.vatRateBp, item.changedBy],
    );
    return id;
  });
}

export function updateItem(
  db: ClientBase,
  id: string,
  changes: { name?: string; description?: string | null; categoryId?: string; position?: number },
): Promise<void> {
  return friendly(async () => {
    if (changes.categoryId) await activeCategory(db, changes.categoryId);
    const { rowCount } = await db.query(
      `update menu_items set
         name = coalesce($2, name),
         description = case when $3::boolean then $4 else description end,
         category_id = coalesce($5, category_id),
         position = coalesce($6, position),
         updated_at = now()
       where id = $1 and archived_at is null`,
      [id, changes.name ?? null, changes.description !== undefined, changes.description ?? null, changes.categoryId ?? null, changes.position ?? null],
    );
    if (rowCount === 0) throw new MenuError('not_found', 'No such dish on the menu');
  });
}

// Adds a new price. Nothing is written if the price and rate are the same as now.
export async function setPrice(
  db: ClientBase,
  itemId: string,
  priceTtcMillimes: number,
  vatRateBp: number,
  changedBy: string,
): Promise<{ changed: boolean }> {
  assertMillimes(priceTtcMillimes);
  assertRate(vatRateBp);
  // Locks the dish, so two price changes at the same moment are applied one after the other.
  const item = await db.query(`select 1 from menu_items where id = $1 and archived_at is null for update`, [itemId]);
  if (item.rowCount === 0) throw new MenuError('not_found', 'No such dish on the menu');
  const current = await db.query(
    `select price_ttc_millimes, vat_rate_bp from menu_item_current_prices where item_id = $1`,
    [itemId],
  );
  const c = current.rows[0];
  if (c && Number(c.price_ttc_millimes) === priceTtcMillimes && Number(c.vat_rate_bp) === vatRateBp) {
    return { changed: false };
  }
  await db.query(
    `insert into menu_item_prices (restaurant_id, item_id, price_ttc_millimes, vat_rate_bp, changed_by)
     values (current_restaurant(), $1, $2, $3, $4)`,
    [itemId, priceTtcMillimes, vatRateBp, changedBy],
  );
  return { changed: true };
}

export async function setArchived(db: ClientBase, itemId: string, archived: boolean): Promise<void> {
  await friendly(async () => {
    if (!archived) {
      // Coming back on the menu: its category must still be there.
      const { rows } = await db.query(
        `select c.archived_at is null as ok from menu_items i join menu_categories c on c.id = i.category_id where i.id = $1`,
        [itemId],
      );
      if (rows[0] && !rows[0].ok) throw new MenuError('conflict', 'Its category is archived: move the dish first');
    }
    const { rowCount } = await db.query(
      `update menu_items set archived_at = ${archived ? 'now()' : 'null'}, updated_at = now()
       where id = $1 and archived_at is ${archived ? 'null' : 'not null'}`,
      [itemId],
    );
    if (rowCount === 0) throw new MenuError('not_found', archived ? 'No such dish on the menu' : 'No such archived dish');
  });
}

export async function priceHistory(db: ClientBase, itemId: string) {
  const { rows } = await db.query(
    `select p.price_ttc_millimes, p.vat_rate_bp, p.valid_from, u.full_name
     from menu_item_prices p left join users u on u.id = p.changed_by
     where p.item_id = $1 order by p.valid_from desc, p.id desc`,
    [itemId],
  );
  return rows.map((r) => ({ ...price(r.price_ttc_millimes, r.vat_rate_bp, r.valid_from)!, changedBy: r.full_name as string }));
}
