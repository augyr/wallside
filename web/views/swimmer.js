// A swimmer's page: coach notes, goals, best times, attendance.
// Shown to the family (mode 'family') and, with coach tools, to the coach (mode 'coach').
import { db, state, topBar } from '../app.js';
import { h, mount, must, toast, busy, field, formatTime, eventName, timeAgo, emptyCard, parseTime, formatDate, backLink, withColumns } from '../ui.js';
import { EVENTS, COURSE_LABEL } from '../lib/time.js';
import { analyticsLevel } from '../lib/levels.js';
import { bestTimes } from '../lib/bests.js';
import { cutStatus, ageForStandards, cutLabel, standardSets } from '../lib/standards.js';

const TAGS = { great: 'Great improvement', keep_working: 'Keep working', new_focus: 'New focus' };
const KINDS = { time: 'Time', practice: 'Practice', technique: 'Technique', other: 'Other' };

let course = 'SCY';
export function currentCourse() { return course; }

export function swimmerHref(mode, id) {
  return mode === 'coach' ? `#/coach/s/${id}` : `#/family/${id}`;
}

function isoToday() {
  const x = new Date(); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10);
}

async function loadSwimmer(me) {
  let notesQuery = db.from('notes')
    .select('id, body, focus, tag, correction, corrected_at, created_at, swimmer_id, group_id, note_replies(id, body, created_at, author_id)')
    .order('created_at', { ascending: false })
    .limit(20);
  notesQuery = me.group_id
    ? notesQuery.or(`swimmer_id.eq.${me.id},group_id.eq.${me.group_id}`)
    : notesQuery.eq('swimmer_id', me.id);

  const monthStart = new Date();
  monthStart.setDate(1);
  const today = isoToday();
  const [notes, goals, results, attendance, account, parents, seeds] = await Promise.all([
    notesQuery,
    db.from('goals').select('id, kind, title, course, due_label, status, created_at, created_by, distance, stroke, target_cs')
      .eq('swimmer_id', me.id).eq('status', 'active').order('created_at', { ascending: false }),
    db.from('results').select('distance, stroke, course, time_cs, status, meet_name, meet_date').eq('swimmer_id', me.id),
    db.from('attendance').select('status, parent_reported, reason, practices!inner(practice_date, session)').eq('swimmer_id', me.id)
      .gte('practices.practice_date', monthStart.toISOString().slice(0, 10)),
    db.from('swimmer_accounts').select('swimmer_id').eq('swimmer_id', me.id),
    db.from('guardians').select('swimmer_id').eq('swimmer_id', me.id),
    db.from('seed_times').select('distance, stroke, course, time_cs, meets(name, meet_date)').eq('swimmer_id', me.id)
      .then((r) => (r.error ? { data: [], error: null } : r)),
  ]);
  const att = must(attendance) || [];
  return {
    notes: must(notes) || [],
    goals: must(goals) || [],
    results: must(results) || [],
    attendance: att.filter((a) => a.practices.practice_date <= today),
    upcoming: att.filter((a) => a.practices.practice_date >= today && a.parent_reported)
      .sort((a, b) => a.practices.practice_date.localeCompare(b.practices.practice_date)),
    seeds: must(seeds) || [],
    hasOwnLogin: (must(account) || []).length > 0,
    hasParent: (must(parents) || []).length > 0,
  };
}

/**
 * @param id    swimmer id
 * @param mode  'family' | 'coach'
 * @param opts  { role: 'guardian'|'self', siblings: [{id, first_name}] }  (family mode)
 */
