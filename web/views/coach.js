// Coach screens: create a team, roster, and family invite codes.
import { db, state, go, loadRoles, topBar } from '../app.js';
import { h, mount, must, toast, busy, field, initials } from '../ui.js';
import { APP_NAME } from '../config.js';

// ------------------------------------------------------------------
// First-time team setup
// ------------------------------------------------------------------
export function renderCoachSetup() {
  const teamName = h('input', { type: 'text', required: true, maxlength: 120, placeholder: 'Riverside Aquatics' });
  const picked = new Set(['Senior', 'Age Group', 'Novice']);
  const options = ['Senior', 'Age Group', 'Novice', 'Masters'];
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Training groups' });
  const custom = h('input', { type: 'text', maxlength: 60, placeholder: 'Add another group' });

  function drawChips() {
    chips.replaceChildren(...options.map((name) => h('button', {
      type: 'button', class: 'chip' + (picked.has(name) ? ' on' : ''), 'aria-pressed': picked.has(name) ? 'true' : 'false',
      onClick: () => { picked.has(name) ? picked.delete(name) : picked.add(name); drawChips(); },
    }, name)));
  }
  drawChips();

  const addCustom = () => {
    const name = custom.value.trim();
    if (!name) return;
    if (!options.includes(name)) options.push(name);
    picked.add(name);
    custom.value = '';
    drawChips();
  };

  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button[type=submit]'), async () => {
      const groups = options.filter((o) => picked.has(o));
      if (!groups.length) throw new Error('Pick at least one training group.');
      must(await db.rpc('create_team', { team_name: teamName.value.trim(), group_names: groups }));
      await loadRoles();
      toast('Team created', 'success');
      go('/coach');
    });
  } },
    field('Team name', teamName),
    h('div', { class: 'field' },
      h('p', { class: 'label' }, 'Training groups'),
      h('p', { class: 'hint' }, 'Tap to choose. You can add more later.'),
      chips,
      h('div', { class: 'row' }, custom, h('button', { type: 'button', class: 'btn small', onClick: addCustom }, 'Add'))),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', required: true }),
      h('span', {}, "I'm a coach on this team. I'll follow my club's athlete-safety rules — every message I send in " + APP_NAME + ' also goes to the swimmer\'s parents.')),
    h('button', { type: 'submit', class: 'btn primary' }, 'Create team'));

  mount(topBar('coach'), h('main', { class: 'page' }, h('h1', {}, 'Set up your team'), h('section', { class: 'card' }, form)));
}

// ------------------------------------------------------------------
// Coach home: roster + invites
// ------------------------------------------------------------------
async function loadTeam(teamId) {
  const [groups, swimmers, guardians, accounts, invites] = await Promise.all([
    db.from('groups').select('id, name, sort').eq('team_id', teamId).order('sort'),
    db.from('swimmers').select('id, first_name, last_name, birth_year, birth_year_estimated, group_id, archived').eq('team_id', teamId).eq('archived', false).order('last_name'),
    db.from('guardians').select('swimmer_id, user_id'),
    db.from('swimmer_accounts').select('swimmer_id'),
    db.from('invites').select('code, swimmer_id, kind, uses_left, expires_at').eq('revoked', false),
  ]);
  const swimmerList = must(swimmers) || [];
  const ids = new Set(swimmerList.map((s) => s.id));
  const joined = {};
  for (const g of must(guardians) || []) if (ids.has(g.swimmer_id)) joined[g.swimmer_id] = (joined[g.swimmer_id] || 0) + 1;
  const selfJoined = {};
  for (const a of must(accounts) || []) if (ids.has(a.swimmer_id)) selfJoined[a.swimmer_id] = true;
  const codes = {};
  const swimmerCodes = {};
  for (const i of must(invites) || []) {
    if (!ids.has(i.swimmer_id) || new Date(i.expires_at) <= new Date() || i.uses_left <= 0) continue;
    if (i.kind === 'swimmer') swimmerCodes[i.swimmer_id] = i; else codes[i.swimmer_id] = i;
  }
  return { groups: must(groups) || [], swimmers: swimmerList, joined, selfJoined, codes, swimmerCodes };
}

