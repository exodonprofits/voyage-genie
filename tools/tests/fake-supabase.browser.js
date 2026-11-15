// Browser stand-in for supabase-js, used by the e2e tests in place of the CDN.
// Serves both the global build (window.supabase) and, when window.__FAKE_ESM
// is set before it runs, the module build (export createClient).
//
// Each project gets an in-memory database persisted to localStorage, so data
// survives reloads: GenieSphere (nxgtefbqizvihwikqnaw) with the vg_ tables,
// Salon Genie (pbojacnagutipfhcxltj) with trips / user_trips / user_preferences.
// Crude row security: you see rows of trips you're on (GenieSphere) or rows
// you own (Salon Genie). The real rules are tested in supabase/tests.
//
// Signed-in user: window.__FAKE_USER if set (string id, or null for signed
// out), else whoever signed in through signInWithPassword on this origin.
// Auth calls are recorded in localStorage 'fake-auth-log' for assertions.
(function () {
  'use strict';
  var GS = 'nxgtefbqizvihwikqnaw';
  function dbKey(project) { return 'fake-' + (project === GS ? 'gs' : 'salon') + '-db'; }
  function emptyDb(project) {
    return project === GS
      ? { vg_trips: [], vg_trip_members: [], vg_trip_expenses: [], vg_trip_settlements: [], vg_plans: [], vg_profiles: [], vg_search_history: [], vg_contact_messages: [], shares: {} }
      : { trips: [], user_trips: [], user_preferences: [], search_history: [], contact_messages: [] };
  }
  function loadDb(project) {
    try { var d = JSON.parse(localStorage.getItem(dbKey(project))); if (d) return d; } catch (e) {}
    return emptyDb(project);
  }
  function saveDb(project, db) { localStorage.setItem(dbKey(project), JSON.stringify(db)); }
  var clock = Date.now();
  function now() { clock += 1000; return new Date(clock).toISOString(); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function uid() { return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); }
  function logAuth(entry) {
    var l = []; try { l = JSON.parse(localStorage.getItem('fake-auth-log')) || []; } catch (e) {}
    l.push(entry); localStorage.setItem('fake-auth-log', JSON.stringify(l));
  }
  function user() {
    if (window.__FAKE_USER !== undefined) return window.__FAKE_USER;
    return localStorage.getItem('fake-signed-in') || null;
  }

  function builder(project, table) {
    var op = 'select', payload = null, filters = [], mode = 'many', conflict = null, max = null;
    var b = {
      select: function () { return b; },
      insert: function (v) { op = 'insert'; payload = v; return b; },
      update: function (v) { op = 'update'; payload = v; return b; },
      upsert: function (v, o) { op = 'insert'; payload = v; conflict = ((o && o.onConflict) || 'id').split(','); return b; },
      limit: function (n) { max = n; return b; },
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
      var me = user(); if (!me) return false;
      if (table === 'contact_messages') return false;
      if (project !== GS) return r.owner_id === me || r.user_id === me;
      if (table === 'vg_plans' || table === 'vg_profiles' || table === 'vg_search_history') return r.user_id === me;
      if (table === 'vg_contact_messages') return false;
      var tripId = table === 'vg_trips' ? r.id : r.trip_id;
      return db.vg_trip_members.some(function (m) { return m.trip_id === tripId && m.user_id === me; }) ||
             db.vg_trips.some(function (t) { return t.id === tripId && t.owner_id === me; });
    }
    function run() {
      var db = loadDb(project), rows = db[table], out;
      if (!rows) throw new Error('relation "' + table + '" does not exist');
      if (op === 'select') {
        out = rows.filter(function (r) { return match(r) && visible(db, r); }).map(clone);
        if (max !== null) out = out.slice(0, max);
      } else if (op === 'insert') {
        if (!user() && !/contact_messages$/.test(table)) throw new Error('not signed in');
        out = (Array.isArray(payload) ? payload : [payload]).map(function (v) {
          if (conflict) {
            var same = rows.find(function (r) { return conflict.every(function (c) { return r[c] === v[c]; }); });
            if (same) { Object.assign(same, clone(v)); return clone(same); }
          }
          var row = Object.assign({ id: uid(), created_at: now(), updated_at: now() }, clone(v));
          if (table === 'vg_profiles') { delete row.id; if (rows.some(function (r) { return r.user_id === row.user_id; })) throw new Error('duplicate key'); }
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
        out = rows.filter(function (r) { return match(r) && (project === GS ? (table !== 'vg_trips' || r.owner_id === user()) : visible(db, r)); })
                  .map(function (r) { Object.assign(r, clone(payload)); r.updated_at = now(); return clone(r); });
      } else {
        var gone = rows.filter(function (r) { return match(r) && (project === GS ? (table !== 'vg_trips' || r.owner_id === user()) : visible(db, r)); });
        if (table === 'vg_trip_members') {
          gone.forEach(function (m) {
            if (db.vg_trip_expenses.some(function (e) { return e.paid_by_member_id === m.id; })) throw new Error('member still paid an expense');
          });
          db.vg_trip_settlements = db.vg_trip_settlements.filter(function (s) { return !gone.some(function (m) { return s.from_member_id === m.id || s.to_member_id === m.id; }); });
        }
        if (table === 'vg_trips') {
          var ids = gone.map(function (t) { return t.id; });
          ['vg_trip_members', 'vg_trip_expenses', 'vg_trip_settlements'].forEach(function (t) {
            db[t] = db[t].filter(function (r) { return ids.indexOf(r.trip_id) < 0; });
          });
        }
        db[table] = db[table].filter(function (r) { return gone.indexOf(r) < 0; });
        out = gone.map(clone);
      }
      saveDb(project, db);
      if (mode === 'single') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'expected one row, got ' + out.length } };
      if (mode === 'maybe') return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }
    return b;
  }

  function rpc(project, name, args) {
    var db = loadDb(project), me = user(), r = { data: null, error: null };
    logAuth({ rpc: name });
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
    saveDb(project, db);
    return Promise.resolve(r);
  }

  function auth(project) {
    var who = function () { var u = user(); return u ? { id: u, email: u + '@test.dev', user_metadata: {} } : null; };
    return {
      getUser: function () { return Promise.resolve({ data: { user: who() }, error: null }); },
      getSession: function () { return Promise.resolve({ data: { session: who() ? { user: who() } : null }, error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
      signInWithPassword: function (a) {
        logAuth({ project: project, call: 'signInWithPassword', email: a.email });
        var id = 'user-' + a.email.split('@')[0];
        localStorage.setItem('fake-signed-in', id);
        return Promise.resolve({ data: { user: { id: id, email: a.email, user_metadata: {} }, session: {} }, error: null });
      },
      signInWithOtp: function (a) { logAuth({ project: project, call: 'signInWithOtp', email: a.email, options: a.options }); return Promise.resolve({ data: {}, error: null }); },
      signInWithOAuth: function (a) { logAuth({ project: project, call: 'signInWithOAuth', provider: a.provider }); return Promise.resolve({ data: {}, error: { message: 'oauth not faked' } }); },
      signUp: function (a) {
        logAuth({ project: project, call: 'signUp', email: a.email, options: a.options || null });
        return Promise.resolve({ data: { user: { id: 'user-' + a.email.split('@')[0], email: a.email, user_metadata: (a.options && a.options.data) || {} }, session: null }, error: null });
      },
      updateUser: function (a) { logAuth({ project: project, call: 'updateUser', data: a.data || null }); return Promise.resolve({ data: { user: who() }, error: null }); },
      signOut: function () { localStorage.removeItem('fake-signed-in'); return Promise.resolve({ error: null }); }
    };
  }

  var lib = {
    createClient: function (url) {
      var project = String(url).indexOf(GS) >= 0 ? GS : 'salon';
      return {
        from: function (t) { return builder(project, t); },
        rpc: function (n, a) { return rpc(project, n, a); },
        auth: auth(project),
        __project: project
      };
    }
  };
  window.__fakeSupabaseLib = lib;
  if (!window.__FAKE_ESM) window.supabase = lib;
})();
