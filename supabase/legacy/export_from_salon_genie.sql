-- Run in the SALON GENIE project (pbojacnagutipfhcxltj). Read-only.
-- Produces the bundle for public.vg_import_legacy() in GenieSphere.
-- Output contains trip names, people's names and owner emails: don't commit it.
select jsonb_build_object(
  'exported_at', now(),
  'trips', coalesce((
    select jsonb_agg(jsonb_build_object(
             'legacy_id', t.id, 'owner_email', u.email, 'name', t.name,
             'created_at', t.created_at, 'updated_at', t.updated_at, 'form_data', t.form_data)
           order by t.created_at)
    from public.trips t left join auth.users u on u.id = t.owner_id), '[]'::jsonb),
  'plans', coalesce((
    select jsonb_agg(jsonb_build_object(
             'legacy_id', p.id, 'owner_email', u.email, 'trip_name', p.trip_name,
             'created_at', p.created_at, 'updated_at', p.updated_at, 'trip_data', p.trip_data)
           order by p.created_at)
    from public.user_trips p left join auth.users u on u.id = p.user_id), '[]'::jsonb)
) as bundle;
