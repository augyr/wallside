// In-memory demo: a made-up PASA senior group. Mimics the parts of the database
// client the app uses. Nothing here is real and nothing is saved.
import { goalSplits } from './lib/goalsplits.js';
import { formatTime, eventName } from './lib/time.js';

const TEAM = 'demo-team';
const USERS = {
  coach: { id: 'demo-coach', email: 'coach@demo.wallside' },
  parent: { id: 'demo-parent', email: 'parent@demo.wallside' },
  swimmer: { id: 'demo-swimmer', email: 'swimmer@demo.wallside' },
};

// Deterministic pseudo-random numbers so the demo looks the same every time
function rng(seed) {
  let x = seed % 2147483647; if (x <= 0) x += 2147483646;
  return () => ((x = (x * 16807) % 2147483647) - 1) / 2147483646;
}

let idn = 0;
const nid = (p) => `${p}-${(++idn).toString(36)}`;
const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };

// Split a time into laps with a realistic start-and-fade shape
function makeSplits(totalCs, laps, lapLen, stroke, rand, fade = 1) {
  if (laps < 2) return null;
  const adv = (stroke === 'BK' ? 65 : lapLen === 25 ? 125 : 185) + (rand() - 0.5) * 20;
  const t = Array.from({ length: laps }, (_, i) => (i === 0 ? 0 : 1 + (i / laps) * 0.025 * fade + (rand() - 0.5) * 0.008));
  const restWeight = t.slice(1).reduce((a, b) => a + b, 0);
  const restTotal = (totalCs + adv) * (laps - 1) / laps;   // approx; corrected below
  let rest = t.slice(1).map((w) => (w / restWeight) * restTotal);
  let first = totalCs - rest.reduce((a, b) => a + b, 0);
  const avgRest = rest.reduce((a, b) => a + b, 0) / rest.length;
  if (avgRest - first < adv * 0.8) { first -= 20; rest = rest.map((r) => r + 20 / rest.length); }
  const out = [first, ...rest].map(Math.round);
  out[out.length - 1] += totalCs - out.reduce((a, b) => a + b, 0);
  return out;
}

