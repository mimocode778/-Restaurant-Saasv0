-- Login hardening ---------------------------------------------------------
-- 1. Attempt limits per network address and per account, replacing the simple
--    per-account lock (which let anyone lock an owner out on purpose).
-- 2. A login history (who, when, from where, what happened), append-only.
-- 3. Sessions end after a period of inactivity, not only after 12 hours.
-- 4. Optional second step for owners and managers: a 6-digit code from a phone app
--    (Google Authenticator, Microsoft Authenticator...), with one-time recovery codes.
-- 5. Functions for password change, "log out everywhere", tablet management.
--
-- Same rule as 003: secrets stay in tables the API role cannot read; the API reaches
-- them only through the auth_* functions, which run with the migration owner's rights.

-- Drop the old functions whose shape changes (recreated below).
drop function auth_password_candidate(text);
drop function auth_pin_candidate(text, uuid);
drop function auth_record_failure(text, uuid);
drop function auth_start_session(uuid, text, uuid, text, interval);
drop function auth_resolve_session(text);
drop function auth_set_password(uuid, text, text);
drop function auth_set_pin(uuid, text);

alter table credentials drop column failed_attempts, drop column locked_until;
alter table pins drop column failed_attempts, drop column locked_until;

-- 1. Attempt limits -------------------------------------------------------
-- One row per counter (for example "this network address, password logins").
-- Keys are fingerprints built by the API, so no email or address is stored here in clear.
create table rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);
revoke all on rate_limits from public, app_runtime;

-- Is this counter already at its maximum? (does not count a new hit)
create function auth_limit_reached(p_key text, p_max int, p_window interval) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select hits >= p_max from rate_limits where key = p_key and window_start > now() - p_window), false)
$$;

-- Counts one hit. Returns true if the counter is now over its maximum.
create function auth_limit_hit(p_key text, p_max int, p_window interval) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  insert into rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when r.window_start <= now() - p_window then 1 else r.hits + 1 end,
    window_start = case when r.window_start <= now() - p_window then now() else r.window_start end
  returning hits > p_max
$$;

create function auth_limit_clear(p_key text) returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from rate_limits where key = p_key
$$;

create function auth_limit_cleanup() returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from rate_limits where window_start < now() - interval '1 day'
$$;

-- 2. Login history --------------------------------------------------------
create table auth_events (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  restaurant_id uuid references restaurants(id),  -- empty when the email matched no account
  user_id uuid references users(id),
  kind text not null check (kind in (
    'login_succeeded', 'login_failed', 'login_rate_limited',
    'logout', 'logout_everywhere',
    'password_changed', 'password_reset_by_manager', 'pin_reset_by_manager',
    'two_step_enabled', 'two_step_disabled', 'recovery_code_used',
    'device_paired', 'device_revoked', 'staff_created', 'staff_disabled'
  )),
  method text check (method in ('password', 'pin')),
  ip text,
  user_agent text,
  detail text
);
create index on auth_events (restaurant_id, occurred_at desc);

create trigger auth_events_append_only before update or delete on auth_events
  for each row execute function forbid_change();
create trigger auth_events_no_truncate before truncate on auth_events
  for each statement execute function forbid_change();

alter table auth_events enable row level security;
alter table auth_events force row level security;
create policy tenant_isolation on auth_events using (restaurant_id = current_restaurant());
revoke all on auth_events from public, app_runtime;
grant select on auth_events to app_runtime;  -- read only, own restaurant only

create function auth_log(p_restaurant uuid, p_user uuid, p_kind text, p_method text, p_ip text, p_user_agent text, p_detail text)
returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into auth_events (restaurant_id, user_id, kind, method, ip, user_agent, detail)
  values (
    coalesce(p_restaurant, (select restaurant_id from users where id = p_user)),
    p_user, p_kind, p_method, left(p_ip, 64), left(p_user_agent, 300), left(p_detail, 300)
  )
$$;

-- 3. Sessions end when idle ------------------------------------------------
alter table sessions add column last_seen_at timestamptz not null default now();
alter table sessions add column idle_timeout interval not null default interval '2 hours';

-- 4. Two-step login ---------------------------------------------------------
-- The phone-app secret must be readable to check codes, so it is stored encrypted by
-- the API with a key the database never sees (AUTH_SECRET_KEY).
create table totp_factors (
  user_id uuid primary key,
  restaurant_id uuid not null,
  secret_enc text not null,
  confirmed_at timestamptz,
  last_step bigint not null default 0,  -- a code can only be used once
  foreign key (user_id, restaurant_id) references users (id, restaurant_id)
);

