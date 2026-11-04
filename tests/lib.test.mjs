// Unit tests for the results reader, matching, goal splits and levels.
// Run with:  node tests/lib.test.mjs      (all names here are made up)
import assert from 'node:assert/strict';
import { parseTime, formatTime } from '../web/lib/time.js';
import { parseResultLines, linesFromText, linesFromPdfPages, parseSwimLine, lapSplits } from '../web/lib/results-parser.js';
import { buildReview, splitResultName, teamCodeOf, agesFor } from '../web/lib/matcher.js';
import { goalSplits, diveRange, halves } from '../web/lib/goalsplits.js';
import { analyticsLevel } from '../web/lib/levels.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok ', name); };

// ---------------- times ----------------
test('parse and format times', () => {
  assert.equal(parseTime('59.84'), 5984);
  assert.equal(parseTime('1:07.88'), 6788);
  assert.equal(parseTime('10:58.76'), 65876);
  assert.equal(parseTime('x1:02.03'), 6203);
  assert.equal(parseTime('1:00.50Y'), 6050);
  assert.equal(parseTime('NS'), null);
  assert.equal(formatTime(6788), '1:07.88');
  assert.equal(formatTime(5984), '59.84');
});

// ---------------- HY-TEK web results (single column, seed + finals) ----------------
const HTML_TEXT = `
Licensed to Example Swim Club                    HY-TEK's MEET MANAGER 8.0 - 9:12 PM  9/28/2026  Page 1
                 2026 EXAMPLE SC Fall Invitational - 9/27/2026 to 9/28/2026
                                     Results

Event 1  Girls 50 Yard Freestyle
===============================================================================
    Name                    Age Team                    Seed Time  Finals Time
===============================================================================
  1 Quinn, Harper R          17 PASA-PC                    23.73      24.28
  2 Bennett, Nora            16 OTHR-PC                    24.10      24.51
 -- Raman, Priya             15 PASA-PC                    25.00         NS
  3 Okafor, Mia J            15 UN-PC                      25.30      25.40
Event 2  Boys 100 Yard Breaststroke
===============================================================================
    Name                    Age Team                    Seed Time  Finals Time
===============================================================================
  1 Castillo, Owen           16 PASA-PC                  1:00.26    1:01.97
      13.62      28.93 (15.31)      45.20 (16.27)    1:01.97 (16.77)
  2 Fischer, Elijah M        15 PASA-PC                  1:02.00    1:02.50
     29.91 (29.91)   1:02.50 (32.59)
 -- Ward, Theodore           15 PASA-PC                    56.38         DQ
     Kick breaststroke type
Event 3  Mixed 200 Yard Freestyle Relay
  1 Example Club 'A'         PASA-PC                    1:40.00    1:39.00
Event 4  Women 15 & Over 200 Yard IM
  1 Holloway, Grace          18 PASA-PC                  2:13.00    2:12.10
`;

test('web results: meet, events, statuses, splits, relays skipped', () => {
  const { meet, swims, ignoredEvents } = parseResultLines(linesFromText(HTML_TEXT));
  assert.equal(meet.name, '2026 EXAMPLE SC Fall Invitational');
  assert.equal(meet.date, '2026-09-27');
  assert.equal(ignoredEvents, 1);
  assert.equal(swims.length, 8);
  const harper = swims.find((s) => s.name.startsWith('Quinn'));
  assert.equal(harper.timeCs, 2428);           // finals, not seed
  assert.equal(harper.age, 17);
  assert.equal(harper.team, 'PASA-PC');
  assert.equal(swims.find((s) => s.name.startsWith('Raman')).status, 'ns');
  const owen = swims.find((s) => s.name.startsWith('Castillo'));
  assert.deepEqual(owen.splits, [1362, 1531, 1627, 1677]);
  assert.equal(owen.splitLen, 25);
  const eli = swims.find((s) => s.name.startsWith('Fischer'));
  assert.deepEqual(eli.splits, [2991, 3259]);
  assert.equal(eli.splitLen, 50);
  const ted = swims.find((s) => s.name.startsWith('Ward'));
  assert.equal(ted.status, 'dq');
  assert.equal(ted.timeCs, null);
  assert.equal(ted.dqReason, 'Kick breaststroke type');
  const grace = swims.find((s) => s.name.startsWith('Holloway'));
  assert.equal(grace.distance, 200);
  assert.equal(grace.stroke, 'IM');
});

