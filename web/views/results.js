// Coach: meet results — list, upload a results file, review, publish, and fix afterwards.
import { db, state } from '../app.js';
import { h, mount, must, toast, busy, field, backLink, formatTime, parseTime, eventName, formatDate } from '../ui.js';
import { coachChrome, coachTeam } from './coach.js';
import { teamCodeCard } from './coach-extra.js';
import { buildReview, estimateBirthYear, autoSkipped } from '../lib/matcher.js';
import { COURSE_LABEL } from '../lib/time.js';
import { readResults, readResultsFromUrl, loadRosterAndBests, seedsFor, approveInboxItem, dismissInboxItem } from './results-auto.js';

// ------------------------------------------------------------------
// Meets list
// ------------------------------------------------------------------
export async function renderResults() {
  const team = coachTeam();
  mount(coachChrome('results'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  let meets; let results; let inbox;
  try {
    [meets, results, inbox] = await Promise.all([
      db.from('meets').select('id, name, meet_date, course, created_at').eq('team_id', team.id).order('meet_date', { ascending: false }).then(must),
      db.from('results').select('meet_id').eq('team_id', team.id).then(must),
      db.from('results_inbox').select('id, kind, status, meet_name, meet_date, course, summary, payload, source_url, meet_id')
        .eq('team_id', team.id).eq('status', 'pending').then((r) => (r.error ? [] : r.data || [])),
    ]);
  } catch (err) { toast(err.message, 'error'); return; }
  const counts = {};
  for (const r of results || []) if (r.meet_id) counts[r.meet_id] = (counts[r.meet_id] || 0) + 1;

  mount(coachChrome('results'), h('main', { class: 'page' },
    inboxCard(inbox, team.id, () => renderResults()),
    h('a', { href: '#/coach/upload', class: 'btn primary center' }, 'Add meet results'),
    team.sourceUrl ? null : h('a', { href: '#/coach/team', class: 'notice-link quiet' }, 'Turn on automatic results →'),
    (meets || []).length
      ? h('section', { class: 'card' },
          h('h2', {}, 'Meets'),
          h('ul', { class: 'list' }, meets.map((m) => h('li', {},
            h('a', { href: `#/coach/results/${m.id}`, class: 'list-row row-link' },
              h('span', { class: 'grow' },
                h('strong', {}, m.name),
                h('span', { class: 'muted small block' }, `${formatDate(m.meet_date)} · ${m.course}`)),
              h('span', { class: 'pill' }, `${counts[m.id] || 0} swims`))))))
      : h('section', { class: 'card empty' },
          h('h3', {}, 'No meets yet'),
          h('p', { class: 'muted' }, 'Paste a Pacific Swimming results link or upload a results PDF. You\'ll review every swim before families see anything.'))));
}

// ------------------------------------------------------------------
// Upload → review
// ------------------------------------------------------------------
export async function renderUpload() {
  const team = coachTeam();
  if (!team.code) {
    mount(coachChrome('results'), h('main', { class: 'page' },
      backLink('#/coach/results', 'Results'),
      h('h1', {}, 'Upload meet results'),
      h('p', { class: 'muted' }, 'First, tell the app how your team appears in meet results.'),
      teamCodeCard(team, () => renderUpload())));
    return;
  }

  const input = h('input', { type: 'file', accept: '.pdf,.htm,.html,application/pdf,text/html' });
  const status = h('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    status.textContent = 'Reading ' + file.name + '…';
    try {
      const parsed = await readResults({ name: file.name, type: file.type, buffer: await file.arrayBuffer() });
      if (!parsed.swims.length) throw new Error('No individual swims found in that file. Is it a HY-TEK results PDF or results page?');
      await renderReview(parsed, file.name);
    } catch (err) {
      status.textContent = '';
      toast(err.message || String(err), 'error');
    }
  });

  const link = h('input', { type: 'url', inputmode: 'url', placeholder: 'https://www.pacswim.org/…/meet-results.htm', 'aria-label': 'Results link' });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Read results');
  const linkForm = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(go, async () => {
      const url = link.value.trim();
      if (!url) throw new Error('Paste the link to the results page or PDF.');
      const parsed = await readResultsFromUrl(url);
      if (!parsed.swims.length) throw new Error('No individual swims found at that link. Use the link to the results themselves, not the meet page.');
      await renderReview(parsed, parsed.meet.name || 'Meet results', { url: parsed.url });
    });
  } }, field('Results link', link, 'From Pacific Swimming (pacswim.org) — the results page or PDF itself.'), go);

  mount(coachChrome('results'), h('main', { class: 'page' },
    backLink('#/coach/results', 'Results'),
    h('h1', {}, 'Add meet results'),
    h('section', { class: 'card stack' },
      h('h2', {}, 'Paste a link'),
      linkForm),
    h('section', { class: 'card stack' },
      h('h2', {}, 'Or upload a file'),
      field('Results file', input, 'A HY-TEK results PDF, or a results web page saved as a file.'),
      status),
    h('p', { class: 'muted small' }, `Only swims for ${team.code} are kept, plus seed times faster than anything on file. Nothing is published until you confirm.`)));
}

