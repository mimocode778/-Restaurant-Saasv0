import type { ClientBase } from 'pg';

// Every function here must run inside db.withRestaurant(...).

export type FloorKind = 'table' | 'counter' | 'kitchen' | 'plant' | 'door';

export interface FloorItem {
  id: string;
  kind: FloorKind;
  label: string;
  seats: number | null;
  xCm: number;
  zCm: number;
  rotationDeg: number;
}

export interface Floor {
  widthCm: number;
  depthCm: number;
  items: FloorItem[];
}

export const DEFAULT_PLAN = { widthCm: 1200, depthCm: 800 };

export class FloorError extends Error {
  constructor(
    readonly kind: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

const toItem = (r: Record<string, unknown>): FloorItem => ({
  id: r.id as string,
  kind: r.kind as FloorKind,
  label: r.label as string,
  seats: (r.seats as number | null) ?? null,
  xCm: r.x_cm as number,
  zCm: r.z_cm as number,
  rotationDeg: r.rotation_deg as number,
});

async function plan(db: ClientBase): Promise<{ widthCm: number; depthCm: number }> {
  const { rows } = await db.query('select width_cm, depth_cm from floor_plans');
  return rows[0] ? { widthCm: rows[0].width_cm, depthCm: rows[0].depth_cm } : DEFAULT_PLAN;
}

function inside(p: { widthCm: number; depthCm: number }, x: number, z: number) {
  if (x > p.widthCm || z > p.depthCm) throw new FloorError('invalid', 'This position is outside the room');
}

async function friendly<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new FloorError('conflict', 'A table already has this name');
    throw err;
  }
}

export async function getFloor(db: ClientBase): Promise<Floor> {
  const p = await plan(db);
  const { rows } = await db.query(
    `select id, kind, label, seats, x_cm, z_cm, rotation_deg from floor_items
     where archived_at is null order by kind, lower(label)`,
  );
  return { ...p, items: rows.map(toItem) };
}

export async function setPlan(db: ClientBase, widthCm: number, depthCm: number): Promise<void> {
  const { rows } = await db.query(
    `select count(*)::int as n from floor_items where archived_at is null and (x_cm > $1 or z_cm > $2)`,
    [widthCm, depthCm],
  );
  if (rows[0].n > 0) throw new FloorError('conflict', 'Some items would end up outside the room: move them first');
  await db.query(
    `insert into floor_plans (restaurant_id, width_cm, depth_cm) values (current_restaurant(), $1, $2)
     on conflict (restaurant_id) do update set width_cm = excluded.width_cm, depth_cm = excluded.depth_cm, updated_at = now()`,
    [widthCm, depthCm],
  );
}

export interface NewFloorItem {
  kind: FloorKind;
  label: string;
  seats: number | null;
  xCm: number;
  zCm: number;
  rotationDeg: number;
}

export function createItem(db: ClientBase, item: NewFloorItem): Promise<string> {
  return friendly(async () => {
    inside(await plan(db), item.xCm, item.zCm);
    const { rows } = await db.query(
      `insert into floor_items (restaurant_id, kind, label, seats, x_cm, z_cm, rotation_deg)
       values (current_restaurant(), $1, $2, $3, $4, $5, $6) returning id`,
      [item.kind, item.label, item.kind === 'table' ? item.seats : null, item.xCm, item.zCm, item.rotationDeg],
    );
    return rows[0].id as string;
  });
}

export function updateItem(
  db: ClientBase,
  id: string,
  changes: { label?: string; seats?: number; xCm?: number; zCm?: number; rotationDeg?: number },
): Promise<void> {
  return friendly(async () => {
    const { rows } = await db.query(`select kind, x_cm, z_cm from floor_items where id = $1 and archived_at is null`, [id]);
    if (!rows[0]) throw new FloorError('not_found', 'No such item in the room');
    if (changes.seats !== undefined && rows[0].kind !== 'table') throw new FloorError('invalid', 'Only tables have seats');
    inside(await plan(db), changes.xCm ?? rows[0].x_cm, changes.zCm ?? rows[0].z_cm);
    await db.query(
      `update floor_items set
         label = coalesce($2, label), seats = coalesce($3, seats),
         x_cm = coalesce($4, x_cm), z_cm = coalesce($5, z_cm), rotation_deg = coalesce($6, rotation_deg),
         updated_at = now()
       where id = $1`,
      [id, changes.label ?? null, changes.seats ?? null, changes.xCm ?? null, changes.zCm ?? null, changes.rotationDeg ?? null],
    );
  });
}

export async function archiveItem(db: ClientBase, id: string): Promise<void> {
  const { rowCount } = await db.query(
    `update floor_items set archived_at = now(), updated_at = now() where id = $1 and archived_at is null`,
    [id],
  );
  if (rowCount === 0) throw new FloorError('not_found', 'No such item in the room');
}
