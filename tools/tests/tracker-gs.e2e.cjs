// End-to-end: trip-cost-tracker.html with ?db=gs against a fake GenieSphere.
// Run: node tools/tests/tracker-gs.e2e.cjs [screenshot-dir]
// Uses the page's own functions and buttons; the fake replaces the supabase-js
// CDN script (tools/tests/fake-supabase.browser.js) and persists to
// localStorage so reloads and share links work.
'use strict';
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const shots = process.argv[2] || null;
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.browser.js'), 'utf8');
const OWNER = '00000000-0000-0000-0000-0000000000aa';

function serve() {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };
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
  const base = 'http://localhost:' + srv.address().port + '/trip-cost-tracker.html';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Playwright tries the most recently added route first, so the catch-all goes first
  await ctx.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());   // no other network
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));
  const errors = [];
  const newPage = async (userId) => {
    const p = await ctx.newPage();
    await p.addInitScript((u) => { window.__FAKE_USER = u; }, userId);
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
    p.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    return p;
  };
  const balances = (p) => p.evaluate(() => {
    const { bal } = summarize(); const { adjusted } = getAdjustedBalances(bal);
    const o = {}; Object.keys(adjusted).sort().forEach((k) => { o[k] = Math.round(adjusted[k] * 100); }); return o;
  });

  // ── 1. owner builds a trip in the page ───────────────────────────
  let p = await newPage(OWNER);
  await p.goto(base + '?db=gs', { waitUntil: 'load' });
  await p.waitForTimeout(500);
  ok(await p.evaluate(() => typeof gs === 'object' && gs !== null), 'page is in GenieSphere mode (?db=gs)');
  for (const [name, size] of [['Jimmy', 1], ['Jenny', 1], ['Lan-Chau', 2], ['Hao', 1]]) {
    await p.fill('#personName', name);
    await p.evaluate((s) => { personSizeDraft = s; }, size);
    await p.evaluate(() => addPerson());
  }
  await p.fill('#tripName', 'Key West');
  await p.fill('#tripStart', '2027-01-24');
  await p.fill('#tripEnd', '2027-01-27');
  await p.evaluate(() => {
    expenses.length = 0;
    expenses.push({ date: '2027-01-24', desc: 'Docks', category: 'Food', paidBy: 'Jimmy', amount: 582.68, included: { Jimmy: true, Jenny: true, 'Lan-Chau': true, Hao: true } });
    expenses.push({ date: '2027-01-25', desc: 'Scooter', category: 'Fun', paidBy: 'Lan-Chau', amount: 316.88, included: { Jimmy: true, Jenny: false, 'Lan-Chau': 1, Hao: true } });
    expenses.push({ date: '2027-01-26', desc: 'Car', category: 'Transport', paidBy: 'Hao', amount: 645, included: { Jimmy: true, Hao: true } });
    people.find((x) => x.name === 'Jenny').payer = 'Jimmy';
    renderPeople(); renderExpenses(); recalc();
  });
  // mark the first suggested payment as paid, the way a user does
  const firstPay = p.locator('#settlements .settle-card').first();
  await firstPay.locator('input[type=checkbox]').check();
  const payLabel = await firstPay.locator('.vg-chip').allTextContents();
  const before = await balances(p);
  ok(Object.keys(before).length === 4, 'four people in the split');

  // ── 2. save ───────────────────────────────────────────────────────
  await p.locator('button[onclick="saveToCloud()"]').first().click();
  await p.waitForFunction(() => /Saved/.test(document.getElementById('cloudStatus').textContent), null, { timeout: 5000 });
  const url = p.url();
  ok(/trip_id=/.test(url) && /db=gs/.test(url), 'saved: URL now carries the trip id');
  ok(await p.locator('#gsLinkMe').isVisible(), '"Which person is you?" shown to the organizer');
  if (shots) await p.locator('#gsLinkMe').screenshot({ path: path.join(shots, 'link-me.png') });
  await p.selectOption('#gsLinkMe select', { label: 'Jimmy' });
  await p.click('#gsLinkMe button:has-text("That\'s me")');
  await p.waitForFunction(() => !document.getElementById('gsLinkMe'), null, { timeout: 5000 });
  ok(true, '"That\'s me" linked the owner to Jimmy; banner gone');
  ok(JSON.stringify(await balances(p)) === JSON.stringify(before), 'balances unchanged after save + link');

  // ── 3. reload from the database ─────────────────────────────────
  await p.close();
  p = await newPage(OWNER);
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => /Loaded/.test(document.getElementById('cloudStatus').textContent), null, { timeout: 5000 });
  ok(JSON.stringify(await balances(p)) === JSON.stringify(before), 'reloaded: every balance identical to the cent');
  ok(await p.evaluate(() => people.map((x) => x.name + ':' + x.size + ':' + x.payer).sort().join()) ===
     'Hao:1:Hao,Jenny:1:Jimmy,Jimmy:1:Jimmy,Lan-Chau:2:Lan-Chau', 'people, party sizes and payers reloaded');
  ok(await p.inputValue('#tripName') === 'Key West' && await p.inputValue('#tripEnd') === '2027-01-27', 'trip name and dates reloaded');
  ok(!(await p.locator('#gsLinkMe').count()), 'no "that\'s me" prompt once linked');
  const paidCard = p.locator('#settlements .settle-card', { hasText: payLabel[0].replace(/^\S+\s/, '') }).first();
  ok(await paidCard.locator('input[type=checkbox]').isChecked(), 'paid mark reloaded');
  if (shots) await p.screenshot({ path: path.join(shots, 'reloaded.png'), fullPage: false });

  // ── 4. edit and save again ──────────────────────────────────────
  await p.evaluate(() => { expenses.find((e) => e.desc === 'Car').amount = 700; renderExpenses(); recalc(); });
  const before2 = await balances(p);
  await p.locator('button[onclick="saveToCloud()"]').first().click();
  await p.waitForFunction(() => /Saved/.test(document.getElementById('cloudStatus').textContent), null, { timeout: 5000 });
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => /Loaded/.test(document.getElementById('cloudStatus').textContent), null, { timeout: 5000 });
  ok(await p.evaluate(() => expenses.find((e) => e.desc === 'Car').amount) === 700 &&
     JSON.stringify(await balances(p)) === JSON.stringify(before2), 'edit saved and reloaded');
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('fake-gs-db')).vg_trip_expenses.length) === 3, 'still 3 expense rows (edit updated, no duplicates)');

  // ── 5. read-only share link, signed out ─────────────────────────
  const share = await p.evaluate(() => createPublicShareLink(false));
  ok(share && /share=/.test(share.url) && /db=gs/.test(share.url), 'share link created');
  const anon = await newPage(null);
  await anon.goto(share.url, { waitUntil: 'load' });
  await anon.waitForTimeout(800);
  ok(/read/i.test(await anon.textContent('#cloudStatus')), 'signed-out visitor sees the read-only trip');
  ok(JSON.stringify(await balances(anon)) === JSON.stringify(before2), 'shared view shows the same balances');
  ok(await anon.evaluate(() => __vg_shared_readonly === true), 'shared view cannot save');

  // ── 6. the old backend is untouched without ?db=gs ──────────────
  const old = await newPage(OWNER);
  await old.goto(base + '?db=salon', { waitUntil: 'load' });   // ?db=salon also forgets the remembered choice
  ok(await old.evaluate(() => gs === null), 'with ?db=salon the page uses Salon Genie again');
  await old.goto(base, { waitUntil: 'load' });
  ok(await old.evaluate(() => gs === null), '...and stays on Salon Genie on the next visit');

  ok(errors.length === 0, 'no JS errors or alerts: ' + JSON.stringify(errors));
  await browser.close(); srv.close();
  console.log('ALL ' + passed + ' TRACKER E2E CHECKS PASSED');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
