# Deploying to Bluehost

Every push to `main` runs the site checks, then uploads changed files to Bluehost over FTPS
(`.github/workflows/deploy-bluehost.yml`). Pull requests into `main` run the checks only.
You can also run it by hand: GitHub → Actions → "Deploy to Bluehost" → Run workflow.

## One-time setup

### 1. Make an FTP account just for deploys (Bluehost cPanel)
cPanel → **FTP Accounts** → Add FTP Account.
- Username: e.g. `deploy` (cPanel shows the full login, like `deploy@voyagegenie.com`).
- Directory: the folder voyagegenie.com is served from. For the main domain that's `public_html`;
  for an add-on domain it's usually `public_html/voyagegenie.com` (check cPanel → Domains → Document Root).
- Use a long generated password. Don't use your main cPanel login: if this password ever leaks, it
  only reaches the website folder.

Note the **FTP server** cPanel shows under "Configure FTP Client" (often `ftp.voyagegenie.com`).

### 2. Add four repository secrets (GitHub)
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `BLUEHOST_FTP_SERVER` | FTP server from step 1, e.g. `ftp.voyagegenie.com` |
| `BLUEHOST_FTP_USERNAME` | full FTP login, e.g. `deploy@voyagegenie.com` |
| `BLUEHOST_FTP_PASSWORD` | its password |
| `BLUEHOST_FTP_DIR` | folder **relative to the FTP account's home**, ending in `/`. If the account's directory is already the site folder, use `./` |

### 3. Before the first deploy
- **Get `images/` into the repo** (or at least don't expect it to be uploaded). The deploy never deletes
  files it didn't upload, so the images already on the server stay put either way.
- **Back up the server folder** (cPanel File Manager → select all → Compress → download). The first run
  uploads every file in the repo and overwrites same-named files on the server.
- **Compare `.htaccess`.** The repo's `.htaccess` replaces the server's. If the server copy has lines
  Bluehost added (PHP version handler, SSL, caching), copy them into the repo's `.htaccess` first, or the
  site can break the moment the deploy lands.

### 4. After the first deploy: clean up files the deploy won't remove
These were removed from the repo but still exist on the server. `.htaccess` already 404s or redirects
them, but delete them in File Manager so nothing depends on that:

`trade-journal-pro.html`, `signup.html`, `customs-entry-guide (1).html`, `packing-assistant.html`,
`packing-assistant-ai.html`, `travel-budget-planner.html`, `dashboard.html`, `add-telecom.html`,
`detail.html`, `departure-location.html`, `smart-trip-finder.json`, `Voyage - Smart Trip Finder.json`.

## What gets uploaded
Everything in the repo except: `.git*`, `.github/`, `workflows/` (n8n exports), `tools/`, all `*.md`,
`_headers` and `_redirects` (Cloudflare-only). `.htaccess` **is** uploaded; it carries the HTTPS redirect,
security headers, redirects and file blocks.

The action keeps its own list of uploaded files in `.ftp-deploy-sync-state.json` in the site folder
(blocked from the public by `.htaccess`). Don't delete it, or the next run re-uploads everything.

## If a deploy fails
- **Site checks failed**: the log names the page and line. Fix it and push again. Nothing was uploaded.
- **TLS / certificate error**: the FTP hostname doesn't match Bluehost's certificate. Try the server's
  own hostname from cPanel (e.g. `box1234.bluehost.com`) as `BLUEHOST_FTP_SERVER`.
- **Login / timeout**: check the secrets, and that FTP isn't IP-restricted in cPanel.

## Checking locally
```bash
python3 tools/check-site.py
```
