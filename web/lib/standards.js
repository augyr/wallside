// Time standards ("cuts"): which cut a time meets, and the next one up.
// The numbers live in standards-data.js, copied from the official documents (source noted per set).

import { STANDARD_SETS } from './standards-data.js';

let sets = STANDARD_SETS;
/** Replace the sets in use (the demo uses made-up sample cuts). */
export function useStandardSets(list) { sets = list || []; }
export function standardSets() { return sets; }

// The ladder, slowest to fastest. Motivational levels come first, then championship meets.
export const LADDER = ['B', 'BB', 'A', 'AA', 'AAA', 'AAAA', 'JO', 'FW', 'SECT', 'FUT', 'PSS', 'WJ', 'JN', 'USO', 'NAT', 'OT'];
const rank = (set) => {
  const i = LADDER.indexOf(set.level);
  return i < 0 ? 99 : i;
};

/** Age that standards use: age at the meet when known, otherwise a careful estimate from birth year. */
export function ageForStandards({ ageAtMeet, birthYear, on = new Date() }) {
  if (ageAtMeet) return ageAtMeet;
  if (!birthYear) return null;
  // Without a birthday, the swimmer is (year − birth year) or one less. Use the lower to avoid
  // showing a cut from an older age group.
  return new Date(on).getFullYear() - birthYear - 1;
}

function entryFor(set, gender, age) {
  return (set.entries || []).find((e) => e.gender === gender
    && (e.ageMin == null || (age != null && age >= e.ageMin))
    && (e.ageMax == null || (age != null && age <= e.ageMax)));
}

/** Every applicable cut for an event, slowest to fastest: [{ set, cs }]. */
export function cutsForEvent({ distance, stroke, course, gender, age }) {
  if (!gender || !course) return [];
  const key = `${distance}-${stroke}`;
  const out = [];
  for (const set of sets) {
    if (set.course !== course) continue;
    const e = entryFor(set, gender, age);
    if (!e || !e.times || !e.times[key]) continue;
    out.push({ set, cs: e.times[key] });
  }
  return out.sort((a, b) => b.cs - a.cs || rank(a.set) - rank(b.set));
}

/**
 * For one time: the fastest cut it meets and the next cut up.
 * Returns { met: {set, cs} | null, next: {set, cs, gap} | null, all }
 */
export function cutStatus(timeCs, event) {
  const all = cutsForEvent(event);
  if (!timeCs || !all.length) return { met: null, next: null, all };
  const metList = all.filter((c) => timeCs <= c.cs);
  const met = metList.length ? metList[metList.length - 1] : null;
  const nextC = all.find((c) => timeCs > c.cs);
  return { met, next: nextC ? { ...nextC, gap: timeCs - nextC.cs } : null, all };
}

/** Cuts newly met by a swim compared with the swimmer's earlier best (null = no earlier time). */
export function newCuts(timeCs, earlierBestCs, event) {
  const all = cutsForEvent(event);
  return all.filter((c) => timeCs <= c.cs && (!earlierBestCs || earlierBestCs > c.cs));
}

export const cutLabel = (set) => set.short || set.name;
