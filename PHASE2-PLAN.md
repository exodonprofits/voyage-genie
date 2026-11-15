# Phase 2 plan: group trips

**Status:** proposal, not approved. Nothing here is built yet.
**Goal:** make Voyage Genie the place a group plans, budgets and splits a trip, which is something a chatbot
can't do, because it needs shared, saved state across several people over weeks.

**One-line pitch:** *Plan, budget and split group trips. No spreadsheet, no awkward money talk.*

---

## 1. What exists today

Checked in code and in the live Supabase project (`pbojacnagutipfhcxltj`) on 2026-11-15.

| Piece | What it does | Verdict |
|---|---|---|
| `trip-cost-tracker.html` (3,900 lines) | People (with household "size" and a payer per household), expenses with per-expense "who's included", shared pot/budget contributions, sponsor rules (someone covers someone), multi-currency, health check, settlement suggestions with **paid / method** tracking (Venmo, Zelle, Cash), CSV and printable reports, magic-link sign-in, cloud save, 48-hour read-only share link | **The core asset.** The split logic is real and done. |
| `trip-budget-settlement.html` | An older copy of the tracker (≈30 fewer functions, same logic) | Retire: redirect to the tracker |
| 4 planners + itineraries | AI itinerary via n8n webhooks, saved to `user_trips.trip_data` | Commodity on their own. Useful as the *starting point* of a group trip. |
| `smart-trip-finder.html` | "Where should I go?" with AI estimates and links out | Becomes group-aware in step 7 |
| `trip-dashboard.html` | Lists saved plans (`user_trips`) and splitter trips (`trips`) side by side | Becomes the trip hub |
| n8n `viator-prices`, `flight-prices` (drafts) | Real tour prices; recent fares from any origin | Powers the group features in step 7 |

**Data today**

| Table | Rows | Notes |
|---|---|---|
| `trips` | 12 | Splitter trips. Everything (people, expenses, settlements, sponsor rules) lives in one `form_data` JSON blob. Unused columns already exist: `shared_viewers`, `shared_editors`, `destination`, `start_date`, `days`, … RLS: owner only. |
| `user_trips` | 3 | AI plans (`trip_data` JSON). RLS: owner only, but **every policy is defined twice**. |
| `trip_public_shares` | 16 | 48-hour read-only tokens, via `create_trip_public_share` / `get_public_shared_trip` (security definer). |
| `auth.users` | 48 | Shared by **all** GenieSphere products. |

## 2. The gaps

1. **Only the owner can enter anything.** Friends get a read-only link ("Ask the trip owner to save changes"),
   so one person does all the data entry. That's the exact pain a group tool should remove.
2. **No members.** People are just names in JSON, with no link to an account, an email or a way to join.
3. **One JSON blob per trip.** Fine for one editor. With several editors it's last-save-wins: two friends
   adding expenses at the same time overwrite each other.
4. **Settling ends at a number.** "Paid" and "method" are recorded, but there's no pay button, and only
   the owner can mark anything.
5. **Plan and budget never meet.** An AI plan (`user_trips`) can't become a splitter trip (`trips`); they're
   separate lists on the dashboard.
6. **No group decisions**: dates, destination, budget ceiling.
7. **The share link leaks a little.** `get_public_shared_trip` returns the whole row (`to_jsonb(t)`),
   including `owner_id`. It's low risk, but the public function should return only what the page shows.

## 3. Key decisions

### 3.1 Data model: rows for things many people write, JSON for owner settings
Split the blob into rows wherever more than one person writes, and keep the rest as JSON:

```
vg_trip_members     id, trip_id → trips, user_id → auth.users (null until they join),
                    display_name, email, role ('owner'|'editor'|'viewer'),
                    household_size, payer_member_id, pay_handles jsonb, joined_at
vg_trip_expenses    id, trip_id, paid_by_member_id, amount numeric(12,2), currency, spent_on date,
                    category, note, split jsonb {member_id: weight}, created_by uuid, created_at, updated_at
vg_trip_settlements id, trip_id, from_member_id, to_member_id, amount, currency, method,
                    marked_paid_by, paid_at, confirmed_by, confirmed_at
vg_trip_invites     token (random, unique), trip_id, role, expires_at, max_uses, uses, created_by
trips (existing)    keeps name, dates, destination, form_data → only owner settings
                    (sponsor rules, budget/pot settings, display options) + plan_id → user_trips
```

