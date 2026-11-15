-- Trigger functions aren't meant to be called through the API. Postgres checks
-- EXECUTE when a trigger is created, not each time it fires, so revoking it
-- doesn't stop the triggers (the tests insert trips as a signed-in user after
-- this runs). Clears the Supabase advisor warning for vg_trips_add_owner_member.
begin;
revoke all on function public.vg_trips_add_owner_member(), public.vg_touch_updated_at(), public.vg_trips_guard(),
                       public.vg_members_guard(), public.vg_expenses_guard(), public.vg_settlements_guard()
  from public, anon, authenticated;
commit;
