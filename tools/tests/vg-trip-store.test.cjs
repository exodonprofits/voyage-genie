// Tests for js/vg-trip-store.js against an in-memory Supabase fake.
// Run: node tools/tests/vg-trip-store.test.cjs
// Balances are computed with the tracker's own functions, extracted from
// trip-cost-tracker.html, so "same balances" means what the page would show.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { createFake } = require('./fake-supabase.cjs');
const root = path.join(__dirname, '..', '..');

// load the store as the browser would
const ctx = { console, URLSearchParams, location: { search: '' } };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'vg-trip-store.js'), 'utf8'), ctx);
const S = ctx.VGTripStore;

// tracker maths
const html = fs.readFileSync(path.join(root, 'trip-cost-tracker.html'), 'utf8');
const grab = (name) => { const i = html.indexOf('function ' + name + '('); let d = 0; const j = html.indexOf('{', i);
  for (let k = j; k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); } } };
const fns = ['normalizeAmount', 'normalizeExpensesList', 'includedHeads', 'perPerson', 'summarize', 'getAdjustedBalances', 'consolidateByPayer'].map(grab).join('\n');
function balances(state) {
  const c = { people: JSON.parse(JSON.stringify(state.people)), expenses: JSON.parse(JSON.stringify(state.expenses)),
              sponsorRules: JSON.parse(JSON.stringify(state.sponsorRules)), Math, Number, Object, Array, String, isFinite, isNaN, parseFloat };
  vm.createContext(c);
  vm.runInContext('const names=()=>people.map(p=>p.name); const byName=(n)=>people.find(p=>p.name===n);' +
    'const personSize=(n)=>Math.max(1, Number(byName(n)?.size)||1);' + fns +
    ';expenses=normalizeExpensesList(expenses); const {bal}=summarize(); const {adjusted}=getAdjustedBalances(bal);' +
    'const {out}=consolidateByPayer(adjusted); result={per:adjusted, byPayer:out};', c);
  const r = {};
  for (const [k, v] of Object.entries(c.result.per)) r[k] = Math.round(v * 100);
  return r;
}

const USER = '00000000-0000-0000-0000-0000000000aa';
let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed++; console.log('ok   ' + label); };

