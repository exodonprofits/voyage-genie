-- Voyage Genie: core schema in the GenieSphere project.
-- Group trips with members, expenses and settlements as rows, so several people
-- can add to the same trip at once. Every table is prefixed vg_ and protected by
-- row-level security; helpers follow GenieSphere's is_household_member pattern.
--
-- Money rule kept from the cost tracker: an expense's split is
--   { "<member id>": true | <heads> }   true = the member's whole party,
--   a number = that many heads (capped at the party size when computed),
--   {} = nobody. The split maths stays in the browser.

begin;

-- ── updated_at helper ─────────────────────────────────────────────
create or replace function public.vg_touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── Profiles (replaces the Salon project's user_preferences use) ──
create table public.vg_profiles (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  full_name        text check (full_name is null or char_length(full_name) <= 120),
  home_airport     text check (home_airport is null or home_airport ~ '^[A-Z]{3}$'),
  default_currency text not null default 'USD' check (default_currency ~ '^[A-Z]{3}$'),
  pay_handles      jsonb not null default '{}'::jsonb check (jsonb_typeof(pay_handles) = 'object'),
  created_via      text check (created_via is null or char_length(created_via) <= 60),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ── AI plans from the planners (replaces user_trips) ──────────────
create table public.vg_plans (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references auth.users(id) on delete cascade,  -- null only for unclaimed imports
  name               text not null default '' check (char_length(name) <= 200),
  plan_data          jsonb not null default '{}'::jsonb check (jsonb_typeof(plan_data) = 'object'),
  legacy_id          uuid unique,
  legacy_owner_email text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (user_id is not null or legacy_owner_email is not null)
);
create index vg_plans_user_idx on public.vg_plans (user_id, updated_at desc);

-- ── Trips ─────────────────────────────────────────────────────────
create table public.vg_trips (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid references auth.users(id) on delete set null,  -- null only for unclaimed imports
  name               text not null default '' check (char_length(name) <= 200),
  destination        text check (destination is null or char_length(destination) <= 120),
  start_date         date,
  end_date           date,
  currency           text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  settings           jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),  -- owner-only: sponsor rules, settle options
  plan_id            uuid references public.vg_plans(id) on delete set null,
  legacy_id          uuid unique,
  legacy_owner_email text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index vg_trips_owner_idx on public.vg_trips (owner_id);

-- ── Members: everyone in the split, with or without an account ───
create table public.vg_trip_members (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references public.vg_trips(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete set null,     -- null = name-only member, not joined
  display_name    text not null check (char_length(btrim(display_name)) between 1 and 60),
  email           text check (email is null or char_length(email) <= 254),
  role            text not null default 'editor' check (role in ('owner', 'editor', 'viewer')),
  in_split        boolean not null default true,      -- false = organizer who isn't sharing costs
  household_size  integer not null default 1 check (household_size between 1 and 50),
  payer_member_id uuid,                               -- who settles for this member (the tracker's "payer")
  pay_handles     jsonb not null default '{}'::jsonb check (jsonb_typeof(pay_handles) = 'object'),
  joined_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (trip_id, id),
  foreign key (trip_id, payer_member_id) references public.vg_trip_members (trip_id, id) on delete set null (payer_member_id)
);
create unique index vg_trip_members_user_uq on public.vg_trip_members (trip_id, user_id) where user_id is not null;
create unique index vg_trip_members_name_uq on public.vg_trip_members (trip_id, lower(btrim(display_name)));
create unique index vg_trip_members_one_owner on public.vg_trip_members (trip_id) where role = 'owner';
create index vg_trip_members_user_idx on public.vg_trip_members (user_id) where user_id is not null;

-- ── Expenses ──────────────────────────────────────────────────────
create table public.vg_trip_expenses (
  id                uuid primary key default gen_random_uuid(),
  trip_id           uuid not null references public.vg_trips(id) on delete cascade,
  kind              text not null default 'expense' check (kind in ('expense', 'budget_transfer')),
  paid_by_member_id uuid not null,
  amount            numeric(12, 2) not null check (amount > -10000000 and amount < 10000000),  -- negative = refund
  currency          text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  spent_on          date,
  category          text check (category is null or char_length(category) <= 60),
  description       text check (description is null or char_length(description) <= 300),
  split             jsonb not null default '{}'::jsonb check (jsonb_typeof(split) = 'object'),
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (trip_id, paid_by_member_id) references public.vg_trip_members (trip_id, id) on delete restrict
);
create index vg_trip_expenses_trip_idx on public.vg_trip_expenses (trip_id, spent_on);

-- ── Settlements: one row per payment actually made ───────────────
create table public.vg_trip_settlements (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references public.vg_trips(id) on delete cascade,
  from_member_id uuid not null,
  to_member_id   uuid not null,
  amount_cents   bigint not null check (amount_cents > 0 and amount_cents < 1000000000),
  currency       text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  method         text check (method is null or method in ('venmo', 'paypal', 'cashapp', 'zelle', 'cash', 'other')),
  note           text check (note is null or char_length(note) <= 200),
  marked_by      uuid references auth.users(id) on delete set null,
  marked_at      timestamptz not null default now(),
  confirmed_by   uuid references auth.users(id) on delete set null,
  confirmed_at   timestamptz,
  created_at     timestamptz not null default now(),
  check (from_member_id <> to_member_id),
  foreign key (trip_id, from_member_id) references public.vg_trip_members (trip_id, id) on delete cascade,
  foreign key (trip_id, to_member_id)   references public.vg_trip_members (trip_id, id) on delete cascade
);
create index vg_trip_settlements_trip_idx on public.vg_trip_settlements (trip_id);

-- ── Invite links and read-only share links (tokens stored hashed) ─
create table public.vg_trip_invites (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.vg_trips(id) on delete cascade,
  token_hash text not null unique,
  role       text not null default 'editor' check (role in ('editor', 'viewer')),
  max_uses   integer not null default 20 check (max_uses between 1 and 200),
  uses       integer not null default 0 check (uses >= 0),
  expires_at timestamptz not null default now() + interval '14 days',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index vg_trip_invites_trip_idx on public.vg_trip_invites (trip_id);

create table public.vg_trip_shares (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.vg_trips(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null default now() + interval '48 hours',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index vg_trip_shares_trip_idx on public.vg_trip_shares (trip_id);

-- ── Planner search history and contact messages ───────────────────
create table public.vg_search_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  destination text check (destination is null or char_length(destination) <= 200),
  departure   text check (departure is null or char_length(departure) <= 200),
  search_data jsonb not null default '{}'::jsonb,
  searched_at timestamptz not null default now(),
  unique nulls not distinct (user_id, destination, departure)
);

create table public.vg_contact_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  name       text not null check (char_length(btrim(name)) between 1 and 120),
  email      text not null check (char_length(email) between 3 and 254 and email like '%@%'),
  subject    text check (subject is null or char_length(subject) <= 200),
  message    text not null check (char_length(btrim(message)) between 1 and 5000),
  created_at timestamptz not null default now()
);

-- ── Access helpers (security definer: they read members without
--    tripping the members table's own policies) ─────────────────────
create or replace function public.vg_trip_role(t uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select m.role from public.vg_trip_members m
  where m.trip_id = t and m.user_id = auth.uid()
  limit 1
$$;

create or replace function public.vg_is_trip_member(t uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.vg_trip_role(t) is not null
$$;

create or replace function public.vg_is_trip_editor(t uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.vg_trip_role(t) in ('owner', 'editor'), false)
$$;

create or replace function public.vg_is_trip_owner(t uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.vg_trip_role(t) = 'owner', false)
$$;

-- The account behind a member row (for "only the payer can mark it paid").
create or replace function public.vg_member_user(m uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select user_id from public.vg_trip_members where id = m
$$;

-- ── Triggers ──────────────────────────────────────────────────────
create trigger vg_profiles_touch   before update on public.vg_profiles      for each row execute function public.vg_touch_updated_at();
create trigger vg_plans_touch      before update on public.vg_plans         for each row execute function public.vg_touch_updated_at();
create trigger vg_trips_touch      before update on public.vg_trips         for each row execute function public.vg_touch_updated_at();
create trigger vg_members_touch    before update on public.vg_trip_members  for each row execute function public.vg_touch_updated_at();
create trigger vg_expenses_touch   before update on public.vg_trip_expenses for each row execute function public.vg_touch_updated_at();

-- A new trip gets its creator as the owner member (like households_add_owner_member).
create or replace function public.vg_trips_add_owner_member()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name  text;
  v_email text;
begin
  if new.owner_id is null then
    return new;
  end if;
  select u.email into v_email from auth.users u where u.id = new.owner_id;
  select nullif(btrim(p.full_name), '') into v_name from public.vg_profiles p where p.user_id = new.owner_id;
  v_name := left(coalesce(v_name, split_part(coalesce(v_email, ''), '@', 1), 'Organizer'), 60);
  if v_name = '' then v_name := 'Organizer'; end if;
  insert into public.vg_trip_members (trip_id, user_id, display_name, email, role, joined_at)
  values (new.id, new.owner_id, v_name, v_email, 'owner', now());
  return new;
end $$;
create trigger vg_trips_owner_member after insert on public.vg_trips
  for each row execute function public.vg_trips_add_owner_member();

-- Trip owner can't be changed by a plain update (ownership transfer is a later RPC).
create or replace function public.vg_trips_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.owner_id is distinct from old.owner_id and current_user in ('authenticated', 'anon') then
    raise exception 'Trip owner can''t be changed here';
  end if;
  if new.legacy_id is distinct from old.legacy_id and current_user in ('authenticated', 'anon') then
    raise exception 'legacy_id is read-only';
  end if;
  return new;
end $$;
create trigger vg_trips_guard before update on public.vg_trips
  for each row execute function public.vg_trips_guard();

-- Members: keep exactly one owner and stop rows moving between trips or accounts.
create or replace function public.vg_members_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return coalesce(new, old);  -- service role and SECURITY DEFINER RPCs manage these rules themselves
  end if;
  if tg_op = 'INSERT' then
    if new.role = 'owner' then raise exception 'Only the trip creator is the owner'; end if;
    if new.user_id is not null then raise exception 'Accounts join through an invite'; end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.trip_id <> old.trip_id then raise exception 'Members can''t move between trips'; end if;
    if new.user_id is distinct from old.user_id then raise exception 'Accounts are linked through an invite'; end if;
    if (new.role = 'owner') <> (old.role = 'owner') then raise exception 'Ownership can''t be changed here'; end if;
    return new;
  else
    if old.role = 'owner' and exists (select 1 from public.vg_trips t where t.id = old.trip_id) then
      raise exception 'The owner can''t be removed from the trip';
    end if;
    return old;
  end if;
end $$;
create trigger vg_members_guard before insert or update or delete on public.vg_trip_members
  for each row execute function public.vg_members_guard();

-- Expenses: split keys must be members of the same trip; values true or heads 1-50.
-- created_by is always the person who wrote the row.
create or replace function public.vg_expenses_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  k text;
  v jsonb;
begin
  for k, v in select * from jsonb_each(new.split) loop
    if k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from public.vg_trip_members m where m.id = k::uuid and m.trip_id = new.trip_id) then
      raise exception 'Split refers to someone who isn''t on this trip';
    end if;
    if not (v = 'true'::jsonb or (jsonb_typeof(v) = 'number' and (v::text)::numeric between 1 and 50 and (v::text)::numeric = floor((v::text)::numeric))) then
      raise exception 'Split values must be true or a whole number of people (1-50)';
    end if;
  end loop;
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
      if new.trip_id <> old.trip_id then raise exception 'Expenses can''t move between trips'; end if;
    end if;
  end if;
  return new;
end $$;
create trigger vg_expenses_guard before insert or update on public.vg_trip_expenses
  for each row execute function public.vg_expenses_guard();

-- Settlements: marked_by is the writer; confirmation only through vg_confirm_settlement.
create or replace function public.vg_settlements_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.marked_by := auth.uid();
    new.marked_at := now();
    new.confirmed_by := null;
    new.confirmed_at := null;
  end if;
  return new;
end $$;
create trigger vg_settlements_guard before insert on public.vg_trip_settlements
  for each row execute function public.vg_settlements_guard();

-- ── Row-level security ────────────────────────────────────────────
alter table public.vg_profiles         enable row level security;
alter table public.vg_plans            enable row level security;
alter table public.vg_trips            enable row level security;
alter table public.vg_trip_members     enable row level security;
alter table public.vg_trip_expenses    enable row level security;
alter table public.vg_trip_settlements enable row level security;
alter table public.vg_trip_invites     enable row level security;
alter table public.vg_trip_shares      enable row level security;
alter table public.vg_search_history   enable row level security;
alter table public.vg_contact_messages enable row level security;

-- profiles: your own row only
create policy "vg_profiles own read"   on public.vg_profiles for select to authenticated using (user_id = auth.uid());
create policy "vg_profiles own insert" on public.vg_profiles for insert to authenticated with check (user_id = auth.uid());
create policy "vg_profiles own update" on public.vg_profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- plans: your own rows only
create policy "vg_plans own read"   on public.vg_plans for select to authenticated using (user_id = auth.uid());
create policy "vg_plans own insert" on public.vg_plans for insert to authenticated with check (user_id = auth.uid() and legacy_id is null);
create policy "vg_plans own update" on public.vg_plans for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "vg_plans own delete" on public.vg_plans for delete to authenticated using (user_id = auth.uid());

-- trips: members read; the creator owns; only the owner edits settings or deletes
-- owner_id check first: on insert ... returning, the owner member row doesn't exist yet
create policy "vg_trips member read"  on public.vg_trips for select to authenticated using (owner_id = auth.uid() or public.vg_is_trip_member(id));
create policy "vg_trips create own"   on public.vg_trips for insert to authenticated with check (owner_id = auth.uid() and legacy_id is null);
create policy "vg_trips owner update" on public.vg_trips for update to authenticated using (public.vg_is_trip_owner(id)) with check (public.vg_is_trip_owner(id));
create policy "vg_trips owner delete" on public.vg_trips for delete to authenticated using (public.vg_is_trip_owner(id));

-- members: everyone on the trip sees the list; the owner manages it
-- (members change their own name/pay handles through vg_update_my_membership)
create policy "vg_members member read"  on public.vg_trip_members for select to authenticated using (public.vg_is_trip_member(trip_id));
create policy "vg_members owner insert" on public.vg_trip_members for insert to authenticated with check (public.vg_is_trip_owner(trip_id));
create policy "vg_members owner update" on public.vg_trip_members for update to authenticated using (public.vg_is_trip_owner(trip_id)) with check (public.vg_is_trip_owner(trip_id));
create policy "vg_members owner delete" on public.vg_trip_members for delete to authenticated using (public.vg_is_trip_owner(trip_id));

-- expenses: members read; editors add; you edit your own, the owner edits any
create policy "vg_expenses member read"  on public.vg_trip_expenses for select to authenticated using (public.vg_is_trip_member(trip_id));
create policy "vg_expenses editor insert" on public.vg_trip_expenses for insert to authenticated with check (public.vg_is_trip_editor(trip_id));
create policy "vg_expenses own or owner update" on public.vg_trip_expenses for update to authenticated
  using (public.vg_is_trip_owner(trip_id) or (created_by = auth.uid() and public.vg_is_trip_editor(trip_id)))
  with check (public.vg_is_trip_owner(trip_id) or (created_by = auth.uid() and public.vg_is_trip_editor(trip_id)));
create policy "vg_expenses own or owner delete" on public.vg_trip_expenses for delete to authenticated
  using (public.vg_is_trip_owner(trip_id) or (created_by = auth.uid() and public.vg_is_trip_editor(trip_id)));

-- settlements: members read; the payer (or the owner) records a payment;
-- unconfirmed payments can be removed by whoever recorded them, or the owner
create policy "vg_settlements member read" on public.vg_trip_settlements for select to authenticated using (public.vg_is_trip_member(trip_id));
create policy "vg_settlements payer insert" on public.vg_trip_settlements for insert to authenticated
  with check (public.vg_is_trip_owner(trip_id)
              or (public.vg_is_trip_editor(trip_id) and public.vg_member_user(from_member_id) = auth.uid()));
create policy "vg_settlements remove unconfirmed" on public.vg_trip_settlements for delete to authenticated
  using (public.vg_is_trip_owner(trip_id) or (marked_by = auth.uid() and confirmed_at is null));

-- invites and shares: created through RPCs; the owner can list and revoke
create policy "vg_invites owner read"   on public.vg_trip_invites for select to authenticated using (public.vg_is_trip_owner(trip_id));
create policy "vg_invites owner delete" on public.vg_trip_invites for delete to authenticated using (public.vg_is_trip_owner(trip_id));
create policy "vg_shares owner read"    on public.vg_trip_shares  for select to authenticated using (public.vg_is_trip_owner(trip_id));
create policy "vg_shares owner delete"  on public.vg_trip_shares  for delete to authenticated using (public.vg_is_trip_owner(trip_id));

-- search history: your own rows only
create policy "vg_search own read"   on public.vg_search_history for select to authenticated using (user_id = auth.uid());
create policy "vg_search own insert" on public.vg_search_history for insert to authenticated with check (user_id = auth.uid());
create policy "vg_search own update" on public.vg_search_history for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "vg_search own delete" on public.vg_search_history for delete to authenticated using (user_id = auth.uid());

-- contact messages: anyone can send; nobody can read them back through the API
create policy "vg_contact anyone send" on public.vg_contact_messages for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

-- helper functions are for policies and signed-in users only
revoke all on function public.vg_trip_role(uuid), public.vg_is_trip_member(uuid), public.vg_is_trip_editor(uuid),
                       public.vg_is_trip_owner(uuid), public.vg_member_user(uuid) from public, anon;
grant execute on function public.vg_trip_role(uuid), public.vg_is_trip_member(uuid), public.vg_is_trip_editor(uuid),
                          public.vg_is_trip_owner(uuid), public.vg_member_user(uuid) to authenticated;

commit;
