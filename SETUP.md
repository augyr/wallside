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
4. Then do the same with each file in `supabase/migrations/`, in number order
   (for example `002_batch1_results_analytics.sql`).

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

- **Ask Claude.** Changes are pooled into a batch, published to the preview
  site (`preview--wallside.netlify.app`) first, then to the real site once you
  approve. Netlify publishes automatically from GitHub (`augyr/wallside`):
  the `preview` branch → preview site, `main` → wallside.netlify.app.
- **Colors:** the top of `web/styles.css`.
- **App name:** `web/config.js`.
- **Database changes:** each one is a numbered file in `supabase/migrations/`.
  Run it once in the SQL Editor before the batch that needs it goes live —
  never re-run the whole `schema.sql` on a live database.
- **Tests:** `node tests/lib.test.mjs` (results reader, matching, goal
  splits). Database privacy tests are in `supabase/tests/`.

## How goal splits are calculated

For a time goal, the app suggests a split for each lap (25s in yards, 50s in
long course). The coach can override any of them.

1. **Start from the swimmer's best swim of that event.** Their own pacing
   already includes their own start, and swimmers' pacing is quite repeatable
   (Skorski et al., 2010).
2. **Take only ~10% of the time drop off the first lap** — the start is
   already close to full speed — and the rest off the later laps: half shared
   evenly, half where the swimmer faded most.
3. **Keep the first lap faster than the rest by a realistic amount** (the
   start advantage). Age-group guidance: the first 25 of a 100 is about
   1.0–1.5 s faster than the later 25s; the first 50 of a 200 about 1.5–2.0 s
   faster (SwimSwam race-strategy guidance). Elite 100 m freestyle: second 50
   about 2 s slower than the first (Robertson et al., 2009; Paris 2024 finals).
   Backstroke starts in the water, so its range is about half. If the suggestion
   falls outside the range it's adjusted — but never to a slower start than the
   swimmer's best start.
4. **No splits on file?** A typical race plan: a faster first lap by the
   middle of the range, then even laps.

## Analytics levels

Each swimmer gets **Developing** (halves only), **Age group** or **Senior**
analytics. Order of precedence: a coach override on the swimmer → the training
group's level (a group with "Senior" in its name defaults to Senior) → age at
the start of the season (10 & under Developing, 11–14 Age group, 15+ Senior).

## Meet results upload

Coach → **Results → Upload meet results**. Accepts HY-TEK result PDFs and
HY-TEK results web pages saved as a file. Only swims under the team code (e.g.
`PASA-PC` → PASA, set under **Team**) are kept; other teams are never stored.
Swims are matched on first + last name plus an age that fits the birth year —
never on last name alone. Nicknames (Teddy/Theodore) are suggested for the
coach to confirm and then remembered. Unattached (UN) swims are left out unless
the coach picks the swimmer or marks them "usually swims unattached".
Disqualifications are stored with their reason and never count as best times.
"Meter" meets must be confirmed as long course. Nothing is published until the
coach confirms, and every later fix or removal is logged.

## What's in this folder

| Path | What it is |
|---|---|
| `web/` | The app itself — this is the folder you upload |
| `web/config.js` | Your Supabase address and key |
| `web/views/start.js` | Sign-in, name, choosing coach/parent, joining with a code |
| `web/views/coach.js` | Team setup, roster, invite codes, coach tabs |
| `web/views/coach-extra.js` | Edit swimmer, team code & groups, birth years |
| `web/views/results.js` | Meet results: upload, review, publish, fix |
| `web/views/swimmer.js` | A swimmer's page (family and coach): notes, goals, best times, attendance |
| `web/views/analytics.js` | Event analytics: best / most recent / goal splits, chart, history |
| `web/views/family.js` | Parent & swimmer routes |
| `web/lib/` | Results reader, name matching, goal splits, analytics levels, time helpers |
| `web/demo.js` | The demo (made-up PASA team, nothing saved) |
| `supabase/schema.sql` | All tables and privacy rules (first install) |
| `supabase/migrations/` | Database updates, run in order |
| `supabase/tests/` | Automated checks of the privacy rules (for developers) |
| `tests/` | Automated checks of the app logic |

## Built so far vs. next

**Working now:** email sign-in (link or code) · coach team setup with groups ·
add swimmers one by one or paste a list · private invite codes (2 parents per
code) · parents join with a code and see only their swimmer · swimmer page with
coach notes (and replies), goals, best times by course, attendance count ·
parent invites a 13+ swimmer to their own login · empty states everywhere.

**Batch 1:** meet results upload (PDF and saved web results) with team-code
filter, matching, review and change log · event analytics with best / most
recent / goal splits · analytics levels · edit swimmers, nicknames, bulk birth
years · team code & group levels · demo mode.

**Next rounds:** coach note writing & feedback-coverage chart · attendance
taking (AM/PM, parent absence reports) · coach home page.
