-- Security and behaviour tests for the vg_ schema.
-- Local only: run supabase_stub.sql, the migrations, then this file, on a
-- scratch database (see supabase/tests/run.sh). Stops at the first failure.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on

-- ── test helpers (run as the current role, so RLS applies) ────────
create schema if not exists tst;
grant usage on schema tst to anon, authenticated, service_role;
create or replace function tst.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'ok   %', label;
end $$;
create or replace function tst.n(q text) returns bigint language plpgsql as $$
declare c bigint; begin execute 'select count(*) from (' || q || ') s' into c; return c; end $$;
create or replace function tst.changed(q text) returns bigint language plpgsql as $$
declare c bigint; begin execute 'with x as (' || q || ' returning 1) select count(*) from x' into c; return c; end $$;
create or replace function tst.fails(q text, label text) returns void language plpgsql as $$
declare failed boolean := false; msg text;
begin
  begin execute q; exception when others then failed := true; msg := sqlerrm; end;
  if not failed then raise exception 'FAIL: % (should have been blocked)', label; end if;
  raise notice 'ok   % [blocked: %]', label, msg;
end $$;
grant execute on all functions in schema tst to anon, authenticated, service_role;

-- ── accounts ──────────────────────────────────────────────────────
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@test.dev',    now()),
  ('00000000-0000-0000-0000-00000000000b', 'ben@test.dev',      now()),
  ('00000000-0000-0000-0000-00000000000c', 'outsider@test.dev', now()),
  ('00000000-0000-0000-0000-00000000000d', 'viewer@test.dev',   now()),
  ('00000000-0000-0000-0000-00000000000e', 'legacy@test.dev',   now());
insert into public.vg_profiles (user_id, full_name) values ('00000000-0000-0000-0000-00000000000a', 'Ann');

\set OWNER    '00000000-0000-0000-0000-00000000000a'
\set BEN      '00000000-0000-0000-0000-00000000000b'
\set OUTSIDER '00000000-0000-0000-0000-00000000000c'
\set VIEWER   '00000000-0000-0000-0000-00000000000d'

-- ── owner creates a trip ──────────────────────────────────────────
set role authenticated; select set_config('request.jwt.claim.sub', :'OWNER', false);
insert into public.vg_trips (owner_id, name, destination) values (:'OWNER', 'Cancun 2027', 'Cancun') returning id as trip \gset
select tst.ok((select count(*) = 1 and bool_and(role = 'owner' and display_name = 'Ann' and in_split)
               from public.vg_trip_members where trip_id = :'trip'), 'creator becomes the owner member, named from profile');
insert into public.vg_trip_members (trip_id, display_name) values (:'trip', 'Ben') returning id as ben_m \gset
insert into public.vg_trip_members (trip_id, display_name, household_size) values (:'trip', 'Cam', 2) returning id as cam_m \gset
select id as ann_m from public.vg_trip_members where trip_id = :'trip' and role = 'owner' \gset
select tst.fails(format('insert into public.vg_trip_members (trip_id, display_name) values (%L, %L)', :'trip', 'ben'),
                 'duplicate name (case-insensitive) rejected');
select tst.fails(format('insert into public.vg_trip_members (trip_id, display_name, role) values (%L, %L, %L)', :'trip', 'Eve', 'owner'),
                 'second owner rejected');
select tst.fails(format('insert into public.vg_trip_members (trip_id, display_name, user_id) values (%L, %L, %L)', :'trip', 'Eve', :'OUTSIDER'),
                 'owner can''t attach someone else''s account directly');
insert into public.vg_trip_expenses (trip_id, paid_by_member_id, amount, description, split)
values (:'trip', :'ann_m', 300, 'Villa', jsonb_build_object(:'ann_m', true, :'ben_m', true, :'cam_m', 2)) returning id as villa \gset
select tst.fails(format('insert into public.vg_trip_expenses (trip_id, paid_by_member_id, amount, split) values (%L, %L, 10, %L)',
                        :'trip', :'ann_m', jsonb_build_object(gen_random_uuid(), true)), 'split naming a stranger rejected');
