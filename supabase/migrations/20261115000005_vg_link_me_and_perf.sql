-- Voyage Genie: "that's me" for trip owners, plus the performance fixes the
-- Supabase advisor suggested after 001-004.
--
-- vg_link_me: imported trips (and new trips made in the tracker) give the owner
-- an organizer row that isn't part of the split. This merges the owner's
-- account into their real person in the split (e.g. "Jimmy") and removes the
-- organizer row. Only allowed while the organizer row has no money attached.
--
-- Performance: policies call (select auth.uid()) so Postgres evaluates it once
-- per query instead of once per row, and every foreign key gets an index.

begin;

create or replace function public.vg_link_me(p_trip uuid, p_member uuid)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_me     public.vg_trip_members%rowtype;
  v_target public.vg_trip_members%rowtype;
begin
  select * into v_me from public.vg_trip_members where trip_id = p_trip and user_id = auth.uid() for update;
  if not found then
    raise exception 'You''re not on this trip';
  end if;
  if v_me.in_split then
    raise exception 'You''re already linked to a person on this trip';
  end if;
  select * into v_target from public.vg_trip_members where id = p_member and trip_id = p_trip for update;
  if not found or v_target.user_id is not null then
    raise exception 'That person has already joined or isn''t on this trip';
  end if;
  if exists (select 1 from public.vg_trip_expenses where trip_id = p_trip
             and (paid_by_member_id = v_me.id or split ? v_me.id::text))
     or exists (select 1 from public.vg_trip_settlements where trip_id = p_trip
                and (from_member_id = v_me.id or to_member_id = v_me.id)) then
    raise exception 'Your organizer entry already has money attached, so it can''t be merged automatically';
  end if;
  delete from public.vg_trip_members where id = v_me.id;
  update public.vg_trip_members
     set user_id = v_me.user_id, role = v_me.role, email = coalesce(email, v_me.email), joined_at = now()
   where id = p_member;
end $$;

revoke all on function public.vg_link_me(uuid, uuid) from public, anon;
grant execute on function public.vg_link_me(uuid, uuid) to authenticated;

-- ── (select auth.uid()) in policies ───────────────────────────────
alter policy "vg_profiles own read"   on public.vg_profiles using (user_id = (select auth.uid()));
alter policy "vg_profiles own insert" on public.vg_profiles with check (user_id = (select auth.uid()));
alter policy "vg_profiles own update" on public.vg_profiles using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

alter policy "vg_plans own read"   on public.vg_plans using (user_id = (select auth.uid()));
alter policy "vg_plans own insert" on public.vg_plans with check (user_id = (select auth.uid()) and legacy_id is null);
alter policy "vg_plans own update" on public.vg_plans using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy "vg_plans own delete" on public.vg_plans using (user_id = (select auth.uid()));

alter policy "vg_trips member read" on public.vg_trips using (owner_id = (select auth.uid()) or public.vg_is_trip_member(id));
alter policy "vg_trips create own"  on public.vg_trips with check (owner_id = (select auth.uid()) and legacy_id is null);

alter policy "vg_expenses own or owner update" on public.vg_trip_expenses
  using (public.vg_is_trip_owner(trip_id) or (created_by = (select auth.uid()) and public.vg_is_trip_editor(trip_id)))
  with check (public.vg_is_trip_owner(trip_id) or (created_by = (select auth.uid()) and public.vg_is_trip_editor(trip_id)));
alter policy "vg_expenses own or owner delete" on public.vg_trip_expenses
  using (public.vg_is_trip_owner(trip_id) or (created_by = (select auth.uid()) and public.vg_is_trip_editor(trip_id)));

alter policy "vg_settlements payer insert" on public.vg_trip_settlements
  with check (public.vg_is_trip_owner(trip_id)
              or (public.vg_is_trip_editor(trip_id) and public.vg_member_user(from_member_id) = (select auth.uid())));
alter policy "vg_settlements remove unconfirmed" on public.vg_trip_settlements
  using (public.vg_is_trip_owner(trip_id) or (marked_by = (select auth.uid()) and confirmed_at is null));

alter policy "vg_search own read"   on public.vg_search_history using (user_id = (select auth.uid()));
alter policy "vg_search own insert" on public.vg_search_history with check (user_id = (select auth.uid()));
alter policy "vg_search own update" on public.vg_search_history using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy "vg_search own delete" on public.vg_search_history using (user_id = (select auth.uid()));

alter policy "vg_contact anyone send" on public.vg_contact_messages with check (user_id is null or user_id = (select auth.uid()));

-- ── indexes for every foreign key ─────────────────────────────────
create index if not exists vg_contact_messages_user_idx      on public.vg_contact_messages (user_id);
create index if not exists vg_trip_expenses_created_by_idx   on public.vg_trip_expenses (created_by);
create index if not exists vg_trip_expenses_paid_by_idx      on public.vg_trip_expenses (trip_id, paid_by_member_id);
create index if not exists vg_trip_invites_created_by_idx    on public.vg_trip_invites (created_by);
create index if not exists vg_trip_members_payer_idx         on public.vg_trip_members (trip_id, payer_member_id);
create index if not exists vg_trip_settlements_confirmed_idx on public.vg_trip_settlements (confirmed_by);
create index if not exists vg_trip_settlements_marked_idx    on public.vg_trip_settlements (marked_by);
create index if not exists vg_trip_settlements_from_idx      on public.vg_trip_settlements (trip_id, from_member_id);
create index if not exists vg_trip_settlements_to_idx        on public.vg_trip_settlements (trip_id, to_member_id);
create index if not exists vg_trip_shares_created_by_idx     on public.vg_trip_shares (created_by);
create index if not exists vg_trips_plan_idx                 on public.vg_trips (plan_id);

commit;