// Who has signed in for a swimmer: the swimmer themself and/or parents
function joinStatus(s, data) {
  const parents = data.joined[s.id] || 0;
  const self = !!data.selfJoined[s.id];
  if (self && parents) return { text: `Swimmer & ${parents} parent${parents > 1 ? 's' : ''} joined`, cls: 'ok', pill: 'All set' };
  if (self) return { text: 'Swimmer joined · messages locked until a parent joins', cls: 'warn', pill: 'Swimmer joined' };
  if (parents) return { text: `${parents} parent${parents > 1 ? 's' : ''} joined`, cls: 'ok', pill: 'Parent joined' };
  return { text: 'No one has signed in yet', cls: '', pill: 'Not signed in' };
}

export function canHaveOwnLogin(s) {
  return !!s.birth_year && new Date().getFullYear() - s.birth_year >= 13;
}

export function coachTeam() {
  const membership = state.coachTeams[0];
  const t = membership.teams || {};
  return { id: membership.team_id, name: t.name || 'Your team', code: t.team_code || null,
    aliases: t.team_aliases || [], role: membership.role };
}

export function coachChrome(tab, subtitle) {
  const team = coachTeam();
  const link = (href, key, label) => h('a', { href, 'aria-current': tab === key ? 'page' : null }, label);
  return [
    ...topBar('coach'),
    h('header', { class: 'team-head' },
      h('p', { class: 'eyebrow' }, 'Coach' + (team.code ? ' · ' + team.code : '')),
      h('h1', {}, team.name),
      subtitle ? h('p', {}, subtitle) : null),
    h('nav', { class: 'tabs', 'aria-label': 'Coach sections' },
      link('#/coach', 'roster', 'Roster'),
      link('#/coach/results', 'results', 'Results'),
      link('#/coach/invites', 'invites', 'Invites'),
      link('#/coach/team', 'team', 'Team')),
  ];
}

export async function renderCoach(section = 'roster', id, sub, key) {
  const views = await import('./coach-extra.js');
  switch (section) {
    case 's':
      if (sub === 'edit') return views.renderSwimmerEdit(id);
      if (sub === 'e') return (await import('./analytics.js')).renderEvent(id, key, 'coach');
      return (await import('./swimmer.js')).renderSwimmerPage(id, 'coach');
    case 'results':
      return id ? (await import('./results.js')).renderMeet(id) : (await import('./results.js')).renderResults();
    case 'upload': return (await import('./results.js')).renderUpload();
    case 'team': return views.renderTeamSettings();
    case 'birthyears': return views.renderBirthYears();
    default: return renderRosterOrInvites(section === 'invites' ? 'invites' : 'roster');
  }
}

