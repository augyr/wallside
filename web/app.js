// Wallside — app start-up, sign-in state and page routing.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_NAME } from './config.js';
import { h, mount, must } from './ui.js';
import { renderLogin, renderName, renderWelcome, renderJoin } from './views/start.js';
import { renderCoachSetup, renderCoach } from './views/coach.js';
import { renderFamily } from './views/family.js';

const configured = !SUPABASE_URL.startsWith('PASTE_') && !SUPABASE_ANON_KEY.startsWith('PASTE_');
const realDb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// `db` is the real database, or the in-memory demo while the demo is running
export let db = realDb;

// Everything the screens need to know about the signed-in person
export const state = {
  user: null,
  profile: null,
  coachTeams: [],   // [{ team_id, role, teams: { name, team_code, team_aliases } }]
  family: [],       // [{ swimmer_id, as: 'guardian' | 'self' }]
  demo: null,       // null, or 'coach' | 'parent' | 'swimmer'
};

export function go(path) {
  if (location.hash === '#' + path) route();
  else location.hash = path;
}

export async function loadRoles() {
  const uid = state.user.id;
  const [profile, coaches, guardians, self] = await Promise.all([
    db.from('profiles').select('id, full_name').eq('id', uid).maybeSingle(),
    db.from('team_coaches').select('team_id, role, teams(name, team_code, team_aliases, results_source_url, results_checked_at)').eq('user_id', uid)
      .then((r) => (r.error && /results_/.test(r.error.message || '')
        // database update 004 not run yet: load without the automatic-results columns
        ? db.from('team_coaches').select('team_id, role, teams(name, team_code, team_aliases)').eq('user_id', uid) : r)),
    db.from('guardians').select('swimmer_id').eq('user_id', uid),
    db.from('swimmer_accounts').select('swimmer_id').eq('user_id', uid),
  ]);
  state.profile = must(profile);
  state.coachTeams = must(coaches) || [];
  state.family = [
    ...(must(guardians) || []).map((g) => ({ swimmer_id: g.swimmer_id, as: 'guardian' })),
    ...(must(self) || []).map((s) => ({ swimmer_id: s.swimmer_id, as: 'self' })),
  ];
}

export function homePath() {
  if (state.coachTeams.length) return '/coach';
  if (state.family.length) return '/family';
  return '/welcome';
}

export async function signOut() {
  if (state.demo) return exitDemo();
  await db.auth.signOut();
  state.user = null;
  go('/login');
}

// ------------------------------------------------------------------
// Demo: made-up PASA team, no sign-in, nothing saved
// ------------------------------------------------------------------
export async function startDemo(role) {
  const { createDemoClient, DEMO_STANDARDS } = await import('./demo.js');
  (await import('./lib/standards.js')).useStandardSets(DEMO_STANDARDS);
  if (!state.demo) db = createDemoClient();
  db.setRole(role);
  state.demo = role;
  state.user = db.currentUser();
  go(role === 'coach' ? '/coach' : '/family');
}

function exitDemo() {
  state.demo = null;
  state.user = null;
  db = realDb;
  location.hash = '/login';
  location.reload();
}

function demoBar() {
  if (!state.demo) return null;
  const roles = [['coach', 'Coach'], ['parent', 'Parent'], ['swimmer', 'Swimmer']];
  return h('div', { class: 'demo-bar', role: 'region', 'aria-label': 'Demo' },
    h('strong', {}, 'Demo · PASA'),
    h('span', { class: 'demo-roles' }, roles.map(([r, label]) => h('button', {
      type: 'button', class: 'chip small' + (state.demo === r ? ' on' : ''), 'aria-pressed': state.demo === r ? 'true' : 'false',
      onClick: () => startDemo(r),
    }, label))),
    h('span', { class: 'muted small' }, 'Made-up swimmers. Changes aren\'t saved.'));
}

