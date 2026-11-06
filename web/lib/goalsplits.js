// Goal split calculation.
//
// Research basis (see SETUP.md → "How goal splits are calculated"):
// - The first lap is faster because of the start: in a 100 the first 25 is typically
//   ~1.0–1.5 s faster than the later 25s; in a 200 the first 50 ~1.5–2.0 s faster
//   than the other 50s (age-group race-strategy guidance, SwimSwam).
// - Elite 100 m freestyle: second 50 ≈ 2 s slower than the first (Robertson et al. 2009;
//   Paris 2024 finals).
// - Swimmers' own pacing is quite repeatable (Skorski et al. 2010), so a swimmer's best
//   swim is the starting point; improvement mostly comes from the later laps.

// Allowed first-lap advantage, in hundredths: average of the other laps minus the first lap
const RANGES = {
  25: { developing: [50, 200], age_group: [100, 150], senior: [100, 150] },
  50: { developing: [100, 250], age_group: [150, 200], senior: [160, 210] },
  100: { developing: [150, 350], age_group: [200, 300], senior: [200, 300] },
};

// Backstroke starts in the water, so its first-lap advantage is about half as big
export function diveRange(lapLen, level = 'age_group', stroke = 'FR') {
  const table = RANGES[lapLen] || RANGES[25];
  const [lo, hi] = table[level] || table.age_group;
  return stroke === 'BK' ? [Math.round(lo / 2), Math.round(hi / 2)] : [lo, hi];
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);

// Round to whole hundredths while keeping the exact total
function roundToTotal(values, total) {
  const r = values.map((v) => Math.round(v));
  r[r.length - 1] += total - sum(r);
  return r;
}

// Move time between the first lap and the rest so the first-lap advantage equals adv
function withAdvantage(splits, adv) {
  const n = splits.length;
  const total = sum(splits);
  const first = (total - adv * (n - 1)) / n;
  const restTotal = total - first;
  const restSum = sum(splits.slice(1));
  return [first, ...splits.slice(1).map((s) => (s / restSum) * restTotal)];
}

/**
 * @param {object} p
 * @param {number[]|null} p.bestSplits   per-lap splits of the best swim (same lap length), or null
 * @param {number}        p.goalCs       goal time in hundredths
 * @param {number}        p.laps         number of laps
 * @param {number}        p.lapLen       25 or 50
 * @param {string}        p.level        'developing' | 'age_group' | 'senior'
 * @param {string}        p.stroke       'FR' | 'BK' | 'BR' | 'FL' | 'IM'
 * @returns {{ splits:number[], method:'from-best'|'template', adjusted:boolean, range:number[], advantage:number } | null}
 */
export function goalSplits({ bestSplits, goalCs, laps, lapLen, level, stroke }) {
  if (!goalCs || !laps || laps < 2) return null;
  const range = diveRange(lapLen, level, stroke);

  if (bestSplits && bestSplits.length === laps && bestSplits.every((x) => x > 0)) {
    const bestTotal = sum(bestSplits);
    const drop = bestTotal - goalCs;
    let splits;
    if (drop <= 0) {
      // Goal is at or slower than the best: keep the same pacing, scaled
      splits = bestSplits.map((s) => (s / bestTotal) * goalCs);
    } else {
      // A little off the start (already near max effort), the rest off the later laps:
      // half shared evenly, half where the swimmer faded most.
      const firstDrop = drop * 0.1;
      const restDrop = drop - firstDrop;
      const rest = bestSplits.slice(1);
      const minRest = Math.min(...rest);
      const fade = rest.map((s) => s - minRest);
      const fadeTotal = sum(fade);
      const shares = rest.map((_, i) =>
        restDrop / 2 / rest.length + (fadeTotal > 0 ? (restDrop / 2) * (fade[i] / fadeTotal) : restDrop / 2 / rest.length));
      splits = [bestSplits[0] - firstDrop, ...rest.map((s, i) => s - shares[i])];
    }

    let adjusted = false;
    const adv = mean(splits.slice(1)) - splits[0];
    if (adv < range[0] || adv > range[1]) {
      const target = Math.min(Math.max(adv, range[0]), range[1]);
      let moved = withAdvantage(splits, target);
      // Never ask for a slower start than the swimmer's best start
      if (moved[0] > bestSplits[0]) moved = withAdvantage(splits, mean(splits.slice(1)) - bestSplits[0]);
      if (Math.abs(moved[0] - splits[0]) >= 1) { splits = moved; adjusted = true; }
    }
    const rounded = roundToTotal(splits, goalCs);
    return { splits: rounded, method: 'from-best', adjusted, range, advantage: Math.round(mean(rounded.slice(1)) - rounded[0]) };
  }

  // No splits on file: start fast by the middle of the range, then hold even laps
  const adv = (range[0] + range[1]) / 2;
  const first = (goalCs - adv * (laps - 1)) / laps;
  const restEach = (goalCs - first) / (laps - 1);
  const rounded = roundToTotal([first, ...Array(laps - 1).fill(restEach)], goalCs);
  return { splits: rounded, method: 'template', adjusted: false, range, advantage: Math.round(adv) };
}

// Combine per-lap splits into halves (used for the Developing level)
export function halves(splits) {
  if (!splits || splits.length < 2 || splits.length % 2) return null;
  const h = splits.length / 2;
  return [sum(splits.slice(0, h)), sum(splits.slice(h))];
}
