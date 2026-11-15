-- Voyage Genie: functions the site calls for things plain table access can't
-- do safely: invites, joining, self-service member updates, confirming
-- payments, read-only share links. Tokens are random 48-hex strings shown once;
-- only their SHA-256 hash is stored (same approach as household_invites).

begin;

create or replace function public.vg_hash_token(p_token text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

create or replace function public.vg_new_token()
returns text language sql volatile set search_path = public, pg_temp as $$
  select encode(extensions.gen_random_bytes(24), 'hex')
$$;

-- ── Invites ───────────────────────────────────────────────────────

-- Owner creates an invite link. Returns the token (only time it is visible).
create or replace function public.vg_create_invite(p_trip uuid, p_role text default 'editor',
                                                   p_hours integer default 336, p_max_uses integer default 20)
returns text language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_token text := public.vg_new_token();
begin
  if not public.vg_is_trip_owner(p_trip) then
    raise exception 'Only the trip owner can invite people';
  end if;
  if p_role not in ('editor', 'viewer') then
    raise exception 'Invite role must be editor or viewer';
  end if;
  insert into public.vg_trip_invites (trip_id, token_hash, role, max_uses, expires_at, created_by)
  values (p_trip, public.vg_hash_token(v_token), p_role,
          least(greatest(coalesce(p_max_uses, 20), 1), 200),
          now() + make_interval(hours => least(greatest(coalesce(p_hours, 336), 1), 24 * 60)),
          auth.uid());
  return v_token;
end $$;

-- What an invite is for, shown on the join page before and after sign-in.
-- Lists name-only members so the visitor can say "that's me".
create or replace function public.vg_invite_preview(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_inv  public.vg_trip_invites%rowtype;
  v_trip public.vg_trips%rowtype;
begin
  select * into v_inv from public.vg_trip_invites
  where token_hash = public.vg_hash_token(p_token)
    and revoked_at is null and expires_at > now() and uses < max_uses;
  if not found then
    return null;
  end if;
  select * into v_trip from public.vg_trips where id = v_inv.trip_id;
  return jsonb_build_object(
    'trip', jsonb_build_object('name', v_trip.name, 'destination', v_trip.destination,
                               'start_date', v_trip.start_date, 'end_date', v_trip.end_date),
    'role', v_inv.role,
    'organizer', (select display_name from public.vg_trip_members where trip_id = v_trip.id and role = 'owner'),
    'unclaimed', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'display_name', m.display_name) order by m.display_name)
                           from public.vg_trip_members m
                           where m.trip_id = v_trip.id and m.user_id is null), '[]'::jsonb),
    'already_member', public.vg_is_trip_member(v_trip.id)
  );
end $$;

-- Join a trip with an invite. Either claim an existing name-only member
-- (their past expenses come along) or join as a new member.
create or replace function public.vg_accept_invite(p_token text, p_claim_member uuid default null,
                                                   p_display_name text default null)
returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_inv   public.vg_trip_invites%rowtype;
  v_email text;
  v_name  text;
begin
  if v_uid is null then
    raise exception 'Sign in to join this trip';
  end if;
  select * into v_inv from public.vg_trip_invites
  where token_hash = public.vg_hash_token(p_token)
    and revoked_at is null and expires_at > now() and uses < max_uses
  for update;
  if not found then
    raise exception 'This invite link has expired or is no longer valid';
  end if;
  if exists (select 1 from public.vg_trip_members where trip_id = v_inv.trip_id and user_id = v_uid) then
    return v_inv.trip_id;   -- already in; don't use up the invite
  end if;

  select email into v_email from auth.users where id = v_uid;

  if p_claim_member is not null then
    update public.vg_trip_members
       set user_id = v_uid, email = coalesce(email, v_email), role = v_inv.role, joined_at = now()
     where id = p_claim_member and trip_id = v_inv.trip_id and user_id is null and role <> 'owner';
    if not found then
      raise exception 'That person has already joined or isn''t on this trip';
    end if;
  else
    v_name := nullif(btrim(coalesce(p_display_name, '')), '');
    if v_name is null then
      select nullif(btrim(full_name), '') into v_name from public.vg_profiles where user_id = v_uid;
    end if;
    v_name := left(coalesce(v_name, split_part(coalesce(v_email, ''), '@', 1), 'Traveler'), 60);
    if exists (select 1 from public.vg_trip_members
               where trip_id = v_inv.trip_id and lower(btrim(display_name)) = lower(btrim(v_name))) then
      raise exception 'Someone on this trip is already called %. Pick that name if it''s you, or use a different one.', v_name;
    end if;
    insert into public.vg_trip_members (trip_id, user_id, display_name, email, role, joined_at)
    values (v_inv.trip_id, v_uid, v_name, v_email, v_inv.role, now());
  end if;

  update public.vg_trip_invites set uses = uses + 1 where id = v_inv.id;
  return v_inv.trip_id;
end $$;

-- ── Members helping themselves ────────────────────────────────────

