// End-to-end: trip-dashboard.html, login.html and register.html in both modes,
// against the fake Supabase (tools/tests/fake-supabase.browser.js).
// Run: node tools/tests/dashboard-auth.e2e.cjs
//
// Salon Genie mode proves the fix for the dashboard overwriting cost-tracker
// trips; GenieSphere mode (?db=gs) proves login, register and the dashboard
// use the vg_ tables.
'use strict';
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.browser.js'), 'utf8');
const FAKE_ESM = 'window.__FAKE_ESM = true;\n' + FAKE + '\nexport const createClient = window.__fakeSupabaseLib.createClient;\n';
const ME = 'user-jimmy';

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

// A cost-tracker trip with everything the old dashboard used to destroy.
const SALON_TRIP = {
  id: '11111111-0000-0000-0000-000000000001', owner_id: ME, name: 'Key West – Jan 24–27, 2026',
  created_at: '2026-01-29T00:00:00Z', updated_at: '2026-01-29T00:00:00Z',
  form_data: {
    tripTitle: 'Key West – Jan 24–27, 2026', tripName: 'Key West', tripStart: '2026-01-24', tripEnd: '2026-01-27',
    people: [{ name: 'Jimmy', payer: 'Jimmy', size: 1 }, { name: 'Jenny', payer: 'Jimmy', size: 1 }, { name: 'Lan-Chau', payer: 'Lan-Chau', size: 2 }],
    expenses: [{ date: '2026-01-26', desc: 'Docks', paidBy: 'Jimmy', amount: 582.68, included: { Jimmy: true, Jenny: true, 'Lan-Chau': true } }],
    settlementMeta: { 'Lan-Chau||Jimmy': { paid: true, method: 'zelle', paid_at: '2026-01-30T00:00:00Z', paid_cents: 29134 } },
    sponsorRules: [{ label: 'Gift', traveler: 'Jenny', sponsors: ['Jimmy'], mode: 'full', value: 0 }]
  }
};
const SALON_PLAN = { id: '22222222-0000-0000-0000-000000000002', user_id: ME, trip_name: 'Bahamas Trip', created_at: '2026-03-21T00:00:00Z', updated_at: '2026-03-21T00:00:00Z',
  trip_data: { name: 'Bahamas Trip', tripType: 'Tropical Resort', destination: 'Bahamas', startDate: '2026-05-30', endDate: '2026-06-06' } };

