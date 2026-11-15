# Voyage Genie database (GenieSphere project)

Voyage Genie's data lives in the **GenieSphere** Supabase project (`nxgtefbqizvihwikqnaw`), next to the
household app. Every Voyage table and function starts with `vg_`. Nothing here is served by the website
(`.htaccess` returns 404 for `/supabase`, and the deploy skips the folder).

| Path | What it is |
|---|---|
| `migrations/20261115000001_vg_core.sql` | Tables, access helpers, guards, row-level security |
| `migrations/20261115000002_vg_rpcs.sql` | Invites, joining, self-service member updates, payment confirmation, share links |
| `migrations/20261115000003_vg_legacy_import.sql` | Import from the old Salon Genie tables + `vg_claim_legacy()` |
| `migrations/20261115000004_vg_trigger_grants.sql` | Trigger functions not callable through the API (advisor clean-up) |
| `migrations/20261115000005_vg_link_me_and_perf.sql` | "That's me" for owners; policy and index performance fixes |
| `legacy/export_from_salon_genie.sql` | Read-only export to run in **Salon Genie** |
| `legacy/rows_for_balance_check.sql` | Read-only query to run in **GenieSphere** after the import |
| `tests/run.sh` | Applies everything to a throwaway local PostgreSQL and runs `vg_rls_test.sql` (71 checks) |
| `tests/balance_match.cjs` | Proves every person's balance is unchanged by the import |

## Tables
- `vg_trips`: a trip; `settings` holds owner-only options (sponsor rules, settle-up choices).
- `vg_trip_members`: everyone in the split, with or without an account (`user_id` null until they join).
  Roles: `owner` (exactly one), `editor`, `viewer`.
- `vg_trip_expenses`: one row per expense. `split` is `{ "<member id>": true | heads }`.
- `vg_trip_settlements`: one row per payment made. The payer records it; the person paid confirms it.
- `vg_trip_invites`, `vg_trip_shares`: invite and read-only links (tokens stored hashed).
- `vg_plans`: AI plans from the planners. `vg_profiles`, `vg_search_history`, `vg_contact_messages`.

## Who can do what
| | Owner | Editor | Viewer | Not on the trip | Share-link visitor |
|---|---|---|---|---|---|
| See the trip | yes | yes | yes | no | read-only, no emails/handles |
| Add expenses | yes | yes | no | no | no |
| Edit/delete expenses | all | own | no | no | no |
| Add/remove people, settings | yes | no | no | no | no |
| Record a payment | any | own | no | no | no |
| Confirm a payment | yes | if paid to them | if paid to them | no | no |
| Invite people | yes | no | no | no | no |

## Status
- **2026-11-15:** migrations 001-004 applied to GenieSphere (`vg_core`, `vg_rpcs`, `vg_legacy_import`,
  `vg_trigger_grants`). Verified there: RLS on all 10 tables, function permissions as designed, and a
  rolled-back smoke test (anon blocked, trip create + owner member + invite working, import blocked for users).
- **2026-11-15:** data imported into GenieSphere: 12 trips (8 attached to their owner's account, 4 waiting
  for their owners' first sign-in), 3 plans, 87 members, 51 expenses ($50,475.97), 6 payments ($1,940.06).
  `balance_match.cjs` on GenieSphere's rows: all 12 trips match to the cent (79 people). Plan JSON verified by md5.
  Unpaid settlement records were left out of the transfer (the import ignores them anyway).
- **Follow-up for step 2:** on the 8 attached trips the owner was added as a separate organizer
  (`in_split = false`, named from the email) because no `vg_profiles` name existed yet. Step 2 needs a
  "that's me" action so the owner can merge into their person in the split (e.g. "Jimmy").
- **2026-11-15:** migration 005 (`vg_link_me_and_perf`) applied: "that's me" RPC, `(select auth.uid())` in
  policies, indexes on every foreign key. Rolled-back check in GenieSphere: linking the owner to "Jimmy" works.
- **Step 2 built, dark:** tracker, trip dashboard, login and register use GenieSphere only after `?db=gs`
  (remembered per browser; `?db=salon` turns it off). See `js/vg-trip-store.js`.
- **Other pages built, dark:** all 31 remaining pages' bootstrap and header sign-in follow the same switch; itinerary
  "Save to My Trips" → `vg_plans`, planner history → `vg_search_history`, account → `vg_plans`/`vg_profiles`, contact →
  `vg_contact_messages` (`tools/tests/pages-gs.e2e.cjs`). `trip-budget-settlement.html` is left on Salon Genie (to retire).
- **Not done yet (cutover):** flip `DEFAULT_BACKEND`; enable Google sign-in and custom SMTP in GenieSphere; add the site to its
  Auth redirect URLs; re-import trips edited on the live site since the import.
- **Known advisor notes, to fold into the next migration:** wrap `auth.uid()` as `(select auth.uid())` in policies,
  and index the remaining foreign keys. Both are performance-only and don't matter at current size.

## Moving the data over (one time)
Order:
1. **Test locally:** `bash supabase/tests/run.sh` → must end with `ALL TESTS PASSED`.
2. **GenieSphere:** apply the migration files in order (done for 001-004).
3. **Salon Genie → SQL editor:** run `legacy/export_from_salon_genie.sql`; copy the `bundle` value.
4. **GenieSphere → SQL editor:** `select public.vg_import_legacy('<bundle>'::jsonb);` and read the report
   (expected: 12 trips, 3 plans; warnings for 3 blank draft expenses and 3 paid marks on people no
   longer on one trip).
5. **Prove balances:** run `legacy/rows_for_balance_check.sql` in GenieSphere, save both outputs as JSON
   (outside the repo), then `node supabase/tests/balance_match.cjs bundle.json rows.json` →
   `ALL 12 TRIPS MATCH TO THE CENT`.
6. The site switches to GenieSphere in Phase 2 step 2. Until then the old tables keep working.
   Owners pick up their trips at first GenieSphere sign-in (`vg_claim_legacy()`).

## GenieSphere settings needed before the switch
- Auth → URL Configuration: add `https://voyagegenie.com` and `https://www.voyagegenie.com` to redirect URLs.
- Auth → SMTP: a custom sender (Resend, Postmark, SendGrid…). The built-in one sends only a few emails
  per hour, which invites and magic links will hit quickly.
