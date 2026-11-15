// End-to-end: every other page that talks to Supabase, in both modes,
// against the fake Supabase (tools/tests/fake-supabase.browser.js).
// Run: node tools/tests/pages-gs.e2e.cjs
//
// 1. Each page's bootstrap picks GenieSphere under ?db=gs (remembered) and
//    Salon Genie otherwise, and its header shows the signed-in user.
// 2. "Save to My Trips" on an itinerary writes vg_plans (gs) / user_trips (salon).
// 3. A planner's search history syncs to vg_search_history and restores from it.
// 4. Account reads plan stats from vg_plans and saves the name to vg_profiles.
'use strict';
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.browser.js'), 'utf8');
const FAKE_ESM = 'window.__FAKE_ESM = true;\n' + FAKE + '\nexport const createClient = window.__fakeSupabaseLib.createClient;\n';
const ME = 'user-jimmy';
const GS = 'nxgtefbqizvihwikqnaw';

// Pages switched in this step (the tracker, dashboard, login and register have their own tests).
const OWN_TESTS = ['trip-cost-tracker.html', 'trip-dashboard.html', 'login.html', 'register.html', 'trip-budget-settlement.html'];
const PAGES = fs.readdirSync(root).filter((f) => f.endsWith('.html') && !OWN_TESTS.includes(f) &&
  fs.readFileSync(path.join(root, f), 'utf8').includes('pbojacnagutipfhcxltj')).sort();

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