- **The split math stays in the browser.** The tracker's tested `computeSettlements` and sponsor logic are reused as they are.
  The page loads rows, maps member ids to the same in-memory arrays it uses today, and computes.
  No rewrite of the hard part.
- **Members are keyed by id, not name**, so renaming someone no longer breaks their expenses.
- **New tables get a `vg_` prefix**, because this Supabase project is shared with every other product
  (it already has an `expenses` table that isn't Voyage's).

*Alternative considered:* keep the blob and add `shared_editors` + optimistic locking (`updated_at` check).
It's less work up front, but every concurrent edit becomes a "someone else saved, reload" error. That's wrong for a
feature whose whole point is several people adding at once.

### 3.2 Access rules (RLS)
- A `vg_is_trip_member(trip_id, min_role)` **security-definer** helper, to avoid recursive policies.
- Members read the trip, the members, the expenses and the settlements.
- Editors insert expenses (`created_by = auth.uid()`), and update or delete **their own**. The owner can edit any.
- Only the owner manages members, roles and invites.
- A settlement can be marked paid by the payer. Only the receiver can confirm it.
- Invites are joined through a `vg_accept_trip_invite(token, claim_member_id?)` RPC. It adds the signed-in user, and can
  "claim" an existing name-only member ("I'm Jenny"), so their past expenses come with them.

### 3.3 Sign-in for friends
The tracker already has magic-link sign-in, so a friend's experience is: tap invite → enter email → tap the
link in the email → they're in. There's no password. Viewing could later work without an account (keep the
share link); adding expenses needs one, so every row has an owner.

## 4. Build plan

Each step ships on its own and leaves the site working. Estimates assume this repo plus the Supabase SQL editor.