(async () => {
  const { client, db, log } = createFake({ userId: USER });

  // ── a new trip, built the way the tracker builds one ─────────────
  let t = await S.createTrip(client, 'Cancun 2027');
  ok(t.role === 'owner' && t.me && t.me.in_split === false, 'new trip: creator is owner, outside the split');
  ok(t.state.people.length === 0, 'organizer is not shown as a person');

  let st = t.state;
  st.tripTitle = 'Cancun 2027 – Feb 10–17';
  st.tripName = 'Cancun 2027';
  st.tripStart = '2027-02-10'; st.tripEnd = '2027-02-17';
  st.people.push({ name: 'Jimmy', payer: 'Jimmy', size: 1 }, { name: 'Jenny', payer: 'Jimmy', size: 1 },
                 { name: 'Lan-Chau', payer: 'Lan-Chau', size: 2 }, { name: 'Hao', payer: 'Hao', size: 1 });
  st.expenses.push(
    { date: '2027-02-10', desc: 'Villa', category: 'Lodging', paidBy: 'Jimmy', amount: 3000, included: { Jimmy: true, Jenny: true, 'Lan-Chau': true, Hao: true } },
    { date: '2027-02-11', desc: 'Boat', category: 'Fun', paidBy: 'Lan-Chau', amount: 640.5, included: { Jimmy: true, Jenny: false, 'Lan-Chau': 1, Hao: true } },
    { date: '', desc: 'Pot', paidBy: 'Hao', amount: 100, included: { Jimmy: true }, kind: 'budget_transfer' },
    { date: '2027-02-12', desc: 'Refund', paidBy: 'Jimmy', amount: -20, included: { Jimmy: true, Hao: true } });
  st.sponsorRules.push({ label: 'Gift', traveler: 'Hao', sponsors: ['Jimmy', 'Lan-Chau'], mode: 'percent', value: 50 });
  st.settlementMeta['Hao||Jimmy'] = { paid: true, method: 'zelle', paid_at: '2027-02-18T10:00:00Z', paid_cents: 12345 };
  const before = balances(st);
  t = await S.saveTrip(client, t.snapshot, st);
  ok(db.vg_trip_members.length === 5 && db.vg_trip_expenses.length === 4 && db.vg_trip_settlements.length === 1, 'first save writes 4 people + organizer, 4 expenses, 1 payment');
  ok(JSON.stringify(balances(t.state)) === JSON.stringify(before), 'reloaded trip has identical balances (incl. heads, refund, budget transfer, sponsor rule)');
  ok(t.state.people.find((p) => p.name === 'Jenny').payer === 'Jimmy', 'payer relationship survives');
  ok(t.state.tripTitle === 'Cancun 2027 – Feb 10–17' && t.state.tripName === 'Cancun 2027' && t.state.tripEnd === '2027-02-17', 'trip title, short name and dates survive');
  ok(t.state.sponsorRules.length === 1 && t.state.sponsorRules[0].sponsors.join() === 'Jimmy,Lan-Chau', 'sponsor rule survives');
  const m = t.state.settlementMeta['Hao||Jimmy'];
  ok(m && m.paid && m.paid_cents === 12345 && m.method === 'zelle', 'payment survives (amount + method)');
  ok(t.state.expenses.find((e) => e.desc === 'Boat').included['Lan-Chau'] === 1, 'partial heads (1 of 2) survive');
  ok(!('Jenny' in t.state.expenses.find((e) => e.desc === 'Boat').included), '"false" entries are not stored');

  // ── saving again with no changes writes nothing ──────────────────
  let n0 = log.length;
  t = await S.saveTrip(client, t.snapshot, t.state);
  ok(log.length === n0, 'unchanged trip: save writes nothing');

  // ── edits: rename, resize, edit, delete, add ─────────────────────
  st = t.state;
  const jimmyId = st.people.find((p) => p.name === 'Jimmy')._mid;
  const renamed = st.people.find((p) => p.name === 'Jimmy');
  // what renamePerson() in the page does: rename everywhere
  renamed.name = 'Jimmy T';
  st.people.forEach((p) => { if (p.payer === 'Jimmy') p.payer = 'Jimmy T'; });
  st.expenses.forEach((e) => { if (e.paidBy === 'Jimmy') e.paidBy = 'Jimmy T'; if ('Jimmy' in e.included) { e.included['Jimmy T'] = e.included.Jimmy; delete e.included.Jimmy; } });
  st.sponsorRules.forEach((r) => { r.sponsors = r.sponsors.map((s) => (s === 'Jimmy' ? 'Jimmy T' : s)); });
  st.settlementMeta = { 'Hao||Jimmy T': st.settlementMeta['Hao||Jimmy'] };
  st.people.find((p) => p.name === 'Hao').size = 2;
  st.expenses.find((e) => e.desc === 'Villa').amount = 3100;
  st.expenses = st.expenses.filter((e) => e.desc !== 'Refund');
  st.expenses.push({ date: '2027-02-13', desc: 'Dinner', category: 'Food', paidBy: 'Jenny', amount: 410, included: { 'Jimmy T': true, Jenny: true, Hao: 2 } });
  const before2 = balances(st);
  n0 = log.length;
  t = await S.saveTrip(client, t.snapshot, st);
  const writes = log.slice(n0).map((x) => x.op + ':' + (x.table || x.name));
  ok(t.state.people.find((p) => p.name === 'Jimmy T')._mid === jimmyId, 'rename keeps the same member (id unchanged)');
  ok(JSON.stringify(balances(t.state)) === JSON.stringify(before2), 'after rename/resize/edit/delete/add: balances identical');
  ok(writes.filter((w) => w === 'insert:vg_trip_expenses').length === 1 && writes.filter((w) => w === 'delete:vg_trip_expenses').length === 1
     && writes.filter((w) => w === 'update:vg_trip_expenses').length === 1, 'only the changed expenses were written (1 add, 1 edit, 1 delete)');
  ok(writes.filter((w) => w.startsWith('insert:vg_trip_settlements') || w.startsWith('delete:vg_trip_settlements')).length === 0,
     'renaming someone doesn\'t rewrite their payments');

  // ── payments: method change, more paid, unmark ───────────────────
  st = t.state;
  st.settlementMeta['Hao||Jimmy T'].method = 'venmo';
  t = await S.saveTrip(client, t.snapshot, st);
  ok(t.state.settlementMeta['Hao||Jimmy T'].method === 'venmo' && t.state.settlementMeta['Hao||Jimmy T'].paid_cents === 12345, 'changing only the method is saved');
  st = t.state; st.settlementMeta['Hao||Jimmy T'].paid_cents = 20000;
  t = await S.saveTrip(client, t.snapshot, st);
  ok(t.state.settlementMeta['Hao||Jimmy T'].paid_cents === 20000 && db.vg_trip_settlements.length === 1, '"mark remaining paid" updates the amount');
  st = t.state; st.settlementMeta['Hao||Jimmy T'].paid = false;
  t = await S.saveTrip(client, t.snapshot, st);
  ok(!t.state.settlementMeta['Hao||Jimmy T'] && db.vg_trip_settlements.length === 0, 'unmarking removes the payment');

  // ── removing a person who paid: their expenses go first ──────────
  st = t.state;
  st.people = st.people.filter((p) => p.name !== 'Jenny');
  st.expenses = st.expenses.filter((e) => e.paidBy !== 'Jenny');
  st.expenses.forEach((e) => delete e.included.Jenny);
  st.people.forEach((p) => { if (p.payer === 'Jenny') p.payer = p.name; });
  t = await S.saveTrip(client, t.snapshot, st);
  ok(!t.state.people.some((p) => p.name === 'Jenny') && !db.vg_trip_expenses.some((e) => e.description === 'Dinner'), 'person and their expenses removed');

  // ── problems are caught before anything is written ──────────────
  st = t.state;
  n0 = log.length;
  st.people.push({ name: 'hao', payer: 'hao', size: 1 });
  await assert.rejects(S.saveTrip(client, t.snapshot, st), /Two people are called/);
  ok(log.length === n0, 'duplicate name (any case) refused, nothing written');
  st.people.pop();
  st.people.push({ name: 'Newcomer', payer: 'Newcomer', size: 1 });
  st.expenses.push({ desc: 'Mystery', paidBy: '', amount: 5, included: {} });
  n0 = log.length;
  await assert.rejects(S.saveTrip(client, t.snapshot, st), /needs someone who paid/);
  ok(log.length === n0, 'expense without a payer refused before anything is written (even the new person)');
  st.expenses.pop(); st.people.pop();

  // ── "that's me" ──────────────────────────────────────────────────
  await S.linkMe(client, t.snapshot.tripId, t.state.people.find((p) => p.name === 'Jimmy T')._mid);
  t = await S.loadTrip(client, t.snapshot.tripId);
  ok(t.me && t.me.display_name === 'Jimmy T' && t.role === 'owner' && t.me.in_split, 'after "that\'s me" the owner is Jimmy T, in the split');
  ok(t.state.people.length === 3, 'organizer row gone, people unchanged');

  console.log('ALL ' + passed + ' STORE TESTS PASSED');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
