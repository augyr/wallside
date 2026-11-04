// Fetches a Pacific Swimming results page or file for a signed-in coach, so the app can read it
// (browsers can't read other sites directly). Only pacswim.org addresses are allowed, and only
// for people signed in to Wallside. Nothing is stored here.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../web/config.js';

const ALLOWED_HOSTS = new Set(['www.pacswim.org', 'pacswim.org']);
const MAX_BYTES = 15 * 1024 * 1024;

export function allowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
  u.protocol = 'https:';
  u.hash = '';
  return u;
}

async function signedIn(req) {
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer \S+$/.test(auth)) return false;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth } });
  return res.ok;
}

const fail = (status, message) => new Response(JSON.stringify({ error: message }), {
  status, headers: { 'content-type': 'application/json' } });

export default async function handler(req) {
  if (req.method !== 'GET') return fail(405, 'Use GET');
  const target = allowedUrl(new URL(req.url).searchParams.get('url') || '');
  if (!target) return fail(400, 'Only Pacific Swimming (pacswim.org) links can be read.');
  if (!(await signedIn(req))) return fail(401, 'Sign in to Wallside first.');

  let upstream;
  try {
    upstream = await fetch(target, { redirect: 'follow', headers: { 'user-agent': 'Wallside results reader' } });
  } catch {
    return fail(502, 'Pacific Swimming didn\'t respond. Try again in a minute.');
  }
  if (!upstream.ok) return fail(502, `Pacific Swimming returned an error (${upstream.status}) for that link.`);
  if (!allowedUrl(upstream.url || target.href)) return fail(400, 'That link redirected away from Pacific Swimming.');
  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return fail(413, 'That file is too large.');
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
      'x-final-url': upstream.url || target.href,
      'cache-control': 'private, max-age=300',
    },
  });
}

export const config = { path: '/api/fetch-results' };
