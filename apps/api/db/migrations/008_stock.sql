-- Stock: products, pack sizes, deliveries with their price, waste with a reason, stocktakes.
--
-- How stock works: nobody types "we have 12 kg". Every change is a new row in the
-- append-only journal stock_movements, and the current quantity is the sum of its rows.
--   purchase          a delivery received (positive), optionally in packs and with its price
--   usage             something used by hand (negative)
--   waste             something thrown away (negative), always with a reason
--   count_adjustment  a stocktake: the real counted quantity is kept in counted_base, and
--                     the database itself computes the difference with what the journal says
-- Stock may go below zero (a delivery not entered yet must not block the kitchen); the
-- screens warn instead.
--
-- Rows recorded before this migration are kept as they are (append-only); the new rules
-- apply to every row recorded from now on ("not valid" = skip old rows).

-- 1. Products --------------------------------------------------------------
alter table stock_items add column archived_at timestamptz;
alter table stock_items add column storage_place text not null default 'other'
  check (storage_place in ('fridge', 'freezer', 'dry_store', 'bar', 'other'));
-- "Warn me below this quantity", in the base unit. Empty = no alert.
alter table stock_items add column alert_level_base bigint
  check (alert_level_base between 0 and 1000000000);
alter table stock_items add column updated_at timestamptz not null default now();
alter table stock_items add constraint stock_items_name_length
  check (length(name) between 1 and 100) not valid;

-- Names are unique per restaurant whatever the capital letters, among products still in use
-- (an archived "Tomates" does not block a new "Tomates").
alter table stock_items drop constraint stock_items_restaurant_id_name_key;
create unique index stock_items_unique_name
  on stock_items (restaurant_id, lower(name)) where archived_at is null;

-- The unit can never change once a product exists: its whole history is counted in it.
-- Only these columns can be changed by the app.
revoke update on stock_items from app_runtime;
grant update (name, storage_place, alert_level_base, archived_at, updated_at) on stock_items to app_runtime;

-- 2. Pack sizes ------------------------------------------------------------
-- "Caisse de 12 bouteilles" = 12,000 ml. A delivery can be typed as "2 caisses".
-- A pack size is never edited (past deliveries point to it); it is archived and replaced.
create table stock_item_packs (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  stock_item_id uuid not null,
  name text not null check (length(name) between 1 and 60),
  quantity_base bigint not null check (quantity_base between 1 and 1000000000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, stock_item_id, restaurant_id),
  foreign key (stock_item_id, restaurant_id) references stock_items (id, restaurant_id)
);
create unique index stock_item_packs_unique_name
  on stock_item_packs (stock_item_id, lower(name)) where archived_at is null;

alter table stock_item_packs enable row level security;
alter table stock_item_packs force row level security;
create policy tenant_isolation on stock_item_packs
  using (restaurant_id = current_restaurant()) with check (restaurant_id = current_restaurant());

grant select, insert on stock_item_packs to app_runtime;
grant update (archived_at) on stock_item_packs to app_runtime;  -- archive only, no delete

-- 3. Movements: new details ------------------------------------------------
alter table stock_movements add column pack_id uuid;
alter table stock_movements add column pack_count int;
-- Price paid for this delivery line, before VAT, in millimes.
alter table stock_movements add column cost_millimes bigint;
alter table stock_movements add column reason text;
alter table stock_movements add column counted_base bigint;
-- Order of recording. Rows of one transaction share the same time, so the time alone
-- cannot say which came first; this number always can.
alter table stock_movements add column seq bigint generated always as identity;

-- A pack must belong to the same product and the same restaurant.
alter table stock_movements add constraint stock_movements_pack_fk
  foreign key (pack_id, stock_item_id, restaurant_id) references stock_item_packs (id, stock_item_id, restaurant_id);

alter table stock_movements add constraint stock_movements_sign check (
  case kind
    when 'purchase' then quantity_base > 0
    when 'count_adjustment' then true
    else quantity_base < 0
  end) not valid;
alter table stock_movements add constraint stock_movements_pack_rules check (
  (pack_id is null) = (pack_count is null)
  and (pack_id is null or kind = 'purchase')
  and (pack_count is null or pack_count between 1 and 10000)) not valid;
alter table stock_movements add constraint stock_movements_cost_rules check (
  cost_millimes is null or (kind = 'purchase' and cost_millimes between 0 and 10000000000)) not valid;
alter table stock_movements add constraint stock_movements_reason_rules check (
  (kind = 'waste') = (reason is not null)
  and (reason is null or reason in ('spoiled', 'expired', 'burnt', 'dropped', 'other'))) not valid;
alter table stock_movements add constraint stock_movements_count_rules check (
  (kind = 'count_adjustment') = (counted_base is not null)
  and (counted_base is null or counted_base between 0 and 1000000000)) not valid;
alter table stock_movements add constraint stock_movements_note_length check (
  note is null or length(note) <= 200) not valid;

-- Checks every new movement, inside the database, whatever the application does.
-- Runs with the rights of the caller, so row-level security still applies.
create function stock_movement_rules() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_item record;
  v_pack_quantity bigint;
  v_current bigint;
begin
  -- Server time, always: nobody can backdate or postdate a movement.
  -- All rows of one stocktake are written in one transaction, so they share this time.
  new.occurred_at := now();

  -- Lock the product: movements on the same product are applied one after the other,
  -- so a stocktake always compares with an up-to-date total.
  select id, archived_at into v_item
  from stock_items
  where id = new.stock_item_id and restaurant_id = new.restaurant_id
  for update;
  if v_item.id is null then
    raise exception 'Unknown stock item' using errcode = '23503';
  end if;
  if v_item.archived_at is not null then
    raise exception 'This product is archived' using errcode = '23514';
  end if;

  -- A delivery typed in packs: the quantity comes from the pack size, not from the screen.
  if new.pack_id is not null then
    select quantity_base into v_pack_quantity
    from stock_item_packs
    where id = new.pack_id and stock_item_id = new.stock_item_id
      and restaurant_id = new.restaurant_id and archived_at is null;
    if v_pack_quantity is null then
      raise exception 'Unknown pack size' using errcode = '23503';
    end if;
    new.quantity_base := v_pack_quantity * new.pack_count;
  end if;

  -- A stocktake: the difference is computed here, from the counted quantity.
  if new.kind = 'count_adjustment' then
    select coalesce(sum(quantity_base), 0) into v_current
    from stock_movements
    where stock_item_id = new.stock_item_id and restaurant_id = new.restaurant_id;
    new.quantity_base := new.counted_base - v_current;
  end if;

  return new;
end $$;

create trigger stock_movements_rules before insert on stock_movements
  for each row execute function stock_movement_rules();

create index on stock_movements (stock_item_id, occurred_at desc);