export async function renderReview(parsed, fileName, opts = {}) {
  const team = coachTeam();
  const { roster, bests } = await loadRosterAndBests(team.id);
  const courses = [...new Set(parsed.swims.map((s) => s.course))];
  const fileCourse = courses.includes('SCY') && courses.length === 1 ? 'SCY'
    : courses.length === 1 ? courses[0] : 'MIXED';

  const meet = { name: parsed.meet.name || fileName.replace(/\.[a-z]+$/i, ''), date: parsed.meet.date || '', course: fileCourse === 'SCY' ? 'SCY' : null };
  const review = buildReview(parsed.swims, roster, {
    teamCode: team.code, aliases: team.aliases, meetDate: meet.date || new Date().toISOString().slice(0, 10),
    bests: bests[meet.course || 'LCM'] || {},
  });
  const { counts, groups } = review;
  const rosterById = Object.fromEntries(roster.map((s) => [s.id, s]));

  // Decisions the coach makes, by person
  // Team swimmers with no one on the roster sharing their last name (e.g. other PASA groups at the
  // same meet) are left out by default, in their own collapsed list, instead of needing a decision each.
  groups.notOnRoster = groups.needsMatch.filter(autoSkipped);
  groups.needsMatch = groups.needsMatch.filter((p) => !autoSkipped(p));
  for (const p of groups.notOnRoster) { p.choice = 'skip'; p.rememberName = false; }
  for (const p of [...groups.needsMatch, ...groups.unattached]) {
    // Pre-select only a likely nickname match (e.g. Theodore → Teddy); never a wrong-age or
    // last-name-only guess, and unattached swimmers start out left out.
    p.choice = !p.unattached && p.suggestion && /^Listed as/.test(p.reason || '') ? p.suggestion : '';
    p.rememberName = true;
    p.markUnattached = true;
  }
  for (const p of [...groups.matched, ...groups.needsMatch, ...groups.unattached, ...groups.notOnRoster]) {
    for (const s of p.swims) { s.include = true; s.editTime = s.timeCs; s.keepSeed = true; }
  }
  const seedState = { bests };

  const draw = () => mount(coachChrome('results'), h('main', { class: 'page' },
    opts.inboxItem ? backLink('#/coach', 'Home') : backLink('#/coach/upload', 'Choose a different file'),
    h('h1', {}, 'Review results'),
    meetCard(meet, fileCourse, parsed, counts, team, draw),
    groups.needsMatch.length ? decisionSection('Needs a match', groups.needsMatch, roster, rosterById, false, draw) : null,
    flaggedSection([...groups.matched, ...[...groups.needsMatch, ...groups.notOnRoster].filter((p) => p.choice && p.choice !== 'skip')], rosterById),
    groups.unattached.length ? decisionSection('Unattached swimmers', groups.unattached, roster, rosterById, true, draw) : null,
    groups.notOnRoster.length ? notOnRosterSection(groups.notOnRoster, roster, rosterById, draw) : null,
    seedSection(meet, groups, rosterById, seedState),
    matchedSection(groups.matched, rosterById, meet),
    publishCard(meet, groups, rosterById, parsed, seedState, opts)));
  draw();
}

