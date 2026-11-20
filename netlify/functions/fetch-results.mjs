// Fetches a meet results page or file for a signed-in coach, so the app can read it
// (browsers can't read other sites directly). Works with any swimming region's public
// results site. Safeguards:
//   - only signed-in Wallside coaches can use it (not families, not visitors)
//   - only public web addresses: no private, local or cloud-internal networks, checked on every redirect
//   - only web pages, text and PDFs, up to 15 MB, with a 20-second limit
//   - SwimCloud is never read (project rule)
//   - a per-coach limit on how often it can be used
// Nothing is stored here.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../web/config.js';

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20000;
const BLOCKED_HOSTS = [/(^|\.)swimcloud\.com$/i];
const OK_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/pdf|application\/octet-stream|application\/x-pdf)\b/i;
const RATE = { windowMs: 10 * 60 * 1000, max: 80 };   // per coach, per server instance

/** Parse and check the address itself (no network). Returns a URL or null. */
export function allowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.port && !['80', '443'].includes(u.port)) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !net.isIP(host)) return null;                 // "localhost", intranet names
  if (/\.(local|localhost|internal|lan|home|corp|intranet)$/i.test(host)) return null;
  if (BLOCKED_HOSTS.some((re) => re.test(host))) return null;
  if (net.isIP(host) && privateIp(host)) return null;
  u.hash = '';
  return u;
}

export function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith('64:ff9b');
}

/** The name must point only at public addresses. */
async function resolvesPublic(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return !privateIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !privateIp(a.address));
  } catch { return false; }
}

async function signedInCoach(req) {
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer \S+$/.test(auth)) return null;
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: auth };
  const user = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers });
  if (!user.ok) return null;
  const { id } = await user.json();
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return null;
  // parents can see their team's coach list, so look for this person's own coach row
  const coach = await fetch(`${SUPABASE_URL}/rest/v1/team_coaches?select=team_id&user_id=eq.${id}&limit=1`, { headers });
  if (!coach.ok) return null;
  const rows = await coach.json();
  return Array.isArray(rows) && rows.length ? id : null;
}

const uses = new Map();
function overLimit(id) {
  const now = Date.now();
  const recent = (uses.get(id) || []).filter((t) => now - t < RATE.windowMs);
  recent.push(now);
  uses.set(id, recent);
  return recent.length > RATE.max;
}

const fail = (status, message) => new Response(JSON.stringify({ error: message }), {
  status, headers: { 'content-type': 'application/json' } });

export default async function handler(req) {
  if (req.method !== 'GET') return fail(405, 'Use GET');
  const raw = new URL(req.url).searchParams.get('url') || '';
  let target = allowedUrl(raw);
  if (!target) {
    return fail(400, /swimcloud/i.test(raw)
      ? 'SwimCloud can\'t be read. Use your swimming region\'s results page or upload the PDF.'
      : 'That link can\'t be read. Use a public results page or PDF (starting with https://).');
  }
  const coachId = await signedInCoach(req);
  if (!coachId) return fail(401, 'Sign in to Wallside as a coach first.');
  if (overLimit(coachId)) return fail(429, 'Too many links read in a short time. Wait a few minutes and try again.');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let upstream;
    for (let hop = 0; ; hop++) {
      if (!(await resolvesPublic(target))) return fail(400, 'That link can\'t be read.');
      try {
        upstream = await fetch(target, { redirect: 'manual', signal: ctrl.signal,
          headers: { 'user-agent': 'Wallside results reader (for swim coaches)' } });
      } catch {
        return fail(502, 'That site didn\'t respond. Try again in a minute.');
      }
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
        if (hop >= MAX_REDIRECTS) return fail(502, 'That link redirected too many times.');
        const next = allowedUrl(new URL(upstream.headers.get('location'), target).href);
        if (!next) return fail(400, 'That link redirected somewhere that can\'t be read.');
        target = next;
        continue;
      }
      break;
    }
    if (!upstream.ok) return fail(502, `That site returned an error (${upstream.status}) for the link.`);
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    if (!OK_TYPES.test(type)) return fail(415, 'That link isn\'t a results page or PDF. If it\'s a zip file, download it and upload the PDF inside.');
    if (Number(upstream.headers.get('content-length') || 0) > MAX_BYTES) return fail(413, 'That file is too large.');

    // read with a size cap
    const reader = upstream.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { ctrl.abort(); return fail(413, 'That file is too large.'); }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { body.set(c, off); off += c.byteLength; }
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': type,
        'x-final-url': target.href,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'attachment',
      },
    });
  } catch {
    return fail(504, 'That site took too long to answer. Try again in a minute.');
  } finally {
    clearTimeout(timer);
  }
}

export const config = { path: '/api/fetch-results' };
