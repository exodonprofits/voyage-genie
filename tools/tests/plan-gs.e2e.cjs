// End-to-end: a saved plan becomes a cost-tracker trip ("Track costs"), against the fake GenieSphere.
// Run: node tools/tests/plan-gs.e2e.cjs [screenshot-dir]
// The dashboard's plan card opens the tracker with the plan's name, dates, planned budget and the
// people/expenses from the plan's old mini log; a second click reopens the same trip; the budget bar
// tracks spending; the itinerary page offers "Track costs" right after saving; signed-out users are asked to sign in.
'use strict';
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.browser.js'), 'utf8');
const FAKE_ESM = 'window.__FAKE_ESM = true;\n' + FAKE + '\nexport const createClient = window.__fakeSupabaseLib.createClient;\n';
const ME = 'user-owner';
const shots = process.argv[2] || null;

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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: /\+esm/.test(r.request().url()) ? FAKE_ESM : FAKE }));
  const errors = [], dialogs = [];
  const newPage = async (userId) => {
    const p = await ctx.newPage();
    await p.addInitScript((u) => { window.__FAKE_USER = u; }, userId);
    p.on('pageerror', (e) => errors.push(p.url() + ': ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(p.url() + ': ' + m.text()); });
    p.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    return p;
  };
  const db = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('fake-gs-db')));
  const status = (p, re) => p.waitForFunction((s) => new RegExp(s).test(document.getElementById('cloudStatus').textContent), re, { timeout: 5000 });

  const p = await newPage(ME);
  await p.goto(base + 'index.html', { waitUntil: 'load' });
  await p.evaluate((me) => {
    localStorage.setItem('fake-gs-db', JSON.stringify({
      vg_trips: [], vg_trip_members: [], vg_trip_expenses: [], vg_trip_settlements: [], vg_profiles: [], vg_search_history: [], vg_contact_messages: [], shares: {},
      vg_plans: [{ id: 'plan-cancun', user_id: me, name: 'Cancun Getaway', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
        plan_data: { tripType: 'Tropical Trip', name: 'Cancun Getaway', destination: 'Cancun', startDate: '2027-03-01', endDate: '2027-03-08',
                     budget: '3000', groupSize: '3', participants: ['Jimmy'], expenses: [{ date: '2027-02-01', desc: 'Deposit', paidBy: 'Jimmy', amount: 500 }] } }]
    }));
  }, ME);

  // ── 1. dashboard → Track costs → a new trip from the plan ───────
  await p.goto(base + 'trip-dashboard.html', { waitUntil: 'domcontentloaded' });
  const track = p.locator('button[data-action="trackCosts"][data-id="plan-cancun"]');
  await track.waitFor({ timeout: 5000 });
  ok(/Track costs/.test(await track.textContent()), 'plan card has "💰 Track costs" (not the old in-plan expense log)');
  await Promise.all([p.waitForURL(/trip-cost-tracker\.html\?trip_id=/, { timeout: 8000 }), track.click()]);
  await status(p, 'Trip created from your plan');
  let d = await db(p);
  const trip = d.vg_trips[0];
  ok(d.vg_trips.length === 1 && trip.plan_id === 'plan-cancun' && trip.destination === 'Cancun' && trip.settings.plannedBudget === 3000,
     'one trip created, linked to the plan, with destination and planned budget');
  ok(await p.inputValue('#tripStart') === '2027-03-01' && await p.inputValue('#tripEnd') === '2027-03-08', 'dates filled in from the plan');
  ok(await p.evaluate(() => people.map((x) => x.name).join() === 'Jimmy' && expenses.length === 1 && expenses[0].desc === 'Deposit'),
     'the plan\'s old log came along: Jimmy and the $500 Deposit');
  ok(/Planned budget \$3,000\.00 · spent \$500\.00 · \$2,500\.00 left/.test(await p.textContent('#gsPlanBar')), 'Step 3 shows planned budget vs spent');
  ok(/plan is for 3 travelers · 1 added so far/.test(await p.textContent('#gsPlanHint')), 'Step 1 hint: plan was for 3, 1 added');

  // adding people and spending updates both
  for (const n of ['Jenny', 'Hao']) { await p.fill('#personName', n); await p.evaluate(() => addPerson()); }
  ok(!(await p.locator('#gsPlanHint').count()), 'hint goes away once all 3 travelers are in');
  await p.evaluate(() => { expenses.push({ date: '2027-03-02', desc: 'Villa', category: '', paidBy: 'Jenny', amount: 2700, included: { Jimmy: true, Jenny: true, Hao: true } }); renderExpenses(); recalc(); dirty(); });
  ok(/spent \$3,200\.00 · \$200\.00 over/.test(await p.textContent('#gsPlanBar')) && await p.locator('#gsPlanBar .gs-plan-fill.over').count() === 1,
     'over budget: says "$200.00 over" in coral');
  await p.evaluate(() => saveToCloud());
  await status(p, 'Saved');
  if (shots) await p.locator('#panel-summary').screenshot({ path: path.join(shots, 'plan-budget-bar.png') });
  ok((await db(p)).vg_trips[0].settings.plannedBudget === 3000, 'planned budget survives the owner saving the trip');

  // ── 2. second click opens the same trip ─────────────────────────
  await p.goto(base + 'trip-dashboard.html', { waitUntil: 'domcontentloaded' });
  await track.waitFor({ timeout: 5000 });
  ok(/Open costs/.test(await track.textContent()), 'plan card now says "Open costs"');
  await Promise.all([p.waitForURL(/trip_id=/, { timeout: 8000 }), track.click()]);
  await status(p, 'already has a trip');
  d = await db(p);
  ok(d.vg_trips.length === 1 && new URL(p.url()).searchParams.get('trip_id') === trip.id && await p.evaluate(() => expenses.length) === 2,
     '...the same trip, no duplicate, with both expenses');

  // ── 3. itinerary: Save to My Trips → Track costs link ──────────
  await p.evaluate(() => {
    localStorage.setItem('itineraryHtml', '<h2>Day 1</h2><p>Beach</p>');
    localStorage.setItem('formData', JSON.stringify({ destination: 'Aruba', startDate: '2027-05-01', endDate: '2027-05-06', budget: '2000', groupSize: '2' }));
  });
  await p.goto(base + 'tropical-trip-itinerary.html', { waitUntil: 'load' });
  await p.click('#saveToTripsBtn');
  await p.waitForSelector('#vgTrackCosts', { timeout: 5000 });
  const aruba = (await db(p)).vg_plans.find((x) => /Aruba/.test(x.name));
  ok(aruba && (await p.getAttribute('#vgTrackCosts', 'href')) === 'trip-cost-tracker.html?from_plan=' + aruba.id, 'after saving a plan: "Track costs for this trip" links to it');
  if (shots) await p.locator('#vgTrackCosts').screenshot({ path: path.join(shots, 'plan-track-link.png') });
  await Promise.all([p.waitForURL(/trip_id=/, { timeout: 8000 }), p.click('#vgTrackCosts')]);
  await status(p, 'Trip created from your plan');
  ok(await p.evaluate(() => !people.length && /plan is for 2 travelers · 0 added/.test(document.getElementById('gsPlanHint').textContent)),
     'a plan with no log starts with no people, and asks for 2');

  // ── 4. signed out / not yours ───────────────────────────────────
  const anon = await newPage(null);
  await anon.goto(base + 'trip-cost-tracker.html?from_plan=plan-cancun', { waitUntil: 'load' });
  await anon.waitForSelector('#gsPlanPanel a', { timeout: 5000 });
  ok(decodeURIComponent(await anon.getAttribute('#gsPlanPanel a', 'href')).includes('next=trip-cost-tracker.html?from_plan=plan-cancun'), 'signed out: sign in and come back to the plan');
  await anon.close();
  const other = await newPage('user-someone-else');
  await other.goto(base + 'trip-cost-tracker.html?from_plan=plan-cancun', { waitUntil: 'load' });
  await other.waitForFunction(() => /Couldn't start tracking/.test((document.getElementById('gsPlanPanel') || {}).textContent || ''), null, { timeout: 5000 });
  ok((await db(other)).vg_trips.length === 2, 'someone else\'s plan: refused, no trip created');
  await other.close();

  const realErrors = errors.filter((e) => !/plan was not found/.test(e));
  ok(realErrors.length === 0 && dialogs.length === 0, 'no JS errors or alerts: ' + JSON.stringify(realErrors.concat(dialogs)));
  await browser.close(); srv.close();
  console.log('ALL ' + passed + ' PLAN-TO-TRIP E2E CHECKS PASSED');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