select tst.fails(format('insert into public.vg_trip_expenses (trip_id, paid_by_member_id, amount, split) values (%L, %L, 10, %L)',
                        :'trip', :'ann_m', jsonb_build_object(:'ben_m', 1.5)), 'fractional heads rejected');
select tst.fails(format('update public.vg_trips set owner_id = %L where id = %L', :'OUTSIDER', :'trip'), 'owner can''t be reassigned by update');
select tst.fails(format('delete from public.vg_trip_members where id = %L', :'ann_m'), 'owner member can''t be removed');
select public.vg_create_invite(:'trip', 'editor') as inv \gset
select public.vg_create_invite(:'trip', 'viewer') as vinv \gset
select tst.ok(length(:'inv') = 48, 'invite token is 48 hex characters');
select tst.ok(not exists (select 1 from public.vg_trip_invites where token_hash = :'inv'), 'raw token is not stored');

-- ── an outsider sees nothing ──────────────────────────────────────
select set_config('request.jwt.claim.sub', :'OUTSIDER', false);
select tst.ok(tst.n('select * from public.vg_trips') = 0, 'outsider: no trips visible');
select tst.ok(tst.n('select * from public.vg_trip_members') = 0, 'outsider: no members visible');
select tst.ok(tst.n('select * from public.vg_trip_expenses') = 0, 'outsider: no expenses visible');
select tst.ok(tst.n('select * from public.vg_trip_invites') = 0, 'outsider: no invites visible');
select tst.fails(format('insert into public.vg_trip_expenses (trip_id, paid_by_member_id, amount) values (%L, %L, 5)', :'trip', :'ann_m'),
                 'outsider can''t add an expense');
select tst.ok(tst.changed(format('update public.vg_trips set name = %L where id = %L', 'hacked', :'trip')) = 0, 'outsider can''t rename the trip');
select tst.fails(format('select public.vg_create_invite(%L)', :'trip'), 'outsider can''t create invites');
select tst.ok((public.vg_invite_preview(:'inv')->'trip'->>'name') = 'Cancun 2027', 'invite preview shows the trip');
select tst.ok(jsonb_array_length(public.vg_invite_preview(:'inv')->'unclaimed') = 2, 'preview lists Ben and Cam as claimable');
select tst.ok(public.vg_invite_preview('not-a-real-token') is null, 'wrong token previews nothing');

-- ── Ben joins by claiming his name ────────────────────────────────
select set_config('request.jwt.claim.sub', :'BEN', false);
select tst.ok(public.vg_accept_invite(:'inv', :'ben_m') = :'trip'::uuid, 'Ben accepts the invite');
select tst.ok(public.vg_accept_invite(:'inv') = :'trip'::uuid, 'accepting twice is harmless');
select tst.ok((select uses from public.vg_trip_invites where trip_id = :'trip' and role = 'editor') is null, 'editors can''t read invites');
select tst.ok(tst.n('select * from public.vg_trip_members') = 3, 'Ben sees the member list');
select tst.ok(tst.n('select * from public.vg_trip_expenses') = 1, 'Ben sees the villa');
insert into public.vg_trip_expenses (trip_id, paid_by_member_id, amount, description, split, created_by)
values (:'trip', :'ben_m', 90, 'Dinner', jsonb_build_object(:'ann_m', true, :'ben_m', true, :'cam_m', true), :'OWNER') returning id as dinner, created_by as dinner_by \gset
select tst.ok(:'dinner_by'::uuid = :'BEN'::uuid, 'created_by is forced to the real author');
select tst.ok(tst.changed(format('update public.vg_trip_expenses set amount = 95 where id = %L', :'dinner')) = 1, 'Ben edits his own expense');
select tst.ok(tst.changed(format('update public.vg_trip_expenses set amount = 1 where id = %L', :'villa')) = 0, 'Ben can''t edit Ann''s expense');
select tst.ok(tst.changed(format('delete from public.vg_trip_expenses where id = %L', :'villa')) = 0, 'Ben can''t delete Ann''s expense');
select tst.fails(format('insert into public.vg_trip_members (trip_id, display_name) values (%L, %L)', :'trip', 'Dee'), 'Ben can''t add members');
select tst.ok(tst.changed(format('update public.vg_trip_members set role = %L where id = %L', 'viewer', :'cam_m')) = 0, 'Ben can''t change roles');
select public.vg_update_my_membership(:'trip', 'Benny', '{"venmo":"ben-t"}'::jsonb);
select tst.ok((select display_name = 'Benny' and pay_handles->>'venmo' = 'ben-t' from public.vg_trip_members where id = :'ben_m'),
              'Ben updates his own name and Venmo handle');
