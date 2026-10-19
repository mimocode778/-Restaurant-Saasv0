import type { ClientBase } from 'pg';
import { assertMillimes } from '@app/shared';

export type SaleKind = 'sale' | 'void' | 'discount' | 'refund';
export type SaleSource = 'import' | 'manual' | 'register';

export interface NewSale {
  kind: SaleKind;
  amountMillimes: number;
  source: SaleSource;
  // The staff member recording it (always from the login).
  recordedBy: string;
  // For a void, discount or refund: the sale it takes money back from.
  refersTo?: string;
  // Only used for imported sales. Sales typed at the till always get the server's time:
  // the database enforces it, whatever is sent here.
  occurredAt?: Date;
  externalRef?: string;
}

export interface DaySummary {
  tickets: number;
  grossMillimes: number;
  netMillimes: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Records one sales event. The restaurant is NOT a parameter: the database fills in the
// restaurant of the current transaction, so a caller cannot write into another restaurant.
export async function insertSale(db: ClientBase, sale: NewSale): Promise<{ duplicate: boolean; id?: string }> {
  assertMillimes(sale.amountMillimes);
  if (sale.kind === 'sale' && sale.amountMillimes < 0) {
    throw new Error('A sale cannot be negative');
  }
  if (sale.kind !== 'sale' && sale.amountMillimes > 0) {
    throw new Error('A void, discount or refund must be negative');
  }
  if ((sale.kind === 'sale') !== (sale.refersTo === undefined)) {
    throw new Error('A void, discount or refund must refer to a sale, and a sale must not');
  }
  if (sale.source === 'import' && !sale.occurredAt) {
    throw new Error('An imported sale needs its original time');
  }

  const result = await db.query(
    `insert into sales_events (restaurant_id, occurred_at, kind, amount_millimes, source, external_ref, recorded_by, refers_to)
     values (current_restaurant(), coalesce($1, now()), $2, $3, $4, $5, $6, $7)
     on conflict (restaurant_id, source, external_ref) where external_ref is not null do nothing
     returning id`,
    [sale.occurredAt ?? null, sale.kind, sale.amountMillimes, sale.source, sale.externalRef ?? null, sale.recordedBy, sale.refersTo ?? null],
  );
  return result.rowCount === 0 ? { duplicate: true } : { duplicate: false, id: result.rows[0].id as string };
}

// Totals for one calendar day in Tunisian time. Only the current restaurant's rows are visible,
// because row-level security filters them before this query sees them.
export async function salesForDay(db: ClientBase, day: string): Promise<DaySummary> {
  if (!DAY.test(day)) {
    throw new Error('Day must look like 2026-10-19');
  }
  const { rows } = await db.query(
    `select
       count(*) filter (where kind = 'sale') as tickets,
       coalesce(sum(amount_millimes) filter (where kind = 'sale'), 0) as gross,
       coalesce(sum(amount_millimes), 0) as net
     from sales_events
     where occurred_at >= ($1::date)::timestamp at time zone 'Africa/Tunis'
       and occurred_at <  (($1::date + 1))::timestamp at time zone 'Africa/Tunis'`,
    [day],
  );
  const r = rows[0];
  return { tickets: Number(r.tickets), grossMillimes: Number(r.gross), netMillimes: Number(r.net) };
}