test('PDF style lines: place, ties, DQ with time', () => {
  assert.deepEqual(
    { ...parseSwimLine('*13 Lark, Juniper T            8 PASA-PC         25.71') },
    { place: 13, name: 'Lark, Juniper T', age: 8, team: 'PASA-PC', status: 'ok', timeCs: 2571 });
  const dq = parseSwimLine('--- Pemberton, Ada            7 PASA-PC     DQ 37.95');
  assert.equal(dq.status, 'dq');
  assert.equal(dq.timeCs, 3795);
  assert.equal(parseSwimLine('Name Age Team Finals Time'), null);
});

test('PDF: three columns are read separately', () => {
  const mk = (x, y, str) => ({ x, y, str, w: str.length * 4 });
  const page = { width: 612, items: [
    mk(150, 20, 'Example Meet - 10/16/2026'),
    mk(10, 60, '#1 Girls 50 Yard Free'), mk(214, 60, '3 Quinn, Harper'), mk(330, 60, '12 PASA-PC'), mk(380, 60, '33.10'),
    mk(10, 72, '1 Bennett, Nora'), mk(120, 72, '11 PASA-PC'), mk(170, 72, '30.00'),
    mk(418, 60, '#2 Boys 50 Yard Back'), mk(418, 72, '1 Castillo, Owen'), mk(520, 72, '12 PASA-PC'), mk(570, 72, '35.00'),
    mk(10, 84, '2 Raman, Priya'), mk(120, 84, '12 PASA-PC'), mk(170, 84, '31.00'),
  ] };
  const { meet, swims } = parseResultLines(linesFromPdfPages([page]));
  assert.equal(meet.date, '2026-10-16');
  assert.deepEqual(swims.map((s) => [s.name, s.stroke]), [
    ['Bennett, Nora', 'FR'], ['Raman, Priya', 'FR'], ['Quinn, Harper', 'FR'], ['Castillo, Owen', 'BK']]);
});

test('lap splits only when they divide the race evenly', () => {
  assert.deepEqual(lapSplits([1362, 2893, 4441], 5984, 100).splits, [1362, 1531, 1548, 1543]);
  assert.equal(lapSplits([3000], 9000, 300), null);
});

// ---------------- matching ----------------
const roster = [
  { id: 'a', first_name: 'Harper', last_name: 'Quinn', birth_year: 2009, also_known_as: [] },
  { id: 'b', first_name: 'Teddy', last_name: 'Ward', birth_year: 2011, also_known_as: [] },
  { id: 'c', first_name: 'Owen', last_name: 'Castillo', birth_year: 2010, also_known_as: [] },
  { id: 'd', first_name: 'Eli', last_name: 'Fischer', birth_year: null, also_known_as: ['Elijah'] },
  { id: 'e', first_name: 'Mia', last_name: 'Okafor', birth_year: 2011, also_known_as: [], usually_unattached: true },
  { id: 'f', first_name: 'Ava', last_name: 'Holloway', birth_year: 2008, also_known_as: [] },
];

test('names and team codes', () => {
  assert.deepEqual(splitResultName('Vance, Rowan -'), { last: 'Vance', first: 'Rowan' });
  assert.deepEqual(splitResultName('van der Berg, Elin B'), { last: 'van der Berg', first: 'Elin' });
  assert.equal(teamCodeOf('PASA-PC'), 'PASA');
  assert.deepEqual(agesFor(2009, '2026-09-27'), [16, 17]);
});