async function renderRosterOrInvites(tab) {
  const teamId = coachTeam().id;
  mount(coachChrome(tab), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading team…')));
  let data;
  try {
    data = await loadTeam(teamId);
  } catch (err) {
    toast(err.message || String(err), 'error');
    return;
  }
  const joinedCount = data.swimmers.filter((s) => data.joined[s.id] || data.selfJoined[s.id]).length;
  mount(coachChrome(tab,
      `${data.swimmers.length} swimmer${data.swimmers.length === 1 ? '' : 's'} on the team · ${joinedCount} signed in`),
    h('main', { class: 'page' }, tab === 'invites' ? invitesView(teamId, data) : rosterView(teamId, data)));
}

function rosterView(teamId, data) {
  const groupName = Object.fromEntries(data.groups.map((g) => [g.id, g.name]));
  const byGroup = new Map(data.groups.map((g) => [g.id, []]));
  const ungrouped = [];
  for (const s of data.swimmers) (byGroup.get(s.group_id) || ungrouped).push(s);

  const sections = data.groups.map((g) => groupSection(g.name, byGroup.get(g.id), data));
  if (ungrouped.length) sections.push(groupSection('No group', ungrouped, data));

  const missingYears = data.swimmers.filter((s) => !s.birth_year || s.birth_year_estimated).length;
  return [
    data.swimmers.length ? null : h('section', { class: 'card empty' },
      h('h3', {}, 'Add your swimmers'),
      h('p', { class: 'muted' }, 'Add swimmers one at a time, or paste a list from your team spreadsheet below. You can add notes and times before families join — it will all be waiting for them.')),
    data.swimmers.length && missingYears ? h('a', { href: '#/coach/birthyears', class: 'notice-link' },
      `${missingYears} swimmer${missingYears === 1 ? ' needs a' : 's need a'} birth year checked →`) : null,
    ...sections,
    addSwimmerCard(teamId, data.groups),
    pasteListCard(teamId, data.groups, groupName),
    addGroupCard(teamId, data.groups),
  ];
}

function groupSection(name, swimmers, data) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, name), h('span', { class: 'muted' }, `${swimmers.length}`)),
    swimmers.length
      ? h('ul', { class: 'list' }, swimmers.map((s) => h('li', {},
          h('a', { class: 'list-row row-link', href: `#/coach/s/${s.id}` },
            h('span', { class: 'avatar' }, initials(s.first_name, s.last_name)),
            h('span', { class: 'grow' },
              h('strong', {}, `${s.first_name} ${s.last_name}`),
              h('span', { class: 'muted small block' },
                s.birth_year ? `Born ${s.birth_year}${s.birth_year_estimated ? ' (estimated)' : ''}` : 'Birth year not set')),
            (() => { const st = joinStatus(s, data); return h('span', { class: 'pill ' + st.cls }, st.pill); })()))))
      : h('p', { class: 'muted' }, 'No swimmers in this group yet.'));
}

function groupSelect(groups) {
  return h('select', {}, h('option', { value: '' }, 'No group'),
    groups.map((g) => h('option', { value: g.id }, g.name)));
}

function addSwimmerCard(teamId, groups) {
  const first = h('input', { type: 'text', required: true, maxlength: 60, autocomplete: 'off' });
  const last = h('input', { type: 'text', required: true, maxlength: 60, autocomplete: 'off' });
  const year = h('input', { type: 'number', min: 1990, max: 2035, inputmode: 'numeric', placeholder: '2012' });
  const group = groupSelect(groups);
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      must(await db.from('swimmers').insert({
        team_id: teamId, first_name: first.value.trim(), last_name: last.value.trim(),
        birth_year: year.value ? Number(year.value) : null, group_id: group.value || null,
      }));
      toast(`${first.value.trim()} added`, 'success');
      renderCoach('roster');
    });
  } },
    h('div', { class: 'grid2' }, field('First name', first), field('Last name', last)),
    h('div', { class: 'grid2' }, field('Birth year', year), field('Group', group)),
    h('button', { type: 'submit', class: 'btn primary' }, 'Add swimmer'));
  return h('details', { class: 'card' }, h('summary', {}, 'Add a swimmer'), form);
}

// Paste lines like:  Maya Rivera, 2012, Senior
export function parseRosterLines(text, groupsByName) {
  const rows = [];
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const raw = line.trim();
    if (!raw) return;
    const parts = raw.split(/[,\t]/).map((p) => p.trim()).filter(Boolean);
    const nameParts = (parts[0] || '').split(/\s+/);
    if (nameParts.length < 2) { problems.push(`Line ${i + 1}: needs a first and last name`); return; }
    const yearPart = parts.find((p) => /^\d{4}$/.test(p));
    const groupPart = parts.slice(1).find((p) => !/^\d{4}$/.test(p));
    const groupId = groupPart ? groupsByName[groupPart.toLowerCase()] : null;
    if (groupPart && !groupId) problems.push(`Line ${i + 1}: no group called "${groupPart}" — added without a group`);
    rows.push({
      first_name: nameParts[0],
      last_name: nameParts.slice(1).join(' '),
      birth_year: yearPart ? Number(yearPart) : null,
      group_id: groupId || null,
    });
  });
  return { rows, problems };
}

