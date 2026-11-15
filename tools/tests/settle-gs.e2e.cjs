// End-to-end: settle up on the cost tracker (Phase 2 step 4), against the fake GenieSphere.
// Run: node tools/tests/settle-gs.e2e.cjs [screenshot-dir]
// Jimmy (owner) is owed $50 by Jenny (member). Jimmy saves his Venmo and Zelle;
// Jenny sees "Pay with Venmo" with the amount, taps "I paid"; Jimmy taps "Got it";
// the trip shows "All settled". Junk handles are not saved.
'use strict';
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.browser.js'), 'utf8');
const OWNER = 'user-owner', JENNY = 'user-jenny';
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
  const backToTab = (p) => p.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });

  // ── setup: Jimmy's trip, Jenny owes him $50, Jenny joins ─────────
  const o = await newPage(OWNER);
  await o.goto(base, { waitUntil: 'load' });
  await o.waitForTimeout(400);
  for (const n of ['Jimmy', 'Jenny']) { await o.fill('#personName', n); await o.evaluate(() => addPerson()); }
  await o.fill('#tripName', 'Tahoe');
  await o.evaluate(() => {
    expenses.length = 0;
    expenses.push({ date: '2027-02-01', desc: 'Cabin', category: '', paidBy: 'Jimmy', amount: 100, included: { Jimmy: true, Jenny: true } });
    renderExpenses(); recalc();
  });
  await o.locator('button[onclick="saveToCloud()"]').first().click();
  await status(o, 'Saved');
  await o.selectOption('#gsLinkMe select', { label: 'Jimmy' });
  await o.click('#gsLinkMe button:has-text("That\'s me")');
  await o.waitForFunction(() => !document.getElementById('gsLinkMe'), null, { timeout: 5000 });

  // Jimmy's payment details, including junk that must not be stored
  await o.waitForSelector('#gsPayDetails', { timeout: 5000 });
  ok(/How people pay you \(Jimmy\)/.test(await o.textContent('#gsPayDetails h3')), 'owner gets "How people pay you" once linked to Jimmy');
  await o.fill('#gsPayDetails input[data-key="venmo"]', '@jimmy-t');
  await o.fill('#gsPayDetails input[data-key="zelle"]', 'jimmy@example.com');
  await o.fill('#gsPayDetails input[data-key="cashapp"]', '$bad tag<script>');
  await o.click('#gsPayDetails button');
  await status(o, 'Payment details saved');
  const jimmyRow = (await db(o)).vg_trip_members.find((m) => m.display_name === 'Jimmy');
  ok(jimmyRow.pay_handles.venmo === 'jimmy-t' && jimmyRow.pay_handles.zelle === 'jimmy@example.com', 'Venmo (without @) and Zelle saved');
  ok(!('cashapp' in jimmyRow.pay_handles), 'an invalid Cash App tag is not saved');

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

  // ── Jenny pays ──────────────────────────────────────────────────
  const card = j.locator('#settlements .settle-card').first();
  const venmo = await card.locator('a:has-text("Pay with Venmo")').getAttribute('href');
  ok(/^https:\/\/venmo\.com\/jimmy-t\?txn=pay&amount=50\.00&note=Tahoe/.test(venmo), 'Jenny gets "Pay with Venmo" for $50.00 to jimmy-t');
  ok(await card.locator('button:has-text("Copy Zelle: jimmy@example.com")').count() === 1, '...and a Copy Zelle button');
  ok(await card.locator('a:has-text("Pay with Cash App")').count() === 0, 'no Cash App button (Jimmy has none)');
  ok(await card.locator('button:has-text("I paid $50.00")').isEnabled() &&
     await j.evaluate(() => [...document.querySelectorAll('#settlements .gs-act, #gsPayDetails .gs-act')].every((el) => getComputedStyle(el).pointerEvents !== 'none')),
     '"I paid", pay buttons and her payment details are clickable for a member (not locked)');
  ok(await card.locator('button:has-text("Got it")').count() === 0, 'Jenny (the payer) cannot confirm');
  ok(await j.locator('#gsPayDetails').isVisible() && /\(Jenny\)/.test(await j.textContent('#gsPayDetails h3')), 'Jenny can add her own payment details');
  if (shots) await card.screenshot({ path: path.join(shots, 'settle-payer.png') });
  await card.locator('select.gs-act').selectOption('venmo');
  await card.locator('button:has-text("I paid")').click();
  await status(j, 'Payment recorded');
  let d = await db(j);
  const jen = d.vg_trip_members.find((m) => m.display_name === 'Jenny'), jim = d.vg_trip_members.find((m) => m.display_name === 'Jimmy');
  const pay = d.vg_trip_settlements.find((s) => s.from_member_id === jen.id && s.to_member_id === jim.id);
  ok(pay && pay.amount_cents === 5000 && pay.method === 'venmo' && !pay.confirmed_at && pay.marked_by === JENNY, 'payment recorded: Jenny → Jimmy $50, Venmo, unconfirmed');
  ok(/waiting for Jimmy to confirm/.test(await j.textContent('#settlements')), 'Jenny sees "waiting for Jimmy to confirm"');
  ok(/All paid · waiting for 1 confirmation/.test(await j.textContent('#settlements')), 'header: all paid, 1 confirmation pending');

  // ── Jimmy confirms ──────────────────────────────────────────────
  await backToTab(o);
  await o.waitForFunction(() => /Got it/.test(document.getElementById('settlements').textContent), null, { timeout: 5000 });
  if (shots) await o.locator('#settlements').screenshot({ path: path.join(shots, 'settle-receiver.png') });
  await o.click('#settlements button:has-text("Got it")');
  await status(o, 'Payment confirmed');
  d = await db(o);
  ok(!!d.vg_trip_settlements.find((s) => s.id === pay.id).confirmed_at, 'Jimmy confirmed the payment');
  ok(/All settled: every payment confirmed/.test(await o.textContent('#settlements')), 'trip shows "All settled"');
  await backToTab(j);
  await j.waitForFunction(() => /Jimmy confirmed \$50\.00/.test(document.getElementById('settlements').textContent), null, { timeout: 5000 });
  ok(true, 'Jenny sees "Jimmy confirmed $50.00"');

  // ── families: Jimmy pays for Jenny; Hao paid the villa ──────────
  const f = await newPage(OWNER);
  await f.goto(base, { waitUntil: 'load' });
  await f.waitForTimeout(400);
  for (const n of ['Jimmy', 'Jenny', 'Hao']) { await f.fill('#personName', n); await f.evaluate(() => addPerson()); }
  await f.fill('#tripName', 'Maui');
  await f.evaluate(() => {
    people.find((x) => x.name === 'Jenny').payer = 'Jimmy';
    expenses.length = 0;
    expenses.push({ date: '2027-04-01', desc: 'Villa', category: '', paidBy: 'Hao', amount: 300, included: { Jimmy: true, Jenny: true, Hao: true } });
    renderExpenses(); recalc();
  });
  await f.evaluate(() => saveToCloud());
  await status(f, 'Saved');
  await f.selectOption('#gsLinkMe select', { label: 'Jimmy' });
  await f.click('#gsLinkMe button:has-text("That\'s me")');
  await f.waitForFunction(() => !document.getElementById('gsLinkMe'), null, { timeout: 5000 });
  const fcard = f.locator('#settlements .settle-card').first();
  ok(/💸 Jimmy \(\+ Jenny\)/.test(await fcard.textContent()) && /\$200\.00/.test(await fcard.textContent()),
     'family: the card says "Jimmy (+ Jenny) pays Hao $200.00"');
  ok(await fcard.locator('button:has-text("I paid $200.00")').count() === 1, '...and Jimmy, the family\'s payer, gets "I paid"');
  await f.click('#gsInviteBtn');
  await f.click('#gsInvitePanel button:has-text("Create invite link")');
  await f.waitForFunction(() => /join=/.test(document.querySelector('#gsInvitePanel input').value), null, { timeout: 5000 });
  const flink = await f.inputValue('#gsInvitePanel input');
  const fj = await newPage(JENNY);
  await fj.goto(flink, { waitUntil: 'load' });
  await fj.waitForSelector('#gsJoinPanel input[name="gsJoinWho"]', { timeout: 5000 });
  await fj.check('#gsJoinPanel label.gs-choice:has-text("Jenny") input');
  await Promise.all([fj.waitForURL(/trip_id=/), fj.click('#gsJoinPanel button:has-text("Join trip")')]);
  await status(fj, "You're on this trip");
  const jcard = fj.locator('#settlements .settle-card').first();
  ok(/Jimmy pays this for your group, including your share/.test(await jcard.textContent()), 'Jenny (covered by Jimmy) is told Jimmy pays her share');
  ok(await jcard.locator('button:has-text("I paid")').count() === 0, '...and gets no "I paid" for it');
  if (shots) await jcard.screenshot({ path: path.join(shots, 'settle-family.png') });
  await f.close(); await fj.close();

  ok(errors.length === 0 && dialogs.length === 0, 'no JS errors or alerts: ' + JSON.stringify(errors.concat(dialogs)));
  await browser.close(); srv.close();
  console.log('ALL ' + passed + ' SETTLE-UP E2E CHECKS PASSED');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
