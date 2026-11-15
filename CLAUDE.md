# Voyage Genie — working rules

Live site for voyagegenie.com (AI travel planning). Static HTML/CSS/JS, no build step, no frameworks.

## Code
- One self-contained HTML file per page. Dependencies from CDNs only.
- Build DOM with `document.createElement`. Never add template strings or `innerHTML` (quote-collision bugs). Old pages may still use them; don't add more.
- No class names containing ad-blocker trigger words: `affiliate-`, `aff-`, `deal-`, `ad-`, `sponsor-`, `promo-`.
- Functions inside `<script type="module">` aren't global. Expose with `window.fn = fn` if classic scripts call them.
- Multi-select fields: `formData.getAll()` plus `Array.isArray` guards.
- `js/genie-chat.js` is always loaded with `defer`.
- Auth pages: the Supabase bootstrap `<script type="module">` comes before `#authSlot`, with an 800ms retry guard for a slow CDN.

## Design
- Tokens: `--ocean #0077b6`, `--ocean-deep #023e8a`, `--teal #00b4d8`, `--coral #e76f51`.
- Fonts: Playfair Display (headings), DM Sans (body). Content rail 1240px.

## Backend
- Supabase: **GenieSphere** (`nxgtefbqizvihwikqnaw`). The old Salon Genie project (`pbojacnagutipfhcxltj`) still holds the pre-move copy; only the `?db=salon` switch uses it. Only the anon key goes in frontend code.
- Every page reaches GenieSphere only through `js/vg-trip-store.js` (load it before the supabase-js bootstrap; use `VGTripStore.table()` / `planRow()` for old table names). **The site runs on GenieSphere since 2026-11-15** (`DEFAULT_BACKEND = 'gs'`). `?db=salon` pins one browser to the old Salon Genie tables (read-only reference) until `?db=gs`. Google sign-in stays hidden until `GS_GOOGLE_ENABLED` is set after enabling Google in GenieSphere.
- Voyage tables/functions are prefixed `vg_`. Schema changes go in `supabase/migrations/` and must pass `bash supabase/tests/run.sh` before being run in GenieSphere. Never commit exported data.
- AI calls go through n8n webhooks: `https://exodonprofits.app.n8n.cloud/webhook/<name>`. Never call OpenAI from the browser.
- n8n workflow exports live in `/workflows`, which must never be served publicly.
- Partner/affiliate IDs live only in `js/partners.js`. Don't hardcode IDs in pages.

## Links
- Don't link to a page that doesn't exist. Use a non-link "coming soon" card instead.
- `images/` is referenced by most pages but is not in the repo yet; don't delete image references.

## Before finishing any change
1. `python3 tools/check-site.py` (script syntax, HTML structure, CSS braces, missing links). Deploys are blocked if it fails.
   - Touching the cost tracker or `js/vg-trip-store.js`: also `node tools/tests/vg-trip-store.test.cjs` and
     `node tools/tests/tracker-gs.e2e.cjs` (the tracker against a fake GenieSphere, incl. balances to the cent).
   - Touching invites, joining or member editing on the tracker: `node tools/tests/invites-gs.e2e.cjs`.
   - Touching settle up (pay details, pay links, I paid / Got it): `node tools/tests/settle-gs.e2e.cjs`.
   - Touching login, register or the trip dashboard: `node tools/tests/dashboard-auth.e2e.cjs` (both backends).
   - Touching any other page's Supabase bootstrap, header sign-in, plan/search saves or account: `node tools/tests/pages-gs.e2e.cjs`.
   - Touching `supabase/`: `bash supabase/tests/run.sh`.
2. `python3 -m http.server`, then click through every touched page with Playwright and check for console errors.

## Deploy
- Pushes to `main` deploy to Bluehost over FTPS (`.github/workflows/deploy-bluehost.yml`, setup in `DEPLOY.md`). Merging to `main` means going live.
- The deploy never deletes server files it didn't upload. When removing a page, also 404 or redirect it in `.htaccess`.

## Git
- Commit per logical change with a clear message.
- Push the working branch after every commit (owner's standing approval). Never push to or merge into `main` without asking: that deploys to the live site.
