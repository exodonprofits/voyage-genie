# Voyage Genie database (GenieSphere project)

Voyage Genie's data lives in the **GenieSphere** Supabase project (`nxgtefbqizvihwikqnaw`), next to the
household app. Every Voyage table and function starts with `vg_`. Nothing here is served by the website
(`.htaccess` returns 404 for `/supabase`, and the deploy skips the folder).

| Path | What it is |
|---|---|
| `migrations/20261115000001_vg_core.sql` | Tables, access helpers, guards, row-level security |
| `migrations/20261115000002_vg_rpcs.sql` | Invites, joining, self-service member updates, payment confirmation, share links |
| `migrations/20261115000003_vg_legacy_import.sql` | Import from the old Salon Genie tables + `vg_claim_legacy()` |
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

## Moving the data over (one time)
Nothing has been run in either project yet. Order:
1. **Test locally:** `bash supabase/tests/run.sh` → must end with `ALL TESTS PASSED`.
2. **GenieSphere → SQL editor:** run the three migration files in order.
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
