// Coach: Home (today at a glance), Notes (write + feedback coverage) and Practice (attendance).
import { db, state } from '../app.js';
import { h, mount, must, toast, busy, field, initials, timeAgo, formatDate, friendlyError } from '../ui.js';
import { coachChrome, coachTeam, loadTeam, rosterDropdown } from './coach.js';

const TAGS = { great: 'Great improvement', keep_working: 'Keep working', new_focus: 'New focus' };
const STARTERS = { great: 'Great improvement on ', keep_working: 'Keep working on ', new_focus: '' };
const COVERAGE_DAYS = 10;   // "1.5 weeks"
const STATUS_NEXT = { here: 'late', late: 'out', out: 'here' };
const STATUS_LABEL = { here: 'Here', late: 'Late', out: 'Out' };

const isoDay = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const todayIso = () => isoDay(new Date());
const nowSession = () => (new Date().getHours() < 12 ? 'AM' : 'PM');
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const fullName = (s) => `${s.first_name} ${s.last_name}`;

async function safe(query, fallback) {
  const r = await query;
  return r.error ? fallback : (r.data || fallback);
}

// ------------------------------------------------------------------
// Home
// ------------------------------------------------------------------
export async function renderHome({ rosterOpen = false } = {}) {
  const team = coachTeam();
  mount(coachChrome('home'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  const since = new Date(Date.now() - COVERAGE_DAYS * 86400000).toISOString();
  let data; let practices; let notes; let inbox;
  try {
    [data, practices, notes, inbox] = await Promise.all([
      loadTeam(team.id),
      db.from('practices').select('id, group_id, session, practice_date, attendance(status, parent_reported)')
        .eq('team_id', team.id).eq('practice_date', todayIso()).then(must),
      db.from('notes').select('swimmer_id, group_id, created_at').eq('team_id', team.id).gte('created_at', since).then(must),
      safe(db.from('results_inbox').select('id, kind, status, meet_name, meet_date, course, summary, payload, source_url, meet_id')
        .eq('team_id', team.id).eq('status', 'pending').order('found_at', { ascending: false }), []),
    ]);
  } catch (err) { toast(friendlyError(err), 'error'); return; }

  const { inboxCard } = await import('./results.js');
  const heldNames = inbox.flatMap((i) => (i.summary && i.summary.heldNames) || []);
  const joinedCount = data.swimmers.filter((s) => data.joined[s.id] || data.selfJoined[s.id]).length;

  const draw = () => mount(coachChrome('home',
      `${data.swimmers.length} swimmer${data.swimmers.length === 1 ? '' : 's'} on the team · ${joinedCount} signed in`),
    h('main', { class: 'page' },
      inboxSlot,
      todayCard(team, data, practices),
      coverageCard(data, notes),
      h('details', { class: 'card' }, h('summary', {}, 'Write a note'),
        noteComposer({ team, data, onSent: () => renderHome() })),
      rosterDropdown(team.id, data, { open: rosterOpen, heldNames }),
      team.sourceUrl || !team.code ? null : h('a', { href: '#/coach/team', class: 'notice-link quiet' },
        'Turn on automatic results — the app finds new PASA meets for you to approve →')));

  const inboxSlot = h('div', { class: 'stack' }, inboxCard(inbox, team.id, () => renderHome()));
  draw();

  // Look for new results in the background (at most twice a day)
  if (team.sourceUrl) {
    const { runAutoCheck } = await import('./results-auto.js');
    const res = await runAutoCheck(team);
    if (res.added && location.hash.replace(/^#/, '') === '/coach') renderHome({ rosterOpen });
  }
}

function todayCard(team, data, practices) {
  const session = nowSession();
  const groups = data.groups.filter((g) => data.swimmers.some((s) => s.group_id === g.id));
  const byKey = Object.fromEntries((practices || []).map((p) => [`${p.group_id}|${p.session}`, p]));
  const day = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const rows = [];
  for (const g of groups) {
    for (const ses of ['AM', 'PM']) {
      const p = byKey[`${g.id}|${ses}`];
      const size = data.swimmers.filter((s) => s.group_id === g.id).length;
      if (!p && ses !== session) continue;   // show the other session only if it happened
      const att = p ? p.attendance || [] : [];
      const taken = att.some((a) => !a.parent_reported);
      const here = att.filter((a) => a.status !== 'out').length;
      const out = att.filter((a) => a.status === 'out').length;
      rows.push(h('li', {},
        h('a', { class: 'list-row row-link compact', href: `#/coach/practice/${todayIso()}/${ses}/${g.id}` },
          h('span', { class: 'session-tag' }, ses),
          h('span', { class: 'grow' }, h('strong', {}, g.name),
            h('span', { class: 'muted small block' }, taken ? `${here} of ${size} here${out ? ` · ${out} out` : ''}`
              : out ? `${out} reported out by parents` : 'Attendance not taken')),
          h('span', { class: 'btn small' + (taken ? '' : ' primary') }, taken ? 'Open' : 'Take'))));
    }
  }
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Today'), h('span', { class: 'muted small' }, day)),
    rows.length ? h('ul', { class: 'list' }, rows)
      : h('p', { class: 'muted' }, 'Put swimmers in a training group to take attendance.'));
}

// Personal notes in the last 10 days, per swimmer
function coverage(data, notes) {
  const last = {};
  for (const n of notes || []) {
    if (!n.swimmer_id) continue;
    if (!last[n.swimmer_id] || n.created_at > last[n.swimmer_id]) last[n.swimmer_id] = n.created_at;
  }
  return last;
}

function coverageCard(data, notes) {
  if (!data.swimmers.length) return null;
  const last = coverage(data, notes);
  const total = data.swimmers.length;
  const noted = data.swimmers.filter((s) => last[s.id] && daysSince(last[s.id]) < COVERAGE_DAYS).length;
  const pct = Math.round((noted / total) * 100);
  const missing = total - noted;
  return h('a', { class: 'card coverage row-link', href: '#/coach/notes' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Feedback'), h('span', { class: 'muted small' }, `last ${COVERAGE_DAYS} days`)),
    h('div', { class: 'meter', role: 'img', 'aria-label': `${noted} of ${total} swimmers had a personal note in the last ${COVERAGE_DAYS} days` },
      h('span', { style: `width:${pct}%` })),
    h('p', { class: 'small' }, h('strong', {}, `${noted} of ${total}`), ' had a personal note',
      missing ? h('span', { class: 'warn-text' }, ` · ${missing} need one →`) : h('span', { class: 'ok-text' }, ' · everyone ✓')));
}

// ------------------------------------------------------------------
// Note composer: one or more swimmers, or a whole group; parents always included
// ------------------------------------------------------------------
export function noteComposer({ team, data, preset = [], onSent }) {
  const chosen = new Set(preset);
  let tag = null;
  const chips = h('div', { class: 'chips' });
  const info = h('p', { class: 'muted small' });
  const picker = h('select', { 'aria-label': 'Add a recipient' });
  const body = h('textarea', { rows: 3, maxlength: 2000, placeholder: 'What went well, what to work on…' });
  const focus = h('input', { type: 'text', maxlength: 80, placeholder: 'e.g. Breakouts' });
  const focusField = field('Focus (optional)', focus);
  const tagChips = h('div', { class: 'chips' });
  const send = h('button', { type: 'submit', class: 'btn primary' }, 'Send');

  const byId = Object.fromEntries(data.swimmers.map((s) => [s.id, s]));
  const groupById = Object.fromEntries(data.groups.map((g) => [g.id, g]));
  const label = (id) => (groupById[id] ? `${groupById[id].name} (whole group)` : byId[id] ? fullName(byId[id]) : '?');

  function draw() {
    picker.replaceChildren(
      h('option', { value: '' }, chosen.size ? '+ Add someone' : 'Choose a swimmer or group'),
      h('optgroup', { label: 'Whole group' }, data.groups.filter((g) => !chosen.has(g.id)).map((g) => h('option', { value: g.id }, g.name))),
      h('optgroup', { label: 'Swimmers' }, [...data.swimmers].sort((a, b) => a.first_name.localeCompare(b.first_name))
        .filter((s) => !chosen.has(s.id)).map((s) => h('option', { value: s.id }, fullName(s)))));
    chips.replaceChildren(...[...chosen].map((id) => h('button', { type: 'button', class: 'chip small on', 'aria-label': `Remove ${label(id)}`,
      onClick: () => { chosen.delete(id); draw(); } }, label(id), ' ×')));
    tagChips.replaceChildren(...Object.entries(TAGS).map(([k, text]) => h('button', {
      type: 'button', class: 'chip small' + (tag === k ? ' on' : ''), 'aria-pressed': tag === k ? 'true' : 'false',
      onClick: () => {
        tag = tag === k ? null : k;
        if (tag && (!body.value.trim() || Object.values(STARTERS).includes(body.value))) body.value = STARTERS[tag];
        draw();
        if (tag === 'new_focus') focus.focus(); else body.focus();
      } }, text)));
    focusField.hidden = tag !== 'new_focus' && !focus.value;
    const people = [...chosen].filter((id) => byId[id]);
    const waiting = people.filter((id) => !data.joined[id]);
    const groupsChosen = [...chosen].filter((id) => groupById[id]);
    info.replaceChildren(...[
      !chosen.size ? 'Every note goes to the swimmer and their parents together.'
        : [groupsChosen.length ? `Goes to everyone in ${groupsChosen.map((g) => groupById[g].name).join(' and ')} and their parents.` : null,
           people.length ? `${people.length === 1 ? fullName(byId[people[0]]) + ' and their parents' : people.length + ' swimmers and their parents'} will see it.` : null]
          .filter(Boolean).join(' '),
      waiting.length ? h('span', { class: 'block warn-text' },
        `${waiting.length === 1 ? byId[waiting[0]].first_name + '\'s' : waiting.length + ' swimmers\''} parents haven't joined yet — the note waits on their page until a parent joins.`) : null].filter(Boolean));
    send.textContent = chosen.size > 1 ? `Send to ${chosen.size}` : 'Send';
  }
  picker.addEventListener('change', () => { if (picker.value) chosen.add(picker.value); draw(); });
  draw();

  const form = h('form', { class: 'stack composer', onSubmit: async (e) => {
    e.preventDefault();
    await busy(send, async () => {
      if (!chosen.size) throw new Error('Choose who the note is for.');
      const text = body.value.trim();
      if (!text || Object.values(STARTERS).includes(body.value)) throw new Error('Write the note first.');
      const rows = [...chosen].map((id) => ({
        team_id: team.id, author_id: state.user.id, body: text, tag, focus: focus.value.trim() || null,
        swimmer_id: byId[id] ? id : null, group_id: groupById[id] ? id : null,
      }));
      must(await db.from('notes').insert(rows));
      toast(rows.length > 1 ? `Note sent to ${rows.length}` : 'Note sent', 'success');
      if (onSent) onSent();
    });
  } },
    h('div', { class: 'stack tight' }, h('span', { class: 'label' }, 'To'), chips, picker),
    h('div', { class: 'stack tight' }, h('span', { class: 'label' }, 'Template'), tagChips),
    focusField,
    field('Note', body),
    info, send);
  return form;
}

// ------------------------------------------------------------------
// Notes tab: write, feedback coverage, recent notes
// ------------------------------------------------------------------
export async function renderNotes(presetId) {
  const team = coachTeam();
  mount(coachChrome('notes'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  let data; let notes;
  try {
    [data, notes] = await Promise.all([
      loadTeam(team.id),
      db.from('notes').select('id, swimmer_id, group_id, body, tag, focus, created_at, correction').eq('team_id', team.id)
        .gte('created_at', since).order('created_at', { ascending: false }).then(must),
    ]);
  } catch (err) { toast(friendlyError(err), 'error'); return; }

  const last = coverage(data, notes);
  const byId = Object.fromEntries(data.swimmers.map((s) => [s.id, s]));
  const groupById = Object.fromEntries(data.groups.map((g) => [g.id, g]));
  const rows = data.swimmers.map((s) => ({ s, days: last[s.id] ? daysSince(last[s.id]) : null }));
  const need = rows.filter((r) => r.days === null || r.days >= COVERAGE_DAYS)
    .sort((a, b) => (b.days === null ? 9999 : b.days) - (a.days === null ? 9999 : a.days));
  const done = rows.filter((r) => r.days !== null && r.days < COVERAGE_DAYS).sort((a, b) => b.days - a.days);

  const composerHolder = h('section', { class: 'card', id: 'composer' });
  const showComposer = (preset) => {
    composerHolder.replaceChildren(h('h2', {}, 'Write a note'), noteComposer({ team, data, preset, onSent: () => renderNotes() }));
  };
  showComposer(presetId && (byId[presetId] || groupById[presetId]) ? [presetId] : []);

  const personRow = ({ s, days }, needsOne) => h('li', { class: 'list-row compact' },
    h('span', { class: 'avatar sm' }, initials(s.first_name, s.last_name)),
    h('a', { class: 'grow row-link', href: `#/coach/s/${s.id}` }, h('strong', {}, fullName(s)),
      h('span', { class: 'small block ' + (needsOne ? 'warn-text' : 'muted') },
        days === null ? 'No personal note yet' : days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'} ago`,
        !data.joined[s.id] ? ' · parents not joined' : '')),
    h('button', { type: 'button', class: 'btn small' + (needsOne ? '' : ' ghost'), onClick: () => {
      showComposer([s.id]);
      composerHolder.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } }, 'Note'));

  const total = data.swimmers.length;
  const recent = (notes || []).slice(0, 15);
  mount(coachChrome('notes'), h('main', { class: 'page' },
    composerHolder,
    total ? h('section', { class: 'card stack' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Feedback coverage'), h('span', { class: 'muted small' }, `last ${COVERAGE_DAYS} days`)),
      h('div', { class: 'meter', role: 'img', 'aria-label': `${done.length} of ${total} had a personal note` },
        h('span', { style: `width:${Math.round((done.length / total) * 100)}%` })),
      h('p', { class: 'small' }, h('strong', {}, `${done.length} of ${total}`), ' swimmers had a personal note. Group notes don\'t count here.'),
      need.length ? h('div', { class: 'stack tight' },
        h('h3', { class: 'small-head' }, `Needs a note · ${need.length}`),
        h('ul', { class: 'list' }, need.map((r) => personRow(r, true)))) : h('p', { class: 'notice' }, 'Everyone has had a personal note. Nice.'),
      done.length ? h('details', {},
        h('summary', { class: 'small' }, `Noted recently · ${done.length}`),
        h('ul', { class: 'list' }, done.map((r) => personRow(r, false)))) : null) : null,
    h('section', { class: 'card' },
      h('h2', {}, 'Recent notes'),
      recent.length ? h('ul', { class: 'list' }, recent.map((n) => h('li', { class: 'note' },
        h('div', { class: 'note-meta' },
          h('strong', { class: 'small' }, n.group_id ? `${(groupById[n.group_id] || {}).name || 'Group'} (group)` : byId[n.swimmer_id] ? fullName(byId[n.swimmer_id]) : 'Swimmer'),
          n.tag ? h('span', { class: 'pill ok' }, TAGS[n.tag]) : null,
          h('span', { class: 'muted small' }, timeAgo(n.created_at))),
        n.focus ? h('p', { class: 'focus small' }, 'Focus: ' + n.focus) : null,
        h('p', { class: 'small' }, n.body))))
        : h('p', { class: 'muted' }, 'Notes you send will show here.'))));
}

// ------------------------------------------------------------------
// Practice: attendance for one group, one session, one day
// ------------------------------------------------------------------
const QUEUE_KEY = 'wallside.attendanceQueue';
function readQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
function writeQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* storage off */ } }

async function saveMark(practiceId, swimmerId, status) {
  const row = { practice_id: practiceId, swimmer_id: swimmerId, status, parent_reported: false, reason: null,
    updated_by: state.user.id, updated_at: new Date().toISOString() };
  const res = await db.from('attendance').upsert(row, { onConflict: 'practice_id,swimmer_id' });
  if (res.error) {
    if (/fetch|network/i.test(res.error.message || '') || !navigator.onLine) {
      const q = readQueue().filter((x) => !(x.practice_id === practiceId && x.swimmer_id === swimmerId));
      q.push(row); writeQueue(q);
      return 'queued';
    }
    throw res.error;
  }
  return 'saved';
}

export async function flushAttendanceQueue() {
  if (state.demo) return 0;
  const q = readQueue();
  if (!q.length) return 0;
  const left = [];
  for (const row of q) {
    const res = await db.from('attendance').upsert(row, { onConflict: 'practice_id,swimmer_id' });
    if (res.error) left.push(row);
  }
  writeQueue(left);
  return q.length - left.length;
}
window.addEventListener('online', () => { flushAttendanceQueue().then((n) => { if (n) toast(`${n} attendance change${n === 1 ? '' : 's'} synced`, 'success'); }); });

export async function renderPractice(dateArg, sessionArg, groupArg) {
  const team = coachTeam();
  mount(coachChrome('practice'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateArg || '') ? dateArg : todayIso();
  const session = sessionArg === 'AM' || sessionArg === 'PM' ? sessionArg : nowSession();
  let data;
  try { data = await loadTeam(team.id); } catch (err) { toast(friendlyError(err), 'error'); return; }
  const groups = data.groups.filter((g) => data.swimmers.some((s) => s.group_id === g.id));
  if (!groups.length) {
    mount(coachChrome('practice'), h('main', { class: 'page' },
      h('section', { class: 'card empty' }, h('h3', {}, 'No training groups with swimmers'),
        h('p', { class: 'muted' }, 'Put swimmers in a group (edit a swimmer, or paste the roster with groups) to take attendance.'))));
    return;
  }
  const group = groups.find((g) => g.id === groupArg) || groups[0];
  const swimmers = data.swimmers.filter((s) => s.group_id === group.id).sort((a, b) => a.first_name.localeCompare(b.first_name));
  const path = (d, ses, g) => `#/coach/practice/${d}/${ses}/${g}`;

  const flushed = await flushAttendanceQueue();
  if (flushed) toast(`${flushed} offline change${flushed === 1 ? '' : 's'} synced`, 'success');

  let practice = null; let marks = {};
  try {
    practice = must(await db.from('practices').select('id').eq('group_id', group.id).eq('practice_date', date).eq('session', session).maybeSingle());
    if (practice) {
      for (const a of must(await db.from('attendance').select('swimmer_id, status, parent_reported, reason').eq('practice_id', practice.id)) || []) marks[a.swimmer_id] = a;
    }
  } catch (err) { toast(friendlyError(err), 'error'); return; }
  for (const q of readQueue()) if (practice && q.practice_id === practice.id) marks[q.swimmer_id] = { ...q, queued: true };

  const shift = (n) => { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDay(d); };
  const dayLabel = date === todayIso() ? 'Today' : new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const taken = practice && Object.values(marks).some((m) => !m.parent_reported);
  const future = date > todayIso();

  const counts = h('p', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const offline = h('p', { class: 'small warn-text', hidden: true });
  const drawCounts = () => {
    const vals = swimmers.map((s) => (marks[s.id] ? marks[s.id].status : taken ? 'here' : null)).filter(Boolean);
    const c = { here: 0, late: 0, out: 0 };
    for (const v of vals) c[v]++;
    counts.replaceChildren(h('strong', {}, `${c.here + c.late} of ${swimmers.length} here`),
      c.late ? ` · ${c.late} late` : '', c.out ? ` · ${c.out} out` : '');
    const q = readQueue().length;
    offline.hidden = !q;
    offline.textContent = q ? `Offline — ${q} change${q === 1 ? '' : 's'} saved on this device, will sync` : '';
  };

  const grid = h('ul', { class: 'att-grid' }, swimmers.map((s) => {
    const btn = h('button', { type: 'button', class: 'att' });
    const paint = () => {
      const m = marks[s.id];
      const st = m ? m.status : taken ? 'here' : 'none';
      btn.className = 'att ' + st;
      btn.replaceChildren(h('span', { class: 'att-name' }, s.first_name, ' ', h('span', { class: 'muted' }, s.last_name.charAt(0) + '.')),
        h('span', { class: 'att-status' }, st === 'none' ? '—' : STATUS_LABEL[st]),
        ...(m && m.parent_reported ? [h('span', { class: 'att-note' }, 'Parent: ' + (m.reason || 'out'))] : []));
      btn.setAttribute('aria-label', `${fullName(s)}: ${st === 'none' ? 'not marked' : STATUS_LABEL[st]}. Tap to change.`);
    };
    btn.addEventListener('click', async () => {
      if (!practice || !taken) { toast('Tap “Start” first — everyone starts as here', 'info'); return; }
      const cur = marks[s.id] ? marks[s.id].status : 'here';
      const next = STATUS_NEXT[cur];
      marks[s.id] = { status: next, parent_reported: false };
      paint(); drawCounts();
      try {
        const r = await saveMark(practice.id, s.id, next);
        if (r === 'queued') { marks[s.id].queued = true; drawCounts(); }
      } catch (err) {
        marks[s.id] = { status: cur }; paint(); drawCounts();
        toast(friendlyError(err), 'error');
      }
    });
    paint();
    return h('li', {}, btn);
  }));
  drawCounts();

  const start = h('button', { type: 'button', class: 'btn primary', onClick: async () => {
    await busy(start, async () => {
      must(await db.rpc('start_practice', { p_group: group.id, p_date: date, p_session: session }));
      renderPractice(date, session, group.id);
    });
  } }, 'Start — everyone here');

  mount(coachChrome('practice'), h('main', { class: 'page' },
    h('section', { class: 'card stack tight practice-bar' },
      h('div', { class: 'row between' },
        h('a', { class: 'btn small ghost', href: path(shift(-1), session, group.id), 'aria-label': 'Previous day' }, '‹'),
        h('strong', {}, dayLabel),
        h('a', { class: 'btn small ghost', href: path(shift(1), session, group.id), 'aria-label': 'Next day' }, '›')),
      h('div', { class: 'segmented' }, ['AM', 'PM'].map((ses) => h('a', { href: path(date, ses, group.id),
        class: 'seg' + (ses === session ? ' on' : ''), 'aria-current': ses === session ? 'page' : null }, ses === 'AM' ? 'Morning' : 'Afternoon'))),
      groups.length > 1 ? h('div', { class: 'chips' }, groups.map((g) => h('a', { href: path(date, session, g.id),
        class: 'chip small' + (g.id === group.id ? ' on' : '') }, g.name))) : null),
    h('section', { class: 'card stack' },
      h('div', { class: 'card-head' }, h('h2', {}, `${group.name} · ${session}`), counts),
      offline,
      !taken && !future ? h('div', { class: 'stack tight' }, start,
        h('p', { class: 'muted small' }, 'Then tap anyone who is late or out. Each tap saves right away.')) : null,
      future ? h('p', { class: 'muted small' }, 'Upcoming practice — parent-reported absences show here.') : null,
      taken ? h('p', { class: 'muted small' }, 'Tap to change: here → late → out.') : null,
      grid)));
}
