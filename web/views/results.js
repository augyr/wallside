// Coach: meet results — list, upload a results file, review, publish, and fix afterwards.
import { db, state } from '../app.js';
import { h, mount, must, toast, busy, field, backLink, formatTime, parseTime, eventName, formatDate } from '../ui.js';
import { coachChrome, coachTeam } from './coach.js';
import { teamCodeCard } from './coach-extra.js';
import { parseResultLines, linesFromPdfPages, linesFromText } from '../lib/results-parser.js';
import { buildReview, estimateBirthYear } from '../lib/matcher.js';
import { COURSE_LABEL } from '../lib/time.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

// ------------------------------------------------------------------
// Meets list
// ------------------------------------------------------------------
export async function renderResults() {
  const team = coachTeam();
  mount(coachChrome('results'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  let meets; let results;
  try {
    [meets, results] = await Promise.all([
      db.from('meets').select('id, name, meet_date, course, created_at').eq('team_id', team.id).order('meet_date', { ascending: false }).then(must),
      db.from('results').select('meet_id').eq('team_id', team.id).then(must),
    ]);
  } catch (err) { toast(err.message, 'error'); return; }
  const counts = {};
  for (const r of results || []) if (r.meet_id) counts[r.meet_id] = (counts[r.meet_id] || 0) + 1;

  mount(coachChrome('results'), h('main', { class: 'page' },
    h('a', { href: '#/coach/upload', class: 'btn primary center' }, 'Upload meet results'),
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
          h('p', { class: 'muted' }, 'Upload a results PDF or a saved HY-TEK results page. You\'ll review every swim before families see anything.'))));
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
      const parsed = await readResultsFile(file);
      if (!parsed.swims.length) throw new Error('No individual swims found in that file. Is it a HY-TEK results PDF or results page?');
      await renderReview(parsed, file.name);
    } catch (err) {
      status.textContent = '';
      toast(err.message || String(err), 'error');
    }
  });

  mount(coachChrome('results'), h('main', { class: 'page' },
    backLink('#/coach/results', 'Results'),
    h('h1', {}, 'Upload meet results'),
    h('section', { class: 'card stack' },
      field('Results file', input, 'A HY-TEK results PDF, or a results web page saved as a file (in your browser: File → Save Page As).'),
      status,
      h('p', { class: 'muted small' }, `Only swims for ${team.code} are kept. The file itself isn't stored, and nothing is published until you confirm.`)),
    h('section', { class: 'card' },
      h('h2', {}, 'What happens next'),
      h('ol', { class: 'steps' },
        h('li', {}, 'The file is read on this device.'),
        h('li', {}, 'You review: matched swims, names that need a match, flagged swims and unattached swimmers.'),
        h('li', {}, 'Fix anything, then confirm. Only then do families see the results.')))));
}

async function readResultsFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      pages.push({
        width: vp.width,
        items: tc.items.filter((it) => it.str && it.str.trim())
          .map((it) => ({ str: it.str, x: it.transform[4], y: vp.height - it.transform[5], w: it.width })),
      });
    }
    return { ...parseResultLines(linesFromPdfPages(pages)), source: 'pdf' };
  }
  const html = await file.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((el) => el.remove());
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('tr, p, div, h1, h2, h3, h4, li').forEach((el) => el.append('\n'));
  return { ...parseResultLines(linesFromText(doc.body ? doc.body.textContent : html)), source: 'html' };
}

async function loadRosterAndBests(teamId) {
  const [roster, results] = await Promise.all([
    db.from('swimmers').select('id, first_name, last_name, birth_year, birth_year_estimated, also_known_as, usually_unattached, archived')
      .eq('team_id', teamId).then(must),
    db.from('results').select('swimmer_id, distance, stroke, course, time_cs, status').eq('team_id', teamId).then(must),
  ]);
  const bests = {};
  for (const r of results || []) {
    if (r.status === 'dq' || !r.time_cs) continue;
    const key = `${r.distance}-${r.stroke}`;
    bests[r.course] = bests[r.course] || {};
    const byS = (bests[r.course][r.swimmer_id] = bests[r.course][r.swimmer_id] || {});
    if (!byS[key] || r.time_cs < byS[key]) byS[key] = r.time_cs;
  }
  return { roster: (roster || []).filter((s) => !s.archived), bests };
}

async function renderReview(parsed, fileName) {
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
  for (const p of [...groups.needsMatch, ...groups.unattached]) {
    // Pre-select only a likely nickname match (e.g. Theodore → Teddy); never a wrong-age or
    // last-name-only guess, and unattached swimmers start out left out.
    p.choice = !p.unattached && p.suggestion && /^Listed as/.test(p.reason || '') ? p.suggestion : '';
    p.rememberName = true;
    p.markUnattached = true;
  }
  for (const p of [...groups.matched, ...groups.needsMatch, ...groups.unattached]) {
    for (const s of p.swims) { s.include = true; s.editTime = s.timeCs; }
  }

  const draw = () => mount(coachChrome('results'), h('main', { class: 'page' },
    backLink('#/coach/upload', 'Choose a different file'),
    h('h1', {}, 'Review results'),
    meetCard(meet, fileCourse, parsed, counts, team, draw),
    groups.needsMatch.length ? decisionSection('Needs a match', groups.needsMatch, roster, rosterById, false, draw) : null,
    flaggedSection([...groups.matched, ...groups.needsMatch.filter((p) => p.choice && p.choice !== 'skip')], rosterById),
    groups.unattached.length ? decisionSection('Unattached swimmers', groups.unattached, roster, rosterById, true, draw) : null,
    matchedSection(groups.matched, rosterById, meet),
    publishCard(meet, groups, rosterById, parsed)));
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

function publishCard(meet, groups, rosterById, parsed) {
  const replaceBox = h('input', { type: 'checkbox' });
  const replaceLabel = h('label', { class: 'check small', hidden: true }, replaceBox,
    h('span', {}, 'This meet was already uploaded — replace the earlier upload'));
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
      const toCreate = [...groups.needsMatch, ...groups.unattached].filter((p) => p.choice === 'new');
      if (toCreate.length) {
        const created = must(await db.from('swimmers').insert(toCreate.map((p) => ({
          team_id: team.id, first_name: p.first, last_name: p.last,
          birth_year: estimateBirthYear(p.age, meet.date), birth_year_estimated: true,
          usually_unattached: !!p.unattached,
        }))).select('id, first_name, last_name'));
        toCreate.forEach((p, i) => { p.finalId = created[i].id; });
      }
      for (const p of groups.matched) { p.finalId = p.swimmerId; resolved.push(p); }
      for (const p of [...groups.needsMatch, ...groups.unattached]) {
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

      let meetId;
      try {
        meetId = must(await db.rpc('import_meet', {
          p_team: team.id, p_meet: { name: meet.name.trim(), meet_date: meet.date, course: meet.course, source: parsed.source },
          p_swims: swims, p_replace: replaceBox.checked,
        }));
      } catch (err) {
        if (/already uploaded/i.test(err.message || '')) { replaceLabel.hidden = false; }
        throw err;
      }

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
      toast(`${swims.length} swims published`, 'success');
      location.hash = `/coach/results/${meetId}`;
    });
  }
  return h('section', { class: 'card stack sticky-bottom' }, replaceLabel, msg, btn);
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
