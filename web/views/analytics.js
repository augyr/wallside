// Event analytics: best vs most recent vs goal splits, progress chart, swim history.
import { db, state, topBar } from '../app.js';
import { h, mount, must, toast, busy, field, formatTime, formatDiff, parseTime, eventName, formatDate, backLink, withColumns } from '../ui.js';
import { COURSE_LABEL, lapLength } from '../lib/time.js';
import { goalSplits, halves } from '../lib/goalsplits.js';
import { cutStatus, ageForStandards, cutLabel } from '../lib/standards.js';
import { analyticsLevel, LEVEL_LABEL, seasonStartYear } from '../lib/levels.js';
import { swimmerHref } from './swimmer.js';

const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const lapName = (i, len) => `${ordinal(i + 1)} ${len}`;
function ordinal(n) {
  const t = ['th', 'st', 'nd', 'rd']; const v = n % 100;
  return n + (t[(v - 20) % 10] || t[v] || t[0]);
}

export async function renderEvent(swimmerId, key, mode) {
  const [dStr, stroke, course] = String(key || '').split('-');
  const distance = Number(dStr);
  const chrome = mode === 'coach' ? (await import('./coach.js')).coachChrome('roster') : topBar('family');
  const back = swimmerHref(mode, swimmerId);
  if (!distance || !stroke || !['SCY', 'LCM'].includes(course)) { location.hash = back.slice(1); return; }

  mount(chrome, h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  let me; let results; let goals; let seeds;
  try {
    [me, results, goals, seeds] = await Promise.all([
      withColumns((c) => db.from('swimmers').select(c).eq('id', swimmerId).maybeSingle(),
        'id, first_name, last_name, birth_year, analytics_level, gender, groups(name, analytics_level)',
        'id, first_name, last_name, birth_year, analytics_level, groups(name, analytics_level)').then(must),
      db.from('results').select('id, time_cs, splits_cs, split_len, status, dq_reason, place, meet_name, meet_date, created_at')
        .eq('swimmer_id', swimmerId).eq('distance', distance).eq('stroke', stroke).eq('course', course)
        .order('meet_date', { ascending: true }).then(must),
      db.from('goals').select('id, title, target_cs, goal_splits_cs, goal_splits_set_by, course, distance, stroke, status, created_at')
        .eq('swimmer_id', swimmerId).eq('kind', 'time').eq('distance', distance).eq('stroke', stroke).eq('status', 'active')
        .order('created_at', { ascending: false }).then(must),
      db.from('seed_times').select('time_cs, meets(name, meet_date)').eq('swimmer_id', swimmerId).eq('distance', distance)
        .eq('stroke', stroke).eq('course', course).then((r) => (r.error ? [] : r.data || [])),
    ]);
  } catch (err) { toast(err.message || String(err), 'error'); return; }
  if (!me) { toast('Swimmer not found', 'error'); return; }

  const refresh = () => renderEvent(swimmerId, key, mode);
  const level = analyticsLevel(me, me.groups);
  const ok = (results || []).filter((r) => r.status !== 'dq' && r.time_cs);
  const best = ok.reduce((b, r) => (!b || r.time_cs < b.time_cs ? r : b), null);
  const latest = ok.length ? ok[ok.length - 1] : null;
  const seed = (seeds || []).reduce((b, x) => (!b || x.time_cs < b.time_cs ? x : b), null);
  const seedBest = seed && (!best || seed.time_cs < best.time_cs) ? seed : null;
  const bestCs = seedBest ? seedBest.time_cs : best ? best.time_cs : null;
  const goal = (goals || []).find((g) => (g.course || 'SCY') === course && g.target_cs) || null;

  const seasonStart = `${seasonStartYear()}-09-01`;
  const season = ok.filter((r) => r.meet_date >= seasonStart);
  const seasonBest = season.reduce((b, r) => (!b || r.time_cs < b.time_cs ? r : b), null);
  const seasonChange = season.length > 1 ? seasonBest.time_cs - season[0].time_cs : null;

  const title = `${eventName(distance, stroke)}`;
  const cutEvent = { distance, stroke, course, gender: me.gender, age: ageForStandards({ birthYear: me.birth_year }) };
  const cuts = cutStatus(bestCs, cutEvent);
  mount(chrome, h('main', { class: 'page' },
    backLink(back, mode === 'coach' ? `${me.first_name} ${me.last_name}` : `${me.first_name}'s page`),
    h('div', { class: 'stack tight' },
      h('h1', {}, title),
      h('p', { class: 'muted small' }, `${me.first_name} ${me.last_name} · ${COURSE_LABEL[course]}`),
      h('span', { class: 'pill level' }, level.label)),

    ok.length || seedBest ? h('section', { class: 'tiles' },
      tile('Best', bestCs ? formatTime(bestCs) : '—', seedBest ? 'seed time' : best ? formatDate(best.meet_date) : ''),
      tile('Most recent', latest ? formatTime(latest.time_cs) : '—', latest ? formatDate(latest.meet_date) : ''),
      tile(goal ? 'Goal' : 'This season', goal ? formatTime(goal.target_cs) : (seasonChange !== null ? formatDiff(seasonChange) : '—'),
        goal ? (bestCs ? (bestCs <= goal.target_cs ? 'Reached!' : `${formatTime(bestCs - goal.target_cs)} to go`) : '')
          : (seasonChange !== null ? 'first swim → best' : 'one swim so far'),
        goal ? 'goal' : (seasonChange !== null && seasonChange < 0 ? 'good' : ''))) : null,

    cuts.met || cuts.next ? h('section', { class: 'card cut-strip' },
      cuts.met ? h('span', {}, h('span', { class: 'cut-badge' }, cutLabel(cuts.met.set)), h('span', { class: 'small muted' }, ` ${cuts.met.set.name} · ${formatTime(cuts.met.cs)}`)) : null,
      cuts.next ? h('span', { class: 'small' }, h('strong', {}, `${formatTime(cuts.next.gap)} to ${cutLabel(cuts.next.set)}`),
        h('span', { class: 'muted' }, ` (${formatTime(cuts.next.cs)})`)) : h('span', { class: 'small ok-text' }, 'Fastest cut on file ✓')) : null,
    ok.length >= 2 ? chartCard(ok, goal, [cuts.met, cuts.next].filter(Boolean)) : null,
    seedBest ? h('p', { class: 'muted small' }, `Best time ${formatTime(seedBest.time_cs)} is a seed time${seedBest.meets && seedBest.meets.name ? ` (entered at ${seedBest.meets.name})` : ''} — no splits, so the split table uses the best swim on file.`) : null,
    splitsCard({ me, best, latest, goal, distance, stroke, course, level: level.level, mode, refresh }),
    goal ? null : setGoalCard(me, distance, stroke, course, best, refresh, cuts),
    historyCard(results || []),
    level.level === 'senior' ? h('section', { class: 'card empty' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Stroke efficiency'), h('span', { class: 'pill' }, 'Coming later')),
      h('p', { class: 'muted' }, 'Stroke count, stroke rate and distance per stroke — showing whether speed came from longer strokes or faster turnover.')) : null));
}

function tile(label, value, sub, tone) {
  return h('div', { class: 'tile' + (tone ? ' ' + tone : '') },
    h('span', { class: 'small muted' }, label),
    h('span', { class: 'tile-value' }, value),
    sub ? h('span', { class: 'small muted' }, sub) : null);
}

// ------------------------------------------------------------------
function chartCard(swims, goal, cutLines = []) {
  const W = 340; const H = 170; const L = 46; const R = 12; const T = 14; const B = 30;
  const times = swims.map((r) => r.time_cs).concat(goal ? [goal.target_cs] : [], cutLines.map((c) => c.cs));
  let lo = Math.min(...times); let hi = Math.max(...times);
  const pad = Math.max(20, (hi - lo) * 0.15); lo -= pad; hi += pad;
  const x = (i) => L + (swims.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (swims.length - 1));
  const y = (cs) => T + ((cs - lo) / (hi - lo)) * (H - T - B);   // faster = higher on the chart
  const pts = swims.map((r, i) => `${x(i).toFixed(1)},${y(r.time_cs).toFixed(1)}`).join(' ');
  const first = swims[0]; const last = swims[swims.length - 1];

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img',
    'aria-label': `Times from ${formatTime(first.time_cs)} on ${formatDate(first.meet_date)} to ${formatTime(last.time_cs)} on ${formatDate(last.meet_date)}${goal ? `, goal ${formatTime(goal.target_cs)}` : ''}` },
    s('line', { x1: L, x2: W - R, y1: T, y2: T, class: 'grid' }),
    s('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, class: 'grid' }),
    s('text', { x: L - 6, y: T + 4, 'text-anchor': 'end', class: 'axis' }, formatTime(lo)),
    s('text', { x: L - 6, y: H - B + 4, 'text-anchor': 'end', class: 'axis' }, formatTime(hi)),
    goal ? s('line', { x1: L, x2: W - R, y1: y(goal.target_cs), y2: y(goal.target_cs), class: 'goal-line' }) : null,
    goal ? s('text', { x: W - R, y: y(goal.target_cs) - 5, 'text-anchor': 'end', class: 'goal-label' }, 'Goal ' + formatTime(goal.target_cs)) : null,
    ...cutLines.flatMap((c) => [s('line', { x1: L, x2: W - R, y1: y(c.cs), y2: y(c.cs), class: 'cut-line' }),
      s('text', { x: L + 4, y: y(c.cs) - 4, class: 'cut-label' }, `${cutLabel(c.set)} ${formatTime(c.cs)}`)]),
    s('polyline', { points: pts, class: 'trend' }),
    swims.map((r, i) => s('circle', { cx: x(i), cy: y(r.time_cs), r: i === swims.length - 1 ? 5 : 4, class: 'dot' },
      s('title', {}, `${formatTime(r.time_cs)} · ${r.meet_name || ''} ${formatDate(r.meet_date)}`))),
    s('text', { x: L, y: H - 8, class: 'axis' }, formatDate(first.meet_date)),
    s('text', { x: W - R, y: H - 8, 'text-anchor': 'end', class: 'axis' }, formatDate(last.meet_date)));

  return h('section', { class: 'card' },
    h('h2', {}, 'Progress'),
    h('figure', { class: 'chart' }, svg),
    h('p', { class: 'muted small' }, 'Higher on the chart is faster. Each dot is one swim.'));
}

// ------------------------------------------------------------------
function splitsCard({ me, best, latest, goal, distance, stroke, course, level, mode, refresh }) {
  const lapLen = (best && best.split_len) || (latest && latest.split_len) || lapLength(course);
  const laps = distance / lapLen;
  if (!Number.isInteger(laps) || laps < 2) {
    return h('section', { class: 'card' }, h('h2', {}, 'Splits'),
      h('p', { class: 'muted' }, `A ${distance} in a ${course === 'LCM' ? '50 m' : '25 yd'} pool is one length, so there are no splits to compare.`));
  }
  const usable = (r) => (r && r.splits_cs && r.splits_cs.length === laps && r.split_len === lapLen ? r.splits_cs : null);
  const bestSplits = usable(best);
  const latestSplits = latest && latest !== best ? usable(latest) : (latest === best ? bestSplits : null);

  let goalInfo = null;
  if (goal) {
    if (goal.goal_splits_cs && goal.goal_splits_cs.length === laps) {
      goalInfo = { splits: goal.goal_splits_cs, method: 'coach' };
    } else {
      goalInfo = goalSplits({ bestSplits, goalCs: goal.target_cs, laps, lapLen, level, stroke });
    }
  }

  const developing = level === 'developing';
  const rowsFor = (splits) => (developing ? halves(splits) : splits);
  const cols = [
    { label: 'Best', splits: bestSplits && rowsFor(bestSplits), total: best && best.time_cs, note: best ? formatDate(best.meet_date) : null },
    { label: 'Most recent', splits: latestSplits && rowsFor(latestSplits), total: latest && latest.time_cs, note: latest ? formatDate(latest.meet_date) : null, diff: true },
    { label: 'Goal', splits: goalInfo && rowsFor(goalInfo.splits), total: goal && goal.target_cs, note: goal ? (goalInfo && goalInfo.method === 'coach' ? 'set by coach' : 'suggested') : null, goal: true },
  ];
  const nRows = developing ? 2 : laps;
  const rowLabel = (i) => (developing ? (i === 0 ? '1st half' : '2nd half') : lapName(i, lapLen));
  const bestRows = cols[0].splits;

  const table = h('table', { class: 'splits' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, developing ? 'Half' : 'Lap'),
      cols.map((c) => h('th', { scope: 'col' }, c.label, c.note ? h('span', { class: 'th-note' }, c.note) : null)))),
    h('tbody', {},
      Array.from({ length: nRows }, (_, i) => h('tr', {},
        h('th', { scope: 'row' }, rowLabel(i)),
        cols.map((c) => {
          if (!c.splits) return h('td', { class: 'muted' }, '—');
          const v = c.splits[i];
          const d = c.diff && bestRows && c.splits !== bestRows ? v - bestRows[i] : null;
          return h('td', { class: c.goal ? 'goal-col' : '' }, formatTime(v),
            d !== null && d !== 0 ? h('span', { class: 'delta ' + (d < 0 ? 'faster' : 'slower') }, formatDiff(d)) : null);
        }))),
      h('tr', { class: 'total' }, h('th', { scope: 'row' }, 'Total'),
        cols.map((c) => h('td', { class: c.goal ? 'goal-col' : '' }, c.total ? formatTime(c.total) : '—')))));

  const notes = [];
  if (!bestSplits && !latestSplits) notes.push('No splits in the uploaded results for this event yet — totals only.');
  if (goalInfo && goalInfo.method === 'from-best') {
    notes.push(`Goal splits follow ${me.first_name}'s best swim: a little off the ${lapLen === 25 ? 'first 25' : 'first 50'} (the start is already near full speed), more off the later laps where time was lost.`);
  } else if (goalInfo && goalInfo.method === 'template') {
    notes.push(`No splits on file, so goal splits use a typical race plan: a faster first ${lapLen} from the ${stroke === 'BK' ? 'in-water start' : 'dive'}, then even laps.`);
  }
  if (goalInfo && goalInfo.range && goalInfo.method !== 'coach') {
    const [lo, hi] = goalInfo.range;
    notes.push(`First ${lapLen} kept about ${formatTime(lo)}–${formatTime(hi)} s faster than the other laps (${LEVEL_LABEL[level]} range${stroke === 'BK' ? ', smaller for backstroke' : ''})${goalInfo.adjusted ? ' — adjusted to fit' : ''}.`);
  }

  return h('section', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Splits'), h('span', { class: 'muted small' }, developing ? 'By half' : `Per ${lapLen}`)),
    h('div', { class: 'table-wrap' }, table),
    notes.map((n) => h('p', { class: 'muted small' }, n)),
    goal && mode === 'coach' && !developing ? goalEditor(goal, goalInfo, nRows, lapLen, refresh) : null);
}

