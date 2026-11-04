// Best times from swims and approved seed times, per course and event.
// A seed only counts when it is faster than every swim on file ("from seed time").

/**
 * @param results [{distance, stroke, course, time_cs, status, meet_name, meet_date}]
 * @param seeds   [{distance, stroke, course, time_cs, meets: {name, meet_date}}]
 * @returns { 'SCY': { '100-FR': { time_cs, fromSeed, meet_name, meet_date } }, 'LCM': {...} }
 */
export function bestTimes(results, seeds = []) {
  const out = { SCY: {}, LCM: {} };
  const put = (course, key, row) => {
    if (!out[course]) return;
    const cur = out[course][key];
    // a real swim wins a tie with a seed
    if (!cur || row.time_cs < cur.time_cs || (row.time_cs === cur.time_cs && cur.fromSeed && !row.fromSeed)) out[course][key] = row;
  };
  for (const r of results || []) {
    if (r.status === 'dq' || !r.time_cs) continue;
    put(r.course, `${r.distance}-${r.stroke}`, { time_cs: r.time_cs, fromSeed: false, meet_name: r.meet_name, meet_date: r.meet_date });
  }
  for (const s of seeds || []) {
    if (!s.time_cs) continue;
    const m = s.meets || {};
    put(s.course, `${s.distance}-${s.stroke}`, { time_cs: s.time_cs, fromSeed: true, meet_name: m.name || null, meet_date: m.meet_date || null });
  }
  return out;
}

/**
 * Seeds worth saving from one meet: valid (not converted, not NT), and faster than the time swum
 * at this meet (or no time there because of a DQ).
 * swims: parsed swims with seedCs/seedConverted. Returns the swims that qualify.
 */
export function seedWorthKeeping(swim) {
  if (!swim.seedCs || swim.seedConverted) return false;
  if (swim.status === 'dq' || !swim.timeCs) return true;
  return swim.seedCs < swim.timeCs;
}
