// End-to-end: the phone-friendly quick add on the cost tracker, against the fake GenieSphere.
// Run: node tools/tests/quickadd-gs.e2e.cjs [screenshot-dir]
// At phone width: the owner taps "+ Expense", enters $60 paid by them, split two ways, and it saves to the cloud.
// A member (Jenny) quick-adds her own expense, defaulting to "paid by Jenny". A viewer gets no button.
'use strict';
const { chromium, devices } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.browser.js'), 'utf8');
const OWNER = 'user-owner', JENNY = 'user-jenny', LAN = 'user-lan';
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
  const base = 'http://localhost:' + srv.address().port + '/trip-cost-tracker.html';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));
  const errors = [], dialogs = [];
  const newPage = async (userId) => {
    const p = await ctx.newPage();
    await p.addInitScript((u) => { window.__FAKE_USER = u; }, userId);
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
    p.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    return p;
  };
  const db = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('fake-gs-db')));
  const status = (p, re) => p.waitForFunction((s) => new RegExp(s).test(document.getElementById('cloudStatus').textContent), re, { timeout: 5000 });

  // ── owner: a saved trip with Jimmy, Jenny, Hao ───────────────────
  const o = await newPage(OWNER);
  await o.goto(base, { waitUntil: 'load' });
  await o.waitForTimeout(400);
  for (const n of ['Jimmy', 'Jenny', 'Hao']) { await o.fill('#personName', n); await o.evaluate(() => addPerson()); }
  await o.fill('#tripName', 'Miami');
  await o.evaluate(() => { expenses.length = 0; renderExpenses(); recalc(); });
  await o.evaluate(() => saveToCloud());
  await status(o, 'Saved');
  await o.selectOption('#gsLinkMe select', { label: 'Jimmy' });
  await o.click('#gsLinkMe button:has-text("That\'s me")');
  await o.waitForFunction(() => !document.getElementById('gsLinkMe'), null, { timeout: 5000 });

  ok(await o.locator('#qaFab').isVisible(), 'phone: floating "+ Expense" button shows');
  await o.click('#qaFab');
  await o.waitForSelector('#qaSheet');
  ok(await o.inputValue('#qaPaidBy') === 'Jimmy', 'who paid defaults to you (Jimmy)');
  ok(await o.locator('#qaSplit .qa-chip.on').count() === 4, 'everyone is in the split by default');
  ok(await o.getAttribute('#qaAmount', 'inputmode') === 'decimal', 'amount opens the number keypad');
  await o.fill('#qaAmount', 'abc'); await o.click('#qaSave');
  ok(/Enter an amount/.test(await o.textContent('#qaErr')) && await o.evaluate(() => expenses.length) === 0, 'junk amount: asks again, nothing added');
  await o.fill('#qaAmount', '');
  // validation
  await o.click('#qaSave');
  ok(/Enter an amount/.test(await o.textContent('#qaErr')), 'no amount: asks for one, nothing added');
  await o.fill('#qaAmount', '60');
  await o.fill('#qaDesc', 'Uber to beach');
  await o.click('#qaSplit .qa-chip:has-text("Hao")');   // Hao wasn't there
  ok(await o.locator('#qaSplit .qa-all').textContent() === 'Everyone', '"Everyone" un-ticks when someone is left out');
  if (shots) await o.screenshot({ path: path.join(shots, 'quickadd-sheet.png') });
  await o.click('#qaSave');
  await o.waitForFunction(() => !document.getElementById('qaOverlay'), null, { timeout: 5000 });
  await status(o, 'Saved');
  let d = await db(o);
  const uber = d.vg_trip_expenses.find((e) => e.description === 'Uber to beach');
  ok(uber && Number(uber.amount) === 60, 'saved straight to the cloud: $60 "Uber to beach"');
  const bal = await o.evaluate(() => { const { bal } = summarize(); const o = {}; Object.keys(bal).forEach((k) => { o[k] = Math.round(bal[k] * 100); }); return o; });
  ok(bal.Jimmy === -3000 && bal.Jenny === 3000 && bal.Hao === 0, 'split 2 ways, Hao left out: Jenny owes Jimmy $30');
  ok(await o.evaluate(() => expenses[0].date === qaToday()), 'date defaults to today');

  // Escape closes without adding
  await o.click('#qaFab'); await o.waitForSelector('#qaSheet');
  await o.fill('#qaAmount', '5');
  await o.keyboard.press('Escape');
  ok(!(await o.locator('#qaOverlay').count()) && await o.evaluate(() => expenses.length) === 1, 'Escape closes the sheet without adding');

  // ── Jenny (editor) ──────────────────────────────────────────────
  await o.evaluate(() => { window.scrollTo(0, 0); });
  await o.click('#gsInviteBtn');
  await o.click('#gsInvitePanel button:has-text("Create invite link")');
  await o.waitForFunction(() => /join=/.test(document.querySelector('#gsInvitePanel input').value), null, { timeout: 5000 });
  const link = await o.inputValue('#gsInvitePanel input');
  const j = await newPage(JENNY);
  await j.goto(link, { waitUntil: 'load' });
  await j.waitForSelector('#gsJoinPanel input[name="gsJoinWho"]', { timeout: 5000 });
  await j.check('#gsJoinPanel label.gs-choice:has-text("Jenny") input');
  await Promise.all([j.waitForURL(/trip_id=/), j.click('#gsJoinPanel button:has-text("Join trip")')]);
  await status(j, "You're on this trip");
  ok(await j.locator('#qaFab').isVisible(), 'member sees "+ Expense"');
  await j.click('#qaFab'); await j.waitForSelector('#qaSheet');
  ok(await j.inputValue('#qaPaidBy') === 'Jenny', '...and "who paid" defaults to Jenny');
  await j.fill('#qaAmount', '45,5'); await j.fill('#qaDesc', 'Groceries');   // "45,5": comma keyboards
  await j.selectOption('#qaCat', '🛒 Shopping');
  await j.click('#qaSave');
  await j.waitForFunction(() => !document.getElementById('qaOverlay'), null, { timeout: 5000 });
  await status(j, 'Saved');
  d = await db(j);
  const gro = d.vg_trip_expenses.find((e) => e.description === 'Groceries');
  ok(gro && gro.created_by === JENNY && Number(gro.amount) === 45.5 && d.vg_trip_expenses.length === 2, 'Jenny\'s quick add is saved as hers ("45,5" read as $45.50)');
  if (shots) await j.screenshot({ path: path.join(shots, 'quickadd-member.png') });
  await j.close();

  // ── viewer: no button ───────────────────────────────────────────
  await o.click('#gsInviteBtn'); await o.click('#gsInviteBtn');
  await o.selectOption('#gsInvitePanel select', 'viewer');
  await o.click('#gsInvitePanel button:has-text("Create invite link")');
  await o.waitForFunction((prev) => document.querySelector('#gsInvitePanel input').value && document.querySelector('#gsInvitePanel input').value !== prev, link, { timeout: 5000 });
  const viewLink = await o.inputValue('#gsInvitePanel input');
  const l = await newPage(LAN);
  await l.goto(viewLink, { waitUntil: 'load' });
  await l.waitForSelector('#gsJoinPanel input[name="gsJoinWho"]', { timeout: 5000 });
  await l.fill('#gsJoinPanel input.vg-input', 'Lan');
  await Promise.all([l.waitForURL(/trip_id=/), l.click('#gsJoinPanel button:has-text("Join trip")')]);
  await status(l, 'view only');
  await l.waitForTimeout(1200);
  ok(!(await l.locator('#qaFab').isVisible()), 'a viewer gets no "+ Expense" button');
  await l.close();

  ok(errors.length === 0 && dialogs.length === 0, 'no JS errors or alerts: ' + JSON.stringify(errors.concat(dialogs)));
  await browser.close(); srv.close();
  console.log('ALL ' + passed + ' QUICK-ADD E2E CHECKS PASSED');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
