// Swim time helpers. Times are stored in hundredths of a second ("cs").

// "59.84" → 5984, "1:07.88" → 6788, "10:58.76" → 65876. Returns null if not a time.
export function parseTime(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).trim().replace(/^[xXJj*]+/, '').replace(/[A-Za-z]+$/, '');
  const m = s.match(/^(?:(\d{1,2}):)?(\d{1,2})\.(\d{1,2})$/);
  if (!m) return null;
  const minutes = m[1] ? Number(m[1]) : 0;
  const seconds = Number(m[2]);
  if (m[1] && seconds >= 60) return null;
  const hundredths = Number(m[3].padEnd(2, '0'));
  return minutes * 6000 + seconds * 100 + hundredths;
}

// 5984 → "59.84"; 6788 → "1:07.88"
export function formatTime(cs) {
  if (cs === null || cs === undefined || Number.isNaN(cs)) return '--.--';
  const rounded = Math.round(cs);
  const totalSeconds = Math.floor(rounded / 100);
  const hundredths = String(rounded % 100).padStart(2, '0');
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, '0')}.${hundredths}`
    : `${seconds}.${hundredths}`;
}

// Signed difference, e.g. -84 → "−0.84", 22 → "+0.22"
export function formatDiff(cs) {
  if (cs === null || cs === undefined || Number.isNaN(cs)) return '';
  const sign = cs > 0 ? '+' : cs < 0 ? '−' : '±';
  return sign + formatTime(Math.abs(cs));
}

export const STROKES = { FR: 'Free', BK: 'Back', BR: 'Breast', FL: 'Fly', IM: 'IM' };
export const COURSE_LABEL = { SCY: 'Short course yards', LCM: 'Long course meters' };

export function eventName(distance, stroke) {
  return `${distance} ${STROKES[stroke] || stroke}`;
}

// Events a goal or analytics page can be about, per course
export const EVENTS = {
  SCY: [[50, 'FR'], [100, 'FR'], [200, 'FR'], [500, 'FR'], [1000, 'FR'], [1650, 'FR'],
        [50, 'BK'], [100, 'BK'], [200, 'BK'], [50, 'BR'], [100, 'BR'], [200, 'BR'],
        [50, 'FL'], [100, 'FL'], [200, 'FL'], [100, 'IM'], [200, 'IM'], [400, 'IM']],
  LCM: [[50, 'FR'], [100, 'FR'], [200, 'FR'], [400, 'FR'], [800, 'FR'], [1500, 'FR'],
        [50, 'BK'], [100, 'BK'], [200, 'BK'], [50, 'BR'], [100, 'BR'], [200, 'BR'],
        [50, 'FL'], [100, 'FL'], [200, 'FL'], [200, 'IM'], [400, 'IM']],
};

// Lap length used for split analysis: 25s in a yards pool, 50s in long course
export function lapLength(course) {
  return course === 'LCM' ? 50 : 25;
}