function meetCard(meet, fileCourse, parsed, counts, team, redraw) {
  const name = h('input', { type: 'text', maxlength: 160, value: meet.name });
  const date = h('input', { type: 'date', value: meet.date });
  name.addEventListener('input', () => { meet.name = name.value; });
  date.addEventListener('input', () => { meet.date = date.value; });

  let courseBlock;
  if (fileCourse === 'SCY') {
    courseBlock = h('p', {}, h('strong', {}, 'Course: '), 'Short course yards (from the event names)');
  } else {
    const opts = [['LCM', 'Long course meters (50 m pool)'], ['SCM', 'Short course meters (25 m pool)']];
    courseBlock = h('fieldset', { class: 'stack' },
      h('legend', { class: 'label' }, fileCourse === 'MIXED' ? 'This file mixes yards and meters. Which course is this meet?' : 'This meet is in meters. Which pool?'),
      opts.map(([v, label]) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'course', value: v, checked: meet.course === v ? true : null,
          onChange: () => { meet.course = v; redraw(); } }),
        h('span', {}, label))),
      meet.course === 'SCM' ? h('p', { class: 'correction' }, 'Short course meters isn\'t supported — only yards and long course meters can be imported.') : null);
  }

  const ours = counts.total - counts.otherTeams - counts.noShows;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return h('section', { class: 'card stack' },
    h('div', { class: 'grid2' }, field('Meet name', name), field('First day of meet', date)),
    courseBlock,
    h('p', { class: 'muted small' },
      `${plural(ours, 'swim')} for ${team.code} (incl. unattached) · ${plural(counts.otherTeams, 'other-team swim')} ignored · ${plural(counts.noShows, 'no-show')} skipped`
      + (parsed.ignoredEvents ? ` · ${parsed.ignoredEvents} relay events skipped` : '')));
}


// Seed times faster than anything on file — kept by default (usually a swimmer's real best)
function chosenPeople(groups) {
  return [...groups.matched, ...[...groups.needsMatch, ...groups.unattached, ...groups.notOnRoster]
    .filter((p) => p.choice && p.choice !== 'skip' && p.choice !== 'new')];
}
function seedList(meet, groups, seedState) {
  const course = meet.course || 'LCM';
  return seedsFor(chosenPeople(groups), (seedState.bests || {})[course] || {}, (p) => p.swimmerId || (p.choice !== 'new' ? p.choice : null));
}

function seedSection(meet, groups, rosterById, seedState) {
  if (!meet.course || meet.course === 'SCM') return null;
  const list = seedList(meet, groups, seedState);
  if (!list.length) return null;
  const all = h('input', { type: 'checkbox', checked: list.every((x) => x.swim.keepSeed) ? true : null,
    onChange: (e) => { list.forEach((x) => { x.swim.keepSeed = e.target.checked; }); boxes.forEach((b) => { b.checked = e.target.checked; }); } });
  const boxes = [];
  const rows = list.map((x) => {
    const sw = rosterById[x.swimmer_id];
    const box = h('input', { type: 'checkbox', checked: x.swim.keepSeed ? true : null, 'aria-label': 'Keep this seed time',
      onChange: (e) => { x.swim.keepSeed = e.target.checked; } });
    boxes.push(box);
    return h('li', { class: 'swim-row' }, box,
      h('span', { class: 'grow' },
        h('strong', { class: 'block' }, sw ? `${sw.first_name} ${sw.last_name}` : x.person.name),
        h('span', { class: 'small muted' }, `${eventName(x.distance, x.stroke)} · swam ${x.swim.status === 'dq' ? 'DQ' : formatTime(x.swim.timeCs)}`)),
      h('span', { class: 'time small-time' }, formatTime(x.time_cs)));
  });
  return h('details', { class: 'card' },
    h('summary', {}, `${list.length} seed time${list.length === 1 ? '' : 's'} faster than anything on file — kept as best times`),
    h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Shown to families as “from seed time”. A real swim that beats it takes over. Untick any that look wrong.'),
      h('label', { class: 'check small' }, all, h('span', {}, 'Keep all')),
      h('ul', { class: 'list' }, rows)));
}

function swimLabel(s) {
  return `${eventName(s.distance, s.stroke)} · ` + (s.status === 'dq' ? 'DQ' + (s.timeCs ? ' ' + formatTime(s.timeCs) : '') : formatTime(s.timeCs));
}

