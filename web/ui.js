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

// 5984 hundredths → "59.84"; 6788 → "1:07.88"
export function formatTime(cs) {
  if (!cs && cs !== 0) return '--.--';
  const totalSeconds = Math.floor(cs / 100);
  const hundredths = String(cs % 100).padStart(2, '0');
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, '0')}.${hundredths}`
    : `${seconds}.${hundredths}`;
}

const STROKES = { FR: 'Free', BK: 'Back', BR: 'Breast', FL: 'Fly', IM: 'IM' };
export function eventName(distance, stroke) {
  return `${distance} ${STROKES[stroke] || stroke}`;
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
