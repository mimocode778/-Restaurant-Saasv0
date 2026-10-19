-- Login and sessions ------------------------------------------------------
-- Secrets (password hashes, PIN hashes, session and tablet tokens) live in tables the
-- runtime role cannot read at all. The API reaches them only through the small
-- functions below, which each do one narrow thing.
--
-- These functions are "security definer": they run with the rights of the role that
-- runs this migration. That role must own the tables and bypass row-level security
-- (true for the default Docker user). Login happens before we know the restaurant,
-- so these functions have to see across restaurants, carefully.

-- The login email moves out of users (which the runtime role can read) into credentials.
alter table users drop column email;
alter table users add column disabled_at timestamptz;
alter table users add constraint users_id_restaurant unique (id, restaurant_id);

create table credentials (
  user_id uuid primary key,
  restaurant_id uuid not null,
  email text not null unique check (email = lower(email) and position('@' in email) > 1),
  password_hash text not null,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (user_id, restaurant_id) references users (id, restaurant_id)
);

create table pins (
  user_id uuid primary key,
  restaurant_id uuid not null,
  pin_hash text not null,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (user_id, restaurant_id) references users (id, restaurant_id)
);

-- A tablet paired by a manager. Waiters can only use a PIN on a paired tablet.
create table devices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  name text not null,
  token_hash text not null unique,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (created_by, restaurant_id) references users (id, restaurant_id)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null,
  restaurant_id uuid not null,
  method text not null check (method in ('password', 'pin')),
  device_id uuid references devices(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (user_id, restaurant_id) references users (id, restaurant_id),
  check ((method = 'pin') = (device_id is not null))
);
create index on sessions (user_id);

revoke all on credentials, pins, devices, sessions from public;
revoke all on credentials, pins, devices, sessions from app_runtime;

-- Login with email + password ----------------------------------------------
-- Locks the row until the end of the transaction, so parallel guesses are counted one by one.
create function auth_password_candidate(p_email text)
returns table (user_id uuid, password_hash text, locked_until timestamptz)
language sql security definer set search_path = public, pg_temp as $$
  select c.user_id, c.password_hash, c.locked_until
  from credentials c
  join users u on u.id = c.user_id and u.restaurant_id = c.restaurant_id
  where c.email = lower(p_email) and u.disabled_at is null
  for update of c
$$;

-- Login with a PIN on a paired tablet (waiters only) -------------------------
create function auth_pin_candidate(p_device_token_hash text, p_user uuid)
returns table (user_id uuid, device_id uuid, pin_hash text, locked_until timestamptz)
language sql security definer set search_path = public, pg_temp as $$
  select p.user_id, d.id, p.pin_hash, p.locked_until
  from devices d
  join users u on u.restaurant_id = d.restaurant_id and u.id = p_user
  join pins p on p.user_id = u.id and p.restaurant_id = u.restaurant_id
  where d.token_hash = p_device_token_hash and d.revoked_at is null
    and u.role = 'waiter' and u.disabled_at is null
  for update of p
$$;

-- After 5 wrong tries in a row, the account is blocked for 15 minutes, then gets 5 new tries.
create function auth_record_failure(p_method text, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_method = 'password' then
    update credentials set
      locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end,
      failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
      updated_at = now()
    where user_id = p_user;
  elsif p_method = 'pin' then
    update pins set
      locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end,
      failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
      updated_at = now()
    where user_id = p_user;
  else
    raise exception 'unknown login method %', p_method;
  end if;
end $$;

-- Called only after the API has checked the password or PIN.
create function auth_start_session(p_user uuid, p_method text, p_device uuid, p_token_hash text, p_ttl interval)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_restaurant uuid;
  v_expires timestamptz := now() + p_ttl;
begin
  if p_ttl <= interval '0' or p_ttl > interval '24 hours' then
    raise exception 'session length out of range';
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
  if p_method = 'password' then
    update credentials set failed_attempts = 0, locked_until = null where user_id = p_user;
  else
    update pins set failed_attempts = 0, locked_until = null where user_id = p_user;
  end if;
  insert into sessions (token_hash, user_id, restaurant_id, method, device_id, expires_at)
  values (p_token_hash, p_user, v_restaurant, p_method, p_device, v_expires);
  return v_expires;
end $$;

-- Who is behind this session token? Reads the role live, so a role change applies at once.
create function auth_resolve_session(p_token_hash text)
returns table (user_id uuid, restaurant_id uuid, role text, full_name text, expires_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id, u.restaurant_id, u.role, u.full_name, s.expires_at
  from sessions s
  join users u on u.id = s.user_id and u.restaurant_id = s.restaurant_id
  left join devices d on d.id = s.device_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null and s.expires_at > now()
    and u.disabled_at is null
    and (s.device_id is null or d.revoked_at is null)
$$;

create function auth_end_session(p_token_hash text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update sessions set revoked_at = now() where token_hash = p_token_hash and revoked_at is null
$$;

-- Waiters to show on a paired tablet's login screen.
create function auth_device_staff(p_device_token_hash text)
returns table (user_id uuid, full_name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id, u.full_name
  from devices d
  join users u on u.restaurant_id = d.restaurant_id
  join pins p on p.user_id = u.id
  where d.token_hash = p_device_token_hash and d.revoked_at is null
    and u.role = 'waiter' and u.disabled_at is null
  order by u.full_name
$$;

-- Functions used while acting for one restaurant (current_restaurant() is set) ------
create function auth_set_password(p_user uuid, p_email text, p_hash text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from users where id = p_user and restaurant_id = current_restaurant()) then
    raise exception 'user not found in this restaurant';
  end if;
  insert into credentials (user_id, restaurant_id, email, password_hash)
  values (p_user, current_restaurant(), lower(p_email), p_hash)
  on conflict (user_id) do update
    set email = excluded.email, password_hash = excluded.password_hash,
        failed_attempts = 0, locked_until = null, updated_at = now();
end $$;

create function auth_set_pin(p_user uuid, p_hash text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from users where id = p_user and restaurant_id = current_restaurant() and role = 'waiter') then
    raise exception 'waiter not found in this restaurant';
  end if;
  insert into pins (user_id, restaurant_id, pin_hash)
  values (p_user, current_restaurant(), p_hash)
  on conflict (user_id) do update
    set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
end $$;

create function auth_register_device(p_name text, p_token_hash text, p_created_by uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if current_restaurant() is null then
    raise exception 'no restaurant selected';
  end if;
  insert into devices (restaurant_id, name, token_hash, created_by)
  values (current_restaurant(), p_name, p_token_hash, p_created_by)
  returning id into v_id;
  return v_id;
end $$;

-- Only the API's runtime role may call these.
revoke all on function auth_password_candidate(text), auth_pin_candidate(text, uuid),
  auth_record_failure(text, uuid), auth_start_session(uuid, text, uuid, text, interval),
  auth_resolve_session(text), auth_end_session(text), auth_device_staff(text),
  auth_set_password(uuid, text, text), auth_set_pin(uuid, text),
  auth_register_device(text, text, uuid) from public;
grant execute on function auth_password_candidate(text), auth_pin_candidate(text, uuid),
  auth_record_failure(text, uuid), auth_start_session(uuid, text, uuid, text, interval),
  auth_resolve_session(text), auth_end_session(text), auth_device_staff(text),
  auth_set_password(uuid, text, text), auth_set_pin(uuid, text),
  auth_register_device(text, text, uuid) to app_runtime;