create table recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  restaurant_id uuid not null,
  code_hash text not null unique,
  used_at timestamptz,
  foreign key (user_id, restaurant_id) references users (id, restaurant_id)
);
revoke all on totp_factors, recovery_codes from public, app_runtime;

-- Login lookups (no restaurant selected yet) ---------------------------------
-- Locks the row until the end of the transaction, so parallel tries are handled one by one.
create function auth_password_candidate(p_email text)
returns table (user_id uuid, restaurant_id uuid, password_hash text, totp_secret_enc text, totp_last_step bigint)
language sql security definer set search_path = public, pg_temp as $$
  select c.user_id, c.restaurant_id, c.password_hash, t.secret_enc, t.last_step
  from credentials c
  join users u on u.id = c.user_id and u.restaurant_id = c.restaurant_id
  left join totp_factors t on t.user_id = c.user_id and t.confirmed_at is not null
  where c.email = lower(p_email) and u.disabled_at is null
  for update of c
$$;

create function auth_pin_candidate(p_device_token_hash text, p_user uuid)
returns table (user_id uuid, restaurant_id uuid, device_id uuid, pin_hash text)
language sql security definer set search_path = public, pg_temp as $$
  select p.user_id, u.restaurant_id, d.id, p.pin_hash
  from devices d
  join users u on u.restaurant_id = d.restaurant_id and u.id = p_user
  join pins p on p.user_id = u.id and p.restaurant_id = u.restaurant_id
  where d.token_hash = p_device_token_hash and d.revoked_at is null
    and u.role = 'waiter' and u.disabled_at is null
  for update of p
$$;

-- Marks a phone-app code as used. False if it (or a later one) was already used.
create function auth_totp_use_step(p_user uuid, p_step bigint) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  with used as (
    update totp_factors set last_step = p_step
    where user_id = p_user and confirmed_at is not null and last_step < p_step
    returning 1
  )
  select exists (select 1 from used)
$$;

-- Uses up one recovery code. False if unknown or already used.
create function auth_recovery_use(p_user uuid, p_code_hash text) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  with used as (
    update recovery_codes set used_at = now()
    where user_id = p_user and code_hash = p_code_hash and used_at is null
    returning 1
  )
  select exists (select 1 from used)
$$;

-- Called only after the API has checked the password or PIN (and code, if any).
create function auth_start_session(
  p_user uuid, p_method text, p_device uuid, p_token_hash text, p_ttl interval, p_idle interval
) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_restaurant uuid;
  v_expires timestamptz := now() + p_ttl;
begin
  if p_ttl <= interval '0' or p_ttl > interval '24 hours' then
    raise exception 'session length out of range';
  end if;
  if p_idle <= interval '0' or p_idle > p_ttl then
    raise exception 'idle timeout out of range';
  end if;
  select restaurant_id into v_restaurant from users where id = p_user and disabled_at is null;
  if v_restaurant is null then
    raise exception 'unknown or disabled user';
  end if;
  if p_method = 'pin' and not exists (
    select 1 from devices where id = p_device and restaurant_id = v_restaurant and revoked_at is null
  ) then
    raise exception 'tablet not valid for this restaurant';
  end if;
  insert into sessions (token_hash, user_id, restaurant_id, method, device_id, expires_at, idle_timeout)
  values (p_token_hash, p_user, v_restaurant, p_method, p_device, v_expires, p_idle);
  return v_expires;
end $$;

