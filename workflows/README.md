# n8n workflows

Source copies of the n8n Cloud workflows behind the site's webhooks
(`https://exodonprofits.app.n8n.cloud/webhook/<name>`). Not part of the website:
`.htaccess` returns 404 for `/workflows/`, and nothing in here may be linked from a page.

| File | What it is |
|---|---|
| `smart-trip-finder.n8n-export.json` | Export from n8n (real node IDs, `active: true`, credential "OpenAi account"). |
| `smart-trip-finder.hand-authored.json` | Hand-written version of the same flow (placeholder IDs, credential "Voyage-Genie"). |

Keep one of the two once it's confirmed which matches what's live in n8n.
