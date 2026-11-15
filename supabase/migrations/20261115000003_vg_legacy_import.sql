-- Voyage Genie: bring trips and plans over from the Salon Genie project.
--
-- 1. Run supabase/legacy/export_from_salon_genie.sql in Salon Genie (read-only).
-- 2. Pass its JSON to  select public.vg_import_legacy('<json>'::jsonb);  here,
--    as the service role. It returns a report; nothing is imported twice.
-- 3. Owners without a GenieSphere account yet get their trips when they first
--    sign in: the site calls vg_claim_legacy(), which matches their verified email.
--
-- Conversion follows trip-cost-tracker.html exactly:
--   people[].size -> household_size, people[].payer -> payer_member_id
--   expenses[].included: {name: true|heads|false}, ["name"], "a, b" or "All";
--     true = whole party, number = heads (1-50), false/0 = left out, and
--     "All"/{} = nobody (that is what the page does with them)
--   expenses[].amount: number, or text parsed like parseFloat after
--     stripping everything but digits, '.' and '-'
--   settlementMeta: "from||to" or legacy "from||to||cents" keys; per pair the
--     latest paid record becomes one payment row (paid_cents, else the key's cents)
--   sponsorRules: names are swapped for member ids

begin;

-- Attach an account as the owner of an imported trip. If a member already has
-- the owner's name, that member becomes the owner; otherwise a new owner
-- member is added who isn't part of the split.
create or replace function public.vg__attach_owner(p_trip uuid, p_user uuid)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_email  text;
  v_name   text;
  v_member uuid;
begin
  select email into v_email from auth.users where id = p_user;
  select nullif(btrim(full_name), '') into v_name from public.vg_profiles where user_id = p_user;
  v_name := left(coalesce(v_name, split_part(coalesce(v_email, ''), '@', 1), 'Organizer'), 60);
  if v_name = '' then v_name := 'Organizer'; end if;

  update public.vg_trips set owner_id = p_user where id = p_trip;

  select id into v_member from public.vg_trip_members
  where trip_id = p_trip and user_id is null and lower(btrim(display_name)) = lower(btrim(v_name))
  limit 1;
  if v_member is not null then
    update public.vg_trip_members
       set user_id = p_user, role = 'owner', email = coalesce(email, v_email), joined_at = now()
     where id = v_member;
  else
    while exists (select 1 from public.vg_trip_members where trip_id = p_trip and lower(btrim(display_name)) = lower(v_name)) loop
      v_name := left(v_name, 55) || ' (org)';
    end loop;
    insert into public.vg_trip_members (trip_id, user_id, display_name, email, role, in_split, joined_at)
    values (p_trip, p_user, v_name, v_email, 'owner', false, now());
  end if;
end $$;

-- JS parseFloat-style amount parsing, as normalizeAmount() does.
create or replace function public.vg__parse_amount(v jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $$
declare
  s text;
  m text;
begin
  if v is null or v = 'null'::jsonb then return 0; end if;
  if jsonb_typeof(v) = 'number' then return (v::text)::numeric; end if;
  if jsonb_typeof(v) <> 'string' then return 0; end if;
  s := regexp_replace(v #>> '{}', '[^0-9.\-]', '', 'g');
  m := substring(s from '^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)');
  if m is null or m in ('-', '') then return 0; end if;
  return m::numeric;
end $$;

create or replace function public.vg__iso_date(v text)
returns date language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if v is null or v !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return v::date;
exception when others then
  return null;
end $$;

create or replace function public.vg_import_legacy(p_bundle jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t           jsonb;
  pl          jsonb;
  fd          jsonb;
  v_trip      uuid;
  v_user      uuid;
  v_start     date;
  v_end       date;
  v_names     jsonb;     -- exact legacy name -> member id
  v_name      text;
  v_label     text;
  v_n         integer;
  p           jsonb;
  ex          jsonb;
  v_inc       jsonb;
  v_split     jsonb;
  k           text;
  val         jsonb;
  v_heads     numeric;
  v_payer     uuid;
  v_amt       numeric;
  v_report    jsonb := '[]'::jsonb;
  v_warn      jsonb;
  v_counts    jsonb;
  v_meta      jsonb;
  v_pairs     jsonb;
  v_pair      text;
  v_rec       jsonb;
  v_cur       jsonb;
  v_parts     text[];
  v_cents     bigint;
  v_rules     jsonb;
  v_plans     integer := 0;
  v_plans_skipped integer := 0;
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'Import runs with the service role only';
  end if;

  for t in select * from jsonb_array_elements(coalesce(p_bundle->'trips', '[]'::jsonb)) loop
    v_warn := '[]'::jsonb;
    if exists (select 1 from public.vg_trips where legacy_id = (t->>'legacy_id')::uuid) then
      v_report := v_report || jsonb_build_array(jsonb_build_object('legacy_id', t->>'legacy_id', 'status', 'already imported'));
      continue;
    end if;
    fd := coalesce(t->'form_data', '{}'::jsonb);
    v_start := public.vg__iso_date(fd->>'tripStart');
    v_end   := public.vg__iso_date(fd->>'tripEnd');
    if v_start is not null and v_end is not null and v_end < v_start then
      v_end := null;
      v_warn := v_warn || '"end date was before start date; dropped"'::jsonb;
    end if;

    insert into public.vg_trips (owner_id, name, start_date, end_date, legacy_id, legacy_owner_email, created_at, updated_at)
    values (null, left(coalesce(nullif(t->>'name', ''), fd->>'tripTitle', ''), 200), v_start, v_end,
            (t->>'legacy_id')::uuid, lower(t->>'owner_email'),
            coalesce((t->>'created_at')::timestamptz, now()), coalesce((t->>'updated_at')::timestamptz, now()))
    returning id into v_trip;

    -- members, in the page's order
    v_names := '{}'::jsonb;
    for p in select * from jsonb_array_elements(case when jsonb_typeof(fd->'people') = 'array' then fd->'people' else '[]'::jsonb end) loop
      if jsonb_typeof(p) = 'string' then
        p := jsonb_build_object('name', p #>> '{}');
      end if;
      v_name := coalesce(p->>'name', '');
      if btrim(v_name) = '' or v_names ? v_name then
        v_warn := v_warn || to_jsonb('person skipped (blank or repeated name): "' || v_name || '"');
        continue;
      end if;
      v_label := left(btrim(regexp_replace(v_name, '\s+', ' ', 'g')), 60);
      v_n := 2;
      while exists (select 1 from public.vg_trip_members where trip_id = v_trip and lower(btrim(display_name)) = lower(v_label)) loop
        v_label := left(btrim(regexp_replace(v_name, '\s+', ' ', 'g')), 54) || ' (' || v_n || ')';
        v_n := v_n + 1;
      end loop;
      if v_label <> v_name then
        v_warn := v_warn || to_jsonb('"' || v_name || '" saved as "' || v_label || '"');
      end if;
      insert into public.vg_trip_members (trip_id, display_name, role, household_size)
      values (v_trip, v_label, 'editor',
              least(greatest(coalesce(floor(public.vg__parse_amount(p->'size'))::int, 1), 1), 50))
      returning to_jsonb(id) into val;
      v_names := v_names || jsonb_build_object(v_name, val);
    end loop;

    -- who pays for whom
    for p in select * from jsonb_array_elements(case when jsonb_typeof(fd->'people') = 'array' then fd->'people' else '[]'::jsonb end) loop
      continue when jsonb_typeof(p) <> 'object';
      continue when coalesce(p->>'payer', '') = '' or p->>'payer' = p->>'name';
      if v_names ? (p->>'name') and v_names ? (p->>'payer') then
        update public.vg_trip_members set payer_member_id = (v_names->>(p->>'payer'))::uuid
         where id = (v_names->>(p->>'name'))::uuid;
      else
        v_warn := v_warn || to_jsonb('payer "' || (p->>'payer') || '" for "' || (p->>'name') || '" not found; they pay for themselves');
      end if;
    end loop;

    -- expenses
    for ex in select * from jsonb_array_elements(case when jsonb_typeof(fd->'expenses') = 'array' then fd->'expenses' else '[]'::jsonb end) loop
      continue when jsonb_typeof(ex) <> 'object';
      v_payer := (v_names->>coalesce(ex->>'paidBy', ''))::uuid;
      v_amt := round(public.vg__parse_amount(ex->'amount'), 2);
      if v_payer is null then
        v_warn := v_warn || to_jsonb('expense skipped, payer "' || coalesce(ex->>'paidBy', '') || '" not on the trip: '
                                     || coalesce(ex->>'desc', '') || ' ' || v_amt::text);
        continue;
      end if;
      -- normalise "included" into {name: value} like normalizeExpensesList
      v_inc := ex->'included';
      if jsonb_typeof(v_inc) = 'array' then
        select coalesce(jsonb_object_agg(btrim(x #>> '{}'), true), '{}'::jsonb) into v_inc
        from jsonb_array_elements(v_inc) x where jsonb_typeof(x) = 'string' and btrim(x #>> '{}') <> '';
      elsif jsonb_typeof(v_inc) = 'string' then
        if btrim(v_inc #>> '{}') = 'All' then
          v_inc := '{}'::jsonb;
        else
          select coalesce(jsonb_object_agg(btrim(s), true), '{}'::jsonb) into v_inc
          from unnest(string_to_array(v_inc #>> '{}', ',')) s where btrim(s) <> '';
        end if;
      elsif jsonb_typeof(v_inc) is distinct from 'object' then
        v_inc := '{}'::jsonb;
      end if;
      -- then to {member_id: true | heads}, like includedHeads()
      v_split := '{}'::jsonb;
      for k, val in select * from jsonb_each(v_inc) loop
        continue when not (v_names ? k);
        if val = 'true'::jsonb then
          v_split := v_split || jsonb_build_object(v_names->>k, true);
        elsif val is null or val in ('false'::jsonb, 'null'::jsonb) then
          continue;
        else
          v_heads := floor(public.vg__parse_amount(case when jsonb_typeof(val) in ('number', 'string') then val else null end));
          continue when v_heads is null or v_heads < 1;
          v_split := v_split || jsonb_build_object(v_names->>k, least(v_heads, 50)::int);
        end if;
      end loop;
      insert into public.vg_trip_expenses (trip_id, kind, paid_by_member_id, amount, spent_on, category, description, split)
      values (v_trip,
              case when ex->>'kind' = 'budget_transfer' then 'budget_transfer' else 'expense' end,
              v_payer, v_amt, public.vg__iso_date(ex->>'date'),
              nullif(left(coalesce(ex->>'category', ''), 60), ''), nullif(left(coalesce(ex->>'desc', ''), 300), ''),
              v_split);
    end loop;

    -- settlement "paid" marks -> one payment row per pair (latest paid record)
    v_meta := case when jsonb_typeof(fd->'settlementMeta') = 'object' then fd->'settlementMeta' else '{}'::jsonb end;
    v_pairs := '{}'::jsonb;
    for k, v_rec in select * from jsonb_each(v_meta) loop
      continue when jsonb_typeof(v_rec) <> 'object' or (v_rec->'paid') is distinct from 'true'::jsonb;
      v_parts := string_to_array(k, '||');
      continue when coalesce(array_length(v_parts, 1), 0) < 2;
      v_pair := v_parts[1] || '||' || v_parts[2];
      -- amount paid: paid_cents when saved (new tracker), else the cents in the old key
      v_cents := round(public.vg__parse_amount(v_rec->'paid_cents'));
      if v_cents <= 0 and array_length(v_parts, 1) >= 3 then
        v_cents := round(public.vg__parse_amount(to_jsonb(v_parts[3])));
      end if;
      v_rec := jsonb_build_object('from', v_parts[1], 'to', v_parts[2], 'cents', v_cents,
                                  'method', coalesce(v_rec->>'method', ''), 'paid_at', coalesce(v_rec->>'paid_at', ''));
      v_cur := v_pairs->v_pair;
      if v_cur is null or (v_rec->>'paid_at') > (v_cur->>'paid_at') then
        if (v_rec->>'method') = '' and v_cur is not null then
          v_rec := jsonb_set(v_rec, '{method}', v_cur->'method');
        end if;
        v_pairs := v_pairs || jsonb_build_object(v_pair, v_rec);
      end if;
    end loop;
    for v_pair, v_rec in select * from jsonb_each(v_pairs) loop
      if not (v_names ? (v_rec->>'from') and v_names ? (v_rec->>'to')) or (v_rec->>'cents')::bigint <= 0
         or (v_rec->>'from') = (v_rec->>'to') then
        v_warn := v_warn || to_jsonb('paid mark skipped: ' || v_pair);
        continue;
      end if;
      insert into public.vg_trip_settlements (trip_id, from_member_id, to_member_id, amount_cents, method, note, marked_at)
      values (v_trip, (v_names->>(v_rec->>'from'))::uuid, (v_names->>(v_rec->>'to'))::uuid, (v_rec->>'cents')::bigint,
              case lower(v_rec->>'method') when 'venmo' then 'venmo' when 'zelle' then 'zelle' when 'cash' then 'cash'
                   when 'paypal' then 'paypal' when 'cashapp' then 'cashapp' when '' then null else 'other' end,
              'Imported from the old cost tracker',
              coalesce(public.vg__iso_ts(v_rec->>'paid_at'), now()));
    end loop;

    -- sponsor rules: names -> member ids (rules naming missing people are dropped)
    v_rules := '[]'::jsonb;
    for p in select * from jsonb_array_elements(case when jsonb_typeof(fd->'sponsorRules') = 'array' then fd->'sponsorRules' else '[]'::jsonb end) loop
      if jsonb_typeof(p) = 'object' and v_names ? coalesce(p->>'traveler', '') then
        select coalesce(jsonb_agg(v_names->(s #>> '{}')), '[]'::jsonb) into val
        from jsonb_array_elements(case when jsonb_typeof(p->'sponsors') = 'array' then p->'sponsors' else '[]'::jsonb end) s
        where v_names ? (s #>> '{}');
        if jsonb_array_length(val) > 0 then
          v_rules := v_rules || jsonb_build_object('label', coalesce(p->>'label', ''), 'traveler', v_names->(p->>'traveler'),
                                                   'sponsors', val, 'mode', coalesce(p->>'mode', 'full'),
                                                   'value', public.vg__parse_amount(p->'value'));
          continue;
        end if;
      end if;
      v_warn := v_warn || to_jsonb('sponsor rule dropped: ' || p::text);
    end loop;
    if jsonb_array_length(v_rules) > 0 then
      update public.vg_trips set settings = jsonb_build_object('sponsorRules', v_rules) where id = v_trip;
    end if;

    -- owner: attach now if they already have a GenieSphere account
    select id into v_user from auth.users
    where lower(email) = lower(t->>'owner_email') and email_confirmed_at is not null limit 1;
    if v_user is not null then
      perform public.vg__attach_owner(v_trip, v_user);
    end if;

    select jsonb_build_object(
      'members',     (select count(*) from public.vg_trip_members where trip_id = v_trip and user_id is null),
      'expenses',    (select count(*) from public.vg_trip_expenses where trip_id = v_trip),
      'expense_total', (select coalesce(sum(amount), 0) from public.vg_trip_expenses where trip_id = v_trip),
      'payments',    (select count(*) from public.vg_trip_settlements where trip_id = v_trip)) into v_counts;
    v_report := v_report || jsonb_build_array(
                  jsonb_build_object('legacy_id', t->>'legacy_id', 'trip_id', v_trip, 'status', 'imported',
                                     'owner', case when v_user is null then 'waiting for sign-in' else 'attached' end,
                                     'warnings', v_warn) || v_counts);
  end loop;

  -- plans
  for pl in select * from jsonb_array_elements(coalesce(p_bundle->'plans', '[]'::jsonb)) loop
    if exists (select 1 from public.vg_plans where legacy_id = (pl->>'legacy_id')::uuid) then
      v_plans_skipped := v_plans_skipped + 1;
      continue;
    end if;
    select id into v_user from auth.users
    where lower(email) = lower(pl->>'owner_email') and email_confirmed_at is not null limit 1;
    insert into public.vg_plans (user_id, name, plan_data, legacy_id, legacy_owner_email, created_at, updated_at)
    values (v_user, left(coalesce(pl->>'trip_name', ''), 200),
            case when jsonb_typeof(pl->'trip_data') = 'object' then pl->'trip_data' else '{}'::jsonb end,
            (pl->>'legacy_id')::uuid, lower(pl->>'owner_email'),
            coalesce((pl->>'created_at')::timestamptz, now()), coalesce((pl->>'updated_at')::timestamptz, now()));
    v_plans := v_plans + 1;
  end loop;

  return jsonb_build_object('trips', v_report, 'plans_imported', v_plans, 'plans_already_imported', v_plans_skipped);
end $$;

create or replace function public.vg__iso_ts(v text)
returns timestamptz language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if v is null or v = '' then return null; end if;
  return v::timestamptz;
exception when others then
  return null;
end $$;

-- Signed-in user picks up imported trips and plans saved under their verified email.
create or replace function public.vg_claim_legacy()
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_trip  uuid;
  v_trips integer := 0;
  v_plans integer := 0;
begin
  if v_uid is null then
    raise exception 'Sign in first';
  end if;
  select lower(email) into v_email from auth.users where id = v_uid and email_confirmed_at is not null;
  if v_email is null then
    return jsonb_build_object('trips', 0, 'plans', 0);
  end if;
  for v_trip in select id from public.vg_trips where owner_id is null and legacy_owner_email = v_email for update loop
    perform public.vg__attach_owner(v_trip, v_uid);
    v_trips := v_trips + 1;
  end loop;
  update public.vg_plans set user_id = v_uid where user_id is null and legacy_owner_email = v_email;
  get diagnostics v_plans = row_count;
  return jsonb_build_object('trips', v_trips, 'plans', v_plans);
end $$;

revoke all on function public.vg__attach_owner(uuid, uuid), public.vg__parse_amount(jsonb), public.vg__iso_date(text),
                       public.vg__iso_ts(text), public.vg_import_legacy(jsonb) from public, anon, authenticated;
revoke all on function public.vg_claim_legacy() from public, anon;
grant execute on function public.vg_claim_legacy() to authenticated;

commit;
