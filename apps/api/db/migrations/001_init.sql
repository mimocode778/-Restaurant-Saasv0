-- Tenants and users -------------------------------------------------------
create table restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  email text not null unique,
  full_name text not null,
  role text not null check (role in ('owner', 'manager', 'waiter')),
  created_at timestamptz not null default now()
);
create index on users (restaurant_id);

-- Inventory ---------------------------------------------------------------
create table stock_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  name text not null,
  base_unit text not null check (base_unit in ('g', 'ml', 'piece')),
  created_at timestamptz not null default now(),
  unique (restaurant_id, name),
  unique (id, restaurant_id)  -- lets movements prove the item belongs to the same restaurant
);

-- Append-only: quantity_base is a signed whole number in the base unit.
create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  stock_item_id uuid not null,
  occurred_at timestamptz not null,
  kind text not null check (kind in ('purchase', 'usage', 'waste', 'count_adjustment')),
  quantity_base bigint not null,
  note text,
  recorded_at timestamptz not null default now(),
  foreign key (stock_item_id, restaurant_id) references stock_items (id, restaurant_id)
);
create index on stock_movements (restaurant_id, stock_item_id, occurred_at);

-- Sales -------------------------------------------------------------------
-- Append-only: amount_millimes is an integer (1 TND = 1000 millimes).
-- A void or refund is a new row with a negative amount, never an edit.
create table sales_events (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  occurred_at timestamptz not null,
  kind text not null check (kind in ('sale', 'void', 'discount', 'refund')),
  amount_millimes bigint not null,
  source text not null check (source in ('import', 'manual', 'register')),
  external_ref text,
  recorded_at timestamptz not null default now()
);
create index on sales_events (restaurant_id, occurred_at);
-- Importing the same file twice must not create duplicates.
create unique index sales_events_dedupe
  on sales_events (restaurant_id, source, external_ref)
  where external_ref is not null;

-- Append-only enforcement (second layer, applies even to admins) ----------
create function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed: this table is append-only', tg_op, tg_table_name;
end $$;

create trigger sales_events_append_only
  before update or delete on sales_events
  for each row execute function forbid_change();
create trigger sales_events_no_truncate
  before truncate on sales_events
  for each statement execute function forbid_change();

create trigger stock_movements_append_only
  before update or delete on stock_movements
  for each row execute function forbid_change();
create trigger stock_movements_no_truncate
  before truncate on stock_movements
  for each statement execute function forbid_change();

-- Tenant isolation (row-level security) -----------------------------------
-- The app tells the database which restaurant it is acting for with:
--   select set_config('app.restaurant_id', '<uuid>', true);
create function current_restaurant() returns uuid language sql stable as $$
  select nullif(current_setting('app.restaurant_id', true), '')::uuid
$$;

alter table restaurants enable row level security;
alter table restaurants force row level security;
create policy tenant_isolation on restaurants
  using (id = current_restaurant()) with check (id = current_restaurant());

alter table users enable row level security;
alter table users force row level security;
create policy tenant_isolation on users
  using (restaurant_id = current_restaurant()) with check (restaurant_id = current_restaurant());

alter table stock_items enable row level security;
alter table stock_items force row level security;
create policy tenant_isolation on stock_items
  using (restaurant_id = current_restaurant()) with check (restaurant_id = current_restaurant());

alter table stock_movements enable row level security;
alter table stock_movements force row level security;
create policy tenant_isolation on stock_movements
  using (restaurant_id = current_restaurant()) with check (restaurant_id = current_restaurant());

alter table sales_events enable row level security;
alter table sales_events force row level security;
create policy tenant_isolation on sales_events
  using (restaurant_id = current_restaurant()) with check (restaurant_id = current_restaurant());

-- The role the API uses at runtime (NOT a superuser, so security applies) --
do $$ begin
  if not exists (select from pg_roles where rolname = 'app_runtime') then
    create role app_runtime login password 'app_runtime';  -- development password only
  end if;
end $$;

grant usage on schema public to app_runtime;
grant select, update on restaurants to app_runtime;
grant select, insert, update on users, stock_items to app_runtime;
grant select, insert on sales_events, stock_movements to app_runtime;  -- no update, no delete
