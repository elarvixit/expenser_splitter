-- Splitter (Tharun Expense Splitter) — Supabase schema: private groups with Splitter's own accounts
--
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run: tables/columns are added only if missing, functions are replaced, data is kept.
-- Supabase will warn about "destructive operations": the only drops are of this app's own
-- functions (so they can be updated), and the deletes inside functions touch one group or session.
--
-- Everything this app owns is prefixed, so it can live in a shared team project:
--   tables     public.tharun_expense_splitter_*   (users, sessions, groups, members, expenses,
--                                                  expense_splits, settlements)
--   functions  public.splitter_*
-- Nothing else in the project is created, changed or dropped. In particular Splitter does NOT use
-- Supabase Auth: its accounts live in tharun_expense_splitter_users, separate from the team's users.
--
-- Security model
--   * Accounts: email + password. Passwords are stored only as bcrypt hashes (pgcrypto). Five wrong
--     passwords lock the account for 15 minutes.
--   * Signing in returns a random session token (valid 30 days). Only its SHA-256 hash is stored.
--   * Every group has an owner. Each function takes the session token and only ever touches groups
--     owned by that account, so each user sees only their own groups.
--   * The tables have Row Level Security on and NO policies, and anon/authenticated have no table
--     privileges, so the public anon/publishable key cannot read or write them directly.
--   * Balances are never stored. The app recomputes them from these transactions.
--
-- Reset a forgotten password (run in the SQL Editor; signs the user out everywhere):
--   update tharun_expense_splitter_users
--   set password_hash = extensions.crypt('NEW-PASSWORD-HERE', extensions.gen_salt('bf', 10)),
--       failed_attempts = 0, locked_until = null
--   where email = lower('person@example.com');
--   delete from tharun_expense_splitter_sessions
--   where user_id = (select id from tharun_expense_splitter_users where email = lower('person@example.com'));
--
-- To remove the app completely later:
--   drop function if exists public.splitter_sign_up(text, text), public.splitter_sign_in(text, text),
--     public.splitter_sign_out(text), public.splitter_whoami(text), public.splitter_change_password(text, text, text),
--     public.splitter_list_groups(text), public.splitter_account_create_group(text, text),
--     public.splitter_account_get_group(text, uuid), public.splitter_account_save_group(text, uuid, integer, jsonb),
--     public.splitter_account_delete_group(text, uuid), public.splitter_account_claim_group(text, uuid),
--     public.splitter__session_user(text), public.splitter__new_session(uuid), public.splitter__group_json(uuid),
--     public.splitter__save(uuid, integer, jsonb);
--   drop table if exists public.tharun_expense_splitter_settlements, public.tharun_expense_splitter_expense_splits,
--     public.tharun_expense_splitter_expenses, public.tharun_expense_splitter_members,
--     public.tharun_expense_splitter_groups, public.tharun_expense_splitter_sessions,
--     public.tharun_expense_splitter_users;

create extension if not exists pgcrypto with schema extensions;

-- ---------- accounts ----------

