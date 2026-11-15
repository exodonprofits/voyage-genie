/* Voyage Genie trip store: the cost tracker's connection to GenieSphere.
 *
 * The tracker keeps its own in-memory model (people by name, expenses with an
 * `included` map, settlementMeta keyed "from||to"). This file converts between
 * that model and the vg_ tables, and saves only what changed:
 *   rowsToState(rows)            rows from the database -> tracker state
 *   planMembers(snapshot, state)  which people to add, rename or remove
 *   planRest(snapshot, state, ids) expenses, payments and trip fields to write
 * The maths stays in trip-cost-tracker.html.
 *
 * Backend: GenieSphere by default since the 2026-11-15 cutover. ?db=salon (or ?db=gs)
 * on any URL pins one browser to a backend until changed; see DEFAULT_BACKEND.
 */
(function (global) {
  'use strict';

  var GS_URL = 'https://nxgtefbqizvihwikqnaw.supabase.co';
  var GS_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im54Z3RlZmJxaXp2aWh3aWtxbmF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5NzM5NjIsImV4cCI6MjEwOTU0OTk2Mn0.mHDoeUzaWn0tFF_wbNw9rAZhPDtAB6VAU07hfkXgApk';
  // GenieSphere since 2026-11-15. ?db=salon switches one browser back to Salon Genie (emergency
  // rollback, remembered until ?db=gs); flipping this to 'salon' rolls back everyone.
  var DEFAULT_BACKEND = 'gs';
  // Flip to true once Google is enabled in GenieSphere (Auth -> Providers -> Google).
  var GS_GOOGLE_ENABLED = false;

  // ?db=gs / ?db=salon picks a backend and is remembered in this browser, so a
  // tester can move between login, dashboard and tracker; ?db=salon forgets it.
  var BACKEND_KEY = 'vg-db';
  function backend() {
    try {
      var q = new URLSearchParams(global.location.search).get('db');
      if (q === 'gs' || q === 'salon') { global.localStorage.setItem(BACKEND_KEY, q); return q; }
      var kept = global.localStorage.getItem(BACKEND_KEY);
      if (kept === 'gs' || kept === 'salon') return kept;
    } catch (e) { /* not in a browser, or storage blocked */ }
    return DEFAULT_BACKEND;
  }

  // One shared GenieSphere client per page. Pages that load supabase-js as a
  // module pass their createClient; others use the global supabase-js.
  var client = null;
  function getClient(createClientFn) {
    if (client) return client;
    var make = createClientFn || (global.supabase && global.supabase.createClient);
    if (typeof make !== 'function') return null;
    client = make(GS_URL, GS_ANON_KEY, { auth: { storageKey: 'vg-geniesphere-auth' } });
    return client;
  }

  // Create the vg_profiles row on first sign-in (create-only, safe to repeat).
  async function ensureProfile(sb, user, fullName) {
    if (!user) return;
    var have = await sb.from('vg_profiles').select('user_id').eq('user_id', user.id).maybeSingle();
    if (have.error) throw fail('Checking profile', have.error);
    if (have.data) return;
    var meta = user.user_metadata || {};
    var name = String(fullName || meta.full_name || meta.name || String(user.email || '').split('@')[0] || '').trim().slice(0, 120);
    var ins = await sb.from('vg_profiles').insert({ user_id: user.id, full_name: name || null, created_via: 'voyagegenie.com' });
    if (ins.error && !/duplicate/i.test(ins.error.message || '')) throw fail('Creating profile', ins.error);
  }

  // ── conversions ────────────────────────────────────────────────

  function cents(n) { return Math.round((Number(n) || 0) * 100); }

  function sortMembers(list) {
    return list.slice().sort(function (a, b) {
      var ta = a.created_at || '', tb = b.created_at || '';
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.display_name).localeCompare(String(b.display_name));
    });
  }

  function sortExpenses(list) {
    return list.slice().sort(function (a, b) {
      var da = a.spent_on || '9999', db = b.spent_on || '9999';
      if (da !== db) return da < db ? -1 : 1;
      var ta = a.created_at || '', tb = b.created_at || '';
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
  }

  // A split value as the tracker understands it: true = whole party,
  // a whole number = that many heads. Anything else means "not included".
  function splitValue(v) {
    if (v === true) return true;
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n < 1) return null;
    return Math.min(n, 50);
  }

  // rows: { trip, members, expenses, settlements } (as selected, or as
  // returned by vg_get_shared_trip). Returns { state, snapshot }.
  function rowsToState(rows) {
    var trip = rows.trip || {};
    var settings = trip.settings || {};
    var members = sortMembers(rows.members || []);
    var byId = {};
    members.forEach(function (m) { byId[m.id] = m; });
    var nameOf = function (id) { return byId[id] && byId[id].in_split !== false ? byId[id].display_name : null; };

    var people = members.filter(function (m) { return m.in_split !== false; }).map(function (m) {
      var payerName = m.payer_member_id ? nameOf(m.payer_member_id) : null;
      return { name: m.display_name, payer: payerName || m.display_name, size: Math.max(1, Number(m.household_size) || 1), _mid: m.id,
               _joined: !!m.user_id || m.joined === true, _handles: m.pay_handles || {} };
    });

    var expenses = sortExpenses(rows.expenses || []).map(function (e) {
      var included = {};
      Object.keys(e.split || {}).forEach(function (id) {
        var n = nameOf(id);
        var v = splitValue(e.split[id]);
        if (n && v !== null) included[n] = v;
      });
      var ex = {
        date: e.spent_on || '',
        desc: e.description || '',
        category: e.category || '',
        paidBy: nameOf(e.paid_by_member_id) || '',
        amount: Number(e.amount) || 0,
        included: included,
        _id: e.id,
        _by: e.created_by || null
      };
      if (e.kind === 'budget_transfer') ex.kind = 'budget_transfer';
      return ex;
    });

    // payments -> settlementMeta, one entry per pair: total paid, latest method/date
    var settlementMeta = {};
    var pairCents = {};
    (rows.settlements || []).forEach(function (s) {
      var key = s.from_member_id + '|' + s.to_member_id;
      pairCents[key] = (pairCents[key] || 0) + (Number(s.amount_cents) || 0);
      var f = nameOf(s.from_member_id), t = nameOf(s.to_member_id);
      if (!f || !t) return;
      var k = f + '||' + t;
      var m = settlementMeta[k] || (settlementMeta[k] = { paid: true, method: '', paid_at: '', paid_cents: 0 });
      m.paid_cents += Number(s.amount_cents) || 0;
      var at = s.marked_at || '';
      if (at >= m.paid_at) {
        m.paid_at = at;
        if (s.method) m.method = s.method;
      }
    });

    var sponsorRules = (Array.isArray(settings.sponsorRules) ? settings.sponsorRules : []).map(function (r) {
      var traveler = nameOf(r.traveler);
      var sponsors = (Array.isArray(r.sponsors) ? r.sponsors : []).map(nameOf).filter(Boolean);
      if (!traveler || !sponsors.length) return null;
      return { label: r.label || '', traveler: traveler, sponsors: sponsors, mode: r.mode || 'full', value: Number(r.value) || 0 };
    }).filter(Boolean);

    var snapshot = {
      tripId: trip.id || null,
      trip: { name: trip.name || '', start_date: trip.start_date || null, end_date: trip.end_date || null,
              settings: JSON.stringify(settings) },
      members: {},
      expenses: {},
      expenseBy: {},
      pairs: {}
    };
    members.forEach(function (m) {
      snapshot.members[m.id] = { name: m.display_name, size: Number(m.household_size) || 1,
                                 payer: m.payer_member_id || null, in_split: m.in_split !== false };
    });
    (rows.expenses || []).forEach(function (e) {
      snapshot.expenseBy[e.id] = e.created_by || null;
      snapshot.expenses[e.id] = expenseKey({ kind: e.kind || 'expense', paid_by_member_id: e.paid_by_member_id,
        amount: cents(e.amount), spent_on: e.spent_on || null, category: e.category || null,
        description: e.description || null, split: e.split || {} });
    });
    Object.keys(pairCents).forEach(function (k) { snapshot.pairs[k] = { cents: pairCents[k] }; });
    (rows.settlements || []).forEach(function (s) {
      var k = s.from_member_id + '|' + s.to_member_id;
      if (s.method && (!snapshot.pairs[k].at || (s.marked_at || '') >= snapshot.pairs[k].at)) {
        snapshot.pairs[k].method = s.method;
        snapshot.pairs[k].at = s.marked_at || '';
      }
    });

    return {
      state: {
        tripTitle: trip.name || '',
        tripName: settings.tripName || '',
        tripStart: trip.start_date || '',
        tripEnd: trip.end_date || '',
        people: people,
        expenses: expenses,
        settlementMeta: settlementMeta,
        sponsorRules: sponsorRules,
        // each recorded payment, for "I paid" / "Got it"
        payments: (rows.settlements || []).map(function (s) {
          return { id: s.id, from: nameOf(s.from_member_id), to: nameOf(s.to_member_id), cents: Number(s.amount_cents) || 0,
                   method: s.method || '', confirmed: !!s.confirmed_at, markedBy: s.marked_by || null };
        }).filter(function (x) { return x.from && x.to; })
      },
      snapshot: snapshot
    };
  }

  // Stable text form of an expense row for change detection.
  function expenseKey(r) {
    var split = {};
    Object.keys(r.split || {}).sort().forEach(function (k) { split[k] = r.split[k]; });
    return JSON.stringify([r.kind, r.paid_by_member_id, r.amount, r.spent_on, r.category, r.description, split]);
  }

  function cleanName(s) { return String(s || '').trim().replace(/\s+/g, ' ').slice(0, 60); }

  // Which people to add, rename/resize, or remove.
  function planMembers(snapshot, state) {
    var plan = { inserts: [], updates: [], deletes: [] };
    var kept = {};
    (state.people || []).forEach(function (p) {
      var name = cleanName(p.name);
      var size = Math.max(1, Math.min(50, Number(p.size) || 1));
      var row = p._mid && snapshot.members[p._mid];
      if (row) {
        kept[p._mid] = true;
        if (row.name !== name || row.size !== size) plan.updates.push({ id: p._mid, display_name: name, household_size: size });
      } else {
        plan.inserts.push({ person: p, display_name: name, household_size: size });
      }
    });
    Object.keys(snapshot.members).forEach(function (id) {
      if (snapshot.members[id].in_split && !kept[id]) plan.deletes.push(id);
    });
    return plan;
  }

  // Everything else, once every person has a member id.
  // ids: { byName: { name -> member id } }
  function planRest(snapshot, state, ids) {
    var errors = [];
    var plan = { payerUpdates: [], expInserts: [], expUpdates: [], expDeletes: [], pairDeletes: [], pairInserts: [], trip: null };
    var mid = function (name) { return ids.byName[name] || null; };

    (state.people || []).forEach(function (p) {
      var id = mid(p.name);
      var payer = p.payer && p.payer !== p.name ? mid(p.payer) : null;
      var before = id && snapshot.members[id] ? snapshot.members[id].payer : null;
      if (id && payer !== before) plan.payerUpdates.push({ id: id, payer_member_id: payer });
    });

    var keptExp = {};
    (state.expenses || []).forEach(function (ex, i) {
      var payer = mid(ex.paidBy);
      if (!payer) {
        errors.push('Expense ' + (i + 1) + (ex.desc ? ' ("' + ex.desc + '")' : '') + ' needs someone who paid.');
        return;
      }
      var split = {};
      Object.keys(ex.included || {}).forEach(function (n) {
        var v = splitValue(ex.included[n]);
        var id = mid(n);
        if (id && v !== null) split[id] = v;
      });
      var row = {
        kind: ex.kind === 'budget_transfer' ? 'budget_transfer' : 'expense',
        paid_by_member_id: payer,
        amount: Math.round((Number(ex.amount) || 0) * 100) / 100,
        spent_on: /^\d{4}-\d{2}-\d{2}$/.test(ex.date || '') ? ex.date : null,
        category: ex.category ? String(ex.category).slice(0, 60) : null,
        description: ex.desc ? String(ex.desc).slice(0, 300) : null,
        split: split
      };
      var key = expenseKey({ kind: row.kind, paid_by_member_id: row.paid_by_member_id, amount: cents(row.amount),
                             spent_on: row.spent_on, category: row.category, description: row.description, split: split });
      if (ex._id && snapshot.expenses[ex._id] !== undefined) {
        keptExp[ex._id] = true;
        if (snapshot.expenses[ex._id] !== key) plan.expUpdates.push({ id: ex._id, row: row });
      } else {
        plan.expInserts.push({ expense: ex, row: row });
      }
    });
    Object.keys(snapshot.expenses).forEach(function (id) { if (!keptExp[id]) plan.expDeletes.push(id); });

    // payments: per pair, replace the rows when the paid amount or method changed
    var want = {};
    Object.keys(state.settlementMeta || {}).forEach(function (k) {
      var m = state.settlementMeta[k];
      if (!m || !m.paid) return;
      var parts = k.split('||');
      var f = mid(parts[0]), t = mid(parts[1]);
      var c = Math.round(Number(m.paid_cents) || 0);
      if (!f || !t || f === t || c <= 0) return;
      want[f + '|' + t] = { from: f, to: t, cents: c, method: m.method || null };
    });
    var pairKeys = {};
    Object.keys(want).concat(Object.keys(snapshot.pairs)).forEach(function (k) { pairKeys[k] = true; });
    Object.keys(pairKeys).forEach(function (k) {
      var w = want[k], h = snapshot.pairs[k];
      var same = w && h && w.cents === h.cents && (w.method || null) === (h.method || null);
      if (same || (!w && !h)) return;
      if (h) plan.pairDeletes.push(k);
      if (w) plan.pairInserts.push(w);
    });

    // trip fields
    var settings = {};
    try { settings = JSON.parse(snapshot.trip.settings) || {}; } catch (e) { settings = {}; }
    settings.tripName = state.tripName || '';
    settings.sponsorRules = (state.sponsorRules || []).map(function (r) {
      var traveler = mid(r.traveler);
      var sponsors = (r.sponsors || []).map(mid).filter(Boolean);
      if (!traveler || !sponsors.length) return null;
      return { label: r.label || '', traveler: traveler, sponsors: sponsors, mode: r.mode || 'full', value: Number(r.value) || 0 };
    }).filter(Boolean);
    var tripRow = {
      name: String(state.tripTitle || '').slice(0, 200),
      start_date: /^\d{4}-\d{2}-\d{2}$/.test(state.tripStart || '') ? state.tripStart : null,
      end_date: /^\d{4}-\d{2}-\d{2}$/.test(state.tripEnd || '') ? state.tripEnd : null,
      settings: settings
    };
    if (tripRow.start_date && tripRow.end_date && tripRow.end_date < tripRow.start_date) tripRow.end_date = null;
    if (tripRow.name !== snapshot.trip.name || tripRow.start_date !== snapshot.trip.start_date ||
        tripRow.end_date !== snapshot.trip.end_date || JSON.stringify(settings) !== snapshot.trip.settings) {
      plan.trip = tripRow;
    }
    plan.errors = errors;
    return plan;
  }

  // ── database calls ─────────────────────────────────────────────

  function fail(where, error) {
    var e = new Error(where + ': ' + (error && error.message ? error.message : String(error)));
    e.cause = error;
    return e;
  }

  async function loadTrip(sb, tripId) {
    var t = await sb.from('vg_trips').select('*').eq('id', tripId).maybeSingle();
    if (t.error) throw fail('Loading trip', t.error);
    if (!t.data) {
      // Links made before the move to GenieSphere carry the old Salon Genie id.
      t = await sb.from('vg_trips').select('*').eq('legacy_id', tripId).maybeSingle();
      if (t.error) throw fail('Loading trip', t.error);
      if (!t.data) return null;
      tripId = t.data.id;
    }
    var m = await sb.from('vg_trip_members').select('*').eq('trip_id', tripId);
    if (m.error) throw fail('Loading people', m.error);
    var e = await sb.from('vg_trip_expenses').select('*').eq('trip_id', tripId);
    if (e.error) throw fail('Loading expenses', e.error);
    var s = await sb.from('vg_trip_settlements').select('*').eq('trip_id', tripId);
    if (s.error) throw fail('Loading payments', s.error);
    var user = (await sb.auth.getUser()).data.user;
    var me = user ? (m.data || []).find(function (x) { return x.user_id === user.id; }) || null : null;
    var out = rowsToState({ trip: t.data, members: m.data, expenses: e.data, settlements: s.data });
    out.me = me;
    out.role = me ? me.role : null;
    out.userId = user ? user.id : null;
    return out;
  }

  async function createTrip(sb, title) {
    var user = (await sb.auth.getUser()).data.user;
    if (!user) throw new Error('Please sign in first.');
    var t = await sb.from('vg_trips').insert({ owner_id: user.id, name: String(title || '').slice(0, 200) }).select('*').single();
    if (t.error) throw fail('Creating trip', t.error);
    // The organizer starts outside the split; "that's me" links them to a person.
    var u = await sb.from('vg_trip_members').update({ in_split: false }).eq('trip_id', t.data.id).eq('user_id', user.id);
    if (u.error) throw fail('Setting up trip', u.error);
    return loadTrip(sb, t.data.id);
  }

  // Writes the differences between snapshot and state. Returns the reloaded trip.
  async function saveTrip(sb, snapshot, state) {
    var tripId = snapshot.tripId;
    var mp = planMembers(snapshot, state);
    var byName = {};
    (state.people || []).forEach(function (p) { if (p._mid && snapshot.members[p._mid]) byName[p.name] = p._mid; });

    // check names first so nothing is half-written on an obvious clash
    var seen = {};
    for (var i = 0; i < (state.people || []).length; i++) {
      var n = cleanName(state.people[i].name).toLowerCase();
      if (!n) throw new Error('Every person needs a name.');
      if (seen[n]) throw new Error('Two people are called "' + state.people[i].name + '". Names must be different.');
      seen[n] = true;
    }
    var names = {};
    (state.people || []).forEach(function (p) { names[p.name] = true; });
    var noPayer = (state.expenses || []).map(function (ex, k) {
      return names[ex.paidBy] ? null : 'Expense ' + (k + 1) + (ex.desc ? ' ("' + ex.desc + '")' : '') + ' needs someone who paid.';
    }).filter(Boolean);
    if (noPayer.length) throw new Error(noPayer.join('\n'));

    for (var a = 0; a < mp.updates.length; a++) {
      var up = mp.updates[a];
      var r1 = await sb.from('vg_trip_members').update({ display_name: up.display_name, household_size: up.household_size }).eq('id', up.id);
      if (r1.error) throw fail('Updating ' + up.display_name, r1.error);
    }
    for (var b = 0; b < mp.inserts.length; b++) {
      var ins = mp.inserts[b];
      var r2 = await sb.from('vg_trip_members').insert({ trip_id: tripId, display_name: ins.display_name, household_size: ins.household_size }).select('id').single();
      if (r2.error) throw fail('Adding ' + ins.display_name, r2.error);
      ins.person._mid = r2.data.id;
      byName[ins.person.name] = r2.data.id;
    }

    var rest = planRest(snapshot, state, { byName: byName });
    if (rest.errors.length) throw new Error(rest.errors.join('\n'));

    for (var c = 0; c < rest.payerUpdates.length; c++) {
      var pu = rest.payerUpdates[c];
      var r3 = await sb.from('vg_trip_members').update({ payer_member_id: pu.payer_member_id }).eq('id', pu.id);
      if (r3.error) throw fail('Saving who pays for whom', r3.error);
    }
    if (rest.trip) {
      var r4 = await sb.from('vg_trips').update(rest.trip).eq('id', tripId);
      if (r4.error) throw fail('Saving trip details', r4.error);
    }
    for (var d = 0; d < rest.expUpdates.length; d++) {
      var eu = rest.expUpdates[d];
      var r5 = await sb.from('vg_trip_expenses').update(eu.row).eq('id', eu.id);
      if (r5.error) throw fail('Saving an expense', r5.error);
    }
    // one at a time, so each new id is matched to the right expense for sure
    for (var g = 0; g < rest.expInserts.length; g++) {
      var x = rest.expInserts[g];
      var r6 = await sb.from('vg_trip_expenses').insert(Object.assign({ trip_id: tripId }, x.row)).select('id').single();
      if (r6.error) throw fail('Adding expenses', r6.error);
      x.expense._id = r6.data.id;
    }
    if (rest.expDeletes.length) {
      var r7 = await sb.from('vg_trip_expenses').delete().in('id', rest.expDeletes);
      if (r7.error) throw fail('Removing expenses', r7.error);
    }
    if (mp.deletes.length) {
      var r8 = await sb.from('vg_trip_members').delete().in('id', mp.deletes);
      if (r8.error) throw fail('Removing people', r8.error);
    }
    for (var f = 0; f < rest.pairDeletes.length; f++) {
      var ft = rest.pairDeletes[f].split('|');
      var r9 = await sb.from('vg_trip_settlements').delete().eq('trip_id', tripId).eq('from_member_id', ft[0]).eq('to_member_id', ft[1]);
      if (r9.error) throw fail('Updating payments', r9.error);
    }
    if (rest.pairInserts.length) {
      var prow = rest.pairInserts.map(function (w) {
        return { trip_id: tripId, from_member_id: w.from, to_member_id: w.to, amount_cents: w.cents, method: w.method };
      });
      var r10 = await sb.from('vg_trip_settlements').insert(prow);
      if (r10.error) throw fail('Saving payments', r10.error);
    }
    return loadTrip(sb, tripId);
  }

  // A member (editor) saves: only expenses. They add any expense and change or remove
  // the ones they added; people, trip details and payments stay with the owner, so
  // changes there are not written. The database enforces the same rules.
  async function saveTripAsMember(sb, snapshot, state, userId) {
    var tripId = snapshot.tripId;
    var byName = {};
    Object.keys(snapshot.members).forEach(function (id) { byName[snapshot.members[id].name] = id; });
    var rest = planRest(snapshot, state, { byName: byName });
    if (rest.errors.length) throw new Error(rest.errors.join('\n'));
    var notMine = rest.expUpdates.map(function (u) { return u.id; }).concat(rest.expDeletes)
      .filter(function (id) { return snapshot.expenseBy[id] !== userId; });
    if (notMine.length) {
      throw new Error('You can only change or remove expenses you added. Reload the trip to undo changes to other people\'s expenses.');
    }
    for (var d = 0; d < rest.expUpdates.length; d++) {
      var eu = rest.expUpdates[d];
      var r1 = await sb.from('vg_trip_expenses').update(eu.row).eq('id', eu.id);
      if (r1.error) throw fail('Saving an expense', r1.error);
    }
    for (var g = 0; g < rest.expInserts.length; g++) {
      var x = rest.expInserts[g];
      var r2 = await sb.from('vg_trip_expenses').insert(Object.assign({ trip_id: tripId }, x.row)).select('id').single();
      if (r2.error) throw fail('Adding expenses', r2.error);
      x.expense._id = r2.data.id;
    }
    if (rest.expDeletes.length) {
      var r3 = await sb.from('vg_trip_expenses').delete().in('id', rest.expDeletes);
      if (r3.error) throw fail('Removing expenses', r3.error);
    }
    return loadTrip(sb, tripId);
  }

  // Settle up. Pay handles: what a member saves so others can pay them.
  var HANDLE_RE = /^[A-Za-z0-9._-]{1,40}$/;
  function cleanHandles(h) {
    h = h || {};
    var out = {};
    var v = String(h.venmo || '').trim().replace(/^@/, '');
    if (v && HANDLE_RE.test(v)) out.venmo = v;
    var pp = String(h.paypal || '').trim().replace(/^(https?:\/\/)?(www\.)?(paypal\.me|paypal\.com\/paypalme)\//i, '').replace(/\/.*$/, '');
    if (pp && HANDLE_RE.test(pp)) out.paypal = pp;
    var c = String(h.cashapp || '').trim().replace(/^\$/, '');
    if (c && /^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(c)) out.cashapp = c;
    var z = String(h.zelle || '').trim();
    if (z && z.length <= 80 && /^[^<>"']+$/.test(z)) out.zelle = z;
    return out;
  }
  // Links that open the payment app with the amount (and a note) filled in.
  function payLinks(handles, cents, note) {
    var h = cleanHandles(handles), amt = (Math.max(0, cents) / 100).toFixed(2), links = [];
    if (h.venmo) links.push({ app: 'venmo', label: 'Venmo', url: 'https://venmo.com/' + encodeURIComponent(h.venmo) + '?txn=pay&amount=' + amt + '&note=' + encodeURIComponent(note || '') });
    if (h.paypal) links.push({ app: 'paypal', label: 'PayPal', url: 'https://www.paypal.com/paypalme/' + encodeURIComponent(h.paypal) + '/' + amt + 'USD' });
    if (h.cashapp) links.push({ app: 'cashapp', label: 'Cash App', url: 'https://cash.app/$' + encodeURIComponent(h.cashapp) + '/' + amt });
    return { links: links, zelle: h.zelle || null };
  }
  async function savePayHandles(sb, tripId, handles) {
    var r = await sb.rpc('vg_update_my_membership', { p_trip: tripId, p_pay_handles: cleanHandles(handles) });
    if (r.error) throw fail('Saving payment details', r.error);
  }
  async function recordPayment(sb, tripId, fromId, toId, cents, method) {
    var m = ['venmo', 'paypal', 'cashapp', 'zelle', 'cash', 'other'].indexOf(method) >= 0 ? method : null;
    var r = await sb.from('vg_trip_settlements').insert({ trip_id: tripId, from_member_id: fromId, to_member_id: toId,
      amount_cents: Math.round(cents), method: m });
    if (r.error) throw fail('Recording payment', r.error);
  }
  async function confirmPayment(sb, settlementId) {
    var r = await sb.rpc('vg_confirm_settlement', { p_settlement: settlementId });
    if (r.error) throw fail('Confirming payment', r.error);
  }

  // Invites: the owner makes a link; anyone signed in can preview and accept it.
  async function createInvite(sb, tripId, role, hours) {
    var r = await sb.rpc('vg_create_invite', { p_trip: tripId, p_role: role === 'viewer' ? 'viewer' : 'editor', p_hours: hours || 336 });
    if (r.error) throw fail('Creating invite', r.error);
    return r.data;
  }
  async function invitePreview(sb, token) {
    var r = await sb.rpc('vg_invite_preview', { p_token: token });
    if (r.error) throw fail('Opening invite', r.error);
    return r.data;   // null when expired or used up
  }
  async function acceptInvite(sb, token, claimMemberId, displayName) {
    var r = await sb.rpc('vg_accept_invite', { p_token: token, p_claim_member: claimMemberId || null, p_display_name: displayName || null });
    if (r.error) throw fail('Joining trip', r.error);
    return r.data;   // the trip id
  }

  async function linkMe(sb, tripId, memberId) {
    var r = await sb.rpc('vg_link_me', { p_trip: tripId, p_member: memberId });
    if (r.error) throw fail('Linking you', r.error);
  }

  async function claimLegacy(sb) {
    var r = await sb.rpc('vg_claim_legacy');
    if (r.error) throw fail('Picking up your trips', r.error);
    return r.data;
  }

  async function createShare(sb, tripId, hours) {
    var r = await sb.rpc('vg_create_share', { p_trip: tripId, p_hours: hours || 48 });
    if (r.error) throw fail('Creating share link', r.error);
    return r.data;
  }

  async function loadShared(sb, token) {
    var r = await sb.rpc('vg_get_shared_trip', { p_token: token });
    if (r.error) throw fail('Opening shared trip', r.error);
    if (!r.data) return null;
    return rowsToState(r.data);
  }

  // ── the other pages' tables ───────────────────────────────────
  // Planners, itineraries, account and contact keep their old table names in
  // code; these pick the right table (and plan columns) for the backend.
  var GS_TABLES = { search_history: 'vg_search_history', contact_messages: 'vg_contact_messages', user_trips: 'vg_plans' };
  function table(name) { return backend() === 'gs' ? (GS_TABLES[name] || name) : name; }
  // A saved AI plan row: { user_id, name, data } -> the backend's columns.
  function planRow(userId, name, data) {
    return backend() === 'gs'
      ? { user_id: userId, name: String(name || '').slice(0, 200), plan_data: data || {} }
      : { user_id: userId, trip_name: name, trip_data: data };
  }
  function planCols() { return backend() === 'gs' ? 'id, name, plan_data, created_at' : 'id, trip_name, trip_data, created_at'; }
  function planData(row) { return row ? (row.plan_data || row.trip_data || null) : null; }

  // "Delete my Voyage Genie data" (account page). The sign-in is shared with other
  // apps, so only Voyage Genie's own data goes; the login stays.
  // GenieSphere: one transaction in vg_delete_my_data() (migration 006).
  // Salon Genie: table by table, then re-read each table, because a delete that row
  // security blocks returns no error. Resolves { ok, left: [table names still holding data] }.
  // user_preferences is NOT here: in Salon Genie it holds the user's Salon Genie role and
  // business, shared with that app. Deleting it would break their Salon Genie account.
  var SALON_MINE = [['user_trips', 'user_id'], ['search_history', 'user_id'], ['trips', 'owner_id']];
  async function deleteMyData(sb, userId) {
    if (backend() === 'gs') {
      var r = await sb.rpc('vg_delete_my_data');
      if (r.error) throw fail('Deleting your data', r.error);
      return { ok: true, left: [], counts: r.data };
    }
    var left = [];
    for (var i = 0; i < SALON_MINE.length; i++) {
      var t = SALON_MINE[i][0], col = SALON_MINE[i][1];
      var del = await sb.from(t).delete().eq(col, userId);
      if (del.error && !/does not exist|schema cache/i.test(del.error.message || '')) { left.push(t); continue; }
      var chk = await sb.from(t).select(col).eq(col, userId);
      if (chk.error && /does not exist|schema cache/i.test(chk.error.message || '')) continue;
      if (chk.error || (chk.data && chk.data.length)) left.push(t);
    }
    return { ok: left.length === 0, left: left };
  }

  global.VGTripStore = {
    backend: backend,
    getClient: getClient,
    deleteMyData: deleteMyData,
    googleEnabled: function () { return backend() !== 'gs' || GS_GOOGLE_ENABLED; },
    table: table,
    planRow: planRow,
    planCols: planCols,
    planData: planData,
    ensureProfile: ensureProfile,
    rowsToState: rowsToState,
    planMembers: planMembers,
    planRest: planRest,
    loadTrip: loadTrip,
    createTrip: createTrip,
    saveTrip: saveTrip,
    linkMe: linkMe,
    saveTripAsMember: saveTripAsMember,
    cleanHandles: cleanHandles,
    payLinks: payLinks,
    savePayHandles: savePayHandles,
    recordPayment: recordPayment,
    confirmPayment: confirmPayment,
    createInvite: createInvite,
    invitePreview: invitePreview,
    acceptInvite: acceptInvite,
    claimLegacy: claimLegacy,
    createShare: createShare,
    loadShared: loadShared
  };
})(typeof window !== 'undefined' ? window : globalThis);
