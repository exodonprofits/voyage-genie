// End-to-end: how the Smart Trip Finder handles each kind of reply from its n8n webhook (faked here).
// Run: node tools/tests/finder.e2e.cjs
// A good reply shows trips (also when n8n double-encodes the JSON); ok:false shows the workflow's own reason;
// "Workflow was started", an empty 200, junk and a 500 each get a clear message and log the raw reply.
'use strict';
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const root = path.join(__dirname, '..', '..');

function serve() {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    }).listen(0, () => resolve(srv));
  });
}

let passed = 0;
const ok = (c, label) => { assert.ok(c, label); passed++; console.log('ok   ' + label); };
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const TRIP = { name: 'Puerto Morelos', country: 'Mexico', region_label: 'Caribbean', trip_type: 'tropical', start_date: iso(40), end_date: iso(45),
  nights: 5, origin_iata: 'ORD', dest_iata: 'CUN', drive_ok: false, embark_port: '', cruise_search: '', stay_area: 'Beachfront',
  est_pp_low: 900, est_pp_high: 1200, breakdown: { flights: 400, stay: 500, activities: 100 }, value_score: 8.7,
  why_value: 'Quieter than Cancun, same beach.', highlights: ['Reef snorkeling'], weather: '85°F, dry', booking_tip: 'Book midweek', watch_out: 'Sargassum' };
const GOOD = { ok: true, summary: 'Two good picks.', results: [TRIP] };

(async () => {
  const srv = await serve();
  const base = 'http://localhost:' + srv.address().port + '/smart-trip-finder.html';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let reply = { status: 200, body: '' };
  await ctx.route(/exodonprofits\.app\.n8n\.cloud\/webhook\/trip-finder/, (r) => r.fulfill({ status: reply.status, contentType: 'application/json', body: reply.body }));
  await ctx.route(/^https?:\/\/(?!localhost)(?!exodonprofits\.app\.n8n\.cloud)/, (r) => r.abort());
  const p = await ctx.newPage();
  const errors = [], warns = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  await p.goto(base, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await p.goto(base, { waitUntil: 'domcontentloaded' });

  const search = async (status, body) => {
    reply = { status, body };
    warns.length = 0;
    await p.fill('#tfOrigin', 'Chicago (ORD)');
    await p.fill('#tfStart', iso(30));
    await p.fill('#tfEnd', iso(90));
    await p.click('#tfSubmit');
    await p.waitForFunction(() => document.querySelector('#tfOut .tf-fail, #tfOut .tf-card:not(.tf-fail)') && !document.getElementById('tfSubmit').disabled, null, { timeout: 8000 });
    await p.waitForTimeout(100);
    return (await p.textContent('#tfOut')) || '';
  };

  let t = await search(200, JSON.stringify(GOOD));
  ok(/Puerto Morelos/.test(t), 'good reply: trips are shown');
  t = await search(200, JSON.stringify(JSON.stringify(GOOD)));
  ok(/Puerto Morelos/.test(t), 'reply encoded twice (a JSON string): still shown');
  t = await search(200, JSON.stringify([GOOD]));
  ok(/Puerto Morelos/.test(t), 'reply wrapped in a one-item array: still shown');
  t = await search(200, JSON.stringify({ ok: false, error: 'No trips matched those criteria. Try widening your dates, budget or regions.', detail: 'model said nope' }));
  ok(/No trips matched those criteria/.test(t) && warns.some((w) => /model said nope/.test(w)), 'ok:false: the workflow\'s own reason is shown, detail logged');
  t = await search(200, JSON.stringify({ message: 'Workflow was started' }));
  ok(/didn’t send the results back \(code: responded-early\)/.test(t) && warns.some((w) => /Workflow was started/.test(w)), '"Workflow was started": says so (responded-early) and logs the reply');
  t = await search(200, '');
  ok(/code: empty-reply/.test(t) && warns.some((w) => /\(empty body\)/.test(w)), 'empty 200: empty-reply, logged');
  t = await search(200, '<html>oops</html>');
  ok(/code: bad-reply/.test(t) && warns.some((w) => /oops/.test(w)), 'junk 200: bad-reply, raw text logged');
  t = await search(500, JSON.stringify({ message: 'Error in workflow' }));
  ok(/error 500/.test(t) && warns.some((w) => /HTTP 500.*Error in workflow/.test(w)), '500: says error 500 and logs the reply');
  t = await search(200, JSON.stringify(GOOD));
  ok(/Puerto Morelos/.test(t), 'and a good search after all that still works');

  ok(errors.length === 0, 'no JS errors: ' + JSON.stringify(errors));
  await browser.close(); srv.close();
  console.log('ALL ' + passed + ' TRIP-FINDER E2E CHECKS PASSED');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
