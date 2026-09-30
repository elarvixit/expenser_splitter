-- Splitter (Tharun Expense Splitter) — Supabase schema, "share by link" mode
--
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run: tables are created only if missing, functions are replaced.
-- Supabase will warn about "destructive operations": the only drops are of this app's own
-- three functions (so they can be updated), and the deletes run inside save, per group.
--
-- Everything this app owns is prefixed, so it can live in a shared team project:
--   tables     public.tharun_expense_splitter_*   (groups, members, expenses, expense_splits, settlements)
--   functions  public.splitter_create_group / splitter_get_group / splitter_save_group
-- Nothing else in the project is created, changed or dropped.
--
-- Security model
--   * A group is reached only through its secret token (a random UUID in the share link).
--   * The tables have Row Level Security on and NO policies, and anon/authenticated have no
--     table privileges, so the public anon/publishable key cannot read or write them directly.
--   * The browser calls three SECURITY DEFINER functions, each of which requires the token:
--       splitter_create_group(name)                 → token
--       splitter_get_group(token)                   → the group's transactions as JSON
--       splitter_save_group(token, version, group)  → new version (optimistic concurrency)
--   * Balances are never stored. The app recomputes them from these transactions.
--
-- To remove the app completely later:
--   drop function if exists public.splitter_create_group(text), public.splitter_get_group(uuid),
--                            public.splitter_save_group(uuid, integer, jsonb);
--   drop table if exists public.tharun_expense_splitter_settlements, public.tharun_expense_splitter_expense_splits,
--                        public.tharun_expense_splitter_expenses, public.tharun_expense_splitter_members,
--                        public.tharun_expense_splitter_groups;

-- ---------- tables ----------

create table if not exists public.tharun_expense_splitter_groups (
  id         uuid primary key default gen_random_uuid(),
  token      uuid not null unique default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 40),
  version    integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tharun_expense_splitter_members (
  group_id uuid not null references public.tharun_expense_splitter_groups on delete cascade,
  id       text not null,
  name     text not null check (char_length(name) between 1 and 24),
  position integer not null,
  primary key (group_id, id)
);
create unique index if not exists tharun_expense_splitter_members_unique_name
  on public.tharun_expense_splitter_members (group_id, lower(name));

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

-- Lock the tables: only the functions below can touch them.
alter table public.tharun_expense_splitter_groups         enable row level security;
alter table public.tharun_expense_splitter_members        enable row level security;
alter table public.tharun_expense_splitter_expenses       enable row level security;
alter table public.tharun_expense_splitter_expense_splits enable row level security;
alter table public.tharun_expense_splitter_settlements    enable row level security;
revoke all on public.tharun_expense_splitter_groups, public.tharun_expense_splitter_members,
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
    raise notice 'Copied existing Splitter data from schema "splitter". Once you have checked it, you can remove the old copy with: drop schema splitter cascade;';
  end if;
end $$;

-- ---------- functions (the only way the browser can reach the data) ----------

drop function if exists public.splitter_create_group(text);
drop function if exists public.splitter_get_group(uuid);
drop function if exists public.splitter_save_group(uuid, integer, jsonb);

-- Create an empty group and return its secret token.
create function public.splitter_create_group(p_name text)
returns uuid
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_token uuid;
begin
  insert into tharun_expense_splitter_groups (name)
  values (coalesce(nullif(left(trim(p_name), 40), ''), 'New group'))
  returning token into v_token;
  return v_token;
end $$;

-- Return a group's transactions in the shape the app uses, or null for an unknown token.
create function public.splitter_get_group(p_token uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_catalog as $$
  select jsonb_build_object(
    'groupName', g.name,
    'version',   g.version,
    'createdAt', g.created_at,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.position)
      from tharun_expense_splitter_members m where m.group_id = g.id), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'description', e.description, 'paidBy', e.paid_by, 'amount', e.amount,
               'splitMode', e.split_mode, 'splitInput', e.split_input, 'createdAt', e.created_at,
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
  where g.token = p_token
$$;

-- Replace a group's transactions atomically. p_version must match the stored version,
-- otherwise 'version_conflict' is raised and the app re-applies its change to fresh data.
create function public.splitter_save_group(p_token uuid, p_version integer, p_group jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  g_id      uuid;
  g_version integer;
  e         jsonb;
  v_sum     bigint;
  v_name    text := left(trim(coalesce(p_group->>'groupName', '')), 40);
  v_mem     jsonb := coalesce(p_group->'members', '[]'::jsonb);
  v_exp     jsonb := coalesce(p_group->'expenses', '[]'::jsonb);
  v_set     jsonb := coalesce(p_group->'settlements', '[]'::jsonb);
begin
  select id, version into g_id, g_version
  from tharun_expense_splitter_groups where token = p_token for update;
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
  delete from tharun_expense_splitter_settlements where group_id = g_id;
  delete from tharun_expense_splitter_expenses    where group_id = g_id;   -- cascades to expense_splits
  delete from tharun_expense_splitter_members     where group_id = g_id;

  insert into tharun_expense_splitter_members (group_id, id, name, position)
  select g_id, m->>'id', m->>'name', t.ord
  from jsonb_array_elements(v_mem) with ordinality as t(m, ord);

  insert into tharun_expense_splitter_expenses (group_id, id, description, paid_by, amount, split_mode, split_input, created_at)
  select g_id, x->>'id', coalesce(nullif(x->>'description', ''), 'Expense'), x->>'paidBy', (x->>'amount')::bigint,
         coalesce(x->>'splitMode', 'exact'), coalesce(x->'splitInput', '{}'::jsonb),
         coalesce((x->>'createdAt')::timestamptz, now())
  from jsonb_array_elements(v_exp) x;

  insert into tharun_expense_splitter_expense_splits (group_id, expense_id, member_id, amount)
  select g_id, x->>'id', s->>'memberId', (s->>'amount')::bigint
  from jsonb_array_elements(v_exp) x, jsonb_array_elements(coalesce(x->'splits', '[]'::jsonb)) s;

  insert into tharun_expense_splitter_settlements (group_id, id, from_member, to_member, amount, note, created_at)
  select g_id, x->>'id', x->>'from', x->>'to', (x->>'amount')::bigint, coalesce(x->>'note', ''),
         coalesce((x->>'createdAt')::timestamptz, now())
  from jsonb_array_elements(v_set) x;

  update tharun_expense_splitter_groups
  set name = coalesce(nullif(v_name, ''), name), version = version + 1, updated_at = now()
  where id = g_id
  returning version into g_version;

  return g_version;
end $$;

revoke execute on function public.splitter_create_group(text), public.splitter_get_group(uuid),
                            public.splitter_save_group(uuid, integer, jsonb) from public;
grant  execute on function public.splitter_create_group(text), public.splitter_get_group(uuid),
                            public.splitter_save_group(uuid, integer, jsonb) to anon, authenticated;