-- payments
insert into public.vg_trip_settlements (trip_id, from_member_id, to_member_id, amount_cents, method)
values (:'trip', :'ben_m', :'ann_m', 7500, 'venmo') returning id as pay1 \gset
select tst.fails(format('insert into public.vg_trip_settlements (trip_id, from_member_id, to_member_id, amount_cents) values (%L, %L, %L, 100)',
                        :'trip', :'cam_m', :'ann_m'), 'Ben can''t record a payment for Cam');
select tst.fails(format('select public.vg_confirm_settlement(%L)', :'pay1'), 'payer can''t confirm their own payment');
select public.vg_create_share(:'trip') as share \gset

-- ── a viewer can look but not touch ───────────────────────────────
select set_config('request.jwt.claim.sub', :'VIEWER', false);
select public.vg_accept_invite(:'vinv', null, 'Vic');
select tst.ok(tst.n('select * from public.vg_trip_expenses') = 2, 'viewer sees expenses');
select tst.fails(format('insert into public.vg_trip_expenses (trip_id, paid_by_member_id, amount) values (%L, %L, 5)', :'trip', :'ann_m'),
                 'viewer can''t add expenses');
select tst.fails(format('select public.vg_create_share(%L)', :'trip'), 'viewer can''t create share links');

-- ── owner confirms, then cleans up ────────────────────────────────
select set_config('request.jwt.claim.sub', :'OWNER', false);
select public.vg_confirm_settlement(:'pay1');
select tst.ok((select confirmed_at is not null and confirmed_by = :'OWNER'::uuid from public.vg_trip_settlements where id = :'pay1'),
              'receiver (Ann) confirms Ben''s payment');
select tst.ok(tst.changed(format('update public.vg_trip_expenses set amount = 310 where id = %L', :'dinner')) = 1, 'owner can edit anyone''s expense');
select tst.fails(format('delete from public.vg_trip_members where id = %L', :'ben_m'), 'member who paid can''t be deleted (expenses depend on them)');
select tst.ok(tst.changed(format('delete from public.vg_trip_invites where trip_id = %L', :'trip')) = 2, 'owner revokes both invites (delete)');

-- ── share link without signing in ─────────────────────────────────
reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);
select tst.ok((public.vg_get_shared_trip(:'share')->'trip'->>'name') = 'Cancun 2027', 'anon opens the share link');
select tst.ok(public.vg_get_shared_trip(:'share')::text !~* '(@test\.dev|ben-t|user_id)', 'share link leaks no emails, handles or account ids');
select tst.ok(tst.n('select * from public.vg_trips') = 0, 'anon can''t query trips directly');
select tst.fails(format('select public.vg_accept_invite(%L)', :'inv'), 'anon can''t accept invites');
select tst.ok(public.vg_invite_preview(:'inv') is null, 'revoked invite previews nothing');
insert into public.vg_contact_messages (name, email, message) values ('Visitor', 'v@x.dev', 'Hello');
select tst.ok(tst.n('select * from public.vg_contact_messages') = 0, 'contact messages can be sent but not read back');
select tst.fails('select public.vg_import_legacy(''{}''::jsonb)', 'anon can''t run the import');
reset role; set role authenticated; select set_config('request.jwt.claim.sub', :'BEN', false);
select tst.fails('select public.vg_import_legacy(''{}''::jsonb)', 'signed-in users can''t run the import');

