// Parent and swimmer routes: #/family[/swimmerId[/e/eventKey]]
import { db, state } from '../app.js';
import { must, toast } from '../ui.js';
import { renderSwimmerPage } from './swimmer.js';

export async function renderFamily(selectedId, sub, key) {
  const ids = [...new Set(state.family.map((f) => f.swimmer_id))];
  const current = ids.includes(selectedId) ? selectedId : ids[0];
  const role = state.family.find((f) => f.swimmer_id === current).as;

  if (sub === 'e' && key) {
    const { renderEvent } = await import('./analytics.js');
    return renderEvent(current, key, 'family');
  }

  let siblings = [];
  try {
    siblings = must(await db.from('swimmers').select('id, first_name').in('id', ids)) || [];
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
  return renderSwimmerPage(current, 'family', { role, siblings });
}