(async () => {
  const srv = await serve();
  const base = 'http://localhost:' + srv.address().port + '/';
  const browser = await chromium.launch();
  const errors = [];
  async function newContext() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js\/\+esm/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_ESM }));
    await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));
    return ctx;
  }
  async function page(ctx) {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(p.url() + ': ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(p.url() + ': ' + m.text()); });
    return p;
  }
  const db = (p, which) => p.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), 'fake-' + which + '-db');
  const authLog = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('fake-auth-log') || '[]'));

  // ═══ Salon Genie mode: the data-loss fix ═══════════════════════════
  let ctx = await newContext();
  let p = await page(ctx);
  await p.goto(base + 'login.html?db=salon', { waitUntil: 'load' });
  await p.evaluate(({ trip, plan, me }) => {
    localStorage.setItem('fake-salon-db', JSON.stringify({ trips: [trip], user_trips: [plan], user_preferences: [] }));
    localStorage.setItem('fake-signed-in', me);
  }, { trip: SALON_TRIP, plan: SALON_PLAN, me: ME });
  await p.goto(base + 'trip-dashboard.html', { waitUntil: 'load' });
  await p.waitForSelector('#grid [data-action="editTripName"]', { timeout: 8000 });
  ok(await p.locator('#grid .card-title-row').count() === 2, 'Salon: dashboard lists the plan and the cost-tracker trip');

  // rename the cost-tracker trip through the inline editor
  await p.click('#grid [data-action="editTripName"][data-id="legacy_' + SALON_TRIP.id + '"]');
  await p.fill('.rename-popover input', 'Key West Crew – Jan 24–27, 2026');
  await p.click('#_rnSave');
  await p.waitForFunction((id) => JSON.parse(localStorage.getItem('fake-salon-db')).trips.find((t) => t.id === id).name.startsWith('Key West Crew'), SALON_TRIP.id);
  let t = (await db(p, 'salon')).trips.find((x) => x.id === SALON_TRIP.id);
  ok(t.form_data.tripTitle === 'Key West Crew – Jan 24–27, 2026' && t.form_data.tripName === 'Key West Crew', 'Salon: rename updates the title the tracker shows');
  ok(JSON.stringify(t.form_data.people) === JSON.stringify(SALON_TRIP.form_data.people), 'Salon: rename keeps people, sizes and payers (was wiped before)');
  ok(JSON.stringify(t.form_data.settlementMeta) === JSON.stringify(SALON_TRIP.form_data.settlementMeta)
     && JSON.stringify(t.form_data.sponsorRules) === JSON.stringify(SALON_TRIP.form_data.sponsorRules), 'Salon: rename keeps paid marks and sponsor rules');

  // duplicate it
  await p.click('#grid .overflow-toggle[data-id="legacy_' + SALON_TRIP.id + '"]');
  await p.click('#grid [data-action="duplicateTrip"][data-id="legacy_' + SALON_TRIP.id + '"]');
  await p.waitForFunction(() => JSON.parse(localStorage.getItem('fake-salon-db')).trips.length === 2);
  const copy = (await db(p, 'salon')).trips.find((x) => x.id !== SALON_TRIP.id);
  ok(/\(Copy\)$/.test(copy.name) && JSON.stringify(copy.form_data.people) === JSON.stringify(SALON_TRIP.form_data.people)
     && JSON.stringify(copy.form_data.expenses) === JSON.stringify(SALON_TRIP.form_data.expenses), 'Salon: duplicate copies the full trip, not the summary');

  // delete the copy
  await p.waitForSelector('#grid .overflow-toggle[data-id="legacy_' + copy.id + '"]');
  await p.click('#grid .overflow-toggle[data-id="legacy_' + copy.id + '"]');
  await p.click('#grid [data-action="deleteTrip"][data-id="legacy_' + copy.id + '"]');
  await p.click('#confirmOkBtn');
  await p.waitForFunction(() => JSON.parse(localStorage.getItem('fake-salon-db')).trips.length === 1);
  ok(true, 'Salon: delete removes the copy only');
  ok(!(await authLog(p)).some((e) => e.project && e.project !== 'salon'), 'Salon mode never touches GenieSphere');
  await ctx.close();

  // ═══ GenieSphere mode: login, register, dashboard ══════════════════
  ctx = await newContext();
  p = await page(ctx);
  await p.goto(base + 'login.html?db=gs&next=trip-dashboard.html', { waitUntil: 'load' });
  ok(await p.locator('#magicLinkBtn').isVisible(), 'GS: login offers "Email me a sign-in link"');
  await p.fill('#email', 'jimmy@test.dev');
  await p.click('#magicLinkBtn');
  await p.waitForSelector('#alertSuccess.show');
  let log = await authLog(p);
  const otp = log.find((e) => e.call === 'signInWithOtp');
  ok(otp && otp.project === 'nxgtefbqizvihwikqnaw' && /login\.html\?next=trip-dashboard\.html$/.test(otp.options.emailRedirectTo),
     'GS: sign-in link sent through GenieSphere, returning to login with ?next');

  await p.fill('#password', 'correct horse battery');
  await Promise.all([p.waitForURL(/trip-dashboard\.html/, { timeout: 8000 }), p.click('#submitBtn')]);
  log = await authLog(p);
  ok(log.some((e) => e.call === 'signInWithPassword' && e.project === 'nxgtefbqizvihwikqnaw'), 'GS: password sign-in goes to GenieSphere and lands on the dashboard');
  ok((await db(p, 'gs')).vg_profiles.some((r) => r.user_id === ME), 'GS: first sign-in creates the vg_profiles row');
  ok(log.some((e) => e.rpc === 'vg_claim_legacy'), 'GS: sign-in picks up imported trips (vg_claim_legacy)');

  // seed a GenieSphere trip + plan the way the import and tracker leave them
  await p.evaluate((me) => {
    const d = JSON.parse(localStorage.getItem('fake-gs-db'));
    const trip = { id: 'gs-trip-1', owner_id: me, name: 'Saint Petersburg – Jul 4–7, 2026', start_date: '2026-07-04', end_date: '2026-07-07',
                   settings: { tripName: 'Saint Petersburg', sponsorRules: [] }, created_at: '2026-07-16T00:00:00Z', updated_at: '2026-09-07T00:00:00Z' };
    const m = (id, name, extra) => Object.assign({ id, trip_id: trip.id, user_id: null, display_name: name, role: 'editor', in_split: true, household_size: 2, payer_member_id: null, pay_handles: {}, created_at: '2026-07-16T00:00:0' + id.slice(-1) + 'Z' }, extra || {});
    d.vg_trips.push(trip);
    d.vg_trip_members.push(m('m1', 'Jimmy-Jenny', { user_id: me, role: 'owner' }), m('m2', 'Lan-Chau'), m('m3', 'Hao', { household_size: 1 }));
    d.vg_trip_expenses.push({ id: 'e1', trip_id: trip.id, kind: 'expense', paid_by_member_id: 'm1', amount: 2942.44, spent_on: '2026-07-04', description: 'VRBO', category: null, split: { m1: true, m2: true, m3: true }, created_at: 'x' },
                            { id: 'e2', trip_id: trip.id, kind: 'expense', paid_by_member_id: 'm2', amount: 1000, spent_on: '2026-07-05', description: 'Farm', category: null, split: { m1: true, m2: 1 }, created_at: 'y' });
    d.vg_trip_settlements.push({ id: 's1', trip_id: trip.id, from_member_id: 'm3', to_member_id: 'm1', amount_cents: 50000, method: 'zelle', marked_at: '2026-09-07T00:00:00Z', confirmed_at: null });
    d.vg_plans.push({ id: 'gs-plan-1', user_id: me, name: 'Cancun Trip', plan_data: { name: 'Cancun Trip', tripType: 'Tropical Resort', destination: 'Cancun', startDate: '2026-04-21', endDate: '2026-04-26' }, created_at: 'z', updated_at: 'z' });
    localStorage.setItem('fake-gs-db', JSON.stringify(d));
  }, ME);
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('#grid [data-action="editTripName"][data-id="legacy_gs-trip-1"]', { timeout: 8000 });
  ok(await p.locator('#grid .card-title-row').count() === 2, 'GS: dashboard lists the vg_plans plan and the vg_trips trip');
  const cardText = await p.locator('#grid').textContent();
  ok(/Saint Petersburg/.test(cardText) && /Cancun Trip/.test(cardText), 'GS: card titles come from GenieSphere');

  // rename
  await p.click('#grid [data-action="editTripName"][data-id="legacy_gs-trip-1"]');
  await p.fill('.rename-popover input', 'St Pete Crew – Jul 4–7, 2026');
  await p.click('#_rnSave');
  await p.waitForFunction(() => JSON.parse(localStorage.getItem('fake-gs-db')).vg_trips[0].name.startsWith('St Pete Crew'));
  let g = await db(p, 'gs');
  ok(g.vg_trips[0].settings.tripName === 'St Pete Crew' && g.vg_trip_members.length === 3 && g.vg_trip_expenses.length === 2 && g.vg_trip_settlements.length === 1,
     'GS: rename touches only the trip name; people, expenses and payments untouched');

  // duplicate: a real copy through the trip store
  await p.click('#grid .overflow-toggle[data-id="legacy_gs-trip-1"]');
  await p.click('#grid [data-action="duplicateTrip"][data-id="legacy_gs-trip-1"]');
  await p.waitForFunction(() => JSON.parse(localStorage.getItem('fake-gs-db')).vg_trips.length === 2, null, { timeout: 8000 });
  g = await db(p, 'gs');
  const copyTrip = g.vg_trips.find((x) => x.id !== 'gs-trip-1');
  const copyMembers = g.vg_trip_members.filter((m) => m.trip_id === copyTrip.id && m.in_split).map((m) => m.display_name + ':' + m.household_size).sort().join();
  ok(/\(Copy\)$/.test(copyTrip.name) && copyMembers === 'Hao:1,Jimmy-Jenny:2,Lan-Chau:2', 'GS: duplicate copies people and party sizes');
  ok(g.vg_trip_expenses.filter((e) => e.trip_id === copyTrip.id).map((e) => e.amount).sort().join() === '1000,2942.44', 'GS: duplicate copies expenses');

  // delete the copy
  await p.waitForSelector('#grid .overflow-toggle[data-id="legacy_' + copyTrip.id + '"]');
  await p.click('#grid .overflow-toggle[data-id="legacy_' + copyTrip.id + '"]');
  await p.click('#grid [data-action="deleteTrip"][data-id="legacy_' + copyTrip.id + '"]');
  await p.click('#confirmOkBtn');
  await p.waitForFunction(() => JSON.parse(localStorage.getItem('fake-gs-db')).vg_trips.length === 1);
  g = await db(p, 'gs');
  ok(!g.vg_trip_members.some((m) => m.trip_id === copyTrip.id), 'GS: delete removes the copy and its rows');

  // the Cost Tracker button opens the tracker on the GenieSphere trip
  await Promise.all([p.waitForURL(/trip-cost-tracker\.html\?trip_id=gs-trip-1/), p.click('#grid [data-action="viewTrip"][data-id="legacy_gs-trip-1"]')]);
  await p.waitForFunction(() => /Loaded/.test(document.getElementById('cloudStatus').textContent), null, { timeout: 8000 });
  ok(await p.evaluate(() => typeof gs === 'object' && gs !== null && people.length === 3), 'GS: "Cost Tracker" opens the trip in the tracker, still in GenieSphere mode');

  // register
  await p.evaluate(() => localStorage.removeItem('fake-signed-in'));
  await p.goto(base + 'register.html?next=trip-dashboard.html', { waitUntil: 'load' });
  await p.fill('#fullName', 'Lan Nguyen');
  await p.fill('#email', 'lan@test.dev');
  await p.fill('#password', 'a-long-password');
  await p.fill('#confirmPassword', 'a-long-password').catch(() => {});
  const cb = p.locator('input[type=checkbox]').first(); if (await cb.count()) await cb.check();
  await p.locator('button[type=submit]').first().click();
  await p.waitForSelector('#alertSuccess.show');
  log = await authLog(p);
  const su = log.find((e) => e.call === 'signUp');
  ok(su && su.project === 'nxgtefbqizvihwikqnaw' && su.options.data.full_name === 'Lan Nguyen'
     && /login\.html\?next=trip-dashboard\.html$/.test(su.options.emailRedirectTo), 'GS: sign-up goes to GenieSphere with the name and a return link to login');
  await ctx.close();

  // ═══ GenieSphere is the default (cutover 2026-11-15); ?db=salon sticks ═══
  ctx = await newContext();
  p = await page(ctx);
  await p.goto(base + 'login.html', { waitUntil: 'load' });
  ok(await p.locator('#magicLinkBtn').count() === 1, 'default: a fresh browser signs in through GenieSphere (sign-in link offered)');
  ok(!(await p.locator('#googleBtn').isVisible()), 'default: Google button hidden until enabled in GenieSphere');
  await p.goto(base + 'login.html?db=salon', { waitUntil: 'load' });
  await p.goto(base + 'login.html', { waitUntil: 'load' });
  ok(!(await p.locator('#magicLinkBtn').count()) && await p.locator('#googleBtn').isVisible(), '?db=salon switches this browser back to Salon Genie and is remembered');
  await ctx.close();

  ok(errors.length === 0, 'no JS errors: ' + JSON.stringify(errors));
  await browser.close(); srv.close();
  console.log('ALL ' + passed + ' DASHBOARD/LOGIN/REGISTER E2E CHECKS PASSED');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