export async function renderSwimmerPage(id, mode, opts = {}) {
  const chrome = mode === 'coach' ? (await import('./coach.js')).coachChrome('roster') : topBar('family');
  mount(chrome, h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));

  let me; let data;
  try {
    const base = 'id, first_name, last_name, birth_year, birth_year_estimated, group_id, analytics_level, groups(name, analytics_level), teams(name)';
    me = must(await withColumns((c) => db.from('swimmers').select(c).eq('id', id).maybeSingle(), base + ', gender', base));
    if (!me) throw new Error('Swimmer not found');
    data = await loadSwimmer(me);
  } catch (err) {
    toast(err.message || String(err), 'error');
    return;
  }

  const role = opts.role;
  const refresh = () => renderSwimmerPage(id, mode, opts);
  const level = analyticsLevel(me, me.groups);

  const switcher = mode === 'family' && ((opts.siblings || []).length > 1 || role === 'guardian')
    ? h('nav', { class: 'switcher', 'aria-label': 'Swimmer' },
        (opts.siblings || []).map((s) => h('a', { href: '#/family/' + s.id, class: 'chip' + (s.id === me.id ? ' on' : ''),
          'aria-current': s.id === me.id ? 'page' : null }, s.first_name)),
        role === 'guardian' ? h('a', { href: '#/join', class: 'chip add', 'aria-label': 'Add another swimmer' }, '+') : null)
    : null;

  const header = mode === 'coach'
    ? h('div', { class: 'stack tight' },
        backLink('#/coach', 'Roster'),
        h('div', { class: 'card-head' },
          h('h1', {}, `${me.first_name} ${me.last_name}`),
          h('a', { href: `#/coach/s/${me.id}/edit`, class: 'btn small' }, 'Edit details')),
        h('p', { class: 'muted small' }, [me.groups && me.groups.name,
          me.birth_year ? `born ${me.birth_year}${me.birth_year_estimated ? ' (est.)' : ''}` : 'birth year not set',
          level.label].filter(Boolean).join(' · ')))
    : null;

  mount(chrome,
    mode === 'family' ? h('header', { class: 'team-head teal' },
      h('p', { class: 'eyebrow' }, role === 'self' ? 'My page' : 'Parent'),
      h('h1', {}, role === 'self' ? `Hey, ${me.first_name}` : `${me.first_name} ${me.last_name}`),
      h('p', {}, [me.groups && me.groups.name, me.teams && me.teams.name].filter(Boolean).join(' · '))) : null,
    switcher,
    h('main', { class: 'page' },
      header,
      glance(me, data, mode, role),
      mode === 'family' && role === 'self' && !data.hasParent
        ? h('section', { class: 'card empty' },
            h('div', { class: 'card-head' }, h('h2', {}, "Coach's notes"), h('span', { class: 'pill' }, 'Locked')),
            h('p', { class: 'muted' }, 'Coach notes and messages turn on once a parent or guardian joins — every message goes to you and your parents together. Ask a parent to join with the parent code from your coach.'))
        : notesSection(me, data.notes, mode, refresh, data.hasParent),
      timesSection(me, data.results, mode, refresh, data.seeds),
      goalsSection(me, data.goals, refresh),
      attendanceSection(me, data, role, refresh),
      mode === 'family' && role === 'guardian' ? swimmerLoginSection(me, data.hasOwnLogin) : null));
}

// ------------------------------------------------------------------
// At a glance: three small tiles (attendance, goals, latest note / working on)
function glance(me, data, mode, role) {
  const att = data.attendance;
  const here = att.filter((r) => r.status !== 'out').length;
  const focus = (data.notes.find((n) => n.focus) || {}).focus;
  const latest = data.notes[0];
  const locked = mode === 'family' && role === 'self' && !data.hasParent;
  const tile = (label, value, sub) => h('div', { class: 'tile' },
    h('span', { class: 'small muted' }, label), h('span', { class: 'tile-value' }, value), sub ? h('span', { class: 'small muted' }, sub) : null);
  return h('section', { class: 'tiles' },
    tile('Attendance', att.length ? `${here}/${att.length}` : '—', new Date().toLocaleDateString(undefined, { month: 'long' })),
    tile('Goals', String(data.goals.length), data.goals.length ? 'active' : 'none yet'),
    locked || !latest ? tile('Coach notes', locked ? '🔒' : '—', locked ? 'parent joins first' : 'none yet')
      : focus ? h('div', { class: 'tile' }, h('span', { class: 'small muted' }, 'Working on'), h('span', { class: 'tile-text' }, focus), h('span', { class: 'small muted' }, timeAgo(latest.created_at)))
        : tile('Latest note', timeAgo(latest.created_at), TAGS[latest.tag] || ''));
}

