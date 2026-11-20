// Reading a roster list that a coach pasted or uploaded (spreadsheet, team-software export,
// email). Works out which column is which, cleans up names, birth years and girls/boys, and
// marks swimmers already on the roster. No DOM here, so it can be tested in Node.

export const ROLES = {
  ignore: 'Skip this column',
  first: 'First name',
  last: 'Last name',
  full: 'Full name (First Last)',
  lastfirst: 'Full name (Last, First)',
  birth: 'Birth date or year',
  age: 'Age',
  gender: 'Girl / boy',
  group: 'Group',
};

// ---------------------------------------------------------------- splitting
/** Text → rows of cells. Tabs (spreadsheet copy) win; otherwise commas, with "quoted, cells". */
export function splitRows(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const tabbed = lines.some((l) => l.includes('\t'));
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = tabbed ? line.split('\t') : csvCells(line);
    const clean = cells.map((c) => c.trim());
    if (clean.some(Boolean)) rows.push(clean);
  }
  // even out ragged rows
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => r.concat(Array(width - r.length).fill('')));
}

function csvCells(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------- values
const GENDER = { f: 'F', female: 'F', girl: 'F', girls: 'F', g: 'F', w: 'F', women: 'F', woman: 'F',
  m: 'M', male: 'M', boy: 'M', boys: 'M', b: 'M', men: 'M', man: 'M' };
export const genderOf = (v) => GENDER[String(v || '').trim().toLowerCase()] || null;

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
/** "2012", "3/14/2012", "2012-03-14", "14.03.12", "Mar 14, 2012" → 2012 (or null). */
export function birthYearOf(v, now = new Date()) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/\b(19\d\d|20\d\d)\b/);
  if (m) return Number(m[1]);
  m = s.match(/^\d{1,2}[/.\-]\d{1,2}[/.\-](\d{2})$/) || s.match(new RegExp(`^(?:${MONTHS.join('|')})[a-z]*\\.? \\d{1,2},? (\\d{2})$`, 'i'));
  if (m) {
    const yy = Number(m[1]);
    const cur = now.getFullYear() % 100;
    return yy <= cur ? 2000 + yy : 1900 + yy;
  }
  // Excel date serial number (days since 1899-12-30)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    const y = d.getUTCFullYear();
    if (y >= 1990 && y <= 2035) return y;
  }
  return null;
}

