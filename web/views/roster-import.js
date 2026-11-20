// Add a group of swimmers: paste a list or upload a spreadsheet, check the preview, add everyone.
import { db } from '../app.js';
import { h, mount, must, toast, busy, field, backLink } from '../ui.js';
import { coachChrome, coachTeam } from './coach.js';
import { ROLES, splitRows, guessColumns, buildPeople } from '../lib/roster-parse.js';

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm';
const NEW_GROUP = '__new';
const FROM_COLUMN = '__column';

export async function renderAddSwimmers() {
  const team = coachTeam();
  mount(coachChrome('roster'), h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  let roster; let groups;
  try {
    [roster, groups] = await Promise.all([
      db.from('swimmers').select('first_name, last_name, archived').eq('team_id', team.id).then(must),
      db.from('groups').select('id, name, sort').eq('team_id', team.id).order('sort').then(must),
    ]);
  } catch (err) { toast(err.message, 'error'); return; }

  // what's been read so far
  let rows = [];
  let header = false;
  let roles = [];
  let fileName = '';
  let columnsOpen = false;

  const box = h('textarea', { rows: 7, placeholder: 'Paste from a spreadsheet, team software or an email — for example:\nMaya Rivera, 2012, F\nRivera, Maya\t3/14/2012\tGirl\nOne swimmer per line. Birth year, girls/boys and group are optional.' });
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,.xls,text/csv,text/plain' });
  const preview = h('div', { class: 'stack' });

  const read = () => {
    rows = splitRows(box.value);
    ({ header, roles } = guessColumns(rows, groups.map((g) => g.name)));
    fileName = '';
    draw();
  };
  box.addEventListener('input', debounce(read, 250));
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      rows = await rowsFromFile(f);
      ({ header, roles } = guessColumns(rows, groups.map((g) => g.name)));
      fileName = f.name;
      box.value = '';
      draw();
    } catch (err) { toast(err.message || String(err), 'error'); }
  });

  // group for everyone
  const groupPick = h('select', {});
  const newGroupName = h('input', { type: 'text', maxlength: 60, placeholder: 'New group name' });
  const newGroupWrap = h('div', { hidden: true }, newGroupName);
  let userPicked = false;   // until the coach picks, follow the list (Group column if there is one)
  groupPick.addEventListener('change', () => { userPicked = true; newGroupWrap.hidden = groupPick.value !== NEW_GROUP; draw(false); });

  function fillGroupPick() {
    const keep = groupPick.value;
    const hasColumn = roles.includes('group');
    groupPick.replaceChildren(
      hasColumn ? h('option', { value: FROM_COLUMN }, 'Use the Group column') : null,
      ...groups.map((g) => h('option', { value: g.id }, g.name)),
      h('option', { value: '' }, 'No group'),
      h('option', { value: NEW_GROUP }, '+ New group…'));
    const options = [...groupPick.options].map((o) => o.value);
    groupPick.value = userPicked && options.includes(keep) ? keep : hasColumn ? FROM_COLUMN : (groups[0] ? groups[0].id : '');
    newGroupWrap.hidden = groupPick.value !== NEW_GROUP;
  }

  function draw(refill = true) {
    if (refill) fillGroupPick();
    if (!rows.length) { preview.replaceChildren(); return; }
    const people = buildPeople(rows, { header, roles, roster });
    const columnGroups = groupPick.value === FROM_COLUMN;
    const groupIdByName = Object.fromEntries(groups.map((g) => [g.name.toLowerCase(), g.id]));
    const missing = columnGroups
      ? [...new Set(people.filter((p) => p.status === 'new' && p.groupName && !groupIdByName[p.groupName.toLowerCase()]).map((p) => p.groupName))]
      : [];

    // column picker
    const sample = (i) => rows.slice(header ? 1 : 0, (header ? 1 : 0) + 3).map((r) => r[i]).filter(Boolean).join(' · ');
    const shortRole = { first: 'First', last: 'Last', full: 'Name', lastfirst: 'Last, First', birth: 'Born', age: 'Age', gender: 'Girl/boy', group: 'Group' };
    const used = roles.filter((r) => r !== 'ignore').map((r) => shortRole[r]).join(' · ') || 'nothing yet';
    const columns = h('details', { class: 'stack tight', open: columnsOpen ? true : null,
      onToggle: (e) => { columnsOpen = e.target.open; } },
      h('summary', {}, h('strong', {}, fileName ? `Columns in ${fileName}: ` : 'Columns: '), used, h('span', { class: 'muted small' }, ' — tap to change')),
      h('ul', { class: 'list' }, roles.map((role, i) => {
        const sel = h('select', { 'aria-label': `Column ${i + 1}` },
          Object.entries(ROLES).map(([v, t]) => h('option', { value: v, selected: v === role ? true : null }, t)));
        sel.addEventListener('change', () => { roles[i] = sel.value; draw(); });
        return h('li', { class: 'list-row wrap' },
          h('span', { class: 'grow small' }, h('strong', {}, header ? rows[0][i] || `Column ${i + 1}` : `Column ${i + 1}`),
            h('span', { class: 'muted block' }, sample(i) || '(empty)')),
          sel);
      })),
      h('div', { class: 'row' },
        roles.includes('first') && roles.includes('last')
          ? h('button', { type: 'button', class: 'btn small', onClick: () => {
            const a = roles.indexOf('first'); const b = roles.indexOf('last');
            roles[a] = 'last'; roles[b] = 'first'; draw();
          } }, 'Swap first and last names') : null,
        roles.includes('full') || roles.includes('lastfirst')
          ? h('button', { type: 'button', class: 'btn small', onClick: () => {
            roles = roles.map((r) => (r === 'full' ? 'lastfirst' : r === 'lastfirst' ? 'full' : r)); draw();
          } }, roles.includes('full') ? 'Names are Last, First' : 'Names are First Last') : null,
        h('label', { class: 'small row' },
          (() => { const c = h('input', { type: 'checkbox', checked: header ? true : null }); c.addEventListener('change', () => { header = c.checked; draw(); }); return c; })(),
          'First line is column titles')));

    // people
    const pick = new Map();
    const rowsOut = people.map((p) => {
      const ok = p.status === 'new';
      const box2 = h('input', { type: 'checkbox', checked: ok ? true : null, disabled: ok ? null : true, 'aria-label': `Add ${p.first} ${p.last}` });
      if (ok) pick.set(p, box2);
      box2.addEventListener('change', updateButton);
      const groupLabel = columnGroups ? p.groupName : null;
      return h('li', { class: 'list-row compact' + (ok ? '' : ' muted') },
        box2,
        h('span', { class: 'grow' },
          h('strong', {}, `${p.first || '?'} ${p.last || '?'}`),
          h('span', { class: 'small block muted' }, [
            p.birth_year ? (p.estimated ? `born ~${p.birth_year} (from age)` : `born ${p.birth_year}`) : 'no birth year',
            p.gender === 'F' ? 'girl' : p.gender === 'M' ? 'boy' : null,
            groupLabel,
          ].filter(Boolean).join(' · '))),
        ok ? null : h('span', { class: 'pill ' + (p.status === 'problem' ? 'warn' : '') }, p.note));
    });

    const add = h('button', { type: 'button', class: 'btn primary', onClick: () => busy(add, save) });
    function updateButton() {
      const n = [...pick.values()].filter((c) => c.checked).length;
      add.textContent = n ? `Add ${n} swimmer${n === 1 ? '' : 's'}` : 'Nothing to add';
      add.disabled = !n;
    }
    updateButton();

    async function save() {
      const chosen = [...pick.entries()].filter(([, c]) => c.checked).map(([p]) => p);
      if (!chosen.length) return;
      // groups
      let fixedGroup = groupPick.value;
      if (fixedGroup === NEW_GROUP) {
        const name = newGroupName.value.trim();
        if (!name) throw new Error('Name the new group first.');
        const existing = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
        if (existing) fixedGroup = existing.id;
        else {
          fixedGroup = crypto.randomUUID();
          must(await db.from('groups').insert({ id: fixedGroup, team_id: team.id, name, sort: groups.length }));
        }
      }
      const byName = { ...groupIdByName };
      if (fixedGroup === FROM_COLUMN) {
        for (const name of missing) {
          const id = crypto.randomUUID();
          must(await db.from('groups').insert({ id, team_id: team.id, name, sort: Object.keys(byName).length }));
          byName[name.toLowerCase()] = id;
        }
      }
      const records = chosen.map((p) => ({
        team_id: team.id, first_name: p.first, last_name: p.last,
        birth_year: p.birth_year, birth_year_estimated: !!(p.birth_year && p.estimated),
        group_id: fixedGroup === FROM_COLUMN ? (p.groupName ? byName[p.groupName.toLowerCase()] || null : null) : (fixedGroup || null),
        gender: p.gender,
      }));
      let res = await db.from('swimmers').insert(records);
      if (res.error && /gender/i.test(res.error.message || '')) {
        // database update 005 not run yet: add without girls/boys
        res = await db.from('swimmers').insert(records.map(({ gender, ...r }) => r));
      }
      must(res);
      toast(`${records.length} swimmer${records.length === 1 ? '' : 's'} added`, 'success');
      location.hash = '#/coach/roster';
    }

    const counts = people.reduce((m, p) => { m[p.status] = (m[p.status] || 0) + 1; return m; }, {});
    preview.replaceChildren(
      h('section', { class: 'card stack' }, columns),
      h('section', { class: 'card stack' },
        field('Put them in', groupPick), newGroupWrap,
        missing.length ? h('p', { class: 'small' }, `New group${missing.length === 1 ? '' : 's'} will be made: ${missing.join(', ')}`) : null),
      h('section', { class: 'card stack' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Check the list'),
          h('span', { class: 'pill ok' }, `${counts.new || 0} new`)),
        (counts.onRoster || counts.archived || counts.repeat || counts.problem)
          ? h('p', { class: 'muted small' }, [
            counts.onRoster ? `${counts.onRoster} already on your roster` : null,
            counts.archived ? `${counts.archived} archived` : null,
            counts.repeat ? `${counts.repeat} listed twice` : null,
            counts.problem ? `${counts.problem} need fixing in your list` : null,
          ].filter(Boolean).join(' · ') + ' — these are skipped.') : null,
        h('ul', { class: 'list' }, rowsOut),
        add));
  }

  mount(coachChrome('roster'), h('main', { class: 'page' },
    backLink('#/coach/roster', 'Roster'),
    h('h1', {}, 'Add swimmers'),
    h('section', { class: 'card stack' },
      field('Paste a list', box, 'Copy rows straight from a spreadsheet, TeamUnify/SportsEngine, or an email. Any order of columns.'),
      field('Or upload a spreadsheet', file, 'Excel (.xlsx) or CSV — e.g. a roster export from your team software.'),
      h('p', { class: 'muted small' }, 'Nothing is added until you check the list below and tap Add.')),
    preview));
  fillGroupPick();
}

async function rowsFromFile(f) {
  if (f.size > 5 * 1024 * 1024) throw new Error('That file is too large for a roster (5 MB max).');
  if (/\.xlsx?$/i.test(f.name)) {
    let XLSX;
    try { XLSX = await import(XLSX_URL); } catch { throw new Error('Couldn\'t open Excel files right now. Save it as CSV and upload that instead.'); }
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const rows = raw.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some(Boolean));
    const width = Math.max(0, ...rows.map((r) => r.length));
    return rows.map((r) => r.concat(Array(width - r.length).fill('')));
  }
  return splitRows(await f.text());
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