test('review: only our team, nicknames need confirming, never last name alone', () => {
  const { swims } = parseResultLines(linesFromText(HTML_TEXT));
  const { counts, groups } = buildReview(swims, roster, { teamCode: 'PASA', aliases: [], meetDate: '2026-09-27' });
  assert.equal(counts.otherTeams, 1);           // OTHR-PC skipped
  assert.equal(counts.noShows, 1);              // NS skipped
  const matchedIds = groups.matched.map((p) => p.swimmerId).sort();
  assert.deepEqual(matchedIds, ['a', 'c', 'd', 'e']);   // Elijah via "also listed as"; Mia usually unattached
  const ted = groups.needsMatch.find((p) => p.last === 'Ward');
  assert.equal(ted.swimmerId, null);
  assert.equal(ted.suggestion, 'b');            // Theodore ~ Teddy: suggested, not automatic
  const grace = groups.needsMatch.find((p) => p.last === 'Holloway');
  assert.equal(grace.swimmerId, null);          // same last name, different first name: no match
  assert.equal(grace.suggestion, null);
  const dqFlag = groups.needsMatch.find((p) => p.last === 'Ward').swims[0].flags[0];
  assert.match(dqFlag, /Disqualified: Kick breaststroke type/);
});

test('review: wrong age is not matched automatically', () => {
  const swims = [{ name: 'Quinn, Harper', age: 12, team: 'PASA-PC', status: 'ok', timeCs: 3000, distance: 50, stroke: 'FR' }];
  const { groups } = buildReview(swims, roster, { teamCode: 'PASA', meetDate: '2026-09-27' });
  assert.equal(groups.matched.length, 0);
  assert.equal(groups.needsMatch[0].suggestion, 'a');
});

test('unattached swimmers are held for the coach unless marked', () => {
  const swims = [{ name: 'Quinn, Harper', age: 17, team: 'UN-PC', status: 'ok', timeCs: 2400, distance: 50, stroke: 'FR' }];
  const { groups } = buildReview(swims, roster, { teamCode: 'PASA', meetDate: '2026-09-27' });
  assert.equal(groups.unattached.length, 1);
  assert.equal(groups.unattached[0].swimmerId, 'a');
});

// ---------------- goal splits ----------------
test('goal splits from best swim keep the dive and take more off later laps', () => {
  const g = goalSplits({ bestSplits: [1362, 1531, 1548, 1543], goalCs: 5900, laps: 4, lapLen: 25, level: 'senior', stroke: 'FR' });
  assert.equal(g.method, 'from-best');
  assert.equal(g.splits.reduce((a, b) => a + b), 5900);
  assert.ok(g.splits[0] <= 1362, 'start never slower than best start');
  assert.ok(1362 - g.splits[0] < 20, 'only a little off the start');
  assert.ok(g.splits[2] < 1548 && g.splits[3] < 1543);
  assert.ok(g.advantage >= 100 && g.advantage <= 160);
});

test('goal splits without splits on file use the research template', () => {
  const g = goalSplits({ bestSplits: null, goalCs: 5900, laps: 4, lapLen: 25, level: 'senior', stroke: 'FR' });
  assert.equal(g.method, 'template');
  assert.equal(g.splits.reduce((a, b) => a + b), 5900);
  assert.ok(Math.abs(g.splits[1] - g.splits[3]) <= 1);   // even after the start (to the hundredth)
  assert.ok(g.advantage >= 100 && g.advantage <= 150);
});

test('backstroke start advantage is smaller; one-lap races have no splits', () => {
  assert.deepEqual(diveRange(25, 'senior', 'BK'), [50, 75]);
  assert.equal(goalSplits({ bestSplits: null, goalCs: 2500, laps: 1, lapLen: 50, level: 'senior', stroke: 'FR' }), null);
  assert.deepEqual(halves([1362, 1531, 1548, 1543]), [2893, 3091]);
});

// ---------------- levels ----------------
test('analytics level: coach override, then group, then age', () => {
  const sept = new Date('2026-11-04');
  assert.equal(analyticsLevel({ analytics_level: 'developing', birth_year: 2009 }, { analytics_level: 'senior' }, sept).level, 'developing');
  assert.equal(analyticsLevel({ birth_year: 2012 }, { analytics_level: 'senior', name: 'Senior' }, sept).level, 'senior');
  assert.equal(analyticsLevel({ birth_year: 2012 }, null, sept).level, 'age_group');
  assert.equal(analyticsLevel({ birth_year: 2017 }, null, sept).level, 'developing');
  assert.equal(analyticsLevel({ birth_year: 2010 }, null, sept).level, 'senior');
  assert.equal(analyticsLevel({}, null, sept).source, 'default');
});

console.log(`\n${passed} tests passed`);