const isYearish = (v) => !!v && birthYearOf(v) !== null && /\d/.test(v);
const isAgeish = (v) => /^\d{1,2}$/.test(String(v).trim()) && Number(v) >= 4 && Number(v) <= 30;
const isWord = (v) => /^[\p{L}'’.\-]+$/u.test(String(v).trim());
const hasLetters = (v) => /\p{L}/u.test(String(v));

/** "RIVERA" → "Rivera", "mcdonald" stays as typed unless all one case; keeps "de Witt", "O'Neil". */
export function tidyName(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const allUpper = s === s.toUpperCase() && /\p{Lu}/u.test(s);
  const allLower = s === s.toLowerCase();
  if (!allUpper && !allLower) return s;
  return s.toLowerCase().replace(/(^|[\s'’\-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
}

/** "Maya R Rivera" → {first: Maya, last: Rivera}; "Rivera, Maya R" → same; "Nirelle de Witt" → de Witt. */
export function splitName(v, lastFirst = false) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (!s) return { first: '', last: '' };
  if (lastFirst || s.includes(',')) {
    const [last, rest = ''] = s.split(/\s*,\s*/, 2);
    const first = rest.split(' ').filter((w) => !/^\p{L}\.?$/u.test(w))[0] || rest.split(' ')[0] || '';
    return { first: tidyName(first), last: tidyName(last) };
  }
  const words = s.split(' ');
  if (words.length < 2) return { first: tidyName(words[0]), last: '' };
  const first = words[0];
  let rest = words.slice(1);
  if (rest.length > 1 && /^\p{L}\.?$/u.test(rest[0])) rest = rest.slice(1);   // middle initial
  return { first: tidyName(first), last: tidyName(rest.join(' ')) };
}

// ---------------------------------------------------------------- columns
const HEADER_WORDS = [
  ['ignore', /prefer|nick|middle|\bmi\b|email|phone|address|parent|guardian|usa ?s(wimming)?.?id|member ?id|^id$|status|registr|city|zip|state/i],
  ['first', /first|given|fname/i],
  ['last', /last|surname|family|lname/i],
  ['birth', /birth|dob|born|b\.?day|bday/i],
  ['age', /^age\b|age$/i],
  ['gender', /gender|^sex$|^m\/f$|^g\/b$/i],
  ['group', /group|squad|level|roster|training|practice/i],
  ['full', /name|swimmer|athlete/i],
];

export function headerRole(cell) {
  const s = String(cell || '').trim();
  if (!s || /\d{3,}/.test(s)) return null;
  for (const [role, re] of HEADER_WORDS) if (re.test(s)) return role;
  return null;
}

/**
 * Work out what each column holds.
 * Returns { header: boolean, roles: [role per column] }.
 */
export function guessColumns(rows, groupNames = []) {
  if (!rows.length) return { header: false, roles: [] };
  const width = rows[0].length;
  const headRoles = rows[0].map(headerRole);
  const header = headRoles.filter(Boolean).length >= Math.min(2, width) && !rows[0].some(isYearish);
  let roles;
  if (header) {
    roles = headRoles.map((r) => r || 'ignore');
    // "Name" column holding "Last, First"
    const body = rows.slice(1);
    roles = roles.map((r, i) => (r === 'full' && body.filter((row) => row[i].includes(',')).length > body.length / 2 ? 'lastfirst' : r));
  } else {
    roles = guessFromValues(rows, width, groupNames);
  }
  return { header, roles: fixNameRoles(roles) };
}

function guessFromValues(rows, width, groupNames) {
  const known = new Set(groupNames.map((g) => g.toLowerCase()));
  const roles = [];
  const share = (i, test) => {
    const vals = rows.map((r) => r[i]).filter((v) => v !== '');
    return vals.length ? vals.filter(test).length / vals.length : 0;
  };
  for (let i = 0; i < width; i++) {
    if (rows.every((r) => !r[i])) roles.push('ignore');
    else if (share(i, isYearish) >= 0.6) roles.push('birth');
    else if (share(i, (v) => genderOf(v)) >= 0.8) roles.push('gender');
    else if (share(i, isAgeish) >= 0.8) roles.push('age');
    else if (known.size && share(i, (v) => known.has(v.toLowerCase())) >= 0.5) roles.push('group');
    else if (share(i, (v) => v.includes(',')) >= 0.5) roles.push('lastfirst');
    else if (share(i, (v) => /\s/.test(v.trim()) && hasLetters(v)) >= 0.5) roles.push('full');
    else if (share(i, (v) => isWord(v)) >= 0.6) roles.push('word');
    else roles.push('ignore');
  }
  // single words: the first two are the names (first, last); a later one is probably a group
  let names = roles.some((r) => r === 'full' || r === 'lastfirst') ? 2 : 0;
  return roles.map((r) => {
    if (r !== 'word') return r;
    if (names === 0) { names = 1; return 'first'; }
    if (names === 1) { names = 2; return 'last'; }
    return 'group';
  });
}

function fixNameRoles(roles) {
  const hasFirst = roles.includes('first');
  const hasLast = roles.includes('last');
  // a header said "Name" but first/last columns exist too: skip the combined one
  if (hasFirst && hasLast) return roles.map((r) => (r === 'full' || r === 'lastfirst' ? 'ignore' : r));
  // only one of each role (keep the first)
  const seen = new Set();
  return roles.map((r) => {
    if (r === 'ignore') return r;
    if (seen.has(r)) return 'ignore';
    seen.add(r);
    return r;
  });
}

// ---------------------------------------------------------------- people
export const nameKey = (first, last) => `${String(first).toLowerCase().replace(/[^\p{L}]/gu, '')}|${String(last).toLowerCase().replace(/[^\p{L}]/gu, '')}`;

/**
 * Turn rows into swimmers to add.
 * opts: { header, roles, roster: [{first_name,last_name,archived}], now }
 * Each person: { line, first, last, birth_year, estimated, gender, groupName, status, note }
 *   status: 'new' | 'onRoster' | 'archived' | 'repeat' | 'problem'
 */
export function buildPeople(rows, { header = false, roles = [], roster = [], now = new Date() } = {}) {
  const onRoster = new Map(roster.map((s) => [nameKey(s.first_name, s.last_name), s]));
  const seen = new Set();
  const out = [];
  const body = header ? rows.slice(1) : rows;
  body.forEach((row, n) => {
    const get = (role) => { const i = roles.indexOf(role); return i >= 0 ? row[i] : ''; };
    let first = tidyName(get('first'));
    let last = tidyName(get('last'));
    if (!first && !last) {
      const full = get('lastfirst') ? splitName(get('lastfirst'), true) : splitName(get('full'));
      first = full.first; last = full.last;
    }
    let birthYear = birthYearOf(get('birth'), now);
    let estimated = false;
    if (!birthYear && isAgeish(get('age'))) { birthYear = now.getFullYear() - Number(get('age')); estimated = true; }
    if (birthYear && (birthYear < 1990 || birthYear > 2035)) birthYear = null;
    const person = { line: n + 1 + (header ? 1 : 0), first, last, birth_year: birthYear, estimated,
      gender: genderOf(get('gender')), groupName: get('group').trim(), status: 'new', note: '' };
    const key = nameKey(first, last);
    if (!first || !last) { person.status = 'problem'; person.note = 'Needs a first and last name'; }
    else if (first.length > 60 || last.length > 60) { person.status = 'problem'; person.note = 'Name too long'; }
    else if (onRoster.has(key)) {
      const s = onRoster.get(key);
      person.status = s.archived ? 'archived' : 'onRoster';
      person.note = s.archived ? 'Archived — restore them from their page instead' : 'Already on your roster';
    } else if (seen.has(key)) { person.status = 'repeat'; person.note = 'Listed twice'; }
    seen.add(key);
    out.push(person);
  });
  return out;
}
