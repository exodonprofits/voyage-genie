// End-to-end: invite links on the cost tracker (Phase 2 step 3), against the fake GenieSphere.
// Run: node tools/tests/invites-gs.e2e.cjs [screenshot-dir]
// The owner invites; Jenny joins by claiming her name and adds an expense;
// she can't change the owner's expense; a viewer joins as a new name and is read-only;
// signed-out and expired links show the right message.
'use strict';
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.browser.js'), 'utf8');
const OWNER = 'user-owner', JENNY = 'user-jenny', LAN = 'user-lan';

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
  const balances = (p) => p.evaluate(() => {
    const { bal } = summarize(); const { adjusted } = getAdjustedBalances(bal);
    const o = {}; Object.keys(adjusted).sort().forEach((k) => { o[k] = Math.round(adjusted[k] * 100); }); return o;
  });
  const saved = (p) => p.waitForFunction(() => /Saved/.test(document.getElementById('cloudStatus').textContent), null, { timeout: 5000 });

  // ── 1. owner makes a trip and an invite link ─────────────────────
  let o = await newPage(OWNER);
  await o.goto(base, { waitUntil: 'load' });
  await o.waitForTimeout(400);
  for (const n of ['Jimmy', 'Jenny', 'Hao']) { await o.fill('#personName', n); await o.evaluate(() => addPerson()); }
  await o.fill('#tripName', 'Cancun');
  await o.evaluate(() => {
    expenses.length = 0;
    expenses.push({ date: '2027-03-01', desc: 'Villa', category: '', paidBy: 'Jimmy', amount: 300, included: { Jimmy: true, Jenny: true, Hao: true } });
    renderExpenses(); recalc();
  });
  await o.locator('button[onclick="saveToCloud()"]').first().click();
  await saved(o);
  await o.selectOption('#gsLinkMe select', { label: 'Jimmy' });
  await o.click('#gsLinkMe button:has-text("That\'s me")');
  await o.waitForFunction(() => !document.getElementById('gsLinkMe'), null, { timeout: 5000 });
  ok(await o.locator('#gsInviteBtn').isVisible(), 'owner sees "Invite people"');
  await o.click('#gsInviteBtn');
  await o.click('#gsInvitePanel button:has-text("Create invite link")');
  await o.waitForFunction(() => /join=/.test(document.querySelector('#gsInvitePanel input').value), null, { timeout: 5000 });
  const link = await o.inputValue('#gsInvitePanel input');
  ok(/trip-cost-tracker\.html\?join=inv/.test(link), 'invite link created');
  ok(/Joined: Jimmy/.test(await o.textContent('#gsJoined')) && /Not joined yet: Jenny, Hao/.test(await o.textContent('#gsJoined')),
     'people list says who has joined');
  if (process.argv[2]) await o.screenshot({ path: path.join(process.argv[2], 'invite-owner.png') });

  // ── 2. signed out: the link asks you to sign in and comes back ───
  const anon = await newPage(null);
  await anon.goto(link, { waitUntil: 'load' });
  await anon.waitForSelector('#gsJoinPanel a', { timeout: 5000 });
  const signIn = await anon.getAttribute('#gsJoinPanel a', 'href');
  ok(/^login\.html\?next=/.test(signIn) && decodeURIComponent(signIn).includes('join=inv'), 'signed out: "Sign in to join" returns to the invite');
  await anon.close();

  // ── 3. Jenny joins by claiming her name ──────────────────────────
  let j = await newPage(JENNY);
  await j.goto(link, { waitUntil: 'load' });
  await j.waitForSelector('#gsJoinPanel input[name="gsJoinWho"]', { timeout: 5000 });
  const names = await j.$$eval('#gsJoinPanel label.gs-choice span', (els) => els.map((e) => e.textContent));
  ok(names.includes('Jenny') && names.includes('Hao') && !names.includes('Jimmy'), 'join page lists the names not yet taken');
  if (process.argv[2]) await j.locator('#gsJoinPanel').screenshot({ path: path.join(process.argv[2], 'invite-join.png') });
  await j.check('#gsJoinPanel label.gs-choice:has-text("Jenny") input');
  await Promise.all([j.waitForURL(/trip_id=/), j.click('#gsJoinPanel button:has-text("Join trip")')]);
  await j.waitForFunction(() => /You're on this trip/.test(document.getElementById('cloudStatus').textContent), null, { timeout: 5000 });
  ok(await j.evaluate(() => document.body.classList.contains('vg-member-mode')), 'Jenny is a member: people and payments are the organizer\'s');
  ok(await j.evaluate(() => getComputedStyle(document.getElementById('personName')).pointerEvents === 'none' && getComputedStyle(document.getElementById('tripName')).pointerEvents === 'none'),
     '...people and trip fields really can\'t be clicked (desktop width)');
  ok(await j.evaluate(() => document.querySelector('#expensesBody tr').classList.contains('row-locked')), 'the owner\'s expense is locked for Jenny');
  ok(!(await j.locator('#gsInviteBtn').isVisible()), 'members don\'t get the invite button');

  // she adds her own expense and saves
  await j.evaluate(() => {
    expenses.push({ date: '2027-03-02', desc: 'Boat', category: '', paidBy: 'Jenny', amount: 90, included: { Jimmy: true, Jenny: true, Hao: true } });
    renderExpenses(); recalc(); dirty();
  });
  await j.locator('button[onclick="saveToCloud()"]').first().click();
  await saved(j);
  const db = await j.evaluate(() => JSON.parse(localStorage.getItem('fake-gs-db')));
  const boat = db.vg_trip_expenses.find((e) => e.description === 'Boat');
  ok(boat && boat.created_by === JENNY && db.vg_trip_expenses.length === 2, 'Jenny\'s expense saved as hers');
  ok(!(await j.evaluate(() => document.querySelectorAll('#expensesBody tr')[1].classList.contains('row-locked'))), '...and stays editable for her');

  // she can't change the owner's expense, even by editing state directly
  await j.evaluate(() => { expenses.find((e) => e.desc === 'Villa').amount = 1; dirty(); });
  dialogs.length = 0;
  await j.locator('button[onclick="saveToCloud()"]').first().click();
  await j.waitForFunction(() => /Save failed/.test(document.getElementById('cloudStatus').textContent), null, { timeout: 5000 });
  ok(dialogs.some((d) => /only change or remove expenses you added/.test(d)), 'changing someone else\'s expense is refused');
  const villa = (await j.evaluate(() => JSON.parse(localStorage.getItem('fake-gs-db')))).vg_trip_expenses.find((e) => e.description === 'Villa');
  ok(Number(villa.amount) === 300, '...and nothing was written');
  await j.close();

  // ── 4. the owner sees it when coming back to the tab ─────────────
  await o.evaluate(() => { window.__gsUnsaved = false; Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await o.waitForFunction(() => expenses.length === 2, null, { timeout: 5000 });
  ok(true, 'owner\'s tab picks up Jenny\'s expense on return');
  ok(/Joined: Jimmy, Jenny/.test(await o.textContent('#gsJoined')), '...and shows Jenny as joined');
  const b = await balances(o);
  ok(Object.values(b).reduce((x, y) => x + y, 0) === 0 && Math.abs(b.Hao) === 13000, 'balances include both expenses ($390 split 3 ways)');

  // ── 5. a viewer link, joined as a new name, is read-only ─────────
  await o.click('#gsInviteBtn'); await o.click('#gsInviteBtn');   // close and reopen the panel
  await o.selectOption('#gsInvitePanel select', 'viewer');
  await o.click('#gsInvitePanel button:has-text("Create invite link")');
  await o.waitForFunction(() => /join=/.test(document.querySelector('#gsInvitePanel input').value), null, { timeout: 5000 });
  const viewLink = await o.inputValue('#gsInvitePanel input');
  const l = await newPage(LAN);
  await l.goto(viewLink, { waitUntil: 'load' });
  await l.waitForSelector('#gsJoinPanel input[name="gsJoinWho"]', { timeout: 5000 });
  await l.fill('#gsJoinPanel input.vg-input', 'Lan');
  await Promise.all([l.waitForURL(/trip_id=/), l.click('#gsJoinPanel button:has-text("Join trip")')]);
  await l.waitForFunction(() => /view only/.test(document.getElementById('cloudStatus').textContent), null, { timeout: 5000 });
  ok(await l.evaluate(() => __vg_shared_readonly === true), 'a viewer joins as a new name and sees the trip read-only');
  // opening the invite again just opens the trip
  await Promise.all([l.waitForURL(/trip_id=/), l.goto(viewLink)]);
  ok(true, 'an invite link for a trip you\'re already on just opens the trip');
  await l.close();

  // ── 6. a dead link says so ──────────────────────────────────────
  const x = await newPage(JENNY);
  await x.goto(base + '?join=nope', { waitUntil: 'load' });
  await x.waitForSelector('#gsJoinPanel h3', { timeout: 5000 });
  ok(/expired/.test(await x.textContent('#gsJoinPanel h3')), 'an expired or unknown invite says so');
  await x.close();

  const unexpected = dialogs.filter((d) => !/only change or remove expenses you added/.test(d));
  const realErrors = errors.filter((e) => !/only change or remove expenses you added/.test(e));   // the refused save logs itself
  ok(realErrors.length === 0 && unexpected.length === 0, 'no JS errors or unexpected alerts: ' + JSON.stringify(realErrors.concat(unexpected)));
  await browser.close(); srv.close();
  console.log('ALL ' + passed + ' INVITE E2E CHECKS PASSED');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