-- ── owner deletes the trip: everything goes with it ───────────────
select set_config('request.jwt.claim.sub', :'OWNER', false);
delete from public.vg_trips where id = :'trip';
reset role;
select tst.ok((select count(*) from public.vg_trip_members where trip_id = :'trip') = 0
              and (select count(*) from public.vg_trip_expenses where trip_id = :'trip') = 0
              and (select count(*) from public.vg_trip_settlements where trip_id = :'trip') = 0, 'trip delete removes members, expenses, payments');

-- ── legacy import ─────────────────────────────────────────────────
select public.vg_import_legacy($json$
{"trips":[
 {"legacy_id":"11111111-1111-1111-1111-111111111111","owner_email":"legacy@test.dev","name":"Old trip",
  "form_data":{"tripStart":"2026-07-04","tripEnd":"2026-07-07",
   "people":[{"name":"Jimmy","payer":"Jimmy","size":1},{"name":"Jenny","payer":"Jimmy","size":"2"},"Katie",{"name":"katie","size":1}],
   "expenses":[
     {"date":"2026-07-04","desc":"Boat","category":"Fun","paidBy":"Jimmy","amount":"$1,200.50","included":{"Jimmy":true,"Jenny":2,"Katie":false}},
     {"desc":"Snacks","paidBy":"Katie","amount":30,"included":["Jimmy","Katie"]},
     {"desc":"Gas","paidBy":"Jenny","amount":"45","included":"Jimmy, Jenny"},
     {"desc":"Nobody","paidBy":"Jenny","amount":10,"included":"All"},
     {"desc":"Ghost","paidBy":"Zed","amount":99,"included":{"Jimmy":true}},
     {"kind":"budget_transfer","desc":"Pot","paidBy":"Jenny","amount":100,"included":{"Jimmy":true}}],
   "settlementMeta":{"Katie||Jimmy||12000":{"paid":true,"method":"venmo","paid_at":"2026-07-08T10:00:00Z"},
                     "Katie||Jimmy||15000":{"paid":true,"paid_at":"2026-07-09T10:00:00Z"},
                     "Jenny||Jimmy":{"paid":true,"paid_cents":5000,"paid_at":"2026-07-10T10:00:00Z","method":"zelle"},
                     "Jenny||Katie||300":{"paid":false},
                     "Zed||Jimmy||100":{"paid":true}},
   "sponsorRules":[{"label":"Gift","traveler":"Katie","sponsors":["Jimmy","Zed"],"mode":"full","value":0}]}},
 {"legacy_id":"22222222-2222-2222-2222-222222222222","owner_email":"nobody-yet@test.dev","name":"Waiting trip",
  "form_data":{"people":["A","B"],"expenses":[{"paidBy":"A","amount":20,"included":{"A":true,"B":true}}]}}],
 "plans":[{"legacy_id":"33333333-3333-3333-3333-333333333333","owner_email":"nobody-yet@test.dev","trip_name":"Plan","trip_data":{"x":1}}]}
$json$::jsonb) as report \gset
\echo :report
select tst.ok(jsonb_array_length((:'report'::jsonb)->'trips') = 2, 'report has one entry per trip');
select tst.ok(((:'report'::jsonb)->'trips'->0->>'expenses')::int = 5 and jsonb_array_length((:'report'::jsonb)->'trips'->0->'warnings') = 3,
              'report counts and warnings sit on the trip entry');
select id as old_trip from public.vg_trips where legacy_id = '11111111-1111-1111-1111-111111111111' \gset
select tst.ok((select owner_id = '00000000-0000-0000-0000-00000000000e'::uuid from public.vg_trips where id = :'old_trip'),
              'trip attached to the existing account with the owner''s email');
select tst.ok((select count(*) from public.vg_trip_members where trip_id = :'old_trip') = 5, '4 people + the organizer (no name match) imported');
select tst.ok((select display_name from public.vg_trip_members where trip_id = :'old_trip' and display_name ilike 'katie (%') = 'katie (2)',
              'case-only duplicate name kept as a separate person, renamed');
