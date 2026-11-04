# Wallside — getting it online

This takes about 20–30 minutes, once. You need two free accounts:
**Supabase** (the database and sign-in) and **Netlify** (hosts the website).
You don't need to install anything on your computer.

---

## 1. Create the database (Supabase)

1. Go to **supabase.com** → *Start your project* → sign up.
2. Click **New project**. Name it `wallside`, pick the region closest to you,
   and save the database password somewhere safe (you won't need it day to day).
3. Wait a minute or two while it sets up.

## 2. Load the Wallside tables and privacy rules

1. In your Supabase project, open **SQL Editor** (left sidebar) → **New query**.
2. Open the file `supabase/schema.sql` from this folder, copy **all** of it,
   paste it into the editor, and click **Run**.
3. You should see "Success. No rows returned."

This creates every table plus the privacy rules: families see only their own
swimmer, parents are on every coach note, notes can't be deleted, only coaches
upload results, and courses are yards (SCY) and long course (LCM) only.

## 3. Connect the app to your database

1. In Supabase, open **Project Settings → API** (on some dashboards it's
   **Project Settings → API Keys** / **Data API**).
2. Copy the **Project URL** and the **anon public** key
   (newer dashboards may call it the **publishable** key).
3. Open `web/config.js` in any text editor and paste them between the quotes:

   ```js
   export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
   ```

   This key is meant to be public — the database rules from step 2 decide
   what each signed-in person can see. **Never** paste the `service_role` /
   secret key anywhere in the app.

## 4. Put the website online (Netlify)

1. Go to **app.netlify.com** and sign up (free).
2. Go to **app.netlify.com/drop** and drag the **`web`** folder onto the page.
3. Netlify gives you an address like `https://cheerful-otter-123.netlify.app`.
   You can rename it under *Site configuration → Change site name*
   (e.g. `wallside-riverside.netlify.app`).

## 5. Tell Supabase your website's address

1. In Supabase: **Authentication → URL Configuration**.
2. Set **Site URL** to your Netlify address.
3. Under **Redirect URLs**, add the same address too.

## 6. Make sign-in emails include a 6-digit code

Parents often open email links inside their mail app, which can break the
link. A code they can type always works.

1. In Supabase: **Authentication → Emails** (or *Email Templates*) → **Magic Link**.
2. Add this line to the message body, then save:

   ```html
   <p>Or enter this code in Wallside: <strong>{{ .Token }}</strong></p>
   ```

> **Heads-up on email limits:** Supabase's built-in email sender only allows a
> small number of sign-in emails per hour — fine for testing with a few people.
> Before inviting a whole team, connect your own email sender under
> **Authentication → Emails → SMTP settings** (services like Resend or SendGrid
> have free tiers). Ask Claude to walk you through it when you get there.

## 7. Try it

1. Open your Netlify address on your phone → enter your email → sign in.
2. Choose **I'm a coach**, create your team and groups.
3. Add a few swimmers (or paste a list), then go to **Invites** →
   *Create codes* → *Copy invite*.
4. Send one invite to a second email address of yours (or a willing parent)
   and join from another phone or a private browser window.
5. On the phone: browser menu → **Add to Home Screen** to use it like an app.

---

## Making changes

- **Ask Claude.** Describe what you want ("add a reason when marking someone
  late"), get updated files, then drag the `web` folder onto your Netlify site
  again (*Deploys → drag and drop*). Changes are live in seconds.
- **Colors:** the top of `web/styles.css`.
- **App name:** `web/config.js`.
- **Database changes:** Claude will give you an SQL snippet to run in the
  SQL Editor — never re-run the whole `schema.sql` on a live database.

## What's in this folder

| Path | What it is |
|---|---|
| `web/` | The app itself — this is the folder you upload |
| `web/config.js` | Your Supabase address and key |
| `web/views/start.js` | Sign-in, name, choosing coach/parent, joining with a code |
| `web/views/coach.js` | Team setup, roster, invite codes |
| `web/views/family.js` | Parent & swimmer page: notes, goals, best times, attendance |
| `supabase/schema.sql` | All tables and privacy rules |
| `supabase/tests/` | Automated checks of the privacy rules (for developers) |

## Built so far vs. next

**Working now:** email sign-in (link or code) · coach team setup with groups ·
add swimmers one by one or paste a list · private invite codes (2 parents per
code) · parents join with a code and see only their swimmer · swimmer page with
coach notes (and replies), goals, best times by course, attendance count ·
parent invites a 13+ swimmer to their own login · empty states everywhere.

**Next rounds:** coach note writing & feedback-coverage chart · attendance
taking (AM/PM, parent absence reports) · meet results upload · coach home page.
