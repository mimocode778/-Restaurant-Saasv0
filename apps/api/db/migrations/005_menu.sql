-- Menu: categories, dishes and their prices -------------------------------
-- Prices are entered including VAT (as printed on a menu), in millimes, with the VAT
-- rate of each dish in basis points (19 % = 1900). The rate is not fixed in the software:
-- each restaurant sets it per dish, as its accountant confirms.
--
-- Dishes are never deleted (past sales point to them): they are archived instead.
-- Prices are never edited: a change adds a new price row, so the full history stays,
-- which tax rules on cash registers expect (no change of recorded data).

create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  name text not null check (length(name) between 1 and 60),
  position int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, restaurant_id)
);
create unique index menu_categories_unique_name
  on menu_categories (restaurant_id, lower(name)) where archived_at is null;

create table menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  category_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  description text check (length(description) <= 500),
  position int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, restaurant_id),
  foreign key (category_id, restaurant_id) references menu_categories (id, restaurant_id)
);
create unique index menu_items_unique_name
  on menu_items (restaurant_id, lower(name)) where archived_at is null;
create index on menu_items (restaurant_id, category_id);

-- Append-only price history. The current price of a dish is its latest row.
create table menu_item_prices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  item_id uuid not null,
  price_ttc_millimes bigint not null check (price_ttc_millimes between 0 and 1000000000),
  vat_rate_bp int not null check (vat_rate_bp between 0 and 10000),
  valid_from timestamptz not null default now(),
  changed_by uuid not null,
  foreign key (item_id, restaurant_id) references menu_items (id, restaurant_id),
  foreign key (changed_by, restaurant_id) references users (id, restaurant_id)
);
create index on menu_item_prices (item_id, valid_from desc);

create trigger menu_item_prices_append_only before update or delete on menu_item_prices
  for each row execute function forbid_change();
create trigger menu_item_prices_no_truncate before truncate on menu_item_prices
  for each statement execute function forbid_change();

-- The current price of each dish (latest row).
create view menu_item_current_prices with (security_invoker = true) as
  select distinct on (item_id) item_id, restaurant_id, id as price_id, price_ttc_millimes, vat_rate_bp, valid_from
  from menu_item_prices
  order by item_id, valid_from desc, id desc;

-- Tenant isolation, as for every other table.
alter table menu_categories enable row level security;
alter table menu_categories force row level security;
create policy tenant_isolation on menu_categories
  using (restaurant_id = current_restaurant()) with check (restaurant_id = current_restaurant());

alter table menu_items enable row level security;
alter table menu_items force row level security;
create policy tenant_isolation on menu_items
  using (restaurant_id = current_restaurant()) with check (restaurant_id = current_restaurant());

alter table menu_item_prices enable row level security;
alter table menu_item_prices force row level security;
create policy tenant_isolation on menu_item_prices
  using (restaurant_id = current_restaurant()) with check (restaurant_id = current_restaurant());

grant select, insert, update on menu_categories, menu_items to app_runtime;  -- no delete
grant select, insert on menu_item_prices to app_runtime;                     -- no update, no delete
grant select on menu_item_current_prices to app_runtime;
