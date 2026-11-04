// Coach screens: edit a swimmer, team settings (team code, groups), bulk birth years.
import { db, loadRoles } from '../app.js';
import { h, mount, must, toast, busy, field, backLink } from '../ui.js';
import { coachChrome, coachTeam } from './coach.js';
import { LEVELS, LEVEL_LABEL, analyticsLevel } from '../lib/levels.js';

function levelSelect(current, autoLabel) {
  return h('select', {},
    h('option', { value: '' }, autoLabel),
    LEVELS.map((l) => h('option', { value: l, selected: current === l ? true : null }, LEVEL_LABEL[l])));
}

// ------------------------------------------------------------------
// Edit one swimmer
// ------------------------------------------------------------------
export async function renderSwimmerEdit(id) {
  const team = coachTeam();
  mount(coachChrome('roster'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  let s; let groups;
  try {
    [s, groups] = await Promise.all([
      db.from('swimmers').select('*, groups(name, analytics_level)').eq('id', id).maybeSingle().then(must),
      db.from('groups').select('id, name, analytics_level').eq('team_id', team.id).order('sort').then(must),
    ]);
  } catch (err) { toast(err.message, 'error'); return; }
  if (!s) { toast('Swimmer not found', 'error'); return; }

  const first = h('input', { type: 'text', required: true, maxlength: 60, value: s.first_name });
  const last = h('input', { type: 'text', required: true, maxlength: 60, value: s.last_name });
  const year = h('input', { type: 'number', min: 1990, max: 2035, inputmode: 'numeric', value: s.birth_year || '' });
  const estimated = h('input', { type: 'checkbox', checked: s.birth_year_estimated ? true : null });
  const group = h('select', {}, h('option', { value: '' }, 'No group'),
    (groups || []).map((g) => h('option', { value: g.id, selected: g.id === s.group_id ? true : null }, g.name)));
  const aka = h('input', { type: 'text', maxlength: 200, value: (s.also_known_as || []).join(', '), placeholder: 'e.g. Theodore, Ted' });
  const unattached = h('input', { type: 'checkbox', checked: s.usually_unattached ? true : null });
  const auto = analyticsLevel({ birth_year: s.birth_year }, s.groups);
  const level = levelSelect(s.analytics_level, `Automatic (${LEVEL_LABEL[auto.level]})`);

  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button[type=submit]'), async () => {
      must(await db.from('swimmers').update({
        first_name: first.value.trim(), last_name: last.value.trim(),
        birth_year: year.value ? Number(year.value) : null,
        birth_year_estimated: year.value ? estimated.checked : false,
        group_id: group.value || null,
        also_known_as: aka.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8),
        usually_unattached: unattached.checked,
        analytics_level: level.value || null,
      }).eq('id', s.id));
      toast('Saved', 'success');
      location.hash = `/coach/s/${s.id}`;
    });
  } },
    h('div', { class: 'grid2' }, field('First name', first), field('Last name', last)),
    h('div', { class: 'grid2' }, field('Birth year', year), field('Group', group)),
    h('label', { class: 'check' }, estimated, h('span', {}, 'Birth year is an estimate (e.g. worked out from a meet age)')),
    field('Also listed in results as', aka, 'Other first names this swimmer appears under in meet results, separated by commas. Used to match results automatically.'),
    h('label', { class: 'check' }, unattached, h('span', {}, 'Usually swims unattached (UN) — include their unattached swims automatically')),
    field('Analytics level', level, 'Automatic follows the training group, or age if they have no group.'),
    h('button', { type: 'submit', class: 'btn primary' }, 'Save'));

  const archive = h('button', { type: 'button', class: 'btn ghost danger', onClick: async () => {
    if (!confirm(`Archive ${s.first_name}? They'll be hidden from the roster. Their results and notes are kept.`)) return;
    await busy(archive, async () => {
      must(await db.from('swimmers').update({ archived: true }).eq('id', s.id));
      toast(`${s.first_name} archived`, 'success');
      location.hash = '/coach';
    });
  } }, 'Archive swimmer');

  mount(coachChrome('roster'), h('main', { class: 'page' },
    backLink(`#/coach/s/${s.id}`, `${s.first_name}'s page`),
    h('h1', {}, `Edit ${s.first_name} ${s.last_name}`),
    h('section', { class: 'card' }, form),
    h('section', { class: 'card' }, h('h2', {}, 'Leaving the team?'),
      h('p', { class: 'muted' }, 'Archiving hides a swimmer from the roster and uploads without deleting their history.'), archive)));
}

