// Matches swims read from meet results to swimmers on the roster.
// Never matches on last name alone; uses first name (or a saved "also listed as" name,
// or a common nickname, which needs the coach to confirm) plus a sensible age.

const NICKNAMES = [
  ['alex', 'alexander', 'alexandra', 'alexis', 'alejandro'], ['andy', 'andrew'], ['abby', 'abigail'],
  ['ben', 'benjamin'], ['bill', 'will', 'william', 'liam'], ['bob', 'rob', 'robert', 'bobby'],
  ['charlie', 'charles', 'charlotte'], ['chris', 'christopher', 'christina', 'christian'],
  ['dan', 'danny', 'daniel'], ['dash', 'dashiell'], ['ellie', 'eleanor', 'elizabeth', 'ella', 'elena'],
  ['gabe', 'gabriel'], ['izzy', 'isabel', 'isabella', 'isabelle'], ['jake', 'jacob'], ['jim', 'jimmy', 'james', 'jamie'],
  ['joe', 'joey', 'joseph'], ['josh', 'joshua'], ['kate', 'katie', 'katherine', 'catherine', 'kathryn'],
  ['lexi', 'alexis'], ['liz', 'lizzy', 'elizabeth', 'beth'], ['liv', 'olivia'], ['maddie', 'madison', 'madeline', 'madelyn'],
  ['matt', 'matthew'], ['max', 'maxwell', 'maximilian', 'maximus'], ['mike', 'michael', 'mikey'],
  ['nate', 'nathan', 'nathaniel'], ['nick', 'nicholas', 'nico', 'nicolas'], ['sam', 'samantha', 'samuel'],
  ['ted', 'teddy', 'theodore', 'theo'], ['tom', 'tommy', 'thomas'], ['tony', 'anthony'], ['zach', 'zachary'],
  ['steve', 'steven', 'stephen'], ['jon', 'jonathan'], ['will', 'wilson'], ['becca', 'rebecca'], ['vicky', 'victoria'],
];

export function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ').replace(/[\s'-]+/g, ' ').trim();
}
const compact = (s) => normalize(s).replace(/\s+/g, '');

// "Vance, Rowan -"  /  "Ashby, Marigold M"  /  "van der Berg, Elin B"
export function splitResultName(raw) {
  const [lastRaw, firstRaw = ''] = String(raw).split(',');
  const firstToks = firstRaw.trim().split(/\s+/).filter((x) => x && x !== '-');
  while (firstToks.length > 1 && /^[A-Z]\.?$/.test(firstToks[firstToks.length - 1])) firstToks.pop();
  return { last: lastRaw.trim(), first: firstToks.join(' ') };
}

function nicknameRelated(a, b) {
  if (a === b) return true;
  return NICKNAMES.some((set) => set.includes(a) && set.includes(b));
}

// How a result's first name relates to a roster swimmer
function firstNameMatch(resultFirst, swimmer) {
  const rf = normalize(resultFirst);
  const known = [swimmer.first_name, ...(swimmer.also_known_as || [])].map(normalize);
  if (known.includes(rf)) return 'exact';
  if (known.some((k) => k.split(' ')[0] === rf.split(' ')[0] && rf.split(' ')[0].length > 1)) return 'exact';
  const r0 = rf.split(' ')[0];
  const k0 = normalize(swimmer.first_name).split(' ')[0];
  if (r0.length >= 3 && k0.length >= 3 && (r0.startsWith(k0) || k0.startsWith(r0))) return 'similar';
  if (nicknameRelated(r0, k0)) return 'similar';
  return null;
}

// Possible ages at a meet for a birth year (depends on whether the birthday has passed)
export function agesFor(birthYear, meetDate) {
  if (!birthYear || !meetDate) return null;
  const y = Number(String(meetDate).slice(0, 4));
  return [y - birthYear - 1, y - birthYear];
}

export function estimateBirthYear(age, meetDate) {
  return Number(String(meetDate).slice(0, 4)) - age;
}

export function teamCodeOf(team) {
  const t = String(team || '').trim();
  const m = t.match(/^([A-Za-z0-9]{2,8})-[A-Za-z]{2}$/);
  return (m ? m[1] : t).toUpperCase();
}

export function isUnattached(team) {
  const code = teamCodeOf(team);
  return code === 'UN' || code === 'UNAT' || /^unattached/i.test(String(team || '').trim());
}

export function isOurTeam(team, teamCode, aliases = []) {
  const code = teamCodeOf(team);
  if (teamCode && code === teamCode.toUpperCase()) return true;
  const t = compact(team);
  return aliases.some((a) => a && (compact(a) === t || teamCodeOf(a) === code));
}