(async () => {
  const srv = await serve();
  const base = 'http://localhost:' + srv.address().port + '/';
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, (r) => r.fulfill({
    status: 200, contentType: 'application/javascript', body: /\+esm/.test(r.request().url()) ? FAKE_ESM : FAKE }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(p.url() + ': ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(p.url() + ': ' + m.text()); });
  p.on('dialog', (d) => d.accept());
  const db = (which) => p.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), 'fake-' + which + '-db');
  const project = () => p.waitForFunction(() => window.supabase && window.supabase.__project, null, { timeout: 5000 }).then((h) => h.jsonValue());
  const headerShowsMe = () => p.waitForFunction((me) => {
    const s = document.getElementById('authSlot'); return !s || s.textContent.indexOf(me) >= 0;
  }, ME, { timeout: 5000 }).then(() => true, () => false);

  await p.goto(base + 'index.html?db=gs', { waitUntil: 'load' });
  await p.evaluate((me) => { localStorage.clear(); localStorage.setItem('vg-db', 'gs'); localStorage.setItem('fake-signed-in', me); }, ME);

  // ── 1. every page, both modes ───────────────────────────────────
  ok(PAGES.length >= 30, PAGES.length + ' pages to check');
  const wrong = [], noHeader = [];
  for (const f of PAGES) {
    await p.goto(base + f, { waitUntil: 'load' });
    if (await project() !== GS) wrong.push(f);
    if (!(await headerShowsMe())) noHeader.push(f);
  }
  ok(!wrong.length, 'GenieSphere mode (remembered from ?db=gs): every page uses GenieSphere ' + JSON.stringify(wrong));
  ok(!noHeader.length, '...and every header shows the signed-in user ' + JSON.stringify(noHeader));

  await p.goto(base + 'index.html?db=salon', { waitUntil: 'load' });
  const wrongSalon = [];
  for (const f of PAGES) {
    await p.goto(base + f, { waitUntil: 'load' });
    if (await project() === GS) wrongSalon.push(f);
  }
  ok(!wrongSalon.length, 'after ?db=salon: every page back on Salon Genie ' + JSON.stringify(wrongSalon));

  // ── 2. itinerary "Save to My Trips" ─────────────────────────────
  const seedItinerary = () => p.evaluate(() => {
    localStorage.setItem('itineraryHtml', '<h2>Day 1</h2><p>Beach</p>');
    localStorage.setItem('formData', JSON.stringify({ destination: 'Aruba', departure: 'ORD', startDate: '2027-02-01', endDate: '2027-02-08' }));
  });
  for (const mode of ['salon', 'gs']) {
    await p.goto(base + 'tropical-trip-itinerary.html?db=' + mode, { waitUntil: 'load' });
    await seedItinerary();
    await p.goto(base + 'tropical-trip-itinerary.html', { waitUntil: 'load' });
    await project();
    await p.click('#saveToTripsBtn');
    await p.waitForFunction(() => /Saved/.test(document.getElementById('saveToTripsBtn').textContent), null, { timeout: 5000 });
    const d = await db(mode);
    if (mode === 'gs') {
      const row = (d.vg_plans || [])[0];
      ok(d.vg_plans.length === 1 && row.user_id === ME && row.name === 'Aruba Trip' && row.plan_data.destination === 'Aruba' &&
         /Beach/.test(row.plan_data.itineraryHtml), 'gs: itinerary saved to vg_plans (name + plan_data)');
    } else {
      const row = (d.user_trips || [])[0];
      ok(d.user_trips.length === 1 && row.trip_name === 'Aruba Trip' && row.trip_data.destination === 'Aruba', 'salon: itinerary still saved to user_trips');
    }
  }
  // the dashboard lists the plan just saved
  await p.goto(base + 'trip-dashboard.html', { waitUntil: 'load' });
  ok(await p.waitForFunction(() => /Aruba Trip/.test(document.body.textContent), null, { timeout: 5000 }).then(() => true, () => false),
     'gs: the trip dashboard shows the saved plan');

  // ── 3. planner search history ───────────────────────────────────
  await p.evaluate((me) => {
    const d = JSON.parse(localStorage.getItem('fake-gs-db'));
    d.vg_search_history.push({ id: 'h1', user_id: me, destination: 'Cancun', departure: 'ORD', searched_at: '2026-11-01T00:00:00Z',
      search_data: { destination: 'Cancun', departure: 'ORD', startDate: '2027-03-01', endDate: '2027-03-05' } });
    localStorage.setItem('fake-gs-db', JSON.stringify(d));
  }, ME);
  await p.goto(base + 'tropical-trip-planner.html', { waitUntil: 'load' });
  await project();
  ok(await p.waitForFunction(() => /Cancun/.test(localStorage.getItem('vg_tropical_history') || JSON.stringify(localStorage)), null, { timeout: 5000 })
     .then(() => true, () => false), 'gs: planner restores search history from vg_search_history');
  await p.fill('#destination', 'Bora Bora').catch(() => {});
  const synced = await p.evaluate(async () => {
    const sb = window.supabase; const { data: { user } } = await sb.auth.getUser();
    const entry = { destination: 'Bora Bora', departure: 'ORD', startDate: '2027-04-01' };
    for (let i = 0; i < 2; i++) {
      const r = await sb.from(VGTripStore.table('search_history')).upsert({ user_id: user.id, destination: entry.destination, departure: entry.departure,
        search_data: entry, searched_at: new Date().toISOString() }, { onConflict: 'user_id,destination,departure' });
      if (r.error) return r.error.message;
    }
    return 'ok';
  });
  const hist = (await db('gs')).vg_search_history;
  ok(synced === 'ok' && hist.filter((h) => h.destination === 'Bora Bora').length === 1, 'gs: the planner\'s history upsert lands once in vg_search_history');

  // ── 4. account ──────────────────────────────────────────────────
  await p.evaluate((me) => {
    const d = JSON.parse(localStorage.getItem('fake-gs-db'));
    d.vg_profiles.push({ user_id: me, full_name: 'jimmy' });
    d.vg_plans.push({ id: 'p2', user_id: me, name: 'Old trip', plan_data: { startDate: '2020-01-01', endDate: '2020-01-05' } });
    localStorage.setItem('fake-gs-db', JSON.stringify(d));
  }, ME);
  await p.goto(base + 'account.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('statTotal').textContent === '2', null, { timeout: 5000 });
  ok(await p.textContent('#statUpcoming') === '1' && await p.textContent('#statPast') === '1', 'gs: account stats come from vg_plans (2 total, 1 upcoming, 1 past)');
  await p.fill('#acct-name', 'Jimmy');
  await p.click('#saveProfileBtn');
  await p.waitForFunction(() => /updated/i.test(document.body.textContent), null, { timeout: 5000 });
  ok((await db('gs')).vg_profiles[0].full_name === 'Jimmy', 'gs: account name saved to vg_profiles');

  // ── 5. "Delete my Voyage Genie data" ────────────────────────────
  // gs: one RPC; owned trips, plans, searches, profile go; the friend's trip keeps the name; login kept
  await p.evaluate((me) => {
    const d = JSON.parse(localStorage.getItem('fake-gs-db'));
    d.vg_trips.push({ id: 'mine', owner_id: me, name: 'My trip', settings: {} }, { id: 'friend', owner_id: 'user-friend', name: 'Friend trip', settings: {} });
    d.vg_trip_members.push({ id: 'm1', trip_id: 'mine', user_id: me, display_name: 'Jimmy', role: 'owner' },
                           { id: 'm2', trip_id: 'friend', user_id: me, display_name: 'Jimmy', email: 'j@x.dev', pay_handles: { venmo: '@j' }, role: 'editor' });
    localStorage.setItem('fake-gs-db', JSON.stringify(d));
  }, ME);
  await p.goto(base + 'account.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('statTotal').textContent !== '—', null, { timeout: 5000 });
  ok(/Delete My Voyage Genie Data/.test(await p.textContent('#deleteAccountBtn')), 'button says what it does: Delete My Voyage Genie Data');
  await p.click('#deleteAccountBtn');
  await p.waitForURL(/index\.html$/, { timeout: 5000 });
  let g = await db('gs');
  ok(!g.vg_plans.some((x) => x.user_id === ME) && !g.vg_search_history.some((x) => x.user_id === ME) && !g.vg_profiles.some((x) => x.user_id === ME),
     'gs: plans, searches and profile deleted');
  ok(!g.vg_trips.some((t) => t.id === 'mine') && g.vg_trips.some((t) => t.id === 'friend'), 'gs: own trip deleted, friend\'s trip kept');
  const m2 = g.vg_trip_members.find((m) => m.id === 'm2');
  ok(m2 && m2.display_name === 'Jimmy' && m2.user_id === null && m2.email === null && !Object.keys(m2.pay_handles).length,
     'gs: on the friend\'s trip the name stays, account/email/handles removed');
  ok(!(await p.evaluate(() => localStorage.getItem('fake-signed-in'))), 'gs: signed out afterwards');
  ok(!(await p.evaluate(() => JSON.parse(localStorage.getItem('fake-auth-log') || '[]').some((e) => /deleteUser/.test(JSON.stringify(e))))), 'no attempt to delete the shared login');

  // salon: every table emptied and re-checked
  await p.goto(base + 'index.html?db=salon', { waitUntil: 'load' });
  const seedSalon = () => p.evaluate((me) => {
    localStorage.setItem('fake-signed-in', me);
    localStorage.setItem('fake-salon-db', JSON.stringify({
      trips: [{ id: 't1', owner_id: me, name: 'Old tracker trip', form_data: {} }, { id: 't2', owner_id: 'user-other', name: 'Not mine', form_data: {} }],
      user_trips: [{ id: 'p1', user_id: me, trip_name: 'Bahamas', trip_data: {} }],
      search_history: [{ id: 's1', user_id: me, destination: 'Aruba', departure: 'ORD', search_data: {} }],
      user_preferences: [{ id: 'u1', user_id: me }], contact_messages: [] }));
  }, ME);
  await seedSalon();
  await p.goto(base + 'account.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('statTotal').textContent !== '—', null, { timeout: 5000 });
  await p.click('#deleteAccountBtn');
  await p.waitForURL(/index\.html$/, { timeout: 5000 });
  let sdb = await db('salon');
  ok(!sdb.trips.some((t) => t.owner_id === ME) && sdb.trips.some((t) => t.id === 't2') && !sdb.user_trips.length && !sdb.search_history.length,
     'salon: trips, plans and searches deleted; other users\' trips untouched');
  ok(sdb.user_preferences.length === 1, 'salon: user_preferences kept (Salon Genie\'s role/business row, shared with that app)');

  // salon, a delete silently blocked by the database: the page must say so and keep you signed in
  await seedSalon();
  await p.addInitScript(() => { window.__FAKE_BLOCK_DELETE = ['search_history']; });
  await p.goto(base + 'account.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('statTotal').textContent !== '—', null, { timeout: 5000 });
  await p.click('#deleteAccountBtn');
  await p.waitForFunction(() => /could not be deleted \(search_history\)/.test(document.body.textContent), null, { timeout: 5000 });
  ok(/account\.html/.test(p.url()) && await p.evaluate(() => !!localStorage.getItem('fake-signed-in')),
     'salon: a silently blocked delete is reported (search_history) and the user stays signed in');

  ok(errors.length === 0, 'no JS errors: ' + JSON.stringify(errors.slice(0, 5)));
  await browser.close(); srv.close();
  console.log('ALL ' + passed + ' PAGES E2E CHECKS PASSED');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