function notesSection(me, notes, mode, refresh, hasParent) {
  const composer = mode === 'coach' ? h('details', { class: 'add-goal' },
    h('summary', {}, `+ Note to ${me.first_name}`), h('div', { class: 'composer-slot' })) : null;
  if (composer) {
    composer.addEventListener('toggle', async () => {
      const slot = composer.querySelector('.composer-slot');
      if (!composer.open || slot.childElementCount) return;
      const { noteComposer } = await import('./coach-home.js');
      const { coachTeam } = await import('./coach.js');
      slot.append(noteComposer({ team: coachTeam(), preset: [me.id], onSent: refresh,
        data: { swimmers: [me], groups: [], joined: { [me.id]: hasParent ? 1 : 0 } } }));
    }, { once: false });
  }
  if (!notes.length) {
    return h('section', { class: 'card empty' },
      h('h3', {}, "Coach's notes"),
      h('p', { class: 'muted' }, `Notes from ${me.first_name}'s coach will show here — what they're working on and how it's going. Every note goes to ${me.first_name} and their parents together.`),
      composer);
  }
  const first = notes.slice(0, 2);
  const rest = notes.slice(2);
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, "Coach's notes"), h('span', { class: 'muted small' }, 'Shared with swimmer & parents')),
    h('ul', { class: 'list' }, first.map((n) => noteItem(n, refresh))),
    rest.length ? h('details', {}, h('summary', { class: 'small' }, `${rest.length} earlier note${rest.length === 1 ? '' : 's'}`),
      h('ul', { class: 'list' }, rest.map((n) => noteItem(n, refresh)))) : null,
    composer);
}

function noteItem(n, refresh) {
  const replyBox = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Reply (the swimmer\'s family and coach see replies)' });
  const replies = (n.note_replies || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    if (!replyBox.value.trim()) return;
    await busy(form.querySelector('button'), async () => {
      must(await db.from('note_replies').insert({ note_id: n.id, author_id: state.user.id, body: replyBox.value.trim() }));
      toast('Reply sent', 'success');
      refresh();
    });
  } }, replyBox, h('button', { type: 'submit', class: 'btn small' }, 'Send reply'));

  return h('li', { class: 'note' },
    h('div', { class: 'note-meta' },
      n.group_id ? h('span', { class: 'pill' }, 'Whole group') : null,
      n.tag ? h('span', { class: 'pill ok' }, TAGS[n.tag]) : null,
      h('span', { class: 'muted small' }, timeAgo(n.created_at))),
    n.focus ? h('p', { class: 'focus' }, 'Focus: ' + n.focus) : null,
    h('p', {}, n.body),
    n.correction ? h('p', { class: 'correction' }, h('strong', {}, 'Correction: '), n.correction) : null,
    replies.length ? h('ul', { class: 'replies' }, replies.map((r) => h('li', {},
      h('span', { class: 'muted small' }, (r.author_id === state.user.id ? 'You' : 'Family/coach') + ' · ' + timeAgo(r.created_at)),
      h('p', {}, r.body)))) : null,
    n.swimmer_id ? h('details', {}, h('summary', { class: 'small' }, 'Reply'), form) : null);
}

// ------------------------------------------------------------------
export function eventOptions(courseCode) {
  return EVENTS[courseCode].map(([d, s]) => h('option', { value: `${d}-${s}` }, eventName(d, s)));
}

function goalsSection(me, goals, refresh) {
  const kind = h('select', {}, Object.entries(KINDS).map(([v, label]) => h('option', { value: v }, label)));
  const title = h('input', { type: 'text', maxlength: 160, placeholder: 'e.g. Make every morning practice' });
  const goalCourse = h('select', {}, h('option', { value: 'SCY' }, COURSE_LABEL.SCY), h('option', { value: 'LCM' }, COURSE_LABEL.LCM));
  const event = h('select', {}, eventOptions('SCY'));
  const target = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'e.g. 59.00 or 2:05.50', class: 'time-input' });
  const timeFields = h('div', { class: 'stack' },
    h('div', { class: 'grid2' }, field('Course', goalCourse), field('Event', event)),
    field('Goal time', target));
  const titleField = field('Goal', title);
  const sync = () => { timeFields.hidden = kind.value !== 'time'; titleField.hidden = kind.value === 'time'; };
  goalCourse.addEventListener('change', () => event.replaceChildren(...eventOptions(goalCourse.value)));
  kind.addEventListener('change', sync);
  sync();
  const due = h('select', {},
    h('option', {}, 'Championship meet'), h('option', {}, 'End of this month'), h('option', {}, 'End of season'));

  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      const row = { swimmer_id: me.id, created_by: state.user.id, kind: kind.value, due_label: due.value };
      if (kind.value === 'time') {
        const cs = parseTime(target.value);
        if (!cs) throw new Error('Enter the goal time, like 59.00 or 2:05.50');
        const [d, s] = event.value.split('-');
        Object.assign(row, { course: goalCourse.value, distance: Number(d), stroke: s, target_cs: cs,
          title: `${eventName(Number(d), s)} (${goalCourse.value}) under ${formatTime(cs)}` });
      } else {
        if (!title.value.trim()) throw new Error('Describe the goal');
        row.title = title.value.trim();
      }
      must(await db.from('goals').insert(row));
      toast('Goal shared with coach and family', 'success');
      refresh();
    });
  } },
    field('Type', kind), timeFields, titleField, field('By when?', due),
    h('button', { type: 'submit', class: 'btn primary' }, 'Share goal'));

  const add = h('details', { class: 'add-goal', open: goals.length ? null : true }, h('summary', {}, goals.length ? '+ New goal' : 'Set a first goal'), form);

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Goals'), h('span', { class: 'muted small' }, 'Seen by coach & family')),
    goals.length
      ? h('ul', { class: 'list' }, goals.map((g) => h('li', { class: 'goal' },
          h('span', { class: 'pill' }, KINDS[g.kind] + (g.course ? ' · ' + g.course : '')),
          h('strong', { class: 'block' }, g.title),
          g.due_label ? h('span', { class: 'muted small' }, 'By: ' + g.due_label) : null)))
      : h('p', { class: 'muted' }, `Goals will show here. Set a time, practice or technique goal — ${me.first_name}'s coach and family will see it.`),
    add);
}

