-- Voyage Genie: "Delete my Voyage Genie data" (account page).
--
-- The sign-in is shared with other GenieSphere apps, so this never touches
-- auth.users. It removes everything Voyage Genie holds about the caller:
--   * their plans, search history and profile
--   * trips they own (members, expenses, payments, invites and share links go with them)
--   * imported plans/trips still waiting to be claimed under their verified email
-- and on trips they joined but don't own it unlinks them and clears their email and
-- payment handles. Their name stays on those trips, because it is part of the
-- other members' records and balances.
-- Contact-form messages are kept for support but no longer linked to the account.
-- One transaction: either all of it happens or none of it.

begin;

create or replace function public.vg_delete_my_data()
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_trips int; v_plans int; v_search int; v_left int; v_waiting_trips int := 0; v_waiting_plans int := 0;
begin
  if v_uid is null then
    raise exception 'Sign in first';
  end if;
  select lower(email) into v_email from auth.users where id = v_uid and email_confirmed_at is not null;

  delete from public.vg_trips where owner_id = v_uid;
  get diagnostics v_trips = row_count;

  update public.vg_trip_members
     set user_id = null, email = null, pay_handles = '{}'::jsonb, joined_at = null,
         role = case when role = 'owner' then role else 'editor' end
   where user_id = v_uid;
  get diagnostics v_left = row_count;

  delete from public.vg_plans where user_id = v_uid;
  get diagnostics v_plans = row_count;

  delete from public.vg_search_history where user_id = v_uid;
  get diagnostics v_search = row_count;

  if v_email is not null then
    delete from public.vg_trips where owner_id is null and lower(legacy_owner_email) = v_email;
    get diagnostics v_waiting_trips = row_count;
    delete from public.vg_plans where user_id is null and lower(legacy_owner_email) = v_email;
    get diagnostics v_waiting_plans = row_count;
  end if;

  update public.vg_contact_messages set user_id = null where user_id = v_uid;
  delete from public.vg_profiles where user_id = v_uid;

  return jsonb_build_object('trips', v_trips + v_waiting_trips, 'plans', v_plans + v_waiting_plans,
                            'searches', v_search, 'left_trips', v_left);
end $$;

revoke all on function public.vg_delete_my_data() from public, anon;
grant execute on function public.vg_delete_my_data() to authenticated;

commit;