function goalEditor(goal, goalInfo, laps, lapLen, refresh) {
  const inputs = Array.from({ length: laps }, (_, i) => h('input', { type: 'text', inputmode: 'decimal', class: 'time-input',
    value: goalInfo ? formatTime(goalInfo.splits[i]) : '', 'aria-label': `Goal split ${lapName(i, lapLen)}` }));
  const total = h('p', { class: 'small' });
  const updateTotal = () => {
    const vals = inputs.map((x) => parseTime(x.value));
    total.textContent = vals.every((v) => v) ? `Adds up to ${formatTime(sum(vals))} (goal ${formatTime(goal.target_cs)})` : 'Enter every split';
  };
  inputs.forEach((x) => x.addEventListener('input', updateTotal));
  updateTotal();

  const save = h('button', { type: 'button', class: 'btn small primary', onClick: async () => {
    await busy(save, async () => {
      const vals = inputs.map((x) => parseTime(x.value));
      if (!vals.every((v) => v)) throw new Error('Enter every split, like 15.10');
      must(await db.rpc('set_goal_splits', { p_goal: goal.id, p_splits: vals }));
      toast('Goal splits saved — the swimmer and family see them now', 'success');
      refresh();
    });
  } }, 'Save goal splits');
  const reset = goal.goal_splits_cs ? h('button', { type: 'button', class: 'btn small ghost', onClick: async () => {
    await busy(reset, async () => {
      must(await db.rpc('set_goal_splits', { p_goal: goal.id, p_splits: null }));
      toast('Back to suggested splits', 'success');
      refresh();
    });
  } }, 'Use suggested splits') : null;

  return h('details', { class: 'editor' },
    h('summary', {}, 'Edit goal splits (coach)'),
    h('div', { class: 'stack' },
      h('div', { class: 'split-inputs' }, inputs.map((x, i) => h('label', { class: 'small' }, lapName(i, lapLen), x))),
      total,
      h('div', { class: 'row' }, save, reset)));
}