function buildData() {
  idn = 0;
  const groups = [
    { id: 'g-senior', team_id: TEAM, name: 'Senior', sort: 0, analytics_level: 'senior' },
    { id: 'g-age', team_id: TEAM, name: 'Age Group', sort: 1, analytics_level: null },
  ];
  const people = [
    // first, last, born, group, featured events [distance, stroke, base time cs]
    ['Harper', 'Quinn', 2009, 'g-senior', [[100, 'FR', 5420], [200, 'FR', 11890], [100, 'FL', 6050]]],
    ['Owen', 'Castillo', 2010, 'g-senior', [[100, 'BR', 6120], [200, 'IM', 12750], [50, 'FR', 2410]]],
    ['Nora', 'Bennett', 2010, 'g-senior', [[100, 'BK', 6080], [200, 'BK', 13020], [100, 'FR', 5690]]],
    ['Eli', 'Fischer', 2011, 'g-senior', [[100, 'FR', 5210], [200, 'FR', 11470], [100, 'FL', 5730]]],
    ['Priya', 'Raman', 2011, 'g-senior', [[200, 'IM', 13480], [100, 'BR', 7210], [100, 'FR', 5880]]],
    ['Sofia', 'Marchetti', 2012, 'g-senior', [[50, 'FR', 2690], [100, 'FR', 5940], [100, 'BK', 6610]]],
    ['Caleb', 'Ward', 2009, 'g-senior', [[100, 'FL', 5490], [200, 'FL', 12320], [100, 'FR', 4980]]],
    ['Mia', 'Okafor', 2012, 'g-senior', [[100, 'FR', 6030], [200, 'FR', 13110], [100, 'BR', 7480]]],
    ['Lucas', 'Brandt', 2014, 'g-age', [[50, 'FR', 2990], [100, 'FR', 6650]]],
    ['Grace', 'Holloway', 2016, 'g-age', [[50, 'FR', 3480], [50, 'BK', 4120]]],
  ];
  const swimmers = people.map(([first, last, by, g], i) => ({
    id: `s-${i + 1}`, team_id: TEAM, group_id: g, first_name: first, last_name: last, birth_year: by,
    birth_year_estimated: i === 5, archived: false, also_known_as: i === 6 ? ['Calvin'] : [],
    usually_unattached: false, analytics_level: null, created_at: daysAgo(90).toISOString(),
  }));

  const meets = [
    { id: 'm-1', name: 'Summer Long Course Champs', date: iso(new Date(today.getFullYear() - (today.getMonth() < 7 ? 1 : 0), 6, 26)), course: 'LCM' },
    { id: 'm-2', name: 'PASA Fall Kickoff', date: iso(daysAgo(52)), course: 'SCY' },
    { id: 'm-3', name: 'PASA SC Super League', date: iso(daysAgo(38)), course: 'SCY' },
    { id: 'm-4', name: 'Halloween Invitational', date: iso(daysAgo(17)), course: 'SCY' },
  ].map((m) => ({ id: m.id, team_id: TEAM, name: m.name, meet_date: m.date, course: m.course, source: 'pdf', uploaded_by: USERS.coach.id, created_at: m.date + 'T20:00:00Z' }));

  const results = [];
  people.forEach(([, , , , events], i) => {
    const sw = swimmers[i];
    const rand = rng(1000 + i * 77);
    events.forEach(([distance, stroke, base], k) => {
      const scy = meets.filter((m) => m.course === 'SCY');
      scy.forEach((m, j) => {
        if (k === 2 && j === 0) return;                      // not every event at every meet
        const improve = 1 - 0.006 * j + (rand() - 0.5) * 0.008 + (j === 2 && i % 3 === 0 ? 0.006 : 0);
        const time = Math.round(base * improve);
        const lapLen = 25;
        const dq = i === 4 && k === 1 && j === 1;
        results.push({
          id: nid('r'), team_id: TEAM, swimmer_id: sw.id, meet_id: m.id, distance, stroke, course: 'SCY',
          time_cs: dq ? null : time, status: dq ? 'dq' : 'ok', dq_reason: dq ? 'One hand touch' : null,
          splits_cs: dq ? null : makeSplits(time, distance / lapLen, lapLen, stroke, rand, 1 + j * 0.2),
          split_len: dq ? null : lapLen, place: 1 + Math.floor(rand() * 12), age_at_meet: 2026 - sw.birth_year,
          meet_name: m.name, meet_date: m.meet_date, name_in_results: `${sw.last_name}, ${sw.first_name}`,
          uploaded_by: USERS.coach.id, created_at: m.created_at,
        });
      });
      if (sw.group_id === 'g-senior' && k < 2) {
        const m = meets[0];
        const time = Math.round(base * (distance >= 200 ? 1.115 : 1.12));
        results.push({
          id: nid('r'), team_id: TEAM, swimmer_id: sw.id, meet_id: m.id, distance, stroke, course: 'LCM', time_cs: time, status: 'ok',
          splits_cs: makeSplits(time, distance / 50, 50, stroke, rand), split_len: 50, place: 1 + Math.floor(rand() * 16),
          age_at_meet: 2025 - sw.birth_year, meet_name: m.name, meet_date: m.meet_date, uploaded_by: USERS.coach.id, created_at: m.created_at,
        });
      }
    });
  });

  // Goals for the featured swimmers
  const goal = (sw, distance, stroke, target, by) => ({
    id: nid('goal'), swimmer_id: sw, created_by: by, kind: 'time', distance, stroke, course: 'SCY', target_cs: target,
    title: `${eventName(distance, stroke)} (SCY) under ${formatTime(target)}`,
    due_label: 'Championship meet', status: 'active', goal_splits_cs: null, goal_splits_set_by: null, created_at: daysAgo(30).toISOString(),
  });
  const goals = [
    goal('s-1', 100, 'FR', 5290, USERS.parent.id),
    goal('s-1', 200, 'FR', 11690, USERS.coach.id),
    goal('s-4', 100, 'FR', 5100, USERS.swimmer.id),
    goal('s-2', 100, 'BR', 5990, USERS.coach.id),
    { id: nid('goal'), swimmer_id: 's-1', created_by: USERS.coach.id, kind: 'technique', title: 'Six dolphin kicks off every wall',
      course: null, due_label: 'End of season', status: 'active', created_at: daysAgo(20).toISOString() },
  ];
  // The coach has hand-tuned one set of goal splits
  const g200 = goals[1];
  const best200 = results.filter((r) => r.swimmer_id === 's-1' && r.distance === 200 && r.course === 'SCY' && r.status === 'ok')
    .sort((a, b) => a.time_cs - b.time_cs)[0];
  const suggestion = goalSplits({ bestSplits: best200.splits_cs, goalCs: g200.target_cs, laps: 8, lapLen: 25, level: 'senior', stroke: 'FR' });
  g200.goal_splits_cs = suggestion.splits.map((v, i) => v + (i >= 6 ? -15 : i >= 2 && i < 4 ? 15 : 0));
  g200.goal_splits_set_by = USERS.coach.id;

  const notes = [
    { id: nid('n'), team_id: TEAM, swimmer_id: 's-1', group_id: null, author_id: USERS.coach.id, tag: 'great', focus: 'Back-half speed',
      body: 'Held 1:20s on the last four 100s today — that\'s the back half we need in the 200.', created_at: daysAgo(2).toISOString() },
    { id: nid('n'), team_id: TEAM, swimmer_id: null, group_id: 'g-senior', author_id: USERS.coach.id, tag: null, focus: null,
      body: 'Senior group: taper starts in two weeks. Sleep and hydration matter more than extra yardage now.', created_at: daysAgo(5).toISOString() },
    { id: nid('n'), team_id: TEAM, swimmer_id: 's-4', group_id: null, author_id: USERS.coach.id, tag: 'new_focus', focus: 'Breakouts',
      body: 'Work on breaking out before the flags — you\'re losing a few tenths on every wall.', created_at: daysAgo(4).toISOString() },
  ];
  const note_replies = [
    { id: nid('nr'), note_id: notes[0].id, author_id: USERS.parent.id, body: 'She was so proud of that set!', created_at: daysAgo(1).toISOString() },
  ];

  const practices = []; const attendance = [];
  for (let d = 1; d <= Math.min(today.getDate() - 1, 20); d++) {
    const date = new Date(today.getFullYear(), today.getMonth(), d);
    if (date.getDay() === 0) continue;
    for (const session of date.getDay() === 2 || date.getDay() === 4 ? ['AM', 'PM'] : ['PM']) {
      const p = { id: nid('p'), team_id: TEAM, group_id: 'g-senior', practice_date: iso(date), session };
      practices.push(p);
      for (const sw of ['s-1', 's-4']) {
        const status = (d + (sw === 's-4' ? 2 : 0)) % 9 === 0 ? 'out' : (d % 7 === 0 ? 'late' : 'here');
        attendance.push({ practice_id: p.id, swimmer_id: sw, status, parent_reported: false, updated_by: USERS.coach.id });
      }
    }
  }

  return {
    profiles: [
      { id: USERS.coach.id, full_name: 'Demo Coach' },
      { id: USERS.parent.id, full_name: 'Demo Parent' },
      { id: USERS.swimmer.id, full_name: 'Eli Fischer' },
    ],
    teams: [{ id: TEAM, name: 'PASA', team_code: 'PASA', team_aliases: ['Palo Alto Stanford Aquatics'], created_by: USERS.coach.id }],
    team_coaches: [{ team_id: TEAM, user_id: USERS.coach.id, role: 'head' }],
    groups, swimmers,
    guardians: [{ swimmer_id: 's-1', user_id: USERS.parent.id }, { swimmer_id: 's-6', user_id: USERS.parent.id }, { swimmer_id: 's-4', user_id: 'demo-other-parent' }],
    swimmer_accounts: [{ swimmer_id: 's-4', user_id: USERS.swimmer.id }],
    invites: swimmers.map((sw, i) => ({ code: `${sw.first_name.slice(0, 4).toUpperCase()}-DEMO`, swimmer_id: sw.id, kind: 'guardian', uses_left: 2,
      expires_at: '2099-01-01', revoked: false, created_at: daysAgo(30).toISOString(), i })),
    notes, note_replies, practices, attendance, goals, goal_comments: [],
    meets, results, result_edits: [],
  };
}