// ------------------------------------------------------------------
function timesSection(me, results, mode, refresh, seeds = []) {
  const best = bestTimes(results, seeds)[course] || {};
  const order = EVENTS[course].map(([d, s]) => `${d}-${s}`);
  const rows = Object.entries(best).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

  const toggle = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Course' },
    ['SCY', 'LCM'].map((c) => h('button', { type: 'button', class: c === course ? 'on' : '', 'aria-pressed': c === course ? 'true' : 'false',
      onClick: () => { course = c; refresh(); } }, COURSE_LABEL[c])));

  const item = ([key, r]) => {
    const [d, st] = key.split('-');
    return h('li', {},
      h('a', { class: 'list-row row-link compact', href: `${swimmerHref(mode, me.id)}/e/${key}-${course}` },
        h('span', { class: 'grow' },
          h('strong', {}, eventName(Number(d), st)),
          h('span', { class: 'muted small block' }, r.fromSeed
            ? ['from seed time', r.meet_name ? 'entered at ' + r.meet_name : null].filter(Boolean).join(' · ')
            : [r.meet_name, formatDate(r.meet_date)].filter(Boolean).join(' · '))),
        h('span', { class: 'time-col' },
          h('span', { class: 'time' }, formatTime(r.time_cs)),
          (() => {
            const c = cutStatus(r.time_cs, { distance: Number(d), stroke: st, course, gender: me.gender, age: ageForStandards({ birthYear: me.birth_year }) });
            return [c.met ? h('span', { class: 'cut-badge' }, cutLabel(c.met.set)) : null,
              c.next ? h('span', { class: 'cut-next' }, `${formatTime(c.next.gap)} to ${cutLabel(c.next.set)}`) : null];
          })()),
        h('span', { 'aria-hidden': 'true', class: 'chev' }, '›')));
  };
  const top = rows.slice(0, 6);
  const more = rows.slice(6);
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Best times'), rows.length ? h('span', { class: 'muted small' }, 'Tap for analytics') : null),
    toggle,
    !me.gender && mode === 'coach' && standardSets().length && rows.length
      ? h('a', { class: 'small', href: `#/coach/s/${me.id}/edit` }, 'Set girls or boys on Edit details to show time standards →') : null,
    rows.length
      ? [h('ul', { class: 'list' }, top.map(item)),
         more.length ? h('details', {}, h('summary', { class: 'small' }, `${more.length} more event${more.length === 1 ? '' : 's'}`), h('ul', { class: 'list' }, more.map(item))) : null]
      : h('p', { class: 'muted' }, `${me.first_name}'s ${course === 'SCY' ? 'yards' : 'long course'} times will show here after a meet, once the coach uploads results. Yards and meters are always kept separate.`));
}

