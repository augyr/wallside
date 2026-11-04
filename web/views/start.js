// Sign-in, first-time name, role choice, and joining with an invite code.
import { db, state, go, homePath, loadRoles, topBar } from '../app.js';
import { h, mount, must, toast, busy, field } from '../ui.js';
import { APP_NAME } from '../config.js';

export function renderLogin() {
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'you@email.com' });
  const pending = localStorage.getItem('wallside.pendingCode');

  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    await busy(button, async () => {
      const { error } = await db.auth.signInWithOtp({
        email: email.value.trim(),
        options: { emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
      renderCheckEmail(email.value.trim());
    });
  } },
    field('Email', email),
    h('button', { type: 'submit', class: 'btn primary' }, 'Email me a sign-in link'));

  mount(h('main', { class: 'page hero' },
    h('div', { class: 'hero-top' },
      h('h1', { class: 'display' }, APP_NAME),
      h('p', { class: 'lead' }, 'Practice notes, meet times and progress — one place for coach, swimmer and family.')),
    h('section', { class: 'card' },
      pending ? h('p', { class: 'notice' }, `Invite code ${pending} saved. Sign in to continue.`) : null,
      h('p', { class: 'muted' }, 'No password needed. We\'ll email you a link and a 6-digit code.'),
      form)));
}

function renderCheckEmail(address) {
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 10, placeholder: '123456', class: 'code-input' });
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    await busy(button, async () => {
      const { error } = await db.auth.verifyOtp({ email: address, token: code.value.trim(), type: 'email' });
      if (error) throw error;
    });
  } },
    field('Or type the code from the email', code),
    h('button', { type: 'submit', class: 'btn primary' }, 'Sign in'));

  mount(h('main', { class: 'page' },
    h('h1', {}, 'Check your email'),
    h('section', { class: 'card stack' },
      h('p', {}, 'We sent a sign-in link to ', h('strong', {}, address), '. Tap it on this device, or enter the code below.'),
      form,
      h('button', { type: 'button', class: 'btn ghost', onClick: renderLogin }, 'Use a different email'))));
}

export function renderName() {
  const name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: 120, placeholder: 'First and last name' });
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      must(await db.from('profiles').update({ full_name: name.value.trim() }).eq('id', state.user.id));
      go('/');
    });
  } },
    field('Your name', name, 'Your coach and team see this name.'),
    h('button', { type: 'submit', class: 'btn primary' }, 'Continue'));

  mount(h('main', { class: 'page' },
    h('h1', {}, 'Welcome'),
    h('section', { class: 'card' }, form)));
}

export function renderWelcome() {
  mount(topBar(),
    h('main', { class: 'page' },
      h('h1', {}, 'How will you use ' + APP_NAME + '?'),
      h('div', { class: 'stack' },
        h('a', { class: 'choice', href: '#/coach/setup' },
          h('strong', {}, "I'm a coach"),
          h('span', { class: 'muted' }, 'Set up your team, groups and swimmers.')),
        h('a', { class: 'choice', href: '#/join' },
          h('strong', {}, "I'm a parent or swimmer"),
          h('span', { class: 'muted' }, 'Enter the invite code from your coach.')))));
}

export function renderJoin(prefill) {
  const code = h('input', { type: 'text', autocomplete: 'off', class: 'code-input', placeholder: 'MAYA-7K2Q',
    value: (prefill || localStorage.getItem('wallside.pendingCode') || '').toUpperCase() });

  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      const rows = must(await db.rpc('preview_invite', { p_code: code.value.trim() }));
      if (!rows || !rows.length) {
        localStorage.removeItem('wallside.pendingCode');
        throw new Error("That code isn't valid. Check it, or ask your coach to resend it.");
      }
      renderConfirm(code.value.trim().toUpperCase(), rows[0]);
    });
  } },
    field('Invite code', code, 'Your coach sent a private code by email or text. It links you to your swimmer only.'),
    h('button', { type: 'submit', class: 'btn primary' }, 'Find my swimmer'));

  mount(topBar(),
    h('main', { class: 'page' },
      h('h1', {}, 'Enter your invite code'),
      h('section', { class: 'card' }, form),
      state.coachTeams.length || state.family.length
        ? h('a', { href: '#' + homePath(), class: 'back' }, '← Back') : null));
}

function renderConfirm(code, invite) {
  const isSwimmerCode = invite.kind === 'swimmer';
  const relationship = h('select', {},
    h('option', { value: 'parent' }, 'Parent'),
    h('option', { value: 'guardian' }, 'Guardian'),
    h('option', { value: 'other' }, 'Other family member'));

  const yes = h('button', { type: 'button', class: 'btn primary', onClick: async () => {
    await busy(yes, async () => {
      must(await db.rpc('claim_invite', { p_code: code, p_relationship: isSwimmerCode ? 'self' : relationship.value }));
      localStorage.removeItem('wallside.pendingCode');
      await loadRoles();
      toast("You're in!", 'success');
      go('/family');
    });
  } }, isSwimmerCode ? "Yes, that's me" : "Yes, that's my swimmer");

  mount(topBar(),
    h('main', { class: 'page' },
      h('h1', {}, isSwimmerCode ? 'Is this you?' : 'Is this your swimmer?'),
      h('section', { class: 'card swimmer-card' },
        h('span', { class: 'avatar lg' }, (invite.swimmer_first[0] + invite.swimmer_initial).toUpperCase()),
        h('div', {},
          h('strong', { class: 'big' }, `${invite.swimmer_first} ${invite.swimmer_initial}.`),
          h('p', { class: 'muted' }, [invite.group_name, invite.team_name].filter(Boolean).join(' · ')))),
      isSwimmerCode ? null : field('I am their…', relationship),
      h('p', { class: 'muted small' }, 'Only you, other linked family members and their coaches can see this swimmer\'s information.'),
      h('div', { class: 'stack' },
        yes,
        h('button', { type: 'button', class: 'btn ghost', onClick: () => renderJoin('') }, 'No, try another code'))));
}
