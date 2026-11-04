// Reading results from a file or a Pacific Swimming link, the automatic results check,
// and the "Results to approve" inbox.
import { db, state } from '../app.js';
import { must } from '../ui.js';
import { parseResultLines, linesFromPdfPages, linesFromText } from '../lib/results-parser.js';
import { buildReview, isOurTeam } from '../lib/matcher.js';
import { seedWorthKeeping } from '../lib/bests.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const CHECK_EVERY_MS = 12 * 3600 * 1000;
const MAX_NEW_PER_CHECK = 8;

// ------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------
function looksLikePdf(name, type, bytes) {
  if (/\.pdf($|\?)/i.test(name || '') || /pdf/i.test(type || '')) return true;
  return bytes && bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

/** { name, type, buffer: ArrayBuffer } → parsed results */
export async function readResults({ name, type, buffer }) {
  const bytes = new Uint8Array(buffer);
  if (looksLikePdf(name, type, bytes)) {
    const pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
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
  const html = new TextDecoder('utf-8').decode(bytes);
  return { ...parseResultLines(linesFromText(htmlToText(html))), source: 'html' };
}

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((el) => el.remove());
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('tr, p, div, h1, h2, h3, h4, li').forEach((el) => el.append('\n'));
  return doc.body ? doc.body.textContent : html;
}

/** Fetch a pacswim.org page or file through Wallside's helper (signed-in coaches only). */
export async function fetchViaHelper(url) {
  if (state.demo) throw new Error('Links can\'t be fetched in the demo — upload a file instead.');
  const { data } = await db.auth.getSession();
  const token = data && data.session ? data.session.access_token : null;
  if (!token) throw new Error('Sign in again, then retry.');
  let res;
  try {
    res = await fetch('/api/fetch-results?url=' + encodeURIComponent(url), { headers: { Authorization: 'Bearer ' + token } });
  } catch {
    throw new Error('No connection. Check your internet and try again.');
  }
  if (!res.ok) {
    let msg = `Couldn't read that link (${res.status}).`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return { buffer: await res.arrayBuffer(), type: res.headers.get('content-type') || '', finalUrl: res.headers.get('x-final-url') || url };
}

export async function readResultsFromUrl(url) {
  const got = await fetchViaHelper(url);
  return { ...(await readResults({ name: new URL(got.finalUrl).pathname, type: got.type, buffer: got.buffer })), url: got.finalUrl };
}

// ------------------------------------------------------------------
// Roster + best times on file (swims and approved seeds)
// ------------------------------------------------------------------
export async function loadRosterAndBests(teamId) {
  const [roster, results, seeds] = await Promise.all([
    db.from('swimmers').select('id, first_name, last_name, birth_year, birth_year_estimated, also_known_as, usually_unattached, archived')
      .eq('team_id', teamId).then(must),
    db.from('results').select('swimmer_id, distance, stroke, course, time_cs, status').eq('team_id', teamId).then(must),
    db.from('seed_times').select('swimmer_id, distance, stroke, course, time_cs').eq('team_id', teamId)
      .then((r) => (r.error ? [] : r.data || [])),
  ]);
  const bests = {};
  const put = (r) => {
    const key = `${r.distance}-${r.stroke}`;
    bests[r.course] = bests[r.course] || {};
    const byS = (bests[r.course][r.swimmer_id] = bests[r.course][r.swimmer_id] || {});
    if (!byS[key] || r.time_cs < byS[key]) byS[key] = r.time_cs;
  };
  for (const r of results || []) if (r.status !== 'dq' && r.time_cs) put(r);
  for (const s of seeds || []) if (s.time_cs) put(s);
  return { roster: (roster || []).filter((s) => !s.archived), bests };
}

/** Seeds from matched swims that would beat everything on file. */
export function seedsFor(people, bestsForCourse, getId = (p) => p.swimmerId) {
  const out = [];
  for (const p of people) {
    const id = getId(p);
    if (!id) continue;
    for (const s of p.swims) {
      if (!seedWorthKeeping(s)) continue;
      const onFile = bestsForCourse && bestsForCourse[id] ? bestsForCourse[id][`${s.distance}-${s.stroke}`] : null;
      if (onFile && onFile <= s.seedCs) continue;
      out.push({ person: p, swim: s, swimmer_id: id, distance: s.distance, stroke: s.stroke, time_cs: s.seedCs });
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Automatic review: what "Approve all" would publish
// ------------------------------------------------------------------
export function autoReview(parsed, roster, bests, team) {
  const courses = [...new Set(parsed.swims.map((s) => s.course))];
  const course = courses.length === 1 && courses[0] === 'SCY' ? 'SCY'
    : courses.length === 1 && (courses[0] === 'LCM' || courses[0] === 'M') ? 'LCM' : courses.length === 1 ? courses[0] : 'MIXED';
  const meetDate = parsed.meet.date || new Date().toISOString().slice(0, 10);
  const review = buildReview(parsed.swims, roster, {
    teamCode: team.code, aliases: team.aliases, meetDate, bests: bests[course] || {},
  });
  const { groups } = review;
  const swims = [];
  let heldSwims = 0;
  for (const p of groups.matched) {
    for (const s of p.swims) {
      if ((s.flags || []).some((f) => /^Much faster/.test(f))) { heldSwims++; continue; }
      if (s.status !== 'dq' && !s.timeCs) continue;
      swims.push({ swimmer_id: p.swimmerId, distance: s.distance, stroke: s.stroke, time_cs: s.timeCs || null,
        splits_cs: s.splits, split_len: s.splitLen, status: s.status === 'dq' ? 'dq' : 'ok', dq_reason: s.dqReason,
        place: s.place, age: s.age, name_in_results: p.name });
    }
  }
  const seeds = seedsFor(groups.matched, bests[course] || {}).map(({ swimmer_id, distance, stroke, time_cs }) => ({ swimmer_id, distance, stroke, time_cs }));
  const held = groups.needsMatch.filter((p) => p.reason !== 'Not on your roster');
  const ours = parsed.swims.filter((s) => isOurTeam(s.team, team.code, team.aliases || [])).length;
  return {
    meet: { name: parsed.meet.name || 'Meet results', meet_date: parsed.meet.date || null, course },
    swims, seeds,
    summary: {
      ours, swimmers: groups.matched.length, swims: swims.length, seeds: seeds.length,
      heldPeople: held.length, heldNames: held.slice(0, 12).map((p) => p.name), heldSwims,
      unattached: groups.unattached.length,
      notOnRoster: groups.needsMatch.length - held.length,
    },
  };
}

// ------------------------------------------------------------------
// The automatic check: looks at the team's results list for new meets with our swimmers
// ------------------------------------------------------------------
export function resultLinks(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set();
  const out = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.getAttribute('href'), baseUrl); } catch { continue; }
    u.hash = '';
    const text = (a.textContent || '').trim();
    const isDoc = /\.(htm|html|pdf)$/i.test(u.pathname);
    const saysResults = /result/i.test(u.pathname) || /result/i.test(text);
    if (!isDoc || !saysResults || seen.has(u.href)) continue;
    if (!/(^|\.)pacswim\.org$/i.test(u.hostname)) continue;
    seen.add(u.href);
    out.push({ url: u.href, text });
  }
  return out;
}

let checking = null;
/**
 * Check for new results. Resolves to { added, checked } — never throws (problems go in .error).
 * Runs at most every 12 hours unless force is set.
 */
export function runAutoCheck(team, { force = false } = {}) {
  if (checking) return checking;
  checking = (async () => {
    try {
      if (!team.sourceUrl || !team.code) return { added: 0, checked: false };
      if (!force && team.checkedAt && Date.now() - new Date(team.checkedAt).getTime() < CHECK_EVERY_MS) return { added: 0, checked: false };
      if (state.demo) return { added: 0, checked: true };

      const listing = await fetchViaHelper(team.sourceUrl);
      const html = new TextDecoder('utf-8').decode(new Uint8Array(listing.buffer));
      let links = resultLinks(html, listing.finalUrl);
      // the link may itself be a results file
      if (!links.length && /result/i.test(team.sourceUrl)) links = [{ url: team.sourceUrl, text: '' }];

      const [inbox, meets] = await Promise.all([
        db.from('results_inbox').select('source_url').eq('team_id', team.id).then(must),
        db.from('meets').select('id, name, meet_date, source_url').eq('team_id', team.id).then(must),
      ]);
      const known = new Set([...(inbox || []).map((i) => i.source_url), ...(meets || []).map((m) => m.source_url).filter(Boolean)]);
      const fresh = links.filter((l) => !known.has(l.url)).slice(0, MAX_NEW_PER_CHECK);
      if (!fresh.length) { await db.rpc('mark_results_checked', { p_team: team.id }); return { added: 0, checked: true }; }

      const { roster, bests } = await loadRosterAndBests(team.id);
      let added = 0;
      for (const link of fresh) {
        let row;
        try {
          const parsed = await readResultsFromUrl(link.url);
          const auto = autoReview(parsed, roster, bests, team);
          const base = { team_id: team.id, source_url: link.url, meet_name: auto.meet.name, meet_date: auto.meet.meet_date, course: auto.meet.course };
          const existing = (meets || []).find((m) => m.meet_date === auto.meet.meet_date
            && m.name.trim().toLowerCase() === (auto.meet.name || '').trim().toLowerCase());
          if (!auto.summary.ours) row = { ...base, status: 'not_ours' };
          else if (existing) {
            // Already uploaded by hand: only offer the seed times it didn't have
            row = auto.seeds.length
              ? { ...base, kind: 'seeds', meet_id: existing.id, payload: { seeds: auto.seeds }, summary: { seeds: auto.seeds.length } }
              : { ...base, status: 'approved', meet_id: existing.id };
          } else {
            row = { ...base, payload: { meet: auto.meet, swims: auto.swims, seeds: auto.seeds }, summary: auto.summary };
          }
        } catch (err) {
          continue;   // try this link again next time
        }
        const res = await db.from('results_inbox').insert(row);
        if (!res.error && row.status !== 'not_ours' && row.status !== 'approved') added++;
      }
      await db.rpc('mark_results_checked', { p_team: team.id });
      return { added, checked: true };
    } catch (err) {
      return { added: 0, checked: false, error: err.message || String(err) };
    } finally {
      setTimeout(() => { checking = null; }, 0);
    }
  })();
  return checking;
}

/** Approve all: publish the matched swims (and seeds), or just the seeds for an earlier upload. */
export async function approveInboxItem(item, teamId) {
  const p = item.payload || {};
  let meetId = item.meet_id;
  let swims = 0;
  if (item.kind !== 'seeds') {
    if (!['SCY', 'LCM'].includes(p.meet && p.meet.course)) {
      throw new Error('This meet needs its course confirmed — open Review to check it.');
    }
    if (!p.meet.meet_date) throw new Error('This meet has no date in the file — open Review to add it.');
    if (!(p.swims || []).length) throw new Error('No matched swims to publish — open Review.');
    meetId = must(await db.rpc('import_meet', {
      p_team: teamId, p_meet: { name: p.meet.name, meet_date: p.meet.meet_date, course: p.meet.course,
        source: /\.pdf$/i.test(item.source_url) ? 'pdf' : 'html', source_url: item.source_url },
      p_swims: p.swims, p_replace: false,
    }));
    swims = p.swims.length;
  }
  let seeds = 0;
  if ((p.seeds || []).length && meetId) seeds = must(await db.rpc('add_seed_times', { p_meet: meetId, p_seeds: p.seeds }));
  must(await db.from('results_inbox').update({ status: 'approved', meet_id: meetId, decided_by: state.user.id, decided_at: new Date().toISOString() })
    .eq('id', item.id));
  return { meetId, swims, seeds };
}

export async function dismissInboxItem(item) {
  must(await db.from('results_inbox').update({ status: 'dismissed', decided_by: state.user.id, decided_at: new Date().toISOString() }).eq('id', item.id));
}