create table if not exists public.tharun_expense_splitter_users (
  id              uuid primary key default gen_random_uuid(),
  email           text not null unique check (email = lower(email) and char_length(email) between 3 and 254),
  password_hash   text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists public.tharun_expense_splitter_sessions (
  token_hash   text primary key,                                   -- sha256 of the token the browser holds
  user_id      uuid not null references public.tharun_expense_splitter_users on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_used_at timestamptz not null default now()
);
create index if not exists tharun_expense_splitter_sessions_user on public.tharun_expense_splitter_sessions (user_id);

-- ---------- groups and transactions ----------

create table if not exists public.tharun_expense_splitter_groups (
  id         uuid primary key default gen_random_uuid(),
  token      uuid not null unique default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 40),
  version    integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tharun_expense_splitter_groups
  add column if not exists owner_id uuid references public.tharun_expense_splitter_users on delete cascade;
create index if not exists tharun_expense_splitter_groups_owner on public.tharun_expense_splitter_groups (owner_id);

create table if not exists public.tharun_expense_splitter_members (
  group_id uuid not null references public.tharun_expense_splitter_groups on delete cascade,
  id       text not null,
  name     text not null check (char_length(name) between 1 and 24),
  position integer not null,
  primary key (group_id, id)
);
create unique index if not exists tharun_expense_splitter_members_unique_name
  on public.tharun_expense_splitter_members (group_id, lower(name));
-- Optional picture: a short emoji, or a small image as a base64 data URL (the app shrinks photos to 96×96).
alter table public.tharun_expense_splitter_members
  add column if not exists avatar text check (
    avatar is null
    or (char_length(avatar) <= 16 and avatar !~ '[<>&"''[:space:]]')
    or (char_length(avatar) <= 16000 and avatar ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$')
  );

create table if not exists public.tharun_expense_splitter_expenses (
  group_id    uuid not null references public.tharun_expense_splitter_groups on delete cascade,
  id          text not null,
  description text not null check (char_length(description) between 1 and 60),
  paid_by     text not null,
  amount      bigint not null check (amount > 0),                       -- paise
  split_mode  text not null check (split_mode in ('equal', 'exact', 'percent')),
  split_input jsonb not null default '{}'::jsonb,                        -- what the user typed (for editing)
  created_at  timestamptz not null,
  primary key (group_id, id),
  foreign key (group_id, paid_by) references public.tharun_expense_splitter_members (group_id, id) on delete cascade
);
alter table public.tharun_expense_splitter_expenses
  add column if not exists category text check (category is null or char_length(category) between 1 and 24);

create table if not exists public.tharun_expense_splitter_expense_splits (
  group_id   uuid not null,
  expense_id text not null,
  member_id  text not null,
  amount     bigint not null check (amount >= 0),                        -- paise
  primary key (group_id, expense_id, member_id),
  foreign key (group_id, expense_id) references public.tharun_expense_splitter_expenses (group_id, id) on delete cascade,
  foreign key (group_id, member_id) references public.tharun_expense_splitter_members (group_id, id) on delete cascade
);

create table if not exists public.tharun_expense_splitter_settlements (
  group_id    uuid not null references public.tharun_expense_splitter_groups on delete cascade,
  id          text not null,
  from_member text not null,
  to_member   text not null,
  amount      bigint not null check (amount > 0),                        -- paise
  note        text not null default '' check (char_length(note) <= 40),
  created_at  timestamptz not null,
  primary key (group_id, id),
  check (from_member <> to_member),
  foreign key (group_id, from_member) references public.tharun_expense_splitter_members (group_id, id) on delete cascade,
  foreign key (group_id, to_member) references public.tharun_expense_splitter_members (group_id, id) on delete cascade
);

-- Lock every table: only the functions below can touch them.
alter table public.tharun_expense_splitter_users          enable row level security;
alter table public.tharun_expense_splitter_sessions       enable row level security;
alter table public.tharun_expense_splitter_groups         enable row level security;
alter table public.tharun_expense_splitter_members        enable row level security;
alter table public.tharun_expense_splitter_expenses       enable row level security;
alter table public.tharun_expense_splitter_expense_splits enable row level security;
alter table public.tharun_expense_splitter_settlements    enable row level security;
revoke all on public.tharun_expense_splitter_users, public.tharun_expense_splitter_sessions,
              public.tharun_expense_splitter_groups, public.tharun_expense_splitter_members,
              public.tharun_expense_splitter_expenses, public.tharun_expense_splitter_expense_splits,
              public.tharun_expense_splitter_settlements
  from anon, authenticated;

-- ---------- carry over data from the first version (tables in the "splitter" schema) ----------

do $$
begin
  if to_regclass('splitter.groups') is not null then
    insert into public.tharun_expense_splitter_groups (id, token, name, version, created_at, updated_at)
      select id, token, name, version, created_at, updated_at from splitter.groups
      on conflict do nothing;
    insert into public.tharun_expense_splitter_members (group_id, id, name, position)
      select group_id, id, name, position from splitter.members
      on conflict do nothing;
    insert into public.tharun_expense_splitter_expenses (group_id, id, description, paid_by, amount, split_mode, split_input, created_at)
      select group_id, id, description, paid_by, amount, split_mode, split_input, created_at from splitter.expenses
      on conflict do nothing;
    insert into public.tharun_expense_splitter_expense_splits (group_id, expense_id, member_id, amount)
      select group_id, expense_id, member_id, amount from splitter.expense_splits
      on conflict do nothing;
    insert into public.tharun_expense_splitter_settlements (group_id, id, from_member, to_member, amount, note, created_at)
      select group_id, id, from_member, to_member, amount, note, created_at from splitter.settlements
      on conflict do nothing;
  end if;
end $$;

-- ---------- functions ----------

-- The earlier share-by-link functions are replaced by the account ones below: groups are private now.
drop function if exists public.splitter_create_group(text);
drop function if exists public.splitter_get_group(uuid);
drop function if exists public.splitter_save_group(uuid, integer, jsonb);

drop function if exists public.splitter_sign_up(text, text);
drop function if exists public.splitter_sign_in(text, text);
drop function if exists public.splitter_sign_out(text);
drop function if exists public.splitter_whoami(text);
drop function if exists public.splitter_change_password(text, text, text);
drop function if exists public.splitter_list_groups(text);
drop function if exists public.splitter_account_create_group(text, text);
drop function if exists public.splitter_account_get_group(text, uuid);
drop function if exists public.splitter_account_save_group(text, uuid, integer, jsonb);
drop function if exists public.splitter_account_delete_group(text, uuid);
drop function if exists public.splitter_account_claim_group(text, uuid);
drop function if exists public.splitter__session_user(text);
drop function if exists public.splitter__group_json(uuid);
drop function if exists public.splitter__save(uuid, integer, jsonb);

-- Internal: account id for a valid session token, or error 'not_signed_in'.
create function public.splitter__session_user(p_session text)
returns uuid
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_user uuid;
begin
  update tharun_expense_splitter_sessions
  set last_used_at = now()
  where token_hash = encode(digest(coalesce(p_session, ''), 'sha256'), 'hex') and expires_at > now()
  returning user_id into v_user;
  if v_user is null then
    raise exception 'not_signed_in';
  end if;
  return v_user;
end $$;

-- Internal: create a session for a user and return {session, email}.
create or replace function public.splitter__new_session(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_token text := encode(gen_random_bytes(32), 'hex');
begin
  delete from tharun_expense_splitter_sessions where user_id = p_user and expires_at <= now();
  insert into tharun_expense_splitter_sessions (token_hash, user_id, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), p_user, now() + interval '30 days');
  return jsonb_build_object('session', v_token,
                            'email', (select email from tharun_expense_splitter_users where id = p_user));
end $$;

-- Create an account. Returns {session, email} or {error: 'invalid_email' | 'weak_password' | 'email_taken'}.
create function public.splitter_sign_up(p_email text, p_password text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_user  uuid;
begin
  if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('error', 'invalid_email');
  end if;
  if char_length(coalesce(p_password, '')) < 8 or octet_length(p_password) > 72 then
    return jsonb_build_object('error', 'weak_password');
  end if;
  insert into tharun_expense_splitter_users (email, password_hash)
  values (v_email, crypt(p_password, gen_salt('bf', 10)))
  on conflict (email) do nothing
  returning id into v_user;
  if v_user is null then
    return jsonb_build_object('error', 'email_taken');
  end if;
  return splitter__new_session(v_user);
end $$;

-- Sign in. Returns {session, email} or {error: 'invalid_credentials' | 'account_locked'}.
-- Errors are returned (not raised) so the failed-attempt counter is saved.
create function public.splitter_sign_in(p_email text, p_password text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  u tharun_expense_splitter_users;
begin
  select * into u from tharun_expense_splitter_users where email = lower(trim(coalesce(p_email, ''))) for update;
  if not found then
    perform crypt(coalesce(p_password, ''), gen_salt('bf', 10)); -- same work as a real check
    return jsonb_build_object('error', 'invalid_credentials');
  end if;
  if u.locked_until is not null and u.locked_until > now() then
    return jsonb_build_object('error', 'account_locked', 'retryAfter', u.locked_until);
  end if;
  if u.password_hash <> crypt(coalesce(p_password, ''), u.password_hash) then
    update tharun_expense_splitter_users
    set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
        locked_until    = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
    where id = u.id;
    return jsonb_build_object('error', 'invalid_credentials');
  end if;
  update tharun_expense_splitter_users set failed_attempts = 0, locked_until = null where id = u.id;
  return splitter__new_session(u.id);
end $$;

create function public.splitter_sign_out(p_session text)
returns void
language sql security definer set search_path = public, extensions, pg_catalog as $$
  delete from tharun_expense_splitter_sessions where token_hash = encode(digest(coalesce(p_session, ''), 'sha256'), 'hex');
$$;

create function public.splitter_whoami(p_session text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
begin
  return jsonb_build_object('email', (select email from tharun_expense_splitter_users where id = splitter__session_user(p_session)));
end $$;

-- Change password (signs out every other device). Returns {ok} or {error: 'invalid_credentials' | 'weak_password'}.
create function public.splitter_change_password(p_session text, p_old text, p_new text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_user uuid := splitter__session_user(p_session);
  v_hash text;
begin
  select password_hash into v_hash from tharun_expense_splitter_users where id = v_user;
  if v_hash <> crypt(coalesce(p_old, ''), v_hash) then
    return jsonb_build_object('error', 'invalid_credentials');
  end if;
  if char_length(coalesce(p_new, '')) < 8 or octet_length(p_new) > 72 then
    return jsonb_build_object('error', 'weak_password');
  end if;
  update tharun_expense_splitter_users set password_hash = crypt(p_new, gen_salt('bf', 10)) where id = v_user;
  delete from tharun_expense_splitter_sessions
  where user_id = v_user and token_hash <> encode(digest(p_session, 'sha256'), 'hex');
  return jsonb_build_object('ok', true);
end $$;

-- Internal: a group's transactions in the shape the app uses.
create function public.splitter__group_json(p_group uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_catalog as $$
  select jsonb_build_object(
    'groupName', g.name,
    'version',   g.version,
    'createdAt', g.created_at,
    'members', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', m.id, 'name', m.name, 'avatar', m.avatar)) order by m.position)
      from tharun_expense_splitter_members m where m.group_id = g.id), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'description', e.description, 'category', e.category, 'paidBy', e.paid_by,
               'amount', e.amount, 'splitMode', e.split_mode, 'splitInput', e.split_input, 'createdAt', e.created_at,
               'splits', coalesce((
                 select jsonb_agg(jsonb_build_object('memberId', s.member_id, 'amount', s.amount) order by m.position)
                 from tharun_expense_splitter_expense_splits s
                 join tharun_expense_splitter_members m on m.group_id = s.group_id and m.id = s.member_id
                 where s.group_id = g.id and s.expense_id = e.id), '[]'::jsonb))
             order by e.created_at, e.id)
      from tharun_expense_splitter_expenses e where e.group_id = g.id), '[]'::jsonb),
    'settlements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'from', t.from_member, 'to', t.to_member, 'amount', t.amount,
               'note', t.note, 'createdAt', t.created_at)
             order by t.created_at, t.id)
      from tharun_expense_splitter_settlements t where t.group_id = g.id), '[]'::jsonb)
  )
  from tharun_expense_splitter_groups g
  where g.id = p_group
