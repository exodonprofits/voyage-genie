// Browser stand-in for supabase-js, used by tracker-gs.e2e.cjs in place of the
// CDN script. GenieSphere (nxgtefbqizvihwikqnaw) gets an in-memory database
// persisted to localStorage, so it survives page reloads; any other project
// (the old Salon Genie client the header still uses) gets an empty stub.
// window.__FAKE_USER (set before load) is the signed-in user id, or null.
(function () {
  'use strict';
  var KEY = 'fake-gs-db';
  function loadDb() {
    try { var d = JSON.parse(localStorage.getItem(KEY)); if (d) return d; } catch (e) {}
    return { vg_trips: [], vg_trip_members: [], vg_trip_expenses: [], vg_trip_settlements: [], shares: {} };
  }
  function saveDb(db) { localStorage.setItem(KEY, JSON.stringify(db)); }
  var clock = Date.now();
  function now() { clock += 1000; return new Date(clock).toISOString(); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function uid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); }
  function user() { return window.__FAKE_USER || null; }

  function builder(table) {
    var op = 'select', payload = null, filters = [], mode = 'many';
    var b = {
      select: function () { return b; },
      insert: function (v) { op = 'insert'; payload = v; return b; },
      update: function (v) { op = 'update'; payload = v; return b; },
      delete: function () { op = 'delete'; return b; },
      eq: function (c, v) { filters.push(function (r) { return r[c] === v; }); return b; },
      in: function (c, arr) { filters.push(function (r) { return arr.indexOf(r[c]) >= 0; }); return b; },
      order: function () { return b; },
      single: function () { mode = 'single'; return b; },
      maybeSingle: function () { mode = 'maybe'; return b; },
      then: function (res, rej) {
        return Promise.resolve().then(function () { try { return run(); } catch (e) { return { data: null, error: { message: e.message } }; } }).then(res, rej);
      }
    };
    function match(r) { return filters.every(function (f) { return f(r); }); }
    function visible(db, r) {
      // crude RLS: signed-in members see their trips' rows
      var me = user(); if (!me) return false;
      var tripId = table === 'vg_trips' ? r.id : r.trip_id;
      return db.vg_trip_members.some(function (m) { return m.trip_id === tripId && m.user_id === me; }) ||
             db.vg_trips.some(function (t) { return t.id === tripId && t.owner_id === me; });
    }
    function run() {
      var db = loadDb(), rows = db[table], out;
      if (op === 'select') {
        out = rows.filter(function (r) { return match(r) && visible(db, r); }).map(clone);
      } else if (op === 'insert') {
        if (!user()) throw new Error('not signed in');
        out = (Array.isArray(payload) ? payload : [payload]).map(function (v) {
          var row = Object.assign({ id: uid(), created_at: now() }, clone(v));
          if (table === 'vg_trip_members') {
            row.role = row.role || 'editor'; row.in_split = row.in_split !== false; row.household_size = row.household_size || 1;
            row.user_id = row.user_id || null; row.payer_member_id = row.payer_member_id || null; row.pay_handles = {};
            if (db.vg_trip_members.some(function (m) { return m.trip_id === row.trip_id && m.display_name.toLowerCase() === row.display_name.toLowerCase(); }))
              throw new Error('duplicate key value violates unique constraint "vg_trip_members_name_uq"');
          }
          if (table === 'vg_trip_settlements') { row.marked_at = now(); row.marked_by = user(); row.confirmed_at = null; }
          if (table === 'vg_trips') { row.settings = row.settings || {}; row.start_date = row.start_date || null; row.end_date = row.end_date || null; }
          rows.push(row);
          if (table === 'vg_trips') {
            db.vg_trip_members.push({ id: uid(), created_at: now(), trip_id: row.id, user_id: row.owner_id, display_name: 'organizer',
              role: 'owner', in_split: true, household_size: 1, payer_member_id: null, pay_handles: {} });
          }
          return clone(row);
        });
      } else if (op === 'update') {
        out = rows.filter(match).map(function (r) { Object.assign(r, clone(payload)); return clone(r); });
      } else {
        var gone = rows.filter(match);
        if (table === 'vg_trip_members') {
          gone.forEach(function (m) {
            if (db.vg_trip_expenses.some(function (e) { return e.paid_by_member_id === m.id; })) throw new Error('member still paid an expense');
          });
          db.vg_trip_settlements = db.vg_trip_settlements.filter(function (s) { return !gone.some(function (m) { return s.from_member_id === m.id || s.to_member_id === m.id; }); });
        }
        db[table] = (table === 'vg_trip_members' ? db.vg_trip_members : rows).filter(function (r) { return !match(r); });
        out = gone.map(clone);
      }
      saveDb(db);
      if (mode === 'single') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'expected one row, got ' + out.length } };
      if (mode === 'maybe') return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }
    return b;
  }

  function rpc(name, args) {
    var db = loadDb(), me = user(), r = { data: null, error: null };
    if (name === 'vg_claim_legacy') r.data = { trips: 0, plans: 0 };
    else if (name === 'vg_link_me') {
      var mine = db.vg_trip_members.find(function (m) { return m.trip_id === args.p_trip && m.user_id === me; });
      var target = db.vg_trip_members.find(function (m) { return m.id === args.p_member && m.trip_id === args.p_trip && !m.user_id; });
      if (!mine || mine.in_split || !target) r.error = { message: 'That person has already joined or isn\'t on this trip' };
      else { db.vg_trip_members = db.vg_trip_members.filter(function (m) { return m.id !== mine.id; }); target.user_id = me; target.role = mine.role; }
    } else if (name === 'vg_create_share') {
      var tok = uid().replace(/-/g, ''); db.shares[tok] = args.p_trip; r.data = tok;
    } else if (name === 'vg_get_shared_trip') {
      var tid = db.shares[args.p_token];
      if (tid) {
        var pick = function (t) { return db[t].filter(function (x) { return x.trip_id === tid; }).map(clone); };
        r.data = { trip: clone(db.vg_trips.find(function (t) { return t.id === tid; })),
                   members: pick('vg_trip_members').map(function (m) { delete m.user_id; delete m.email; delete m.pay_handles; return m; }),
                   expenses: pick('vg_trip_expenses'), settlements: pick('vg_trip_settlements') };
      }
    } else r.error = { message: 'rpc not faked: ' + name };
    saveDb(db);
    return Promise.resolve(r);
  }

  function auth() {
    return {
      getUser: function () { return Promise.resolve({ data: { user: user() ? { id: user(), email: 'owner@test.dev' } : null }, error: null }); },
      getSession: function () { return Promise.resolve({ data: { session: user() ? { user: { id: user(), email: 'owner@test.dev' } } : null }, error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
      signInWithOtp: function () { return Promise.resolve({ data: {}, error: null }); },
      signOut: function () { return Promise.resolve({ error: null }); }
    };
  }
  function emptyQuery() {
    var res = { data: [], error: null };
    var p = new Proxy(function () {}, { get: function (t, k) {
      if (k === 'then') return function (a, b) { return Promise.resolve(res).then(a, b); };
      if (k === 'single' || k === 'maybeSingle') return function () { return Promise.resolve({ data: null, error: null }); };
      return function () { return p; };
    } });
    return p;
  }

  window.supabase = {
    createClient: function (url) {
      if (String(url).indexOf('nxgtefbqizvihwikqnaw') >= 0) return { from: builder, rpc: rpc, auth: auth() };
      return { from: emptyQuery, rpc: function () { return Promise.resolve({ data: null, error: null }); },
               auth: { getUser: function () { return Promise.resolve({ data: { user: null } }); },
                       getSession: function () { return Promise.resolve({ data: { session: null } }); },
                       onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; } } };
    }
  };
})();
