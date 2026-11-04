# Wallside

Practice notes, meet times and progress — one place for coach, swimmer and family.

- **Live site:** https://wallside.netlify.app
- **App code:** `web/` (plain HTML/JS, no build step). Netlify publishes this folder automatically on every push to `main`.
- **Database:** Supabase. Tables and privacy rules are in `supabase/schema.sql`. Changes to a live database go in new files under `supabase/migrations/` and are run in the Supabase SQL Editor.
- **Setup from scratch:** see `SETUP.md`.
