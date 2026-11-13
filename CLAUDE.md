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
- Supabase project `pbojacnagutipfhcxltj`. Only the anon key goes in frontend code.
- AI calls go through n8n webhooks: `https://exodonprofits.app.n8n.cloud/webhook/<name>`. Never call OpenAI from the browser.
- n8n workflow exports live in `/workflows`, which must never be served publicly.
- Partner/affiliate IDs live only in `js/partners.js`. Don't hardcode IDs in pages.

## Links
- Don't link to a page that doesn't exist. Use a non-link "coming soon" card instead.
- `images/` is referenced by most pages but is not in the repo yet; don't delete image references.

## Before finishing any change
1. `python3 tools/check-site.py` (script syntax, HTML structure, CSS braces, missing links). Deploys are blocked if it fails.
2. `python3 -m http.server`, then click through every touched page with Playwright and check for console errors.

## Deploy
- Pushes to `main` deploy to Bluehost over FTPS (`.github/workflows/deploy-bluehost.yml`, setup in `DEPLOY.md`). Merging to `main` means going live.
- The deploy never deletes server files it didn't upload. When removing a page, also 404 or redirect it in `.htaccess`.

## Git
- Commit per logical change with a clear message. Don't push until the owner says so.