// Header shown on signed-in screens: app name, role switch and sign-out
export function topBar(current) {
  const both = state.coachTeams.length && state.family.length && !state.demo;
  return [
    demoBar(),
    h('header', { class: 'topbar' },
      h('span', { class: 'brand' }, APP_NAME),
      h('nav', { class: 'topnav', 'aria-label': 'Account' },
        both ? h('a', { href: current === 'coach' ? '#/family' : '#/coach' },
          current === 'coach' ? 'Family view' : 'Coach view') : null,
        h('button', { type: 'button', class: 'link', onClick: signOut }, state.demo ? 'Exit demo' : 'Sign out'))),
  ];
}

// ------------------------------------------------------------------
// Routing:  #/coach[/section[/id[/sub[/key]]]]   #/family[/swimmerId[/e/eventKey]]
// ------------------------------------------------------------------
async function route() {
  const path = location.hash.replace(/^#/, '') || '/';
  const [, page, ...args] = path.split('/');

  if (page === 'demo') return renderDemoChooser();
  if (!configured && !state.demo) return renderNotConfigured();

  // Remember an invite code from a link so it survives the sign-in email round-trip
  if (page === 'join' && args[0] && !state.demo) localStorage.setItem('wallside.pendingCode', args[0].toUpperCase());

  if (!state.user) {
    if (page !== 'login') return go('/login');
    return renderLogin();
  }

  try {
    await loadRoles();
  } catch (err) {
    return mount(h('main', { class: 'page' }, h('p', {}, 'Could not load your account: ' + (err.message || err))));
  }

  if (!state.profile || !state.profile.full_name) return renderName();

  const pending = !state.demo && localStorage.getItem('wallside.pendingCode');
  if (pending && page !== 'join') return go('/join/' + pending);

  switch (page) {
    case 'login':
    case '':
    case undefined:
      return go(homePath());
    case 'welcome': return renderWelcome();
    case 'join': return renderJoin(args[0]);
    case 'coach':
      if (args[0] === 'setup') return renderCoachSetup();
      if (!state.coachTeams.length) return go(homePath());
      return renderCoach(...args);
    case 'family':
      if (!state.family.length) return go(homePath());
      return renderFamily(...args);
    default:
      return go(homePath());
  }
}

function renderDemoChooser() {
  const pick = (role, title, text) => h('button', { type: 'button', class: 'choice', onClick: () => startDemo(role) },
    h('strong', {}, title), h('span', { class: 'muted' }, text));
  mount(h('main', { class: 'page hero' },
    h('div', { class: 'hero-top' },
      h('h1', { class: 'display' }, APP_NAME),
      h('p', { class: 'lead' }, 'Demo with a made-up PASA senior group. Nothing you do here is saved.')),
    h('div', { class: 'stack' },
      pick('coach', 'See it as the coach', 'Today\'s practice, notes, results to approve, analytics.'),
      pick('parent', 'See it as a parent', 'Two swimmers, coach notes, goals and best times.'),
      pick('swimmer', 'See it as a swimmer', 'A senior swimmer\'s own page and event analytics.')),
    configured ? h('a', { href: '#/login', class: 'back' }, '← Back to sign in') : null));
}

function renderNotConfigured() {
  mount(h('main', { class: 'page' },
    h('h1', {}, APP_NAME),
    h('section', { class: 'card' },
      h('h2', {}, 'Almost there'),
      h('p', {}, 'This copy of the app isn\'t connected to a database yet. Open config.js and paste your Supabase project URL and anon key — SETUP.md walks through it.'),
      h('a', { href: '#/demo' }, 'Try the demo instead'))));
}

async function start() {
  if (configured) {
    const { data } = await db.auth.getSession();
    state.user = data.session ? data.session.user : null;
    db.auth.onAuthStateChange((event, session) => {
      if (state.demo) return;
      const was = state.user;
      state.user = session ? session.user : null;
      if (!was && state.user) go(location.hash.startsWith('#/join') ? location.hash.slice(1) : '/');
    });
  }
  window.addEventListener('hashchange', route);
  route();
}

start();
