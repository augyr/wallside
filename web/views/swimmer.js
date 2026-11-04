// A swimmer's page: coach notes, goals, best times, attendance.
// Shown to the family (mode 'family') and, with coach tools, to the coach (mode 'coach').
import { db, state, topBar } from '../app.js';
import { h, mount, must, toast, busy, field, formatTime, eventName, timeAgo, emptyCard, parseTime, formatDate, backLink } from '../ui.js';
import { EVENTS, COURSE_LABEL } from '../lib/time.js';
import { analyticsLevel } from '../lib/levels.js';

const TAGS = { great: 'Great improvement', keep_working: 'Keep working', new_focus: 'New focus' };
const KINDS = { time: 'Time', practice: 'Practice', technique: 'Technique', other: 'Other' };

let course = 'SCY';
export function currentCourse() { return course; }

export function swimmerHref(mode, id) {
  return mode === 'coach' ? `#/coach/s/${id}` : `#/family/${id}`;
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
  const [notes, goals, results, attendance, account] = await Promise.all([
    notesQuery,
    db.from('goals').select('id, kind, title, course, due_label, status, created_at, created_by, distance, stroke, target_cs')
      .eq('swimmer_id', me.id).eq('status', 'active').order('created_at', { ascending: false }),
    db.from('results').select('distance, stroke, course, time_cs, status, meet_name, meet_date').eq('swimmer_id', me.id),
    db.from('attendance').select('status, parent_reported, practices!inner(practice_date, session)').eq('swimmer_id', me.id)
      .gte('practices.practice_date', monthStart.toISOString().slice(0, 10)),
    db.from('swimmer_accounts').select('swimmer_id').eq('swimmer_id', me.id),
  ]);
  return {
    notes: must(notes) || [],
    goals: must(goals) || [],
    results: must(results) || [],
    attendance: must(attendance) || [],
    hasOwnLogin: (must(account) || []).length > 0,
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
    me = must(await db.from('swimmers')
      .select('id, first_name, last_name, birth_year, birth_year_estimated, group_id, analytics_level, groups(name, analytics_level), teams(name)')
      .eq('id', id).maybeSingle());
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
      timesSection(me, data.results, mode, refresh),
      goalsSection(me, data.goals, refresh),
      notesSection(me, data.notes, mode, refresh),
      attendanceSection(me, data.attendance, role),
      mode === 'family' && role === 'guardian' ? swimmerLoginSection(me, data.hasOwnLogin) : null));
}

// ------------------------------------------------------------------
function notesSection(me, notes, mode, refresh) {
  if (!notes.length) {
    return emptyCard("Coach's notes",
      `Notes from ${me.first_name}'s coach will show here — what they're working on and how it's going. Every note goes to ${me.first_name} and their parents together.`);
  }
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, "Coach's notes"), h('span', { class: 'muted small' }, 'Shared with swimmer & parents')),
    h('ul', { class: 'list' }, notes.map((n) => noteItem(n, refresh))));
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
function timesSection(me, results, mode, refresh) {
  const best = {};
  for (const r of results.filter((x) => x.course === course && x.status !== 'dq' && x.time_cs)) {
    const key = `${r.distance}-${r.stroke}`;
    if (!best[key] || r.time_cs < best[key].time_cs) best[key] = r;
  }
  const order = EVENTS[course].map(([d, s]) => `${d}-${s}`);
  const rows = Object.entries(best).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

  const toggle = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Course' },
    ['SCY', 'LCM'].map((c) => h('button', { type: 'button', class: c === course ? 'on' : '', 'aria-pressed': c === course ? 'true' : 'false',
      onClick: () => { course = c; refresh(); } }, COURSE_LABEL[c])));

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Best times'), rows.length ? h('span', { class: 'muted small' }, 'Tap an event for analytics') : null),
    toggle,
    rows.length
      ? h('ul', { class: 'list' }, rows.map(([key, r]) => h('li', {},
          h('a', { class: 'list-row row-link', href: `${swimmerHref(mode, me.id)}/e/${key}-${course}` },
            h('span', { class: 'grow' },
              h('strong', {}, eventName(r.distance, r.stroke)),
              h('span', { class: 'muted small block' }, [r.meet_name, formatDate(r.meet_date)].filter(Boolean).join(' · '))),
            h('span', { class: 'time' }, formatTime(r.time_cs)),
            h('span', { 'aria-hidden': 'true', class: 'chev' }, '›')))))
      : h('p', { class: 'muted' }, `${me.first_name}'s ${course === 'SCY' ? 'yards' : 'long course'} times will show here after a meet, once the coach uploads results. Yards and meters are always kept separate.`));
}

// ------------------------------------------------------------------
function attendanceSection(me, rows, role) {
  const counted = rows.filter((r) => r.status !== 'out').length;
  const total = rows.length;
  const month = new Date().toLocaleDateString(undefined, { month: 'long' });
  if (!total) {
    return emptyCard('Attendance',
      `Practices ${me.first_name} attends will be counted here once the coach takes attendance. Morning and afternoon practices count separately.`);
  }
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Attendance'), h('span', { class: 'muted small' }, month)),
    h('p', { class: 'stat' }, `${counted}/${total}`, h('span', { class: 'muted small' }, ' practices attended')),
    role === 'guardian' ? h('p', { class: 'muted small' }, 'Absence reporting arrives with the coach attendance screen.') : null);
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