-- Who is behind this token? Also records activity, which keeps the session alive.
create function auth_resolve_session(p_token_hash text)
returns table (
  session_id uuid, user_id uuid, restaurant_id uuid, role text, full_name text,
  method text, expires_at timestamptz, two_step_enabled boolean
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Only write when the last recorded activity is over a minute old, to keep requests cheap.
  update sessions s set last_seen_at = now()
  where s.token_hash = p_token_hash and s.revoked_at is null
    and s.last_seen_at < now() - interval '1 minute'
    and s.last_seen_at + s.idle_timeout > now();

  return query
  select s.id, u.id, u.restaurant_id, u.role, u.full_name, s.method, s.expires_at,
         exists (select 1 from totp_factors t where t.user_id = u.id and t.confirmed_at is not null)
  from sessions s
  join users u on u.id = s.user_id and u.restaurant_id = s.restaurant_id
  left join devices d on d.id = s.device_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null and s.expires_at > now()
    and s.last_seen_at + s.idle_timeout > now()
    and u.disabled_at is null
    and (s.device_id is null or d.revoked_at is null);
end $$;

-- Functions used while acting for one restaurant (current_restaurant() is set) ------
create function auth_assert_member(p_user uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if current_restaurant() is null
     or not exists (select 1 from users where id = p_user and restaurant_id = current_restaurant()) then
    raise exception 'user not found in this restaurant';
  end if;
end $$;

create function auth_set_password(p_user uuid, p_email text, p_hash text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform auth_assert_member(p_user);
  insert into credentials (user_id, restaurant_id, email, password_hash)
  values (p_user, current_restaurant(), lower(p_email), p_hash)
  on conflict (user_id) do update
    set email = excluded.email, password_hash = excluded.password_hash, updated_at = now();
end $$;

create function auth_replace_password(p_user uuid, p_hash text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform auth_assert_member(p_user);
  update credentials set password_hash = p_hash, updated_at = now() where user_id = p_user;
  if not found then
    raise exception 'this person has no password login';
  end if;
end $$;

create function auth_current_password_hash(p_user uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform auth_assert_member(p_user);
  return (select password_hash from credentials where user_id = p_user);
end $$;

create function auth_set_pin(p_user uuid, p_hash text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if current_restaurant() is null
     or not exists (select 1 from users where id = p_user and restaurant_id = current_restaurant() and role = 'waiter') then
    raise exception 'waiter not found in this restaurant';
  end if;
  insert into pins (user_id, restaurant_id, pin_hash)
  values (p_user, current_restaurant(), p_hash)
  on conflict (user_id) do update set pin_hash = excluded.pin_hash, updated_at = now();
end $$;

-- Ends every session of a person, except (optionally) the one making the request.
create function auth_revoke_user_sessions(p_user uuid, p_keep_token_hash text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform auth_assert_member(p_user);
  update sessions set revoked_at = now()
  where user_id = p_user and revoked_at is null
    and (p_keep_token_hash is null or token_hash <> p_keep_token_hash);
  get diagnostics n = row_count;
  return n;
end $$;

-- Two-step setup: a secret is stored unconfirmed until the person types a first code.
create function auth_totp_begin(p_user uuid, p_secret_enc text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform auth_assert_member(p_user);
  if exists (select 1 from totp_factors where user_id = p_user and confirmed_at is not null) then
    raise exception 'two-step login is already on';
  end if;
  insert into totp_factors (user_id, restaurant_id, secret_enc)
  values (p_user, current_restaurant(), p_secret_enc)
  on conflict (user_id) do update set secret_enc = excluded.secret_enc, last_step = 0;
end $$;

create function auth_totp_secret(p_user uuid)
returns table (secret_enc text, confirmed boolean, last_step bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform auth_assert_member(p_user);
  return query select t.secret_enc, t.confirmed_at is not null, t.last_step from totp_factors t where t.user_id = p_user;
end $$;

create function auth_totp_confirm(p_user uuid, p_step bigint, p_recovery_hashes text[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform auth_assert_member(p_user);
  update totp_factors set confirmed_at = now(), last_step = p_step
  where user_id = p_user and confirmed_at is null;
  if not found then
    raise exception 'no two-step setup in progress';
  end if;
  delete from recovery_codes where user_id = p_user;
  insert into recovery_codes (user_id, restaurant_id, code_hash)
  select p_user, current_restaurant(), h from unnest(p_recovery_hashes) as h;
end $$;

create function auth_totp_disable(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform auth_assert_member(p_user);
  delete from recovery_codes where user_id = p_user;
  delete from totp_factors where user_id = p_user;
end $$;

-- Tablets ------------------------------------------------------------------------
create function auth_list_devices()
returns table (id uuid, name text, created_at timestamptz, revoked_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select d.id, d.name, d.created_at, d.revoked_at from devices d
  where d.restaurant_id = current_restaurant() order by d.created_at
$$;

create function auth_revoke_device(p_device uuid) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  with done as (
    update devices set revoked_at = now()
    where id = p_device and restaurant_id = current_restaurant() and revoked_at is null
    returning 1
  )
  select exists (select 1 from done)
$$;

-- Only the API's runtime role may call the auth_* functions -------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'auth\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to app_runtime', f.sig);
  end loop;
end $$;
