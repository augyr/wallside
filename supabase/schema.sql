-- =====================================================================
-- Wallside database schema (Supabase / Postgres)
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
--
-- Privacy model (enforced by the database itself, not just the app):
--   * Coaches see swimmers on their own team only.
--   * Parents see only the swimmer(s) they claimed with an invite code.
--   * Swimmers (13+, invited by a parent) see only their own data.
--   * Coach notes are visible to the swimmer AND their parents together.
--     A swimmer can never see a note unless a parent is linked.
--   * Notes cannot be deleted by anyone; they can only be marked corrected.
--   * Only coaches can upload meet results.
--   * Courses are SCY (short course yards) and LCM (long course meters) only.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text check (char_length(full_name) <= 120),
  created_at  timestamptz not null default now()
);

create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now()
);

create table public.team_coaches (
  team_id     uuid not null references public.teams(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'head' check (role in ('head', 'assistant')),
  created_at  timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  sort        int not null default 0
);

create table public.swimmers (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  group_id    uuid references public.groups(id) on delete set null,
  first_name  text not null check (char_length(first_name) between 1 and 60),
  last_name   text not null check (char_length(last_name) between 1 and 60),
  birth_year  int check (birth_year between 1990 and 2035),
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index on public.swimmers (team_id);

-- Parents / guardians linked to a swimmer (claimed with an invite code)
create table public.guardians (
  swimmer_id   uuid not null references public.swimmers(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  relationship text not null default 'parent',
  created_at   timestamptz not null default now(),
  primary key (swimmer_id, user_id)
);
create index on public.guardians (user_id);

-- A swimmer's own login (13+ only, invited by a parent)
create table public.swimmer_accounts (
  swimmer_id  uuid primary key references public.swimmers(id) on delete cascade,
  user_id     uuid not null unique references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Invite codes. 'guardian' codes are made by coaches (usable by up to 2 parents);
-- 'swimmer' codes are made by a parent for their 13+ swimmer (single use).
create table public.invites (
  code        text primary key,
  swimmer_id  uuid not null references public.swimmers(id) on delete cascade,
  kind        text not null default 'guardian' check (kind in ('guardian', 'swimmer')),
  uses_left   int not null default 2 check (uses_left >= 0),
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '90 days',
  revoked     boolean not null default false
);
create index on public.invites (swimmer_id);

create table public.invite_claims (
  code        text not null references public.invites(code) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  claimed_at  timestamptz not null default now(),
  primary key (code, user_id)
);

-- Coach notes: to one swimmer OR to a whole group (never both)
create table public.notes (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  swimmer_id  uuid references public.swimmers(id) on delete cascade,
  group_id    uuid references public.groups(id) on delete cascade,
  author_id   uuid not null references auth.users(id),
  tag         text check (tag in ('great', 'keep_working', 'new_focus')),
  focus       text check (char_length(focus) <= 80),
  body        text not null check (char_length(body) between 1 and 2000),
  correction  text check (char_length(correction) <= 2000),
  corrected_at timestamptz,
  created_at  timestamptz not null default now(),
  check ((swimmer_id is null) <> (group_id is null))
);
create index on public.notes (swimmer_id, created_at desc);
create index on public.notes (group_id, created_at desc);

create table public.note_replies (
  id          uuid primary key default gen_random_uuid(),
  note_id     uuid not null references public.notes(id) on delete cascade,
  author_id   uuid not null references auth.users(id),
  body        text not null check (char_length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);

-- Practices: up to two a day per group (AM / PM)
create table public.practices (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references public.teams(id) on delete cascade,
  group_id      uuid not null references public.groups(id) on delete cascade,
  practice_date date not null,
  session       text not null check (session in ('AM', 'PM')),
  starts_at     time,
  created_at    timestamptz not null default now(),
  unique (group_id, practice_date, session)
);

create table public.attendance (
  practice_id     uuid not null references public.practices(id) on delete cascade,
  swimmer_id      uuid not null references public.swimmers(id) on delete cascade,
  status          text not null check (status in ('here', 'late', 'out')),
  parent_reported boolean not null default false,
  reason          text check (char_length(reason) <= 200),
  updated_by      uuid not null references auth.users(id),
  updated_at      timestamptz not null default now(),
  primary key (practice_id, swimmer_id)
);

create table public.goals (
  id          uuid primary key default gen_random_uuid(),
  swimmer_id  uuid not null references public.swimmers(id) on delete cascade,
  created_by  uuid not null references auth.users(id),
  kind        text not null check (kind in ('time', 'practice', 'technique', 'other')),
  title       text not null check (char_length(title) between 1 and 160),
  course      text check (course in ('SCY', 'LCM')),
  due_label   text check (char_length(due_label) <= 60),
  status      text not null default 'active' check (status in ('active', 'done', 'dropped')),
  created_at  timestamptz not null default now()
);

create table public.goal_comments (
  id          uuid primary key default gen_random_uuid(),
  goal_id     uuid not null references public.goals(id) on delete cascade,
  author_id   uuid not null references auth.users(id),
  body        text not null check (char_length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);

-- Meet results. Coaches only. Times stored in hundredths of a second.
create table public.results (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  swimmer_id  uuid not null references public.swimmers(id) on delete cascade,
  distance    int not null check (distance in (25, 50, 100, 200, 400, 500, 800, 1000, 1500, 1650)),
  stroke      text not null check (stroke in ('FR', 'BK', 'BR', 'FL', 'IM')),
  course      text not null check (course in ('SCY', 'LCM')),
  time_cs     int not null check (time_cs > 0),
  splits_cs   int[],
  meet_name   text check (char_length(meet_name) <= 120),
  meet_date   date not null,
  uploaded_by uuid not null references auth.users(id),
  created_at  timestamptz not null default now()
);
create index on public.results (swimmer_id, course, distance, stroke);

-- ---------------------------------------------------------------------
-- Helper functions (run with owner rights so policies don't recurse)
-- ---------------------------------------------------------------------

create or replace function public.is_team_coach(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_coaches where team_id = t and user_id = auth.uid());
$$;

create or replace function public.is_head_coach(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_coaches where team_id = t and user_id = auth.uid() and role = 'head');
$$;

create or replace function public.swimmer_team(s uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select team_id from swimmers where id = s;
$$;

create or replace function public.is_guardian(s uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from guardians where swimmer_id = s and user_id = auth.uid());
$$;

create or replace function public.is_swimmer_self(s uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from swimmer_accounts where swimmer_id = s and user_id = auth.uid());
$$;

create or replace function public.has_guardian(s uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from guardians where swimmer_id = s);
$$;

-- Family = a parent of the swimmer, or the swimmer themself
create or replace function public.is_family(s uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_guardian(s) or is_swimmer_self(s);
$$;

create or replace function public.can_view_swimmer(s uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_team_coach(swimmer_team(s)) or is_family(s);
$$;

-- Teams the current user belongs to in any role
create or replace function public.my_team_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select team_id from team_coaches where user_id = auth.uid()
  union
  select sw.team_id from swimmers sw join guardians g on g.swimmer_id = sw.id where g.user_id = auth.uid()
  union
  select sw.team_id from swimmers sw join swimmer_accounts a on a.swimmer_id = sw.id where a.user_id = auth.uid();
$$;

-- Groups the current user's family swimmers are in
create or replace function public.my_family_group_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select sw.group_id from swimmers sw
  where sw.group_id is not null and (
    exists (select 1 from guardians g where g.swimmer_id = sw.id and g.user_id = auth.uid())
    or exists (select 1 from swimmer_accounts a where a.swimmer_id = sw.id and a.user_id = auth.uid() and has_guardian(sw.id))
  );
$$;

-- Can the current user see this profile? (yourself, or someone on a shared team)
create or replace function public.can_view_profile(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p = auth.uid() or exists (
    select 1 from my_team_ids() t
    where exists (select 1 from team_coaches c where c.team_id = t and c.user_id = p)
       or (is_team_coach(t) and (
            exists (select 1 from guardians g join swimmers s on s.id = g.swimmer_id where s.team_id = t and g.user_id = p)
         or exists (select 1 from swimmer_accounts a join swimmers s on s.id = a.swimmer_id where s.team_id = t and a.user_id = p)))
  );
$$;

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------

alter table public.profiles         enable row level security;
alter table public.teams            enable row level security;
alter table public.team_coaches     enable row level security;
alter table public.groups           enable row level security;
alter table public.swimmers         enable row level security;
alter table public.guardians        enable row level security;
alter table public.swimmer_accounts enable row level security;
alter table public.invites          enable row level security;
alter table public.invite_claims    enable row level security;
alter table public.notes            enable row level security;
alter table public.note_replies     enable row level security;
alter table public.practices        enable row level security;
alter table public.attendance       enable row level security;
alter table public.goals            enable row level security;
alter table public.goal_comments    enable row level security;
alter table public.results          enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated using (can_view_profile(id));
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- teams (created through create_team(); head coach can rename)
create policy teams_select on public.teams for select to authenticated using (id in (select my_team_ids()));
create policy teams_update on public.teams for update to authenticated using (is_head_coach(id)) with check (is_head_coach(id));

-- team_coaches
create policy coaches_select on public.team_coaches for select to authenticated using (team_id in (select my_team_ids()));
create policy coaches_insert on public.team_coaches for insert to authenticated with check (is_head_coach(team_id));
create policy coaches_delete on public.team_coaches for delete to authenticated using (is_head_coach(team_id) and user_id <> auth.uid());

-- groups
create policy groups_select on public.groups for select to authenticated using (team_id in (select my_team_ids()));
create policy groups_write  on public.groups for all to authenticated using (is_team_coach(team_id)) with check (is_team_coach(team_id));

-- swimmers
create policy swimmers_select on public.swimmers for select to authenticated using (can_view_swimmer(id));
create policy swimmers_insert on public.swimmers for insert to authenticated with check (is_team_coach(team_id));
create policy swimmers_update on public.swimmers for update to authenticated using (is_team_coach(team_id)) with check (is_team_coach(team_id));
create policy swimmers_delete on public.swimmers for delete to authenticated using (is_head_coach(team_id));

-- guardians (rows created only by claim_invite())
create policy guardians_select on public.guardians for select to authenticated
  using (user_id = auth.uid() or is_team_coach(swimmer_team(swimmer_id)) or is_family(swimmer_id));
create policy guardians_delete on public.guardians for delete to authenticated
  using (user_id = auth.uid() or is_head_coach(swimmer_team(swimmer_id)));

-- swimmer_accounts (rows created only by claim_invite())
create policy swacct_select on public.swimmer_accounts for select to authenticated
  using (user_id = auth.uid() or is_team_coach(swimmer_team(swimmer_id)) or is_guardian(swimmer_id));
create policy swacct_delete on public.swimmer_accounts for delete to authenticated
  using (is_guardian(swimmer_id) or is_head_coach(swimmer_team(swimmer_id)));

-- invites: coaches see their team's codes; parents see swimmer codes they made
create policy invites_select on public.invites for select to authenticated
  using (is_team_coach(swimmer_team(swimmer_id)) or (kind = 'swimmer' and is_guardian(swimmer_id)));
create policy invites_update on public.invites for update to authenticated
  using (is_team_coach(swimmer_team(swimmer_id))) with check (is_team_coach(swimmer_team(swimmer_id)));

create policy claims_select on public.invite_claims for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from invites i where i.code = invite_claims.code and is_team_coach(swimmer_team(i.swimmer_id))));

-- notes: coaches write; family sees their swimmer's notes only once a parent is linked
create policy notes_select on public.notes for select to authenticated using (
  is_team_coach(team_id)
  or (swimmer_id is not null and has_guardian(swimmer_id) and is_family(swimmer_id))
  or (group_id is not null and group_id in (select my_family_group_ids()))
);
create policy notes_insert on public.notes for insert to authenticated with check (
  is_team_coach(team_id)
  and author_id = auth.uid()
  and correction is null and corrected_at is null
  and (swimmer_id is null or swimmer_team(swimmer_id) = team_id)
  and (group_id is null or exists (select 1 from groups gr where gr.id = group_id and gr.team_id = notes.team_id))
);
-- no update or delete policy: notes are permanent (use correct_note())

create policy replies_select on public.note_replies for select to authenticated
  using (exists (select 1 from notes n where n.id = note_id));  -- inherits note visibility
create policy replies_insert on public.note_replies for insert to authenticated with check (
  author_id = auth.uid() and exists (
    select 1 from notes n where n.id = note_id and (
      is_team_coach(n.team_id)
      or (n.swimmer_id is not null and has_guardian(n.swimmer_id) and is_family(n.swimmer_id))
    )
  )
);

-- practices
create policy practices_select on public.practices for select to authenticated using (
  is_team_coach(team_id) or group_id in (select my_family_group_ids())
);
create policy practices_write on public.practices for all to authenticated
  using (is_team_coach(team_id)) with check (
    is_team_coach(team_id) and exists (select 1 from groups gr where gr.id = group_id and gr.team_id = practices.team_id)
  );

-- attendance: coaches mark anything; parents may only report their own swimmer "out" ahead of time
create policy attendance_select on public.attendance for select to authenticated using (can_view_swimmer(swimmer_id));
create policy attendance_coach on public.attendance for all to authenticated
  using (is_team_coach(swimmer_team(swimmer_id)))
  with check (is_team_coach(swimmer_team(swimmer_id)) and updated_by = auth.uid()
              and exists (select 1 from practices p where p.id = practice_id and p.team_id = swimmer_team(swimmer_id)));
create policy attendance_parent_report on public.attendance for insert to authenticated
  with check (is_guardian(swimmer_id) and status = 'out' and parent_reported and updated_by = auth.uid()
              and exists (select 1 from practices p join swimmers s on s.group_id = p.group_id
                          where p.id = practice_id and s.id = swimmer_id));

-- goals: coach, parents and the swimmer can add; same people can see
create policy goals_select on public.goals for select to authenticated using (can_view_swimmer(swimmer_id));
create policy goals_insert on public.goals for insert to authenticated
  with check (can_view_swimmer(swimmer_id) and created_by = auth.uid());
create policy goals_update on public.goals for update to authenticated
  using (created_by = auth.uid() or is_team_coach(swimmer_team(swimmer_id)))
  with check (can_view_swimmer(swimmer_id));

create policy goal_comments_select on public.goal_comments for select to authenticated
  using (exists (select 1 from goals g where g.id = goal_id));
create policy goal_comments_insert on public.goal_comments for insert to authenticated
  with check (author_id = auth.uid() and exists (select 1 from goals g where g.id = goal_id and can_view_swimmer(g.swimmer_id)));

-- results: coaches only write; coach + family read
create policy results_select on public.results for select to authenticated using (can_view_swimmer(swimmer_id));
create policy results_insert on public.results for insert to authenticated
  with check (is_team_coach(team_id) and swimmer_team(swimmer_id) = team_id and uploaded_by = auth.uid());
create policy results_delete on public.results for delete to authenticated using (is_team_coach(team_id));

-- ---------------------------------------------------------------------
-- Actions the app calls (each checks permissions itself)
-- ---------------------------------------------------------------------

-- New user → profile row
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name', null))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Coach creates a team with its training groups
create or replace function public.create_team(team_name text, group_names text[])
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid; g text; i int := 0;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into teams (name, created_by) values (trim(team_name), auth.uid()) returning id into t;
  insert into team_coaches (team_id, user_id, role) values (t, auth.uid(), 'head');
  foreach g in array coalesce(group_names, '{}') loop
    if char_length(trim(g)) > 0 then
      insert into groups (team_id, name, sort) values (t, trim(g), i);
      i := i + 1;
    end if;
  end loop;
  return t;
end $$;

-- Readable code like MAYA-7K2Q (no 0/O/1/I to avoid mix-ups)
create or replace function public.make_code(first text)
returns text language plpgsql volatile set search_path = public as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  prefix text := upper(substr(regexp_replace(coalesce(first, 'SWIM'), '[^A-Za-z]', '', 'g') || 'SWIM', 1, 4));
  suffix text := '';
  b bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
begin
  for i in 0..3 loop
    suffix := suffix || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return prefix || '-' || suffix;
end $$;

-- Coach: create a parent invite code for a swimmer (or a parent: a 13+ swimmer login code)
create or replace function public.create_invite(p_swimmer uuid, p_kind text default 'guardian')
returns text language plpgsql security definer set search_path = public as $$
declare c text; fname text; byear int;
begin
  select first_name, birth_year into fname, byear from swimmers where id = p_swimmer;
  if fname is null then raise exception 'Swimmer not found'; end if;

  if p_kind = 'guardian' then
    if not is_team_coach(swimmer_team(p_swimmer)) then raise exception 'Only coaches can invite parents'; end if;
    -- one live parent code per swimmer: revoke older ones
    update invites set revoked = true where swimmer_id = p_swimmer and kind = 'guardian' and not revoked;
  elsif p_kind = 'swimmer' then
    if not is_guardian(p_swimmer) then raise exception 'Only a parent can invite their swimmer'; end if;
    if byear is null or extract(year from now())::int - byear < 13 then
      raise exception 'Swimmers under 13 use a parent''s account';
    end if;
    if exists (select 1 from swimmer_accounts where swimmer_id = p_swimmer) then
      raise exception 'This swimmer already has a login';
    end if;
    update invites set revoked = true where swimmer_id = p_swimmer and kind = 'swimmer' and not revoked;
  else
    raise exception 'Unknown invite type';
  end if;

  loop
    c := make_code(fname);
    exit when not exists (select 1 from invites where code = c);
  end loop;
  insert into invites (code, swimmer_id, kind, uses_left, created_by)
  values (c, p_swimmer, p_kind, case when p_kind = 'guardian' then 2 else 1 end, auth.uid());
  return c;
end $$;

-- Coach: make parent codes for every swimmer on the team that doesn't have a live one
create or replace function public.create_missing_invites(p_team uuid)
returns int language plpgsql security definer set search_path = public as $$
declare s record; n int := 0;
begin
  if not is_team_coach(p_team) then raise exception 'Not a coach on this team'; end if;
  for s in
    select sw.id from swimmers sw
    where sw.team_id = p_team and not sw.archived
      and not exists (select 1 from invites i where i.swimmer_id = sw.id and i.kind = 'guardian'
                      and not i.revoked and i.uses_left > 0 and i.expires_at > now())
  loop
    perform create_invite(s.id, 'guardian');
    n := n + 1;
  end loop;
  return n;
end $$;

-- Anyone signed in: check a code before claiming. Shows first name + last initial only.
create or replace function public.preview_invite(p_code text)
returns table (swimmer_first text, swimmer_initial text, group_name text, team_name text, kind text)
language sql stable security definer set search_path = public as $$
  select sw.first_name, left(sw.last_name, 1), gr.name, t.name, i.kind
  from invites i
  join swimmers sw on sw.id = i.swimmer_id
  join teams t on t.id = sw.team_id
  left join groups gr on gr.id = sw.group_id
  where i.code = upper(trim(p_code)) and not i.revoked and i.uses_left > 0 and i.expires_at > now()
    and auth.uid() is not null;
$$;

-- Claim a code: links the signed-in user as a parent (or as the swimmer)
create or replace function public.claim_invite(p_code text, p_relationship text default 'parent')
returns uuid language plpgsql security definer set search_path = public as $$
declare inv invites%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into inv from invites where code = upper(trim(p_code)) for update;
  if inv.code is null or inv.revoked or inv.uses_left <= 0 or inv.expires_at <= now() then
    raise exception 'That code isn''t valid. Ask your coach to resend it.';
  end if;
  if exists (select 1 from invite_claims where code = inv.code and user_id = auth.uid()) then
    return inv.swimmer_id;
  end if;

  if inv.kind = 'guardian' then
    if is_swimmer_self(inv.swimmer_id) then raise exception 'This is a parent code'; end if;
    insert into guardians (swimmer_id, user_id, relationship)
    values (inv.swimmer_id, auth.uid(), coalesce(nullif(trim(p_relationship), ''), 'parent'))
    on conflict do nothing;
  else
    if is_guardian(inv.swimmer_id) then raise exception 'This code is for the swimmer, not a parent'; end if;
    if exists (select 1 from swimmer_accounts where user_id = auth.uid()) then
      raise exception 'This login is already linked to a swimmer';
    end if;
    insert into swimmer_accounts (swimmer_id, user_id) values (inv.swimmer_id, auth.uid());
  end if;

  insert into invite_claims (code, user_id) values (inv.code, auth.uid());
  update invites set uses_left = uses_left - 1 where code = inv.code;
  return inv.swimmer_id;
end $$;

-- Author marks a note as corrected (the original stays visible)
create or replace function public.correct_note(p_note uuid, p_correction text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update notes set correction = p_correction, corrected_at = now()
  where id = p_note and author_id = auth.uid();
  if not found then raise exception 'You can only correct your own notes'; end if;
end $$;

-- Lock down: these helpers are for policies/the app, never for anonymous visitors
revoke all on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