// ------------------------------------------------------------------
// A tiny query engine with the same shape as the database client
// ------------------------------------------------------------------
const MANY_TO_ONE = { groups: 'group_id', teams: 'team_id', swimmers: 'swimmer_id', meets: 'meet_id', practices: 'practice_id' };
const ONE_TO_MANY = { note_replies: 'note_id', results: 'meet_id' };

function parseEmbeds(select) {
  const embeds = [];
  const re = /(\w+)(!inner)?\(([^()]*)\)/g;
  let m;
  while ((m = re.exec(select || ''))) embeds.push({ name: m[1], inner: !!m[2] });
  return embeds;
}

function getPath(row, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), row);
}

class Query {
  constructor(db, table) {
    this.db = db; this.table = table; this.filters = []; this.mode = 'select';
    this.selectStr = '*'; this.orders = []; this.max = null; this.single = null; this.returning = false;
  }
  select(cols) { if (this.mode === 'select') this.selectStr = cols || '*'; else this.returning = true; return this; }
  eq(c, v) { this.filters.push((r) => getPath(r, c) === v); return this; }
  neq(c, v) { this.filters.push((r) => getPath(r, c) !== v); return this; }
  in(c, vs) { this.filters.push((r) => vs.includes(getPath(r, c))); return this; }
  gte(c, v) { this.filters.push((r) => { const x = getPath(r, c); return x !== undefined && x >= v; }); return this; }
  lte(c, v) { this.filters.push((r) => { const x = getPath(r, c); return x !== undefined && x <= v; }); return this; }
  or(expr) {
    const parts = expr.split(',').map((p) => { const [c, op, ...rest] = p.split('.'); return { c, op, v: rest.join('.') }; });
    this.filters.push((r) => parts.some(({ c, op, v }) => op === 'eq' && String(r[c]) === v));
    return this;
  }
  order(c, opts = {}) { this.orders.push([c, opts.ascending !== false]); return this; }
  limit(n) { this.max = n; return this; }
  maybeSingle() { this.single = 'maybe'; return this; }
  single() { this.single = 'one'; return this; }
  insert(rows) { this.mode = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(vals) { this.mode = 'update'; this.payload = vals; return this; }
  delete() { this.mode = 'delete'; return this; }

  withEmbeds(row) {
    const out = { ...row };
    for (const e of parseEmbeds(this.selectStr)) {
      if (MANY_TO_ONE[e.name] && this.table !== e.name) {
        out[e.name] = (this.db.data[e.name] || []).find((x) => x.id === row[MANY_TO_ONE[e.name]]) || null;
      } else if (ONE_TO_MANY[e.name]) {
        out[e.name] = (this.db.data[e.name] || []).filter((x) => x[ONE_TO_MANY[e.name]] === row.id);
      }
    }
    return out;
  }

  run() {
    const data = this.db.data;
    const rows = (data[this.table] = data[this.table] || []);
    if (this.mode === 'insert') {
      const made = this.payload.map((r) => ({ id: nid(this.table), created_at: new Date().toISOString(), ...this.defaults(), ...r }));
      rows.push(...made);
      return { data: this.returning ? made : null, error: null };
    }
    if (this.mode === 'update') {
      rows.filter((r) => this.filters.every((f) => f(r))).forEach((r) => Object.assign(r, this.payload));
      return { data: null, error: null };
    }
    if (this.mode === 'delete') {
      data[this.table] = rows.filter((r) => !this.filters.every((f) => f(r)));
      return { data: null, error: null };
    }
    let out = rows.map((r) => this.withEmbeds(r));
    for (const e of parseEmbeds(this.selectStr)) if (e.inner) out = out.filter((r) => r[e.name]);
    out = out.filter((r) => this.filters.every((f) => f(r)));
    for (const [c, asc] of [...this.orders].reverse()) {
      out.sort((a, b) => { const x = a[c]; const y = b[c]; if (x === y) return 0; if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1; return (x < y ? -1 : 1) * (asc ? 1 : -1); });
    }
    if (this.max !== null) out = out.slice(0, this.max);
    if (this.single) {
      if (this.single === 'one' && out.length !== 1) return { data: null, error: { message: 'Not found' } };
      return { data: out[0] || null, error: null };
    }
    return { data: out.map((r) => JSON.parse(JSON.stringify(r))), error: null };
  }
  defaults() {
    if (this.table === 'swimmers') return { team_id: TEAM, archived: false, also_known_as: [], usually_unattached: false, birth_year_estimated: false, analytics_level: null };
    if (this.table === 'goals') return { status: 'active', goal_splits_cs: null };
    return {};
  }
  then(resolve, reject) {
    try { return Promise.resolve(this.run()).then(resolve, reject); } catch (err) { return Promise.resolve({ data: null, error: err }).then(resolve, reject); }
  }
}

export function createDemoClient() {
  const db = { data: buildData(), role: 'coach' };
  const fail = (message) => ({ data: null, error: { message } });
  const ok = (data) => ({ data, error: null });
  const log = (action, r, after) => db.data.result_edits.unshift({
    id: nid('e'), team_id: TEAM, result_id: r.id, swimmer_id: r.swimmer_id, action,
    before: JSON.parse(JSON.stringify(r)), after: after ? JSON.parse(JSON.stringify(after)) : null,
    edited_by: USERS.coach.id, edited_at: new Date().toISOString() });

  const rpcs = {
    create_invite: ({ p_swimmer }) => ok(`${(db.data.swimmers.find((s) => s.id === p_swimmer) || { first_name: 'SWIM' }).first_name.slice(0, 4).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`),
    create_missing_invites: () => ok(0),
    create_missing_swimmer_invites: () => {
      let n = 0;
      for (const sw of db.data.swimmers) {
        if (!sw.birth_year || new Date().getFullYear() - sw.birth_year < 13) continue;
        if (db.data.swimmer_accounts.some((a) => a.swimmer_id === sw.id)) continue;
        if (db.data.invites.some((i) => i.swimmer_id === sw.id && i.kind === 'swimmer')) continue;
        db.data.invites.push({ code: `${sw.first_name.slice(0, 4).toUpperCase()}-SWIM`, swimmer_id: sw.id, kind: 'swimmer', uses_left: 1, expires_at: '2099-01-01', revoked: false });
        n++;
      }
      return ok(n);
    },
    preview_invite: () => ok([]),
    claim_invite: () => fail('Invite codes don\'t work in the demo.'),
    create_team: () => fail('The demo already has a team.'),
    correct_note: () => ok(null),
    import_meet: ({ p_meet, p_swims, p_replace }) => {
      if (!['SCY', 'LCM'].includes(p_meet.course)) return fail('Only short course yards and long course meters can be imported');
      const existing = db.data.meets.find((m) => m.name.toLowerCase() === p_meet.name.toLowerCase() && m.meet_date === p_meet.meet_date);
      if (existing && !p_replace) return fail('This meet was already uploaded. Choose "Replace the earlier upload" to upload it again.');
      if (existing) {
        db.data.results.filter((r) => r.meet_id === existing.id).forEach((r) => log('replaced', r));
        db.data.results = db.data.results.filter((r) => r.meet_id !== existing.id);
        db.data.meets = db.data.meets.filter((m) => m.id !== existing.id);
      }
      const m = { id: nid('m'), team_id: TEAM, name: p_meet.name, meet_date: p_meet.meet_date, course: p_meet.course, source: p_meet.source, created_at: new Date().toISOString() };
      db.data.meets.push(m);
      for (const s of p_swims) {
        db.data.results.push({ id: nid('r'), team_id: TEAM, swimmer_id: s.swimmer_id, meet_id: m.id, distance: s.distance, stroke: s.stroke,
          course: m.course, time_cs: s.time_cs, splits_cs: s.splits_cs, split_len: s.split_len, status: s.status || 'ok', dq_reason: s.dq_reason,
          place: s.place, age_at_meet: s.age, name_in_results: s.name_in_results, meet_name: m.name, meet_date: m.meet_date, created_at: m.created_at });
      }
      return ok(m.id);
    },
    update_result: ({ p_result, p_time_cs, p_status, p_dq_reason }) => {
      const r = db.data.results.find((x) => x.id === p_result);
      if (!r) return fail('Result not found');
      const before = { ...r };
      Object.assign(r, { time_cs: p_time_cs, status: p_status, dq_reason: p_status === 'dq' ? p_dq_reason : null });
      log('edit', before, r);
      return ok(null);
    },
    delete_result: ({ p_result }) => {
      const r = db.data.results.find((x) => x.id === p_result);
      if (r) log('delete', r);
      db.data.results = db.data.results.filter((x) => x.id !== p_result);
      return ok(null);
    },
    delete_meet: ({ p_meet }) => {
      db.data.results.filter((r) => r.meet_id === p_meet).forEach((r) => log('delete', r));
      db.data.results = db.data.results.filter((r) => r.meet_id !== p_meet);
      db.data.meets = db.data.meets.filter((m) => m.id !== p_meet);
      return ok(null);
    },
    set_goal_splits: ({ p_goal, p_splits }) => {
      if (db.role !== 'coach') return fail('Only the swimmer\'s coach can set goal splits');
      const g = db.data.goals.find((x) => x.id === p_goal);
      if (g) { g.goal_splits_cs = p_splits; g.goal_splits_set_by = p_splits ? USERS.coach.id : null; }
      return ok(null);
    },
  };

  return {
    from: (table) => new Query(db, table),
    rpc: async (name, args) => (rpcs[name] ? rpcs[name](args || {}) : fail(`${name} isn't available in the demo`)),
    auth: {
      getSession: async () => ({ data: { session: { user: USERS[db.role] } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }),
    },
    setRole(role) {
      db.role = role;
      // Each role sees only what it would see for real
      db.data.team_coaches = role === 'coach' ? [{ team_id: TEAM, user_id: USERS.coach.id, role: 'head' }] : [];
    },
    currentUser: () => USERS[db.role],
  };
}