function setGoalCard(me, distance, stroke, course, best, refresh, cuts) {
  const target = h('input', { type: 'text', inputmode: 'decimal', class: 'time-input',
    placeholder: best ? formatTime(Math.round(best.time_cs * 0.985)) : 'e.g. 59.00' });
  const form = h('form', { class: 'row', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      const cs = parseTime(target.value);
      if (!cs) throw new Error('Enter a goal time, like 59.00');
      must(await db.from('goals').insert({
        swimmer_id: me.id, created_by: state.user.id, kind: 'time', course, distance, stroke, target_cs: cs,
        title: `${eventName(distance, stroke)} (${course}) under ${formatTime(cs)}`, due_label: 'End of season',
      }));
      toast('Goal set — goal splits are ready', 'success');
      refresh();
    });
  } }, field('Goal time', target), h('button', { type: 'submit', class: 'btn small primary' }, 'Set goal'));
  const upcoming = cuts && cuts.next ? cuts.all.filter((c) => c.cs <= cuts.next.cs).slice(0, 3) : [];
  return h('section', { class: 'card stack' },
    h('h2', {}, 'Goal'),
    h('p', { class: 'muted' }, `No goal time for the ${eventName(distance, stroke)} yet. Set one to see suggested goal splits.`),
    upcoming.length ? h('div', { class: 'chips' }, upcoming.map((c) => h('button', { type: 'button', class: 'chip small',
      onClick: () => { target.value = formatTime(c.cs); target.focus(); } }, `${cutLabel(c.set)} · ${formatTime(c.cs)}`))) : null,
    form);
}

function historyCard(all) {
  const rows = [...all].sort((a, b) => (b.meet_date || '').localeCompare(a.meet_date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
  if (!rows.length) {
    return h('section', { class: 'card empty' }, h('h2', {}, 'Swims'),
      h('p', { class: 'muted' }, 'Swims of this event will show here after the coach uploads meet results.'));
  }
  return h('section', { class: 'card' },
    h('h2', {}, 'Swims'),
    h('ul', { class: 'list' }, rows.map((r) => h('li', { class: 'list-row' },
      h('span', { class: 'grow' },
        h('strong', {}, r.meet_name || 'Meet'),
        h('span', { class: 'muted small block' }, formatDate(r.meet_date) + (r.place ? ` · ${ordinal(r.place)}` : '')),
        r.status === 'dq' ? h('span', { class: 'small warn-text block' }, 'Disqualified' + (r.dq_reason ? ': ' + r.dq_reason : '') + ' — not counted') : null),
      h('span', { class: 'time' + (r.status === 'dq' ? ' muted' : '') }, r.status === 'dq' ? 'DQ' : formatTime(r.time_cs))))));
}
