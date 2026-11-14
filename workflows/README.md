# n8n workflows

Source copies of the n8n Cloud workflows behind the site's webhooks
(`https://exodonprofits.app.n8n.cloud/webhook/<name>`). Not part of the website:
`.htaccess` returns 404 for `/workflows/`, and nothing in here may be linked from a page.

| File | What it is |
|---|---|
| `smart-trip-finder.n8n-export.json` | Export from n8n (real node IDs, `active: true`, credential "OpenAi account"). |
| `smart-trip-finder.hand-authored.json` | Hand-written version of the same flow (placeholder IDs, credential "Voyage-Genie"). |
| `viator-prices.n8n.json` | **Draft, not yet live.** Real Viator tour prices for the planners (webhook `viator-prices`). |

Keep one of the two once it's confirmed which matches what's live in n8n.

## viator-prices: setup

Draft workflow. Its logic is tested against mock Viator responses; it has not been run against the real API yet.

1. **Get a Viator key**: Viator partner dashboard → Tools → Affiliate API (Basic access is self-serve).
2. **Create the credential in n8n**: Credentials → New → **Header Auth**. Name: `Viator API`, Header name: `exp-api-key`, Value: your key.
   The key lives only in n8n, never in this repo or a page.
3. **Import** `viator-prices.n8n.json` (Workflows → Import from file), open **Viator – Search Products**, and select the `Viator API` credential.
4. **Test** with the workflow's test URL, then **activate**. Cache and rate limits only persist on the production URL.
5. **Check the first real response** and confirm:
   - `productUrl` carries your affiliate tracking (`pid` / `mcid`). If it doesn't, commissions won't track; tell me and I'll append them.
   - prices, ratings and images come through (any field Viator names differently shows up as `null`).
   For a sandbox key, switch the node URL to Viator's sandbox host (check the URL in your dashboard).

### Request (from the site)
`POST https://exodonprofits.app.n8n.cloud/webhook/viator-prices`
```json
{ "destination": "Cancun", "activities": ["snorkeling"], "currency": "USD", "limit": 6 }
```
`activities` is optional (string or array, max 3 used). `currency`: USD, EUR, GBP, CAD, AUD, MXN or JPY (default USD). `limit`: 1-12 (default 6).

### Response
```json
{ "ok": true, "source": "viator", "priceType": "live", "fetchedAt": "2026-11-14T15:00:00.000Z",
  "destination": "Cancun", "currency": "USD", "cached": true,
  "products": [ { "code": "...", "title": "...", "fromPrice": 89.5, "fromPriceBeforeDiscount": 99,
                  "currency": "USD", "rating": 4.7, "reviewCount": 1203, "duration": "4 h",
                  "image": "https://...", "url": "https://www.viator.com/..." } ] }
```
On failure: `{ "ok": false, "error": "bad_request" | "rate_limited" | "upstream", "message": "...", "fallback": true }`.
`fallback: true` means "show the AI estimate instead". `fromPrice` is per person ("from $89.50 per person").
Show `fetchedAt` as "price as of …"; `cached: true` means it came from the 6-hour cache.

### Built in
- **Rate limit:** 30 lookups per visitor IP per 10 minutes (edit `LIMIT_PER_IP` / `WINDOW_MS` in the first Code node).
- **Cache:** identical searches reuse the result for 6 hours, max 500 entries, so repeat visitors don't spend API calls.
- **Sanitizing:** only `https` links on viator.com (and images on Viator/Tripadvisor CDNs) pass through; products without a title, link or price are dropped.
- **CORS:** same allowed origins as `trip-finder`.