function pasteListCard(teamId, groups) {
  const groupsByName = Object.fromEntries(groups.map((g) => [g.name.toLowerCase(), g.id]));
  const box = h('textarea', { rows: 6, placeholder: 'Maya Rivera, 2012, Senior\nLeo Kim, 2017, Novice' });
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      const { rows, problems } = parseRosterLines(box.value, groupsByName);
      if (!rows.length) throw new Error('Nothing to add. Put one swimmer per line.');
      must(await db.from('swimmers').insert(rows.map((r) => ({ ...r, team_id: teamId }))));
      toast(`${rows.length} swimmers added` + (problems.length ? ` · ${problems.length} note(s)` : ''), 'success');
      if (problems.length) alert(problems.join('\n'));
      renderCoach('roster');
    });
  } },
    field('One swimmer per line: name, birth year, group', box,
      'Copy columns straight from a spreadsheet — commas or tabs both work.'),
    h('button', { type: 'submit', class: 'btn primary' }, 'Add everyone'));
  return h('details', { class: 'card' }, h('summary', {}, 'Paste a roster list'), form);
}

function addGroupCard(teamId, groups) {
  const name = h('input', { type: 'text', required: true, maxlength: 60, placeholder: 'e.g. Masters' });
  const form = h('form', { class: 'row', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      must(await db.from('groups').insert({ team_id: teamId, name: name.value.trim(), sort: groups.length }));
      renderCoach('roster');
    });
  } }, name, h('button', { type: 'submit', class: 'btn small' }, 'Add group'));
  return h('details', { class: 'card' }, h('summary', {}, 'Add a training group'), form);
}

// ------------------------------------------------------------------
// Invites
// ------------------------------------------------------------------
function inviteLink(code) {
  return `${location.origin}${location.pathname}#/join/${code}`;
}

function inviteMessage(swimmer, code) {
  return `You're invited to follow ${swimmer.first_name}'s swimming on ${APP_NAME} — coach notes, goals, times and attendance.\n\n` +
    `Open: ${inviteLink(code)}\nOr enter code ${code}\n\nThis code is private to ${swimmer.first_name}. Up to 2 parents can use it.`;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied — paste it into an email or text', 'success');
  } catch {
    window.prompt('Copy this:', text);
  }
}

function swimmerInviteMessage(swimmer, code) {
  return `Hi ${swimmer.first_name} — here's your own ${APP_NAME} login for your swim times, goals and progress.\n\n` +
    `Open: ${inviteLink(code)}\nOr enter code ${code}\n\nThis code is just for you and works once. ` +
    `Coach notes and messages turn on once a parent or guardian joins too.`;
}

