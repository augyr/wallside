// Reads HY-TEK Meet Manager results (PDF text or web results pages) into swims.
// Pure functions — no browser APIs — so they can be tested on their own.
import { parseTime } from './time.js';

const STROKE_WORDS = [
  [/^free/i, 'FR'], [/^back/i, 'BK'], [/^breast/i, 'BR'], [/^(fly|butter)/i, 'FL'], [/^(im|ind)/i, 'IM'],
];
const VALID_DISTANCES = new Set([25, 50, 100, 200, 400, 500, 800, 1000, 1500, 1650]);
const STATUS_WORDS = new Set(['DQ', 'NS', 'DFS', 'SCR', 'DNF', 'NSS', 'DNS']);

const EVENT_RE = /^\(?\s*(?:#\s*(\d+)\s+|Event\s+(\d+)\s+|(?=(?:Girls|Boys|Women|Men|Mixed|Open|Female|Male)\b))(.*?)\b(\d{2,4})\s+(LC\s+Meters?|SC\s+Meters?|Yards?|Meters?|Metres?)\s+(.+?)\)?\s*$/i;
const MEET_RE = /^(.*?\S)\s+-\s+(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+to\s+\d{1,2}\/\d{1,2}\/\d{4})?\s*$/;

function isTimeToken(tok) {
  return parseTime(tok) !== null && /\d\.\d/.test(tok);
}

// ------------------------------------------------------------------
// Event and swim lines
// ------------------------------------------------------------------
export function parseEventLine(line) {
  const m = line.trim().match(EVENT_RE);
  if (!m) return null;
  const rest = m[6];
  // An event title never contains a comma (names do) or a race time
  if (rest.includes(',') || /\d\.\d\d/.test(rest)) return null;
  if (/relay/i.test(rest) || /diving/i.test(line)) return { skip: true, number: Number(m[1] || m[2]) || null };
  const distance = Number(m[4]);
  const strokeEntry = STROKE_WORDS.find(([re]) => re.test(rest.trim()));
  if (!strokeEntry || !VALID_DISTANCES.has(distance)) return { skip: true, number: Number(m[1] || m[2]) || null };
  const unit = m[5].toLowerCase();
  const course = unit.startsWith('yard') ? 'SCY' : unit.startsWith('lc') ? 'LCM' : unit.startsWith('sc') ? 'SCM' : 'M';
  return { number: Number(m[1] || m[2]) || null, label: line.trim().replace(/^\(|\)$/g, ''), distance, stroke: strokeEntry[1], course };
}

// "  1 Rivera, Maya R   15 PASA-PC   1:00.50   59.84" → swim fields (or null)
export function parseSwimLine(line) {
  const t = line.trim().split(/\s+/);
  if (t.length < 4) return null;
  const placeTok = t[0];
  if (!/^(\*?\d{1,3}|-{2,3}|x\*?\d{0,3})$/i.test(placeTok)) return null;

  let i = 1;
  const nameToks = [];
  while (i < t.length) {
    if (/^\d{1,2}$/.test(t[i]) && nameToks.some((s) => s.includes(','))) break;
    nameToks.push(t[i]);
    i++;
    if (nameToks.length > 7) return null;
  }
  if (i >= t.length - 1 || !nameToks.some((s) => s.includes(','))) return null;
  const age = Number(t[i]);
  i++;

  const teamToks = [];
  while (i < t.length && !isTimeToken(t[i]) && !STATUS_WORDS.has(t[i].toUpperCase()) && t[i].toUpperCase() !== 'NT') {
    teamToks.push(t[i]);
    i++;
  }
  if (!teamToks.length) return null;
  const rest = t.slice(i);
  if (!rest.length) return null;

  let status = 'ok';
  let timeCs = null;
  const statusIdx = rest.findIndex((x) => STATUS_WORDS.has(x.toUpperCase()));
  if (statusIdx >= 0) {
    const word = rest[statusIdx].toUpperCase();
    if (word === 'DQ') {
      status = 'dq';
      const after = rest.slice(statusIdx + 1).find(isTimeToken);
      timeCs = after ? parseTime(after) : null;
    } else {
      status = 'ns';
    }
  } else {
    const times = rest.filter(isTimeToken);
    if (!times.length) return null;
    timeCs = parseTime(times[times.length - 1]);
  }

  const placeNum = placeTok.replace(/[^0-9]/g, '');
  return {
    place: placeNum ? Number(placeNum) : null,
    name: nameToks.join(' '),
    age,
    team: teamToks.join(' '),
    status,
    timeCs,
  };
}

// A line of split times, e.g. "13.62  28.93 (15.31)  44.41 (15.48)  59.84 (15.43)"
export function parseSplitLine(line) {
  const toks = line.trim().split(/\s+/).filter((x) => !/^r:?[+-]?\d/i.test(x));
  if (!toks.length) return null;
  const cumulative = [];
  for (const tok of toks) {
    if (/^\(.*\)$/.test(tok)) {
      if (!isTimeToken(tok.slice(1, -1))) return null;
      continue;
    }
    if (!isTimeToken(tok)) return null;
    cumulative.push(parseTime(tok));
  }
  return cumulative.length ? cumulative : null;
}

// Cumulative splits → per-lap splits, if they divide the race evenly into 25s/50s/100s
export function lapSplits(cumulative, finalCs, distance) {
  if (!cumulative || !cumulative.length || !finalCs) return null;
  const cum = [...cumulative];
  if (cum[cum.length - 1] !== finalCs) {
    if (cum[cum.length - 1] > finalCs) return null;
    cum.push(finalCs);
  }
  for (let k = 1; k < cum.length; k++) if (cum[k] <= cum[k - 1]) return null;
  const splitLen = distance / cum.length;
  if (![25, 50, 100].includes(splitLen)) return null;
  const laps = cum.map((c, k) => (k === 0 ? c : c - cum[k - 1]));
  return { splits: laps, splitLen };
}

function isReasonLine(line) {
  const s = line.trim();
  return s.length > 2 && s.length < 120 && /[a-z]/i.test(s) && !/\d\.\d\d/.test(s) && !/^(Name|Event|#\d)/i.test(s)
    && !/^=+$/.test(s) && !/MEET MANAGER|Page \d|Results|Record|Standard/i.test(s);
}

// ------------------------------------------------------------------
// Lines (already in reading order) → meet + swims
// ------------------------------------------------------------------
export function parseResultLines(lines) {
  const meet = { name: null, date: null };
  const swims = [];
  let event = null;
  let last = null;       // last swim, for split and DQ-reason lines
  let lastKind = null;   // what the previous meaningful line was
  let ignoredEvents = 0;

  for (const raw of lines) {
    const line = raw.replace(/ /g, ' ').replace(/\s+$/, '');
    if (!line.trim()) continue;

    if (!meet.name && !/MEET MANAGER/i.test(line)) {
      const mm = line.trim().match(MEET_RE);
      if (mm && !/^\d{1,2}\.\d/.test(mm[1])) {
        meet.name = mm[1].trim();
        meet.date = `${mm[4]}-${mm[2].padStart(2, '0')}-${mm[3].padStart(2, '0')}`;
        continue;
      }
    }

    const ev = parseEventLine(line);
    if (ev) {
      if (ev.skip) { event = null; ignoredEvents++; } else event = ev;
      last = null; lastKind = 'event';
      continue;
    }
    if (!event) continue;

    const swim = parseSwimLine(line);
    if (swim) {
      const record = { ...swim, distance: event.distance, stroke: event.stroke, course: event.course,
        event: event.label, eventNumber: event.number, splits: null, splitLen: null, dqReason: null, cumulative: [] };
      swims.push(record);
      last = record; lastKind = 'swim';
      continue;
    }

    if (last) {
      const cum = parseSplitLine(line);
      if (cum) { last.cumulative.push(...cum); lastKind = 'split'; continue; }
      if (last.status === 'dq' && (lastKind === 'swim' || lastKind === 'reason') && isReasonLine(line)) {
        const text = line.trim();
        if (!/^other$/i.test(text)) last.dqReason = last.dqReason ? `${last.dqReason} — ${text}` : text;
        lastKind = 'reason';
        continue;
      }
    }
    lastKind = 'other';
  }

  for (const s of swims) {
    if (s.status === 'ok' && s.cumulative.length) {
      const laps = lapSplits(s.cumulative, s.timeCs, s.distance);
      if (laps) { s.splits = laps.splits; s.splitLen = laps.splitLen; }
    }
    delete s.cumulative;
  }
  return { meet, swims, ignoredEvents };
}

// ------------------------------------------------------------------
// PDF: positioned text items → lines in reading order (handles 1–3 columns)
// pages: [{ width, items: [{ str, x, y, w }] }]   (y measured from the top)
// ------------------------------------------------------------------
function rowsOf(items, tolerance = 3) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const row = rows.length ? rows[rows.length - 1] : null;
    if (row && Math.abs(row.y - it.y) <= tolerance) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  return rows.map((r) => {
    const its = r.items.sort((a, b) => a.x - b.x);
    let text = '';
    let end = null;
    for (const it of its) {
      if (end !== null) text += (it.x - end > 0.8 || !it.w) ? ' ' : '';
      text += it.str;
      end = it.w ? it.x + it.w : null;
    }
    return { y: r.y, text: text.replace(/\s+/g, ' ').trim() };
  });
}

function scoreLines(lines) {
  let n = 0;
  for (const l of lines) if (parseSwimLine(l) || parseEventLine(l)) n++;
  return n;
}

export function linesFromPdfPages(pages) {
  const out = [];
  for (const page of pages) {
    const items = page.items.filter((it) => it.str && it.str.trim());
    if (!items.length) continue;
    const width = page.width || Math.max(...items.map((it) => it.x + (it.w || 0))) + 20;

    // Full-width header lines (meet name, page header) go first
    const headerYs = new Set();
    for (const row of rowsOf(items)) {
      if (MEET_RE.test(row.text) || /MEET MANAGER|^Results\b|Page \d+\s*$/i.test(row.text)) {
        out.push(row.text);
        headerYs.add(Math.round(row.y));
      }
    }
    const body = items.filter((it) => ![...headerYs].some((y) => Math.abs(y - it.y) <= 3));

    // Try 1, 2 and 3 columns; keep whichever reads the most events and swims
    let best = { score: -1, lines: [] };
    for (const k of [1, 2, 3]) {
      for (const shift of [-12, -4, 4]) {
        const bounds = Array.from({ length: k - 1 }, (_, j) => (width * (j + 1)) / k + shift);
        const cols = Array.from({ length: k }, () => []);
        for (const it of body) {
          let c = 0;
          while (c < bounds.length && it.x >= bounds[c]) c++;
          cols[c].push(it);
        }
        const lines = cols.flatMap((col) => rowsOf(col).map((r) => r.text));
        const score = scoreLines(lines);
        if (score > best.score) best = { score, lines };
        if (k === 1) break;
      }
    }
    out.push(...best.lines);
  }
  return out;
}

// Web results (HY-TEK HTML) → plain text lines. Pass the page's text content.
export function linesFromText(text) {
  return String(text).split(/\r?\n/);
}