// Names that are left out automatically: not on the roster at all, or same last name but a
// clearly different first name (not a nickname). They can still be added from the "left out" list.
export const AUTO_SKIP_REASONS = new Set(['Not on your roster', 'Same last name as someone on your roster, but a different first name']);
export const autoSkipped = (p) => AUTO_SKIP_REASONS.has(p.reason);

// Groups swims into what the coach reviews.
// swims: from parseResultLines; roster: swimmers; opts: { teamCode, aliases, meetDate, bests: {swimmerId: {eventKey: cs}} }
export function buildReview(swims, roster, opts) {
  const counts = { total: swims.length, otherTeams: 0, noShows: 0 };
  const people = new Map();   // one entry per person in the results (name + age + team)

  for (const s of swims) {
    const ours = isOurTeam(s.team, opts.teamCode, opts.aliases || []);
    const unattached = !ours && isUnattached(s.team);
    if (!ours && !unattached) { counts.otherTeams++; continue; }
    if (s.status === 'ns') { counts.noShows++; continue; }
    const key = `${normalize(s.name)}|${s.age}|${unattached ? 'UN' : 'TEAM'}`;
    if (!people.has(key)) people.set(key, { key, name: s.name, age: s.age, team: s.team, unattached, swims: [] });
    people.get(key).swims.push(s);
  }

  const groups = { matched: [], needsMatch: [], unattached: [] };
  for (const p of people.values()) {
    const { last, first } = splitResultName(p.name);
    p.first = first;
    p.last = last;
    const sameLast = roster.filter((sw) => !sw.archived && compact(sw.last_name) === compact(last));
    const candidates = sameLast.map((sw) => {
      const ages = agesFor(sw.birth_year, opts.meetDate);
      return {
        swimmer: sw,
        first: firstNameMatch(first, sw),
        ageOk: ages ? ages.includes(p.age) : null,   // null = no birth year on file
      };
    });
    const exact = candidates.filter((c) => c.first === 'exact' && c.ageOk !== false);
    const similar = candidates.filter((c) => c.first === 'similar' && c.ageOk !== false);

    p.candidates = candidates;
    p.suggestion = null;
    p.reason = null;
    if (exact.length === 1) {
      p.swimmerId = exact[0].swimmer.id;
      p.confidence = 'exact';
    } else if (exact.length > 1) {
      p.swimmerId = null;
      p.reason = 'More than one swimmer on your roster has this name';
    } else if (similar.length === 1) {
      p.swimmerId = null;
      p.suggestion = similar[0].swimmer.id;
      p.reason = `Listed as “${first}” — is this ${similar[0].swimmer.first_name} ${similar[0].swimmer.last_name}?`;
    } else if (candidates.some((c) => c.first === 'exact' && c.ageOk === false)) {
      p.swimmerId = null;
      const c = candidates.find((x) => x.first === 'exact' && x.ageOk === false);
      p.suggestion = c.swimmer.id;
      p.reason = `Age ${p.age} doesn't fit ${c.swimmer.first_name}'s birth year (${c.swimmer.birth_year}) — check before matching`;
    } else if (sameLast.length) {
      p.swimmerId = null;
      p.reason = 'Same last name as someone on your roster, but a different first name';
    } else {
      p.swimmerId = null;
      p.reason = 'Not on your roster';
    }

    // Flags on individual swims
    for (const s of p.swims) {
      s.flags = [];
      if (s.status === 'dq') s.flags.push('Disqualified' + (s.dqReason ? `: ${s.dqReason}` : ''));
      const best = p.swimmerId && opts.bests && opts.bests[p.swimmerId]
        ? opts.bests[p.swimmerId][`${s.distance}-${s.stroke}`] : null;
      if (best && s.timeCs && s.status === 'ok') {
        const ratio = s.timeCs / best;
        if (ratio < 0.96) s.flags.push(`Much faster than best (${(100 - ratio * 100).toFixed(1)}%) — check the time`);
        else if (ratio > 1.12) s.flags.push(`Much slower than best (+${(ratio * 100 - 100).toFixed(1)}%)`);
      }
    }

    const swimmer = p.swimmerId ? roster.find((sw) => sw.id === p.swimmerId) : null;
    if (p.unattached) {
      if (swimmer && swimmer.usually_unattached) groups.matched.push(p);
      else groups.unattached.push(p);
    } else if (p.swimmerId) {
      groups.matched.push(p);
    } else {
      groups.needsMatch.push(p);
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  groups.matched.sort(byName); groups.needsMatch.sort(byName); groups.unattached.sort(byName);
  return { counts, groups };
}