$$;

-- Internal: replace a group's transactions atomically. p_version must match the stored version,
-- otherwise 'version_conflict' is raised and the app re-applies its change to fresh data.
create function public.splitter__save(p_group uuid, p_version integer, p_body jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  g_version integer;
  e         jsonb;
  v_sum     bigint;
  v_name    text := left(trim(coalesce(p_body->>'groupName', '')), 40);
  v_mem     jsonb := coalesce(p_body->'members', '[]'::jsonb);
  v_exp     jsonb := coalesce(p_body->'expenses', '[]'::jsonb);
  v_set     jsonb := coalesce(p_body->'settlements', '[]'::jsonb);
begin
  select version into g_version from tharun_expense_splitter_groups where id = p_group for update;
  if not found then
    raise exception 'group_not_found';
  end if;
  if g_version <> p_version then
    raise exception 'version_conflict';
  end if;
  if jsonb_array_length(v_mem) > 50 or jsonb_array_length(v_exp) > 5000 or jsonb_array_length(v_set) > 5000 then
    raise exception 'group_too_large';
  end if;

  -- Every expense's splits must add up exactly to its amount (integer paise).
  for e in select * from jsonb_array_elements(v_exp) loop
    select coalesce(sum((s->>'amount')::bigint), 0) into v_sum
    from jsonb_array_elements(coalesce(e->'splits', '[]'::jsonb)) s;
    if v_sum <> (e->>'amount')::bigint then
      raise exception 'splits_mismatch: expense %', e->>'id';
    end if;
  end loop;

  -- Replace this one group's rows (nothing outside this group is touched).
  delete from tharun_expense_splitter_settlements where group_id = p_group;
  delete from tharun_expense_splitter_expenses    where group_id = p_group;   -- cascades to expense_splits
  delete from tharun_expense_splitter_members     where group_id = p_group;

  insert into tharun_expense_splitter_members (group_id, id, name, position, avatar)
  select p_group, m->>'id', m->>'name', t.ord, nullif(m->>'avatar', '')
  from jsonb_array_elements(v_mem) with ordinality as t(m, ord);

  insert into tharun_expense_splitter_expenses (group_id, id, description, category, paid_by, amount, split_mode, split_input, created_at)
  select p_group, x->>'id', coalesce(nullif(x->>'description', ''), 'Expense'), nullif(trim(x->>'category'), ''),
         x->>'paidBy', (x->>'amount')::bigint, coalesce(x->>'splitMode', 'exact'), coalesce(x->'splitInput', '{}'::jsonb),
         coalesce((x->>'createdAt')::timestamptz, now())
  from jsonb_array_elements(v_exp) x;

  insert into tharun_expense_splitter_expense_splits (group_id, expense_id, member_id, amount)
  select p_group, x->>'id', s->>'memberId', (s->>'amount')::bigint
  from jsonb_array_elements(v_exp) x, jsonb_array_elements(coalesce(x->'splits', '[]'::jsonb)) s;

  insert into tharun_expense_splitter_settlements (group_id, id, from_member, to_member, amount, note, created_at)
  select p_group, x->>'id', x->>'from', x->>'to', (x->>'amount')::bigint, coalesce(x->>'note', ''),
         coalesce((x->>'createdAt')::timestamptz, now())
  from jsonb_array_elements(v_set) x;

  update tharun_expense_splitter_groups
  set name = coalesce(nullif(v_name, ''), name), version = version + 1, updated_at = now()
  where id = p_group
  returning version into g_version;

  return g_version;
end $$;

-- The signed-in account's groups (summary only; the app fetches each group's data separately).
create function public.splitter_list_groups(p_session text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_user uuid := splitter__session_user(p_session);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('token', token, 'name', name, 'version', version, 'updatedAt', updated_at)
                     order by created_at)
    from tharun_expense_splitter_groups where owner_id = v_user), '[]'::jsonb);
