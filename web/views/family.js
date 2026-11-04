// Parent and swimmer home: coach notes, goals, best times, attendance.
import { db, state, topBar } from '../app.js';
import { h, mount, must, toast, busy, field, initials, formatTime, eventName, timeAgo, emptyCard } from '../ui.js';

const TAGS = { great: 'Great improvement', keep_working: 'Keep working', new_focus: 'New focus' };
const KINDS = { time: 'Time', practice: 'Practice', technique: 'Technique', other: 'Other' };

let course = 'SCY';

export async function renderFamily(selectedId) {
  const ids = [...new Set(state.family.map((f) => f.swimmer_id))];
  const current = ids.includes(selectedId) ? selectedId : ids[0];
  const myRole = state.family.find((f) => f.swimmer_id === current).as;

  mount(topBar('family'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));

  let swimmers, data;
  try {
    swimmers = must(await db.from('swimmers')
      .select('id, first_name, last_name, birth_year, group_id, groups(name), teams(name)')
      .in('id', ids));
    const me = swimmers.find((s) => s.id === current);
    data = await loadSwimmer(me);
    data.me = me;
  } catch (err) {
    toast(err.message || String(err), 'error');
    return;
  }
  const me = data.me;

  const switcher = swimmers.length > 1 || myRole === 'guardian'
    ? h('nav', { class: 'switcher', 'aria-label': 'Swimmer' },
        swimmers.map((s) => h('a', { href: '#/family/' + s.id, class: 'chip' + (s.id === current ? ' on' : ''),
          'aria-current': s.id === current ? 'page' : null }, s.first_name)),
        myRole === 'guardian' ? h('a', { href: '#/join', class: 'chip add', 'aria-label': 'Add another swimmer' }, '+') : null)
    : null;

  mount(topBar('family'),
    h('header', { class: 'team-head teal' },
      h('p', { class: 'eyebrow' }, myRole === 'self' ? 'My page' : 'Parent'),
      h('h1', {}, myRole === 'self' ? `Hey, ${me.first_name}` : `${me.first_name} ${me.last_name}`),
      h('p', {}, [me.groups && me.groups.name, me.teams && me.teams.name].filter(Boolean).join(' · '))),
    switcher,
    h('main', { class: 'page' },
      notesSection(me, data.notes),
      goalsSection(me, data.goals),
      timesSection(me, data.results),
      attendanceSection(me, data.attendance, myRole),
      myRole === 'guardian' ? swimmerLoginSection(me, data.hasOwnLogin) : null));
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
    db.from('goals').select('id, kind, title, course, due_label, status, created_at, created_by').eq('swimmer_id', me.id).eq('status', 'active').order('created_at', { ascending: false }),
    db.from('results').select('distance, stroke, course, time_cs, meet_name, meet_date').eq('swimmer_id', me.id),
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

// ------------------------------------------------------------------
function notesSection(me, notes) {
  if (!notes.length) {
    return emptyCard("Coach's notes",
      `Notes from ${me.first_name}'s coach will show here — what they're working on and how it's going. Every note goes to ${me.first_name} and their parents together.`);
  }
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, "Coach's notes"), h('span', { class: 'muted small' }, 'Shared with swimmer & parents')),
    h('ul', { class: 'list' }, notes.map((n) => noteItem(me, n))));
}

function noteItem(me, n) {
  const replyBox = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Reply to coach (your family sees replies too)' });
  const replies = (n.note_replies || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    if (!replyBox.value.trim()) return;
    await busy(form.querySelector('button'), async () => {
      must(await db.from('note_replies').insert({ note_id: n.id, author_id: state.user.id, body: replyBox.value.trim() }));
      toast('Reply sent', 'success');
      renderFamily(me.id);
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
function goalsSection(me, goals) {
  const kind = h('select', {}, Object.entries(KINDS).map(([v, label]) => h('option', { value: v }, label)));
  const title = h('input', { type: 'text', required: true, maxlength: 160, placeholder: 'e.g. 100 free under 59.00' });
  const goalCourse = h('select', {}, h('option', { value: 'SCY' }, 'Short course yards'), h('option', { value: 'LCM' }, 'Long course meters'));
  const courseField = field('Course', goalCourse);
  const due = h('select', {},
    h('option', {}, 'Championship meet'), h('option', {}, 'End of this month'), h('option', {}, 'End of season'));
  kind.addEventListener('change', () => { courseField.hidden = kind.value !== 'time'; });

  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      must(await db.from('goals').insert({
        swimmer_id: me.id, created_by: state.user.id, kind: kind.value, title: title.value.trim(),
        course: kind.value === 'time' ? goalCourse.value : null, due_label: due.value,
      }));
      toast('Goal shared with coach and family', 'success');
      renderFamily(me.id);
    });
  } },
    field('Type', kind), field('Goal', title), courseField, field('By when?', due),
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
function timesSection(me, results) {
  const best = {};
  for (const r of results.filter((x) => x.course === course)) {
    const key = `${r.distance}-${r.stroke}`;
    if (!best[key] || r.time_cs < best[key].time_cs) best[key] = r;
  }
  const rows = Object.values(best).sort((a, b) => a.stroke.localeCompare(b.stroke) || a.distance - b.distance);

  const toggle = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Course' },
    ['SCY', 'LCM'].map((c) => h('button', { type: 'button', class: c === course ? 'on' : '', 'aria-pressed': c === course ? 'true' : 'false',
      onClick: () => { course = c; renderFamily(me.id); } }, c === 'SCY' ? 'Short course yards' : 'Long course meters')));

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Best times')),
    toggle,
    rows.length
      ? h('ul', { class: 'list' }, rows.map((r) => h('li', { class: 'list-row' },
          h('span', { class: 'grow' },
            h('strong', {}, eventName(r.distance, r.stroke)),
            h('span', { class: 'muted small block' }, [r.meet_name,
              new Date(r.meet_date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })]
              .filter(Boolean).join(' · '))),
          h('span', { class: 'time' }, formatTime(r.time_cs)))))
      : h('p', { class: 'muted' }, `${me.first_name}'s ${course === 'SCY' ? 'yards' : 'long course'} times will show here after a meet, once the coach uploads results. Yards and meters are always kept separate.`));
}

// ------------------------------------------------------------------
function attendanceSection(me, rows, myRole) {
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
    myRole === 'guardian' ? h('p', { class: 'muted small' }, 'Absence reporting arrives with the coach attendance screen.') : null);
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
