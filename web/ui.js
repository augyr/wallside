// Small helpers for building the screens safely (text is never treated as HTML).

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'value') {
      el.value = value;
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(...children) {
  const root = document.getElementById('app');
  root.replaceChildren();
  append(root, children);
  window.scrollTo(0, 0);
}

let toastTimer;
export function toast(message, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.className = 'toast show ' + kind;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// Run an async action with the button disabled; show errors as a toast.
export async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    return await fn();
  } catch (err) {
    toast(friendlyError(err), 'error');
    return undefined;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

export function friendlyError(err) {
  const msg = (err && (err.message || err.error_description)) || String(err);
  if (/row-level security/i.test(msg)) return "You don't have permission to do that.";
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'No connection. Check your internet and try again.';
  return msg;
}

// Throw if a Supabase call failed, otherwise return its data.
export function must({ data, error }) {
  if (error) throw error;
  return data;
}

export function initials(first, last) {
  return ((first || '?').charAt(0) + (last || '').charAt(0)).toUpperCase();
}

export { formatTime, formatDiff, parseTime, eventName } from './lib/time.js';

export function formatDate(isoDate) {
  if (!isoDate) return '';
  return new Date(String(isoDate).slice(0, 10) + 'T12:00:00')
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Back link at the top of a sub-page
export function backLink(href, label) {
  return h('a', { href, class: 'back' }, '← ' + label);
}

export function timeAgo(iso) {
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// An "it will show here" card for sections with no data yet
export function emptyCard(title, text, action) {
  return h('section', { class: 'card empty' },
    h('h3', {}, title),
    h('p', { class: 'muted' }, text),
    action || null);
}

export function field(labelText, input, hint) {
  const id = input.id || 'f' + Math.random().toString(36).slice(2, 8);
  input.id = id;
  return h('div', { class: 'field' },
    h('label', { for: id }, labelText),
    input,
    hint ? h('p', { class: 'hint' }, hint) : null);
}

// Run a query with newer columns, falling back to older ones if a database update hasn't run yet.
export async function withColumns(run, cols, fallback) {
  const r = await run(cols);
  if (r.error && fallback && /column|does not exist|gender/i.test(r.error.message || '')) return run(fallback);
  return r;
}