-- Change your own display name, pay handles or party size on a trip.
create or replace function public.vg_update_my_membership(p_trip uuid, p_display_name text default null,
                                                          p_pay_handles jsonb default null,
                                                          p_household_size integer default null)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if p_pay_handles is not null and jsonb_typeof(p_pay_handles) <> 'object' then
    raise exception 'pay_handles must be an object';
  end if;
  update public.vg_trip_members
     set display_name   = coalesce(nullif(btrim(p_display_name), ''), display_name),
         pay_handles    = coalesce(p_pay_handles, pay_handles),
         household_size = coalesce(p_household_size, household_size)
   where trip_id = p_trip and user_id = auth.uid();
  if not found then
    raise exception 'You''re not on this trip';
  end if;
end $$;

-- Leave a trip. Your name and expenses stay (the group's maths depends on
-- them); your account is unlinked. The owner can't leave.
create or replace function public.vg_leave_trip(p_trip uuid)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if public.vg_trip_role(p_trip) = 'owner' then
    raise exception 'The owner can''t leave. Delete the trip instead.';
  end if;
  update public.vg_trip_members set user_id = null, role = 'editor', joined_at = null
   where trip_id = p_trip and user_id = auth.uid();
  if not found then
    raise exception 'You''re not on this trip';
  end if;
end $$;

-- ── Payments ──────────────────────────────────────────────────────

-- The person who received a payment (or the owner) confirms it.
create or replace function public.vg_confirm_settlement(p_settlement uuid)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_s public.vg_trip_settlements%rowtype;
begin
  select * into v_s from public.vg_trip_settlements where id = p_settlement for update;
  if not found then
    raise exception 'Payment not found';
  end if;
  if not (public.vg_member_user(v_s.to_member_id) = auth.uid() or public.vg_is_trip_owner(v_s.trip_id)) then
    raise exception 'Only the person who was paid can confirm this';
  end if;
  update public.vg_trip_settlements set confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_settlement and confirmed_at is null;
end $$;

-- ── Read-only share links ─────────────────────────────────────────

-- Owner (or editor) creates a link that shows the trip without signing in.
create or replace function public.vg_create_share(p_trip uuid, p_hours integer default 48)
returns text language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_token text := public.vg_new_token();
begin
  if not public.vg_is_trip_editor(p_trip) then
    raise exception 'Only people on the trip can share it';
  end if;
  insert into public.vg_trip_shares (trip_id, token_hash, expires_at, created_by)
  values (p_trip, public.vg_hash_token(v_token),
          now() + make_interval(hours => least(greatest(coalesce(p_hours, 48), 1), 24 * 30)),
          auth.uid());
  return v_token;
end $$;

-- What a share link shows. Deliberately leaves out emails, account ids and
-- pay handles: only what the read-only page displays.
create or replace function public.vg_get_shared_trip(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_trip_id uuid;
begin
  select trip_id into v_trip_id from public.vg_trip_shares
  where token_hash = public.vg_hash_token(p_token) and revoked_at is null and expires_at > now();
  if v_trip_id is null then
    return null;
  end if;
  return (
    select jsonb_build_object(
      'trip', jsonb_build_object('id', t.id, 'name', t.name, 'destination', t.destination,
                                 'start_date', t.start_date, 'end_date', t.end_date,
                                 'currency', t.currency, 'settings', t.settings),
      'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'display_name', m.display_name,
                                   'in_split', m.in_split, 'household_size', m.household_size,
                                   'payer_member_id', m.payer_member_id) order by m.created_at)
                           from public.vg_trip_members m where m.trip_id = t.id), '[]'::jsonb),
      'expenses', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind,
                                   'paid_by_member_id', e.paid_by_member_id, 'amount', e.amount,
                                   'currency', e.currency, 'spent_on', e.spent_on, 'category', e.category,
                                   'description', e.description, 'split', e.split) order by e.spent_on nulls last, e.created_at)
                            from public.vg_trip_expenses e where e.trip_id = t.id), '[]'::jsonb),
      'settlements', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'from_member_id', s.from_member_id,
                                   'to_member_id', s.to_member_id, 'amount_cents', s.amount_cents,
                                   'currency', s.currency, 'method', s.method, 'marked_at', s.marked_at,
                                   'confirmed_at', s.confirmed_at) order by s.marked_at)
                               from public.vg_trip_settlements s where s.trip_id = t.id), '[]'::jsonb)
    )
    from public.vg_trips t where t.id = v_trip_id
  );
end $$;

-- ── Who can call what ─────────────────────────────────────────────
revoke all on function public.vg_hash_token(text), public.vg_new_token() from public, anon, authenticated;
revoke all on function public.vg_create_invite(uuid, text, integer, integer), public.vg_invite_preview(text),
                       public.vg_accept_invite(text, uuid, text), public.vg_update_my_membership(uuid, text, jsonb, integer),
                       public.vg_leave_trip(uuid), public.vg_confirm_settlement(uuid),
                       public.vg_create_share(uuid, integer), public.vg_get_shared_trip(text) from public, anon;
grant execute on function public.vg_create_invite(uuid, text, integer, integer), public.vg_invite_preview(text),
                          public.vg_accept_invite(text, uuid, text), public.vg_update_my_membership(uuid, text, jsonb, integer),
                          public.vg_leave_trip(uuid), public.vg_confirm_settlement(uuid),
                          public.vg_create_share(uuid, integer), public.vg_get_shared_trip(text) to authenticated;
grant execute on function public.vg_invite_preview(text), public.vg_get_shared_trip(text) to anon;

commit;