// ------------------------------------------------------------------
// Team settings: code, aliases, group analytics levels
// ------------------------------------------------------------------
export async function renderTeamSettings() {
  const team = coachTeam();
  mount(coachChrome('team'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  let groups;
  try { groups = must(await db.from('groups').select('id, name, analytics_level, sort').eq('team_id', team.id).order('sort')); }
  catch (err) { toast(err.message, 'error'); return; }

  mount(coachChrome('team'), h('main', { class: 'page' },
    teamCodeCard(team, () => renderTeamSettings()),
    h('section', { class: 'card stack' },
      h('h2', {}, 'Training groups'),
      h('p', { class: 'muted' }, 'Each group\'s analytics level. Automatic uses each swimmer\'s age (10 & under Developing, 11–14 Age group, 15+ Senior).'),
      h('ul', { class: 'list' }, (groups || []).map((g) => {
        const sel = levelSelect(g.analytics_level, 'Automatic (by age)');
        sel.setAttribute('aria-label', `${g.name} analytics level`);
        sel.addEventListener('change', async () => {
          try {
            must(await db.from('groups').update({ analytics_level: sel.value || null }).eq('id', g.id));
            toast(`${g.name}: ${sel.value ? LEVEL_LABEL[sel.value] : 'Automatic'}`, 'success');
          } catch (err) { toast(err.message, 'error'); }
        });
        return h('li', { class: 'list-row wrap' }, h('strong', { class: 'grow' }, g.name), sel);
      }))),
    h('section', { class: 'card stack' },
      h('h2', {}, 'Birth years'),
      h('p', { class: 'muted' }, 'Check or fill in birth years for the whole roster on one screen.'),
      h('a', { href: '#/coach/birthyears', class: 'btn' }, 'Edit birth years'))));
}

// Also used by the upload screen when a team has no code yet
export function teamCodeCard(team, onSaved) {
  const suggested = team.code || team.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  const code = h('input', { type: 'text', required: true, maxlength: 8, value: suggested, class: 'code-input', autocomplete: 'off' });
  const aliases = h('textarea', { rows: 3, placeholder: 'e.g. Palo Alto Stanford Aquatics' }, (team.aliases || []).join('\n'));
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      const value = code.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{2,8}$/.test(value)) throw new Error('Team code is 2–8 letters or numbers, like PASA.');
      must(await db.from('teams').update({
        team_code: value,
        team_aliases: aliases.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 10),
      }).eq('id', team.id));
      await loadRoles();
      toast('Team code saved', 'success');
      if (onSaved) onSaved();
    });
  } },
    field('Team code in meet results', code, 'Results list teams like "PASA-PC". Only swims with this code are imported.'),
    field('Other names your team appears under (optional)', aliases, 'One per line — for meets that print the full team name instead of the code.'),
    h('button', { type: 'submit', class: 'btn primary' }, 'Save team code'));
  return h('section', { class: 'card' }, h('h2', {}, 'Team code'), form);
}

// ------------------------------------------------------------------
// Bulk birth years
// ------------------------------------------------------------------
export async function renderBirthYears() {
  const team = coachTeam();
  mount(coachChrome('roster'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  let swimmers;
  try {
    swimmers = must(await db.from('swimmers').select('id, first_name, last_name, birth_year, birth_year_estimated')
      .eq('team_id', team.id).eq('archived', false).order('last_name'));
  } catch (err) { toast(err.message, 'error'); return; }

  const rows = swimmers.map((s) => ({
    s,
    year: h('input', { type: 'number', min: 1990, max: 2035, inputmode: 'numeric', value: s.birth_year || '',
      'aria-label': `${s.first_name} ${s.last_name} birth year` }),
    est: h('input', { type: 'checkbox', checked: s.birth_year_estimated ? true : null,
      'aria-label': `${s.first_name}'s birth year is estimated` }),
  }));

  const save = h('button', { type: 'button', class: 'btn primary', onClick: async () => {
    await busy(save, async () => {
      const changed = rows.filter(({ s, year, est }) =>
        (year.value ? Number(year.value) : null) !== (s.birth_year || null) || est.checked !== !!s.birth_year_estimated);
      for (const { s, year, est } of changed) {
        must(await db.from('swimmers').update({
          birth_year: year.value ? Number(year.value) : null,
          birth_year_estimated: year.value ? est.checked : false,
        }).eq('id', s.id));
      }
      toast(changed.length ? `${changed.length} updated` : 'No changes', 'success');
      location.hash = '/coach';
    });
  } }, 'Save birth years');

  const sorted = [...rows].sort((a, b) => (!!a.s.birth_year && !a.s.birth_year_estimated) - (!!b.s.birth_year && !b.s.birth_year_estimated));
  mount(coachChrome('roster'), h('main', { class: 'page' },
    backLink('#/coach', 'Roster'),
    h('h1', {}, 'Birth years'),
    h('p', { class: 'muted' }, 'Missing and estimated years are listed first. Untick "estimated" once a year is confirmed.'),
    h('section', { class: 'card' },
      h('div', { class: 'year-grid' },
        h('span', { class: 'small muted' }, 'Swimmer'), h('span', { class: 'small muted' }, 'Birth year'), h('span', { class: 'small muted' }, 'Est.'),
        sorted.map(({ s, year, est }) => [
          h('span', { class: 'year-name' }, `${s.first_name} ${s.last_name}`), year, est,
        ]))),
    save));
}