**Step 0: groundwork (prerequisites)**
- Finish Phase 1 item 5 (partner config, ad-blocker class renames, including the tracker's `sponsor-*` classes).
- `privacy.html` and `terms.html`. These are **required** before collecting friends' emails.
- Fix the truncated `contact.html`. Pin the `supabase-js` version.
- Retire `trip-budget-settlement.html` (301 to the tracker).
- Remove the duplicate `user_trips` policies.
- Put SQL in the repo: `supabase/migrations/NNN_*.sql`, excluded from deploy and blocked in `.htaccess`.
*Done when:* site checks pass, and the legal pages are linked from register and the footer.

**Step 1: schema and data migration**
- Create the four `vg_` tables, the helper and the RLS policies (section 3).
- Migration script: for each of the 12 `trips`, create members from `form_data.people`, expenses from
  `form_data.expenses`, and settlements from `settlementMeta`. Keep the original JSON untouched as a backup column.
- **Golden test:** for every migrated trip, balances computed from rows must equal balances from the old JSON,
  to the cent. This runs as a script before anything switches over.
*Done when:* all 12 trips match, and RLS is tested with three accounts (owner, editor, outsider).

**Step 2: tracker on rows (owner-only, same UI)**
- The tracker reads and writes rows instead of the blob. Nothing visible changes.
- Each expense saves as its own row the moment it's entered, so no more "Save" for expenses.
*Done when:* the owner flow is identical, Playwright click-through is clean, and the old trips open with the same totals.

**Step 3: invite and join (the core loop)**
- "Invite people": a link (copy, or share via text) with role and expiry. People list shows invited / joined.
- The join page claims a name ("Which one is you?") or adds a new member.
- Members add, edit and delete their own expenses. Balances update live through Supabase Realtime on `vg_trip_expenses`.
- Mobile-first layout for "add expense": amount, who paid (defaults to you), split (defaults to everyone), done.
*Done when:* two phones can add expenses to the same trip at the same time without conflict, and an outsider can't see the trip.

**Step 4: settle up**
- Each member saves pay handles once: Venmo username, PayPal.me, Cash App $cashtag, Zelle email or phone.
- "You owe Jenny $84.50" shows **Pay with Venmo / PayPal / Cash App** buttons that open the app with the amount
  and note pre-filled. Zelle shows the handle with a copy button, since it has no universal deep link.
  Voyage Genie never touches the money.
- The payer taps "I paid", the receiver taps "Got it", and the trip shows "All settled" when everything is confirmed.
*Done when:* a full trip can go from expenses to all settled, with both sides confirming.

**Step 5: plan becomes trip**
- On every itinerary page: **"Start a group trip from this plan."** It creates a `trips` row linked to the plan
  (`plan_id`), with dates, destination and a starting budget by category from the AI estimate.
- The trip hub shows plan, budget and spending together: "Planned $2,400 · Spent $1,870 · Your share $467."
- The dashboard merges the two lists into one "My trips".
*Done when:* a plan created in a planner can be turned into a shared trip in one tap.

**Step 6: group decisions**
- Simple polls: date options, destination options, max budget per person. Members vote, and the owner locks the choice,
  which updates the trip.
*Done when:* a group can settle on dates and destination inside the trip.

**Step 7: AI that uses the group (where Voyage Genie beats a chatbot)**
- **"Where can we meet?"** Each member's home airport + date window + budget, then `flight-prices` per origin,
  ranked by total and by fairness (spread between the cheapest and most expensive traveler).
- **"Plan within everyone's budget."** The AI plans to the lowest member budget, or the agreed ceiling.
- Tours come from `viator-prices` with real per-person prices, so they feed straight into the trip budget.
- Prices are labelled live, recent or estimate (needs both n8n workflows live and rate-limited).
*Done when:* a 3-person, 3-city group gets ranked destinations with real per-person fares.

**Step 8: reposition the site**
- Homepage: hero with the pitch, a 3-step "how it works" (plan, invite, split), and one primary button: "Start a group trip".
- The trip hub becomes the centre. Tools move into the trip where they're relevant: packing list shared with
  "who brings what", visa check per member passport, emergency info for the destination.
- Utilities that don't belong to a trip (tip calculator, temperature converter, …) go to one "Travel tools"
  page or are removed.
*Done when:* a new visitor can tell in 5 seconds what the site is for.

**Step 9 (later): notifications**
- n8n emails: "You were added to Cancun 2027", "Jenny added an expense", "You owe $84.50", and a 3-day
  post-trip settle-up reminder.

## 5. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| **One Supabase project for every product** | An RLS mistake in Voyage can expose salon, rental or finance data. `auth.users` is shared, so a salon client's login also works on Voyage. Table names collide (`expenses`). | `vg_` prefix and an RLS test per table, now. **Longer term: move Voyage to its own Supabase project** before real growth. It's cheap now (12 trips) and expensive later. |
| Friends' emails and spending data | Personal data from people who never signed up for the site. | Privacy page first (step 0). Members can leave a trip and delete their data. |
| Payment deep links change | Venmo, PayPal and Cash App link formats are app-controlled. | One small helper file, an easy fallback to "copy handle", and a quarterly check. |
| Scope creep | Steps 6 to 9 are nice-to-haves. | Steps 1 to 4 are the product. Ship them, watch usage, then decide. |

## 6. How we'll know it works

- **Invite → join rate.** Do invited friends actually join?
- **Expenses added by non-owners.** This is *the* metric: if it stays near zero, the group loop isn't landing.
- **Trips reaching "All settled".**
- **Affiliate clicks per trip**, which is the revenue.

## 7. Decisions needed

1. **Approve the direction** (group trips) and **steps 0 to 4** as the first build.
2. **Data model:** rows for members, expenses and settlements (recommended), or keep the JSON blob plus locking.
3. **Separate Supabase project for Voyage:** now (recommended while data is tiny), later, or never.
4. **Viewing without an account:** keep read-only share links for non-members, yes or no.
5. **Pay handles to support:** Venmo, PayPal, Cash App, Zelle (US). Others? Wise or Revolut if you expect international groups.

## Domain

`voyagegenie.com` still fits. "Voyage" is trips, "Genie" ties it to GenieSphere, and the group positioning lives in
the homepage pitch and the tagline, not the domain. Splitwise doesn't say "travel" and Airbnb doesn't say "rooms".
A rename would cost search history, links and money for little gain. Revisit only if real visitor feedback shows
people expect a solo planner.
