// Balance-match test for the legacy import. Usage:
//   node supabase/tests/balance_match.cjs <export bundle.json> <imported rows.json>
// bundle = output of supabase/legacy/export_from_salon_genie.sql (the "bundle" value)
// rows   = output of supabase/legacy/rows_for_balance_check.sql run after the import
// Runs the tracker's own maths (extracted from trip-cost-tracker.html) on both and
// fails if any person's balance differs by a cent or more.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'trip-cost-tracker.html'), 'utf8');
const grab = (name) => { const i = src.indexOf('function ' + name + '('); let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const fns = ['normalizeAmount', 'normalizeExpensesList', 'includedHeads', 'perPerson', 'summarize', 'getAdjustedBalances', 'consolidateByPayer'].map(grab).join('\n');
function compute(people, expenses, sponsorRules) {
  const ctx = { people, expenses, sponsorRules, Math, Number, Object, Array, String, isFinite, isNaN, parseFloat };
  vm.createContext(ctx);
  vm.runInContext(`const names=()=>people.map(p=>p.name); const byName=(n)=>people.find(p=>p.name===n);
    const personSize=(n)=>Math.max(1, Number(byName(n)?.size)||1); ${fns}
    expenses = normalizeExpensesList(expenses);
    const {bal} = summarize(); const {adjusted} = getAdjustedBalances(bal); const {out} = consolidateByPayer(adjusted);
    result = {perPerson: adjusted, byPayer: out};`, ctx);
  return ctx.result;
}
const pagePeople = (raw) => (Array.isArray(raw) ? raw : []).map(p => typeof p === 'string' ? { name: p, payer: p, size: 1 }
  : { name: p.name, payer: p.payer || p.name, size: Math.max(1, Number(p.size) || 1) });
const bundle = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const rows = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
let bad = 0, compared = 0;
for (const t of bundle.trips) {
  const fd = t.form_data || {};
  const r = rows.find(x => x.legacy_id === t.legacy_id);
  // original, exactly as the page loads it
  const before = compute(pagePeople(fd.people), fd.expenses, Array.isArray(fd.sponsorRules) ? fd.sponsorRules : []);
  // rebuilt from rows; member display names map back to the original names
  const members = r.members || [];
  const byId = Object.fromEntries(members.map(m => [m.id, m]));
  const origName = (m) => (fd.people || []).map(p => typeof p === 'string' ? p : p.name)
    .find(n => n && n.trim().replace(/\s+/g, ' ').slice(0, 60) === m.name) ?? m.name;
  const people = members.map(m => ({ name: origName(m), payer: m.payer ? origName(byId[m.payer]) : origName(m), size: m.size }));
  const expenses = (r.expenses || []).map(e => ({ paidBy: origName(byId[e.paid_by]), amount: Number(e.amount), kind: e.kind,
    included: Object.fromEntries(Object.entries(e.split).map(([id, v]) => [origName(byId[id]), v])) }));
  const rules = ((r.settings || {}).sponsorRules || []).map(x => ({ ...x, traveler: origName(byId[x.traveler]), sponsors: x.sponsors.map(s => origName(byId[s])) }));
  const after = compute(people, expenses, rules);
  const keys = new Set([...Object.keys(before.perPerson), ...Object.keys(after.perPerson)]);
  let worst = 0;
  for (const k of keys) worst = Math.max(worst, Math.abs((before.perPerson[k] || 0) - (after.perPerson[k] || 0)));
  for (const k of new Set([...Object.keys(before.byPayer), ...Object.keys(after.byPayer)]))
    worst = Math.max(worst, Math.abs((before.byPayer[k] || 0) - (after.byPayer[k] || 0)));
  const ok = worst < 0.005 && keys.size === Object.keys(after.perPerson).length;
  compared += keys.size; if (!ok) bad++;
  console.log((ok ? 'MATCH ' : 'DIFF  ') + t.legacy_id.slice(0, 8), 'people', keys.size, 'largest difference $' + worst.toFixed(4));
}
console.log(bad ? `${bad} trip(s) differ` : `ALL ${bundle.trips.length} TRIPS MATCH TO THE CENT (${compared} people compared)`);
process.exit(bad ? 1 : 0);