function decisionSection(title, people, roster, rosterById, unattached, redraw) {
  const sortedRoster = [...roster].sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
  return h('section', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h2', {}, title), h('span', { class: 'pill warn' }, String(people.length))),
    h('p', { class: 'muted small' }, unattached
      ? 'These swimmers swam unattached (UN). They\'re left out unless you pick who they are.'
      : 'These swims are listed under your team but couldn\'t be matched for sure. Pick the right swimmer, add them, or skip.'),
    h('ul', { class: 'list' }, people.map((p) => {
      const sel = h('select', { 'aria-label': `Who is ${p.name}?` },
        h('option', { value: '' }, unattached ? 'Leave out' : '— Choose —'),
        sortedRoster.map((sw) => h('option', { value: sw.id, selected: p.choice === sw.id ? true : null },
          `${sw.first_name} ${sw.last_name}${sw.birth_year ? ' (' + sw.birth_year + ')' : ''}${p.suggestion === sw.id || p.swimmerId === sw.id ? ' — suggested' : ''}`)),
        h('option', { value: 'new', selected: p.choice === 'new' ? true : null }, 'Add as a new swimmer'),
        unattached ? null : h('option', { value: 'skip', selected: p.choice === 'skip' ? true : null }, 'Skip — not our swimmer'));
      sel.addEventListener('change', () => { p.choice = sel.value; redraw(); });

      const chosen = rosterById[p.choice];
      const differentName = chosen && chosen.first_name.toLowerCase() !== p.first.toLowerCase()
        && !(chosen.also_known_as || []).map((x) => x.toLowerCase()).includes(p.first.toLowerCase());
      const remember = differentName ? h('label', { class: 'check small' },
        h('input', { type: 'checkbox', checked: p.rememberName ? true : null, onChange: (e) => { p.rememberName = e.target.checked; } }),
        h('span', {}, `Remember “${p.first}” as ${chosen.first_name} for future meets`)) : null;
      const markUn = unattached && chosen ? h('label', { class: 'check small' },
        h('input', { type: 'checkbox', checked: p.markUnattached ? true : null, onChange: (e) => { p.markUnattached = e.target.checked; } }),
        h('span', {}, `${chosen.first_name} usually swims unattached — include automatically next time`)) : null;
      const exactHint = unattached && p.swimmerId ? rosterById[p.swimmerId] : null;

      return h('li', { class: 'stack tight' },
        h('div', {}, h('strong', {}, p.name), h('span', { class: 'muted' }, ` · age ${p.age} · ${p.team}`)),
        p.reason && !unattached ? h('p', { class: 'small warn-text' }, p.reason) : null,
        exactHint ? h('p', { class: 'small' }, `Matches ${exactHint.first_name} ${exactHint.last_name} on your roster.`) : null,
        h('p', { class: 'muted small' }, p.swims.map(swimLabel).join(' · ')),
        sel, remember, markUn);
    })));
}

function notOnRosterSection(people, roster, rosterById, redraw) {
  const included = people.filter((p) => p.choice && p.choice !== 'skip').length;
  const list = decisionSection('Left out', people, roster, rosterById, false, redraw);
  return h('details', { class: 'card', open: included ? true : null },
    h('summary', {}, `${people.length} more ${people.length === 1 ? 'swimmer' : 'swimmers'} from your team left out — not on your roster`
      + (included ? ` (${included} added)` : '')),
    h('p', { class: 'muted small' }, 'Swimmers from other groups, and anyone who only shares a last name with one of your swimmers. Nicknames still ask you. Open a name only if they belong on your roster.'),
    list);
}

