-- Trustworthy sales records ------------------------------------------------
-- 1. Sales typed at the till get the SERVER's time, never a time sent by the screen,
--    so nobody can backdate or postdate a sale. Only imported sales keep their own time.
-- 2. Every new sale and stock movement records WHO recorded it.
-- 3. A void, discount or refund must point to the original sale, of the same restaurant,
--    and all of them together can never take back more than that sale's amount.
--
-- Rows recorded before this migration are kept as they are (tables are append-only);
-- the new rules apply to every row recorded from now on ("not valid" = skip old rows).

-- Lets other rows prove they point to a sale of the SAME restaurant.
alter table sales_events add constraint sales_events_id_restaurant unique (id, restaurant_id);

alter table sales_events add column recorded_by uuid;
alter table sales_events add column refers_to uuid;

alter table sales_events add constraint sales_events_recorded_by_fk
  foreign key (recorded_by, restaurant_id) references users (id, restaurant_id);
alter table sales_events add constraint sales_events_refers_to_fk
  foreign key (refers_to, restaurant_id) references sales_events (id, restaurant_id);

alter table sales_events add constraint sales_events_recorded_by_required
  check (recorded_by is not null) not valid;
-- A sale stands alone; a void, discount or refund always points to a sale.
alter table sales_events add constraint sales_events_refers_to_rule
  check ((kind = 'sale') = (refers_to is null)) not valid;
create index on sales_events (refers_to) where refers_to is not null;

alter table stock_movements add column recorded_by uuid;
alter table stock_movements add constraint stock_movements_recorded_by_fk
  foreign key (recorded_by, restaurant_id) references users (id, restaurant_id);
alter table stock_movements add constraint stock_movements_recorded_by_required
  check (recorded_by is not null) not valid;

-- Checks every new sales event, inside the database, whatever the application does.
create function sales_event_rules() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_original record;
  v_taken_back bigint;
begin
  -- 1. Server time for everything typed at the till.
  if new.source <> 'import' then
    new.occurred_at := now();
  end if;

  -- 3. A void, discount or refund must refer to a real sale and stay within its amount.
  if new.kind <> 'sale' then
    if new.refers_to is null then
      raise exception 'A void, discount or refund must refer to a sale' using errcode = '23514';
    end if;
    -- Lock the original sale: two refunds at the same moment are checked one after the other.
    select id, kind, amount_millimes into v_original
    from sales_events
    where id = new.refers_to and restaurant_id = new.restaurant_id
    for update;
    if v_original.id is null then
      raise exception 'The original sale was not found' using errcode = '23503';
    end if;
    if v_original.kind <> 'sale' then
      raise exception 'A void, discount or refund must refer to a sale' using errcode = '23514';
    end if;
    select coalesce(sum(amount_millimes), 0) into v_taken_back
    from sales_events where refers_to = new.refers_to;
    if v_original.amount_millimes + v_taken_back + new.amount_millimes < 0 then
      raise exception 'This would take back more than the original sale' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger sales_events_rules before insert on sales_events
  for each row execute function sales_event_rules();
