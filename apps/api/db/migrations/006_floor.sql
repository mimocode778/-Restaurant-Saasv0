-- Dining room layout ------------------------------------------------------
-- What the room looks like: its size, and where the tables, counter, kitchen and
-- decoration stand. Used by the room editor and the 3D view. Positions are in
-- centimetres from the top-left corner of the room, seen from above.

create table floor_plans (
  restaurant_id uuid primary key references restaurants(id),
  width_cm int not null default 1200 check (width_cm between 300 and 10000),
  depth_cm int not null default 800 check (depth_cm between 300 and 10000),
  updated_at timestamptz not null default now()
);

create table floor_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  kind text not null check (kind in ('table', 'counter', 'kitchen', 'plant', 'door')),
  label text not null check (length(label) between 1 and 30),
  seats int check (seats between 1 and 20),
  x_cm int not null check (x_cm between 0 and 10000),
  z_cm int not null check (z_cm between 0 and 10000),
  rotation_deg int not null default 0 check (rotation_deg between 0 and 359),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Only tables have seats.
  check ((kind = 'table') = (seats is not null))
);
create index on floor_items (restaurant_id);
-- Two active tables cannot share a name ("T1" twice would confuse the staff).
create unique index floor_items_unique_table_label
  on floor_items (restaurant_id, lower(label)) where kind = 'table' and archived_at is null;

alter table floor_plans enable row level security;
alter table floor_plans force row level security;
create policy tenant_isolation on floor_plans
  using (restaurant_id = current_restaurant()) with check (restaurant_id = current_restaurant());

alter table floor_items enable row level security;
alter table floor_items force row level security;
create policy tenant_isolation on floor_items
  using (restaurant_id = current_restaurant()) with check (restaurant_id = current_restaurant());

grant select, insert, update on floor_plans, floor_items to app_runtime;  -- no delete: items are archived