function invitesView(teamId, data) {
  const eligible = data.swimmers.filter(canHaveOwnLogin);
  const missingSwimmer = eligible.filter((s) => !data.selfJoined[s.id] && !data.swimmerCodes[s.id]).length;
  const missingParent = data.swimmers.filter((s) => !data.codes[s.id]).length;
  const noYear = data.swimmers.filter((s) => !s.birth_year).length;

  const makeSwimmerCodes = h('button', { type: 'button', class: 'btn primary', onClick: async () => {
    await busy(makeSwimmerCodes, async () => {
      const n = must(await db.rpc('create_missing_swimmer_invites', { p_team: teamId }));
      toast(`${n} swimmer codes created`, 'success');
      renderCoach('invites');
    });
  } }, `Create swimmer codes for ${missingSwimmer}`);
  const makeParentCodes = h('button', { type: 'button', class: 'btn', onClick: async () => {
    await busy(makeParentCodes, async () => {
      const n = must(await db.rpc('create_missing_invites', { p_team: teamId }));
      toast(`${n} parent codes created`, 'success');
      renderCoach('invites');
    });
  } }, `Create parent codes for ${missingParent}`);

  const unclaimedSwimmer = data.swimmers.filter((s) => data.swimmerCodes[s.id] && !data.selfJoined[s.id]);
  const unclaimedParent = data.swimmers.filter((s) => data.codes[s.id] && !data.joined[s.id]);
  const copyList = (list, key, label) => h('button', { type: 'button', class: 'btn small', onClick: () => copy(
    list.map((s) => `${s.first_name} ${s.last_name}: ${data[key][s.id].code}  ${inviteLink(data[key][s.id].code)}`).join('\n')) },
    `Copy ${list.length} ${label}`);

  return [
    h('section', { class: 'card stack' },
      h('h2', {}, 'Invite swimmers and families'),
      h('p', { class: 'muted' }, 'Swimmers 13 and older can sign in first with their own code. Coach notes and messages stay locked for a swimmer until a parent or guardian joins with the parent code. Each code only ever shows that one swimmer.'),
      noYear ? h('a', { href: '#/coach/birthyears', class: 'notice-link' }, `${noYear} swimmer${noYear === 1 ? ' has' : 's have'} no birth year — needed for a swimmer code →`) : null,
      h('div', { class: 'row' },
        missingSwimmer ? makeSwimmerCodes : null,
        missingParent ? makeParentCodes : null),
      !missingSwimmer && !missingParent ? h('p', { class: 'notice' }, 'Every swimmer has their codes.') : null,
      h('div', { class: 'row' },
        unclaimedSwimmer.length ? copyList(unclaimedSwimmer, 'swimmerCodes', 'unclaimed swimmer codes') : null,
        unclaimedParent.length ? copyList(unclaimedParent, 'codes', 'unclaimed parent codes') : null)),
    data.swimmers.length ? h('section', { class: 'card' },
      h('ul', { class: 'list' }, data.swimmers.map((s) => {
        const st = joinStatus(s, data);
        const sInv = data.swimmerCodes[s.id];
        const pInv = data.codes[s.id];
        const renew = (kind, existing) => {
          const b = h('button', { type: 'button', class: 'btn small ghost', onClick: async () => {
            if (existing && !confirm(`Replace ${s.first_name}'s ${kind === 'swimmer' ? 'swimmer' : 'parent'} code? The old code will stop working.`)) return;
            await busy(b, async () => {
              must(await db.rpc('create_invite', { p_swimmer: s.id, p_kind: kind }));
              renderCoach('invites');
            });
          } }, existing ? 'New code' : 'Create code');
          return b;
        };
        const codeLine = (label, inv, kind, msg, done) => h('div', { class: 'code-line' },
          h('span', { class: 'small muted code-label' }, label),
          done ? h('span', { class: 'small ok-text' }, 'Joined')
            : inv ? h('code', { class: 'code' }, inv.code) : h('span', { class: 'small muted' }, '—'),
          !done && inv ? h('button', { type: 'button', class: 'btn small', onClick: () => copy(msg(s, inv.code)) }, 'Copy') : null,
          !done ? renew(kind, inv) : null);
        return h('li', { class: 'stack tight' },
          h('div', {},
            h('strong', {}, `${s.first_name} ${s.last_name}`),
            h('span', { class: 'block small ' + (st.cls === 'ok' ? 'ok-text' : st.cls === 'warn' ? 'warn-text' : 'muted') }, st.text)),
          canHaveOwnLogin(s)
            ? codeLine('Swimmer', sInv, 'swimmer', swimmerInviteMessage, data.selfJoined[s.id])
            : h('p', { class: 'small muted' }, s.birth_year ? 'Under 13 — uses a parent\'s account' : 'Add a birth year to create a swimmer code'),
          codeLine('Parent', pInv, 'guardian', inviteMessage, false));
      }))) : h('section', { class: 'card empty' }, h('p', { class: 'muted' }, 'Add swimmers on the Roster tab first.')),
  ];
}
