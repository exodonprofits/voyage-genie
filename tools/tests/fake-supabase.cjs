// Minimal in-memory stand-in for supabase-js, enough for js/vg-trip-store.js:
// from(t).select/insert/update/delete with eq/in/single/maybeSingle, rpc(),
// auth.getUser(). Mimics the vg_trips owner-member trigger. No RLS: the
// database's rules are tested separately in supabase/tests/vg_rls_test.sql.
'use strict';
const crypto = require('crypto');

function createFake({ userId } = {}) {
  const db = { vg_trips: [], vg_trip_members: [], vg_trip_expenses: [], vg_trip_settlements: [] };
  const log = [];
  let clock = Date.parse('2026-11-15T10:00:00Z');
  const now = () => new Date(clock += 1000).toISOString();
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function builder(table) {
    let op = 'select', payload = null, filters = [], mode = 'many', wantRows = false;
    const b = {
      select() { if (op === 'select') op = 'select'; else wantRows = true; return b; },
      insert(v) { op = 'insert'; payload = v; return b; },
      update(v) { op = 'update'; payload = v; return b; },
      delete() { op = 'delete'; return b; },
      eq(c, v) { filters.push((r) => r[c] === v); return b; },
      in(c, arr) { filters.push((r) => arr.includes(r[c])); return b; },
      order() { return b; },
      single() { mode = 'single'; return b; },
      maybeSingle() { mode = 'maybe'; return b; },
      then(res, rej) {
        return Promise.resolve().then(() => { try { return run(); } catch (e) { return { data: null, error: { message: e.message } }; } }).then(res, rej);
      },
    };
    function match(r) { return filters.every((f) => f(r)); }
    function run() {
      const rows = db[table];
      if (!rows) return { data: null, error: { message: 'no table ' + table } };
      let out;
      if (op === 'select') {
        out = rows.filter(match).map(clone);
      } else if (op === 'insert') {
        log.push({ op, table });
        const list = Array.isArray(payload) ? payload : [payload];
        out = list.map((v) => {
          const row = Object.assign({ id: crypto.randomUUID(), created_at: now() }, clone(v));
          if (table === 'vg_trip_members') {
            row.role = row.role || 'editor'; row.in_split = row.in_split !== false;
            row.household_size = row.household_size || 1; row.user_id = row.user_id || null; row.payer_member_id = row.payer_member_id || null;
            const dup = rows.find((m) => m.trip_id === row.trip_id && m.display_name.toLowerCase() === row.display_name.toLowerCase());
            if (dup) throw Object.assign(new Error('duplicate key value violates unique constraint "vg_trip_members_name_uq"'), { fake: true });
          }
          if (table === 'vg_trip_settlements') { row.marked_at = now(); row.confirmed_at = null; }
          if (table === 'vg_trips') { row.settings = row.settings || {}; row.start_date = row.start_date || null; row.end_date = row.end_date || null; }
          rows.push(row);
          if (table === 'vg_trips' && row.owner_id) {
            db.vg_trip_members.push({ id: crypto.randomUUID(), created_at: now(), trip_id: row.id, user_id: row.owner_id,
              display_name: 'organizer', role: 'owner', in_split: true, household_size: 1, payer_member_id: null });
          }
          return clone(row);
        });
      } else if (op === 'update') {
        log.push({ op, table });
        out = rows.filter(match).map((r) => { Object.assign(r, clone(payload)); return clone(r); });
      } else {
        log.push({ op, table });
        const gone = rows.filter(match);
        if (table === 'vg_trip_members') {
          for (const m of gone) {
            if (db.vg_trip_expenses.some((e) => e.paid_by_member_id === m.id)) {
              return { data: null, error: { message: 'violates foreign key constraint (member still paid an expense)' } };
            }
          }
          db.vg_trip_settlements = db.vg_trip_settlements.filter((s) => !gone.some((m) => s.from_member_id === m.id || s.to_member_id === m.id));
          db.vg_trip_members.forEach((m) => { if (gone.some((g) => g.id === m.payer_member_id)) m.payer_member_id = null; });
        }
        db[table] = rows.filter((r) => !match(r));
        out = gone.map(clone);
      }
      if (mode === 'single') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'expected 1 row, got ' + out.length } };
      if (mode === 'maybe') return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }
    return b;
  }

  const client = {
    from: (t) => builder(t),
    rpc: async (name, args) => {
      log.push({ op: 'rpc', name });
      if (name === 'vg_link_me') {
        const me = db.vg_trip_members.find((m) => m.trip_id === args.p_trip && m.user_id === userId);
        const target = db.vg_trip_members.find((m) => m.id === args.p_member && m.trip_id === args.p_trip && !m.user_id);
        if (!me || me.in_split || !target) return { data: null, error: { message: 'cannot link' } };
        db.vg_trip_members = db.vg_trip_members.filter((m) => m.id !== me.id);
        Object.assign(target, { user_id: userId, role: me.role });
        return { data: null, error: null };
      }
      return { data: null, error: { message: 'rpc not faked: ' + name } };
    },
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null }, error: null }) },
  };
  return { client, db, log };
}

module.exports = { createFake };