// ------------------------------------------------------------------
function attendanceSection(me, data, role, refresh) {
  const rows = data.attendance;
  const counted = rows.filter((r) => r.status !== 'out').length;
  const total = rows.length;
  const month = new Date().toLocaleDateString(undefined, { month: 'long' });
  const report = role === 'guardian' ? absenceForm(me, data.upcoming, refresh) : null;
  if (!total) {
    return h('section', { class: 'card' + (report ? '' : ' empty') },
      h('h3', {}, 'Attendance'),
      h('p', { class: 'muted' }, `Practices ${me.first_name} attends will be counted here once the coach takes attendance. Morning and afternoon practices count separately.`),
      report);
  }
  const late = rows.filter((r) => r.status === 'late').length;
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Attendance'), h('span', { class: 'muted small' }, month)),
    h('p', {}, h('span', { class: 'stat' }, `${counted}/${total}`), h('span', { class: 'muted small' }, ` practices${late ? ` · ${late} late` : ''}`)),
    report);
}

// Parents: report an absence ahead of time; see and cancel what they reported
function absenceForm(me, upcoming, refresh) {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const date = h('input', { type: 'date', value: isoTodayPlus(1), min: isoToday() });
  const ses = h('select', {}, h('option', { value: 'PM' }, 'Afternoon (PM)'), h('option', { value: 'AM' }, 'Morning (AM)'), h('option', { value: 'BOTH' }, 'Both'));
  const reason = h('input', { type: 'text', maxlength: 200, placeholder: 'Optional — e.g. dentist' });
  const btn = h('button', { type: 'submit', class: 'btn' }, 'Report absence');
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(btn, async () => {
      if (!date.value) throw new Error('Pick a date.');
      for (const s of ses.value === 'BOTH' ? ['AM', 'PM'] : [ses.value]) {
        must(await db.rpc('report_absence', { p_swimmer: me.id, p_date: date.value, p_session: s, p_reason: reason.value.trim() || null }));
      }
      toast('Coach will see it on the attendance list', 'success');
      refresh();
    });
  } }, h('div', { class: 'grid2' }, field('Date', date), field('Practice', ses)), field('Reason', reason), btn);
  return h('div', { class: 'stack tight' },
    upcoming.length ? h('ul', { class: 'list' }, upcoming.map((a) => {
      const cancel = h('button', { type: 'button', class: 'btn small ghost', onClick: async () => {
        await busy(cancel, async () => {
          must(await db.rpc('cancel_absence', { p_swimmer: me.id, p_date: a.practices.practice_date, p_session: a.practices.session }));
          refresh();
        });
      } }, 'Cancel');
      return h('li', { class: 'list-row compact' },
        h('span', { class: 'grow' }, h('strong', { class: 'small' }, `Out · ${formatDate(a.practices.practice_date)} ${a.practices.session}`),
          a.reason ? h('span', { class: 'muted small block' }, a.reason) : null), cancel);
    })) : null,
    h('details', { class: 'add-goal' }, h('summary', {}, `+ Report ${me.first_name} out`), form));
}

function isoTodayPlus(n) {
  const x = new Date(); x.setDate(x.getDate() + n); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------
function swimmerLoginSection(me, hasOwnLogin) {
  if (hasOwnLogin) {
    return h('section', { class: 'card' }, h('h2', {}, `${me.first_name}'s login`),
      h('p', { class: 'muted' }, `${me.first_name} has their own login and sees only their own page.`));
  }
  const age = me.birth_year ? new Date().getFullYear() - me.birth_year : null;
  if (age === null || age < 13) {
    return h('section', { class: 'card' }, h('h2', {}, `${me.first_name}'s login`),
      h('p', { class: 'muted' }, `Swimmers under 13 use a parent's account. ${me.first_name} can look at this page with you.`));
  }
  const out = h('div');
  const make = h('button', { type: 'button', class: 'btn', onClick: async () => {
    await busy(make, async () => {
      const code = must(await db.rpc('create_invite', { p_swimmer: me.id, p_kind: 'swimmer' }));
      out.replaceChildren(h('p', {}, 'Give this code to ', h('strong', {}, me.first_name), ': ', h('code', { class: 'code' }, code)),
        h('p', { class: 'muted small' }, `${me.first_name} signs in with their own email and enters it. Works once.`));
    });
  } }, `Invite ${me.first_name} to their own login`);
  return h('section', { class: 'card stack' },
    h('h2', {}, `${me.first_name}'s login`),
    h('p', { class: 'muted' }, `${me.first_name} is 13 or older and can have their own login. They'll see only their own page; you still see everything.`),
    make, out);
}
