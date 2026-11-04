// Wallside — app start-up, sign-in state and page routing.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_NAME } from './config.js';
import { h, mount, must } from './ui.js';
import { renderLogin, renderName, renderWelcome, renderJoin } from './views/start.js';
import { renderCoachSetup, renderCoach } from './views/coach.js';
import { renderFamily } from './views/family.js';

const configured = !SUPABASE_URL.startsWith('PASTE_') && !SUPABASE_ANON_KEY.startsWith('PASTE_');

export const db = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Everything the screens need to know about the signed-in person
export const state = {
  user: null,
  profile: null,
  coachTeams: [],   // [{ team_id, role, teams: { name } }]
  family: [],       // [{ swimmer_id, as: 'guardian' | 'self' }]
};

export function go(path) {
  if (location.hash === '#' + path) route();
  else location.hash = path;
}

export async function loadRoles() {
  const uid = state.user.id;
  const [profile, coaches, guardians, self] = await Promise.all([
    db.from('profiles').select('id, full_name').eq('id', uid).maybeSingle(),
    db.from('team_coaches').select('team_id, role, teams(name)').eq('user_id', uid),
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
  await db.auth.signOut();
  state.user = null;
  go('/login');
}

// Header shown on signed-in screens: app name, role switch and sign-out
export function topBar(current) {
  const both = state.coachTeams.length && state.family.length;
  return h('header', { class: 'topbar' },
    h('span', { class: 'brand' }, APP_NAME),
    h('nav', { class: 'topnav', 'aria-label': 'Account' },
      both ? h('a', { href: current === 'coach' ? '#/family' : '#/coach' },
        current === 'coach' ? 'Family view' : 'Coach view') : null,
      h('button', { type: 'button', class: 'link', onClick: signOut }, 'Sign out')));
}

async function route() {
  const path = location.hash.replace(/^#/, '') || '/';
  const [, page, arg] = path.split('/');

  if (!configured) return renderNotConfigured();

  // Remember an invite code from a link so it survives the sign-in email round-trip
  if (page === 'join' && arg) localStorage.setItem('wallside.pendingCode', arg.toUpperCase());

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

  const pending = localStorage.getItem('wallside.pendingCode');
  if (pending && page !== 'join') return go('/join/' + pending);

  switch (page) {
    case 'login':
    case '':
    case undefined:
      return go(homePath());
    case 'welcome': return renderWelcome();
    case 'join': return renderJoin(arg);
    case 'coach':
      if (arg === 'setup') return renderCoachSetup();
      if (!state.coachTeams.length) return go(homePath());
      return renderCoach(arg);
    case 'family':
      if (!state.family.length) return go(homePath());
      return renderFamily(arg);
    default:
      return go(homePath());
  }
}

function renderNotConfigured() {
  mount(h('main', { class: 'page' },
    h('h1', {}, APP_NAME),
    h('section', { class: 'card' },
      h('h2', {}, 'Almost there'),
      h('p', {}, 'This copy of the app isn\'t connected to a database yet. Open config.js and paste your Supabase project URL and anon key — SETUP.md walks through it.'))));
}

async function start() {
  if (configured) {
    const { data } = await db.auth.getSession();
    state.user = data.session ? data.session.user : null;
    db.auth.onAuthStateChange((event, session) => {
      const was = state.user;
      state.user = session ? session.user : null;
      if (!was && state.user) go(location.hash.startsWith('#/join') ? location.hash.slice(1) : '/');
    });
  }
  window.addEventListener('hashchange', route);
  route();
}

start();