end $$;

create function public.splitter_account_create_group(p_session text, p_name text)
returns uuid
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_user  uuid := splitter__session_user(p_session);
  v_token uuid;
begin
  if (select count(*) from tharun_expense_splitter_groups where owner_id = v_user) >= 200 then
    raise exception 'too_many_groups';
  end if;
  insert into tharun_expense_splitter_groups (name, owner_id)
  values (coalesce(nullif(left(trim(p_name), 40), ''), 'New group'), v_user)
  returning token into v_token;
  return v_token;
end $$;

-- A group owned by this account, or null (unknown token, or someone else's group).
create function public.splitter_account_get_group(p_session text, p_token uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_user uuid := splitter__session_user(p_session);
begin
  return (select splitter__group_json(id) from tharun_expense_splitter_groups
          where token = p_token and owner_id = v_user);
end $$;

create function public.splitter_account_save_group(p_session text, p_token uuid, p_version integer, p_group jsonb)
returns integer
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_user uuid := splitter__session_user(p_session);
  v_id   uuid;
begin
  select id into v_id from tharun_expense_splitter_groups where token = p_token and owner_id = v_user;
  if v_id is null then
    raise exception 'group_not_found';
  end if;
  return splitter__save(v_id, p_version, p_group);
end $$;

create function public.splitter_account_delete_group(p_session text, p_token uuid)
returns boolean
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_user uuid := splitter__session_user(p_session);
begin
  delete from tharun_expense_splitter_groups where token = p_token and owner_id = v_user;
  return found;
end $$;

-- Move a group made before accounts existed (no owner yet) into this account.
-- Returns true if the group is now owned by this account.
create function public.splitter_account_claim_group(p_session text, p_token uuid)
returns boolean
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_user uuid := splitter__session_user(p_session);
begin
  update tharun_expense_splitter_groups set owner_id = v_user where token = p_token and owner_id is null;
  return exists (select 1 from tharun_expense_splitter_groups where token = p_token and owner_id = v_user);
end $$;

-- Internal helpers are callable only from the functions above.
revoke execute on function public.splitter__session_user(text), public.splitter__new_session(uuid),
  public.splitter__group_json(uuid), public.splitter__save(uuid, integer, jsonb)
  from public, anon, authenticated;

revoke execute on function public.splitter_sign_up(text, text), public.splitter_sign_in(text, text),
  public.splitter_sign_out(text), public.splitter_whoami(text), public.splitter_change_password(text, text, text),
  public.splitter_list_groups(text), public.splitter_account_create_group(text, text),
  public.splitter_account_get_group(text, uuid), public.splitter_account_save_group(text, uuid, integer, jsonb),
  public.splitter_account_delete_group(text, uuid), public.splitter_account_claim_group(text, uuid)
  from public;
grant execute on function public.splitter_sign_up(text, text), public.splitter_sign_in(text, text),
  public.splitter_sign_out(text), public.splitter_whoami(text), public.splitter_change_password(text, text, text),
  public.splitter_list_groups(text), public.splitter_account_create_group(text, text),
  public.splitter_account_get_group(text, uuid), public.splitter_account_save_group(text, uuid, integer, jsonb),
  public.splitter_account_delete_group(text, uuid), public.splitter_account_claim_group(text, uuid)
  to anon, authenticated;