function swimRow(p, s, rosterById, showName) {
  const time = h('input', { type: 'text', inputmode: 'decimal', class: 'time-input', value: s.editTime ? formatTime(s.editTime) : '',
    placeholder: s.status === 'dq' ? 'DQ' : '', 'aria-label': `${p.name} ${eventName(s.distance, s.stroke)} time` });
  time.addEventListener('change', () => {
    const v = time.value.trim();
    const cs = v ? parseTime(v) : null;
    if (v && cs === null) { toast('Use a time like 59.84 or 1:07.88', 'error'); time.value = s.editTime ? formatTime(s.editTime) : ''; return; }
    s.editTime = cs;
  });
  const inc = h('input', { type: 'checkbox', checked: s.include ? true : null, 'aria-label': 'Include this swim',
    onChange: (e) => { s.include = e.target.checked; } });
  const who = rosterById[p.swimmerId || p.choice];
  return h('li', { class: 'swim-row' },
    inc,
    h('span', { class: 'grow' },
      showName ? h('strong', { class: 'block' }, who ? `${who.first_name} ${who.last_name}` : p.name) : null,
      h('span', {}, eventName(s.distance, s.stroke) + (s.status === 'dq' ? ' · DQ' : '') + (s.place ? ` · ${ordinal(s.place)}` : '')),
      s.splits ? h('span', { class: 'muted small block' }, 'Splits: ' + s.splits.map(formatTime).join(' / ')) : null,
      (s.flags || []).map((f) => h('span', { class: 'small warn-text block' }, f))),
    time);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function flaggedSection(people, rosterById) {
  const rows = [];
  for (const p of people) for (const s of p.swims) if ((s.flags || []).length) rows.push(swimRow(p, s, rosterById, true));
  if (!rows.length) return null;
  return h('section', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Flagged'), h('span', { class: 'pill warn' }, String(rows.length))),
    h('p', { class: 'muted small' }, 'Disqualifications and times far from a swimmer\'s best. Fix the time or untick to leave a swim out. DQs never count as best times.'),
    h('ul', { class: 'list' }, rows));
}

function matchedSection(people, rosterById, meet) {
  const missingYears = people.filter((p) => { const s = rosterById[p.swimmerId]; return s && !s.birth_year; });
  meet.fillYears = meet.fillYears === undefined ? true : meet.fillYears;
  const nSwims = people.reduce((n, p) => n + p.swims.filter((s) => !(s.flags || []).length).length, 0);
  return h('section', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Matched'), h('span', { class: 'pill ok' }, `${people.length} swimmers`)),
    missingYears.length ? h('label', { class: 'check small' },
      h('input', { type: 'checkbox', checked: meet.fillYears ? true : null, onChange: (e) => { meet.fillYears = e.target.checked; } }),
      h('span', {}, `Fill in ${missingYears.length} missing birth year${missingYears.length === 1 ? '' : 's'} from ages at this meet (marked “estimated”)`)) : null,
    h('details', {},
      h('summary', {}, `Show ${nSwims} matched swim${nSwims === 1 ? '' : 's'}`),
      h('ul', { class: 'list' }, people.map((p) => {
        const sw = rosterById[p.swimmerId];
        const rows = p.swims.filter((s) => !(s.flags || []).length).map((s) => swimRow(p, s, rosterById, false));
        if (!rows.length) return null;
        return h('li', { class: 'stack tight' },
          h('strong', {}, `${sw.first_name} ${sw.last_name}`, h('span', { class: 'muted small' }, `  · listed as ${p.name}, ${p.age}${p.unattached ? ', unattached' : ''}`)),
          h('ul', { class: 'list nested' }, rows));
      }))));
}

function publishCard(meet, groups, rosterById, parsed, seedState, opts) {
  // When the meet is already uploaded: add just the seed times (default) or replace the upload
  let again = 'seeds';
  const againBox = h('fieldset', { class: 'stack', hidden: true },
    h('legend', { class: 'label' }, 'This meet was already uploaded.'),
    [['seeds', 'Only add seed times to the earlier upload (keeps any fixes you made)'], ['replace', 'Replace the earlier upload']]
      .map(([v, label]) => h('label', { class: 'check small' },
        h('input', { type: 'radio', name: 'again', value: v, checked: v === 'seeds' ? true : null, onChange: () => { again = v; } }),
        h('span', {}, v === 'replace' ? 'Replace the earlier upload' : label))));
  const btn = h('button', { type: 'button', class: 'btn primary', onClick: () => publish() }, 'Confirm and publish');
  const msg = h('p', { class: 'muted small' }, 'Families see these results as soon as you publish. You can still fix or remove any swim afterwards.');

  async function publish() {
    await busy(btn, async () => {
      const team = coachTeam();
      if (!meet.name.trim() || !meet.date) throw new Error('Add the meet name and date.');
      if (!meet.course) throw new Error('Choose the course for this meet.');
      if (meet.course === 'SCM') throw new Error('Short course meters meets can\'t be imported.');
      const undecided = groups.needsMatch.filter((p) => !p.choice);
      if (undecided.length) throw new Error(`Choose who ${undecided[0].name} is, or pick “Skip” (${undecided.length} left).`);

      // New swimmers first
      const resolved = [];
      const toCreate = [...groups.needsMatch, ...groups.unattached, ...groups.notOnRoster].filter((p) => p.choice === 'new');
      if (toCreate.length) {
        const created = must(await db.from('swimmers').insert(toCreate.map((p) => ({
          team_id: team.id, first_name: p.first, last_name: p.last,
          birth_year: estimateBirthYear(p.age, meet.date), birth_year_estimated: true,
          usually_unattached: !!p.unattached,
        }))).select('id, first_name, last_name'));
        toCreate.forEach((p, i) => { p.finalId = created[i].id; });
      }
      for (const p of groups.matched) { p.finalId = p.swimmerId; resolved.push(p); }
      for (const p of [...groups.needsMatch, ...groups.unattached, ...groups.notOnRoster]) {
        if (p.choice && p.choice !== 'skip' && p.choice !== 'new') p.finalId = p.choice;
        if (p.finalId) resolved.push(p);
      }

      const swims = [];
      for (const p of resolved) for (const s of p.swims) {
        if (!s.include) continue;
        if (s.status !== 'dq' && !s.editTime) continue;
        const timeChanged = s.editTime !== s.timeCs;
        swims.push({
          swimmer_id: p.finalId, distance: s.distance, stroke: s.stroke, time_cs: s.editTime || null,
          splits_cs: timeChanged ? null : s.splits, split_len: timeChanged ? null : s.splitLen,
          status: s.status === 'dq' ? 'dq' : 'ok', dq_reason: s.dqReason, place: s.place, age: s.age, name_in_results: p.name,
        });
      }
      if (!swims.length) throw new Error('Nothing selected to publish.');
      const seeds = seedList(meet, groups, seedState).filter((x) => x.swim.keepSeed)
        .map((x) => ({ swimmer_id: x.swimmer_id, distance: x.distance, stroke: x.stroke, time_cs: x.time_cs }));

      let meetId;
      if (!againBox.hidden && again === 'seeds') {
        const earlier = must(await db.from('meets').select('id, name, meet_date').eq('team_id', team.id).eq('meet_date', meet.date))
          .find((m) => m.name.trim().toLowerCase() === meet.name.trim().toLowerCase());
        if (!earlier) throw new Error('Couldn\'t find the earlier upload — choose “Replace”.');
        const n = seeds.length ? must(await db.rpc('add_seed_times', { p_meet: earlier.id, p_seeds: seeds })) : 0;
        if (opts.inboxItem) await approveDone(opts.inboxItem, earlier.id);
        toast(n ? `${n} seed time${n === 1 ? '' : 's'} added` : 'No new seed times — everything is already on file', 'success');
        location.hash = `/coach/results/${earlier.id}`;
        return;
      }
      try {
        meetId = must(await db.rpc('import_meet', {
          p_team: team.id, p_meet: { name: meet.name.trim(), meet_date: meet.date, course: meet.course, source: parsed.source, source_url: opts.url || null },
          p_swims: swims, p_replace: !againBox.hidden && again === 'replace',
        }));
      } catch (err) {
        if (/already uploaded/i.test(err.message || '')) {
          againBox.hidden = false;
          btn.textContent = 'Confirm';
          throw new Error('This meet was already uploaded — choose what to do, then confirm.');
        }
        throw err;
      }
      if (seeds.length) must(await db.rpc('add_seed_times', { p_meet: meetId, p_seeds: seeds }));
      if (opts.inboxItem) await approveDone(opts.inboxItem, meetId);

      // Remember names, unattached, and fill birth years
      for (const p of [...groups.needsMatch, ...groups.unattached]) {
        const sw = rosterById[p.finalId];
        if (!sw) continue;
        const update = {};
        if (p.rememberName && sw.first_name.toLowerCase() !== p.first.toLowerCase()
          && !(sw.also_known_as || []).map((x) => x.toLowerCase()).includes(p.first.toLowerCase())) {
          update.also_known_as = [...(sw.also_known_as || []), p.first].slice(0, 8);
        }
        if (p.unattached && p.markUnattached) update.usually_unattached = true;
        if (Object.keys(update).length) must(await db.from('swimmers').update(update).eq('id', sw.id));
      }
      if (meet.fillYears) {
        for (const p of resolved) {
          const sw = rosterById[p.finalId];
          if (sw && !sw.birth_year) {
            must(await db.from('swimmers').update({ birth_year: estimateBirthYear(p.age, meet.date), birth_year_estimated: true }).eq('id', sw.id));
          }
        }
      }
      toast(`${swims.length} swims published` + (seeds.length ? ` · ${seeds.length} seed times` : ''), 'success');
      location.hash = `/coach/results/${meetId}`;
    });
  }
  return h('section', { class: 'card stack sticky-bottom' }, againBox, msg, btn);
}

async function approveDone(item, meetId) {
  must(await db.from('results_inbox').update({ status: 'approved', meet_id: meetId, decided_by: state.user.id, decided_at: new Date().toISOString() }).eq('id', item.id));
}

// ------------------------------------------------------------------
// A results-inbox item opened for full review
// ------------------------------------------------------------------
export async function renderInboxReview(id) {
  mount(coachChrome('home'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Reading results from Pacific Swimming…')));
  try {
    const item = must(await db.from('results_inbox').select('*').eq('id', id).maybeSingle());
    if (!item) throw new Error('That item is gone.');
    let parsed;
    if (item.payload && item.payload.parsed) parsed = item.payload.parsed;     // demo
    else parsed = await readResultsFromUrl(item.source_url);
    await renderReview(parsed, item.meet_name || 'Meet results', { url: item.source_url, inboxItem: item });
  } catch (err) {
    toast(err.message || String(err), 'error');
    location.hash = '/coach';
  }
}

// ------------------------------------------------------------------
// "Results to approve" — shown on the coach home and Results tab
// ------------------------------------------------------------------
export function inboxCard(items, teamId, onChange) {
  const pending = (items || []).filter((i) => i.status === 'pending');
  if (!pending.length) return null;
  return h('section', { class: 'card stack inbox' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Results to approve'), h('span', { class: 'pill warn' }, String(pending.length))),
    h('ul', { class: 'list' }, pending.map((item) => {
      const sm = item.summary || {};
      const approve = h('button', { type: 'button', class: 'btn primary small', onClick: async () => {
        await busy(approve, async () => {
          const res = await approveInboxItem(item, teamId);
          toast(item.kind === 'seeds' ? `${res.seeds} seed times added` : `${res.swims} swims published` + (res.seeds ? ` · ${res.seeds} seed times` : ''), 'success');
          onChange();
        });
      } }, 'Approve all');
      const dismiss = h('button', { type: 'button', class: 'btn small ghost', onClick: async () => {
        await busy(dismiss, async () => { await dismissInboxItem(item); onChange(); });
      } }, 'Not now');
      const line = item.kind === 'seeds'
        ? `${sm.seeds || 0} seed time${sm.seeds === 1 ? '' : 's'} for a meet you already uploaded`
        : [`${sm.swims || 0} swims · ${sm.swimmers || 0} swimmers`, sm.seeds ? `${sm.seeds} seed times` : null].filter(Boolean).join(' · ');
      const held = (sm.heldPeople || 0) + (sm.heldSwims || 0);
      return h('li', { class: 'stack tight' },
        h('div', {}, h('strong', {}, item.meet_name || 'Meet results'),
          h('span', { class: 'muted small block' }, [formatDate(item.meet_date), item.course && item.course !== 'MIXED' ? item.course : null].filter(Boolean).join(' · '))),
        h('p', { class: 'small' }, line),
        held ? h('p', { class: 'small warn-text' }, `${held} held for you to check` + (sm.heldNames && sm.heldNames.length ? `: ${sm.heldNames.slice(0, 3).join('; ')}${sm.heldNames.length > 3 ? '…' : ''}` : '')) : null,
        h('div', { class: 'row' }, approve, item.kind === 'seeds' ? null : h('a', { href: `#/coach/inbox/${item.id}`, class: 'btn small' }, 'Review'), dismiss));
    })),
    h('p', { class: 'muted small' }, 'Approve all publishes only sure matches. Anything uncertain is held for you.'));
}

// ------------------------------------------------------------------
// A published meet: fix or remove swims, see the change log
// ------------------------------------------------------------------
export async function renderMeet(meetId) {
  const team = coachTeam();
  mount(coachChrome('results'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  let meet; let results; let edits;
  try {
    [meet, results, edits] = await Promise.all([
      db.from('meets').select('*').eq('id', meetId).maybeSingle().then(must),
      db.from('results').select('id, swimmer_id, distance, stroke, time_cs, status, dq_reason, place, splits_cs, swimmers(first_name, last_name)')
        .eq('meet_id', meetId).then(must),
      db.from('result_edits').select('id, action, before, after, edited_at, result_id').eq('team_id', team.id)
        .order('edited_at', { ascending: false }).limit(200).then(must),
    ]);
  } catch (err) { toast(err.message, 'error'); return; }
  if (!meet) { toast('Meet not found', 'error'); location.hash = '/coach/results'; return; }

  const byEvent = new Map();
  for (const r of (results || []).sort((a, b) => a.stroke.localeCompare(b.stroke) || a.distance - b.distance || (a.time_cs || 1e9) - (b.time_cs || 1e9))) {
    const k = eventName(r.distance, r.stroke);
    if (!byEvent.has(k)) byEvent.set(k, []);
    byEvent.get(k).push(r);
  }
  const meetEdits = (edits || []).filter((e) => (e.before && e.before.meet_id === meetId) || (e.after && e.after.meet_id === meetId));

  const removeMeet = h('button', { type: 'button', class: 'btn ghost danger', onClick: async () => {
    if (!confirm(`Remove all ${results.length} swims from ${meet.name}? Families will no longer see them. This is recorded.`)) return;
    await busy(removeMeet, async () => {
      must(await db.rpc('delete_meet', { p_meet: meetId }));
      toast('Meet removed', 'success');
      location.hash = '/coach/results';
    });
  } }, 'Remove this meet');

  mount(coachChrome('results'), h('main', { class: 'page' },
    backLink('#/coach/results', 'Results'),
    h('h1', {}, meet.name),
    h('p', { class: 'muted' }, `${formatDate(meet.meet_date)} · ${COURSE_LABEL[meet.course]} · ${results.length} swims`),
    [...byEvent.entries()].map(([ev, rows]) => h('section', { class: 'card' },
      h('h2', {}, ev),
      h('ul', { class: 'list' }, rows.map((r) => resultRow(r, meetId))))),
    meetEdits.length ? h('section', { class: 'card' },
      h('h2', {}, 'Change log'),
      h('ul', { class: 'list' }, meetEdits.map((e) => h('li', { class: 'small' },
        h('strong', {}, { edit: 'Edited', delete: 'Removed', replaced: 'Replaced' }[e.action]), ' · ',
        describeEdit(e), h('span', { class: 'muted' }, ' · ' + new Date(e.edited_at).toLocaleString()))))) : null,
    h('section', { class: 'card' }, h('p', { class: 'muted small' }, 'Every fix and removal is recorded with the time it was made.'), removeMeet)));
}

function describeEdit(e) {
  const b = e.before || {};
  const a = e.after || {};
  const ev = b.distance ? eventName(b.distance, b.stroke) : '';
  if (e.action === 'edit') {
    const from = b.status === 'dq' ? 'DQ' : formatTime(b.time_cs);
    const to = a.status === 'dq' ? 'DQ' : formatTime(a.time_cs);
    return `${ev}: ${from} → ${to}`;
  }
  return `${ev} ${b.status === 'dq' ? 'DQ' : formatTime(b.time_cs)}`;
}

function resultRow(r, meetId) {
  const name = r.swimmers ? `${r.swimmers.first_name} ${r.swimmers.last_name}` : 'Swimmer';
  const view = h('div', { class: 'list-row wrap' },
    h('span', { class: 'grow' },
      h('strong', {}, name),
      r.status === 'dq' ? h('span', { class: 'small warn-text block' }, 'DQ' + (r.dq_reason ? ': ' + r.dq_reason : '')) : null),
    h('span', { class: 'time' }, r.status === 'dq' ? (r.time_cs ? formatTime(r.time_cs) : 'DQ') : formatTime(r.time_cs)),
    h('button', { type: 'button', class: 'btn small ghost', onClick: () => { li.replaceChildren(editor); } }, 'Fix'));

  const time = h('input', { type: 'text', class: 'time-input', value: r.time_cs ? formatTime(r.time_cs) : '', 'aria-label': `${name} time` });
  const status = h('select', { 'aria-label': 'Status' },
    h('option', { value: 'ok', selected: r.status !== 'dq' ? true : null }, 'Counts'),
    h('option', { value: 'dq', selected: r.status === 'dq' ? true : null }, 'Disqualified'));
  const reason = h('input', { type: 'text', maxlength: 200, value: r.dq_reason || '', placeholder: 'DQ reason (optional)' });
  const save = h('button', { type: 'button', class: 'btn small primary', onClick: async () => {
    await busy(save, async () => {
      const cs = time.value.trim() ? parseTime(time.value) : null;
      if (time.value.trim() && cs === null) throw new Error('Use a time like 59.84 or 1:07.88');
      if (status.value === 'ok' && !cs) throw new Error('A swim that counts needs a time.');
      must(await db.rpc('update_result', { p_result: r.id, p_time_cs: cs, p_status: status.value, p_dq_reason: reason.value.trim() || null }));
      toast('Saved', 'success');
      renderMeet(meetId);
    });
  } }, 'Save');
  const remove = h('button', { type: 'button', class: 'btn small ghost danger', onClick: async () => {
    if (!confirm(`Remove ${name}'s swim? This is recorded.`)) return;
    await busy(remove, async () => {
      must(await db.rpc('delete_result', { p_result: r.id }));
      toast('Removed', 'success');
      renderMeet(meetId);
    });
  } }, 'Remove');
  const editor = h('div', { class: 'stack tight' },
    h('strong', {}, name),
    h('div', { class: 'row' }, time, status),
    reason,
    h('div', { class: 'row' }, save, remove,
      h('button', { type: 'button', class: 'btn small ghost', onClick: () => li.replaceChildren(view) }, 'Cancel')));
  const li = h('li', {}, view);
  return li;
}