select tst.ok((select household_size from public.vg_trip_members where trip_id = :'old_trip' and display_name = 'Jenny') = 2, 'size "2" -> 2');
select tst.ok((select p.display_name from public.vg_trip_members m join public.vg_trip_members p on p.id = m.payer_member_id
               where m.trip_id = :'old_trip' and m.display_name = 'Jenny') = 'Jimmy', 'Jenny''s payer is Jimmy');
select tst.ok((select count(*) from public.vg_trip_expenses where trip_id = :'old_trip') = 5, '5 expenses imported, the unknown-payer one skipped');
select tst.ok((select amount from public.vg_trip_expenses where trip_id = :'old_trip' and description = 'Boat') = 1200.50, '"$1,200.50" parsed');
select tst.ok((select split from public.vg_trip_expenses e where trip_id = :'old_trip' and description = 'Boat')
              = (select jsonb_build_object(j.id::text, true, n.id::text, 2) from public.vg_trip_members j, public.vg_trip_members n
                 where j.trip_id = :'old_trip' and j.display_name = 'Jimmy' and n.trip_id = :'old_trip' and n.display_name = 'Jenny'),
              'object split: true stays true, 2 heads kept, false dropped');
select tst.ok((select (select count(*) from jsonb_object_keys(split)) from public.vg_trip_expenses where trip_id = :'old_trip' and description = 'Snacks') = 2, 'array split');
select tst.ok((select (select count(*) from jsonb_object_keys(split)) from public.vg_trip_expenses where trip_id = :'old_trip' and description = 'Gas') = 2, 'comma-string split');
select tst.ok((select split = '{}'::jsonb from public.vg_trip_expenses where trip_id = :'old_trip' and description = 'Nobody'), '"All" -> nobody, as the page does');
select tst.ok((select kind from public.vg_trip_expenses where trip_id = :'old_trip' and description = 'Pot') = 'budget_transfer', 'budget transfer kept');
select tst.ok((select string_agg(f.display_name || '>' || t.display_name || ':' || s.amount_cents || ':' || coalesce(s.method, '-'), ',' order by s.amount_cents)
               from public.vg_trip_settlements s join public.vg_trip_members f on f.id = s.from_member_id join public.vg_trip_members t on t.id = s.to_member_id
               where s.trip_id = :'old_trip') = 'Jenny>Jimmy:5000:zelle,Katie>Jimmy:15000:venmo',
              'paid marks: latest per pair, method carried over, unpaid and unknown-person marks dropped');
select tst.ok((select jsonb_array_length(settings->'sponsorRules'->0->'sponsors') = 1 from public.vg_trips where id = :'old_trip'),
              'sponsor rule kept, unknown sponsor dropped');
select tst.ok((public.vg_import_legacy($j${"trips":[{"legacy_id":"11111111-1111-1111-1111-111111111111","form_data":{}}]}$j$::jsonb)
               ->'trips'->0->>'status') = 'already imported', 're-import is a no-op');

-- the waiting trip and plan are claimed at first sign-in
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-00000000000f', 'Nobody-Yet@test.dev', now());
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
select tst.ok(tst.n('select * from public.vg_trips') = 0, 'before claiming, the imported trip is invisible');
select tst.ok(public.vg_claim_legacy() = '{"plans": 1, "trips": 1}'::jsonb, 'claim picks up 1 trip and 1 plan');
select tst.ok(tst.n('select * from public.vg_trips') = 1 and tst.n('select * from public.vg_plans') = 1, 'claimed trip and plan visible');
select tst.ok(public.vg_claim_legacy() = '{"plans": 0, "trips": 0}'::jsonb, 'claiming again finds nothing');
select set_config('request.jwt.claim.sub', :'OUTSIDER', false);
select tst.ok(tst.n('select * from public.vg_trips') = 0, 'other users still see none of it');
reset role;

\echo ALL TESTS PASSED
