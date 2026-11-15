-- Run in GENIESPHERE after vg_import_legacy(). Read-only.
-- Output feeds supabase/tests/balance_match.cjs. Contains names: don't commit it.
select jsonb_agg(jsonb_build_object('legacy_id', t.legacy_id,
  'members',  (select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.display_name, 'size', m.household_size, 'payer', m.payer_member_id))
               from public.vg_trip_members m where m.trip_id = t.id and m.in_split),
  'expenses', (select jsonb_agg(jsonb_build_object('paid_by', e.paid_by_member_id, 'amount', e.amount, 'split', e.split, 'kind', e.kind))
               from public.vg_trip_expenses e where e.trip_id = t.id),
  'settings', t.settings))
from public.vg_trips t where t.legacy_id is not null;
