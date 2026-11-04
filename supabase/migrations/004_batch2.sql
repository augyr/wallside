-- =====================================================================
-- Wallside migration 004 — Batch 2
-- Run once in Supabase: SQL Editor → New query → paste → Run.
--
-- - Seed times: a swimmer's entry time can count as a best time
--   ("from seed time"), saved only when the coach approves.
-- - Results inbox: meets found automatically wait here until the coach
--   taps "Approve all". Coach-only.
-- - Attendance: one tap starts a practice with everyone "here"; parents
--   report absences ahead of time for their own swimmer only.
-- - Notes: unchanged rules (parents always included, locked until a
--   parent joins). Coaches can now send one note to several swimmers.
-- =====================================================================

-- ---------- Seed times ----------
create table if not exists public.seed_times (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  swimmer_id  uuid not null references public.swimmers(id) on delete cascade,
  meet_id     uuid not null references public.meets(id) on delete cascade,
  distance    int not null check (distance in (25, 50, 100, 200, 400, 500, 800, 1000, 1500, 1650)),
  stroke      text not null check (stroke in ('FR', 'BK', 'BR', 'FL', 'IM')),
  course      text not null check (course in ('SCY', 'LCM')),
  time_cs     int not null check (time_cs > 0),
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (meet_id, swimmer_id, distance, stroke)
);
create index if not exists seed_times_swimmer on public.seed_times (swimmer_id, course, distance, stroke);

alter table public.seed_times enable row level security;
drop policy if exists seed_times_select on public.seed_times;
create policy seed_times_select on public.seed_times for select to authenticated using (can_view_swimmer(swimmer_id));
-- no insert/update/delete policies: written only through add_seed_times()

-- Where a meet's results came from (a results page link), so it isn't picked up twice
alter table public.meets add column if not exists source_url text check (char_length(source_url) <= 500);

-- import_meet now also records the results link it came from
create or replace function public.import_meet(p_team uuid, p_meet jsonb, p_swims jsonb, p_replace boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  m uuid;
  existing uuid;
  s jsonb;
  v_course text := p_meet->>'course';
  v_name text := trim(p_meet->>'name');
  v_date date := (p_meet->>'meet_date')::date;
begin
  if not is_team_coach(p_team) then raise exception 'Only coaches on this team can upload results'; end if;
  if v_course is null or v_course not in ('SCY', 'LCM') then
    raise exception 'Only short course yards and long course meters can be imported';
  end if;
  if v_name is null or v_name = '' or v_date is null then raise exception 'Meet name and date are required'; end if;
  if jsonb_typeof(p_swims) <> 'array' or jsonb_array_length(p_swims) = 0 then raise exception 'No swims to import'; end if;

  select id into existing from meets
    where team_id = p_team and lower(name) = lower(v_name) and meet_date = v_date limit 1;
  if existing is not null then
    if not p_replace then
      raise exception 'This meet was already uploaded. Choose "Replace the earlier upload" to upload it again.';
    end if;
    insert into result_edits (team_id, result_id, swimmer_id, action, before, edited_by)
      select r.team_id, r.id, r.swimmer_id, 'replaced', to_jsonb(r), auth.uid() from results r where r.meet_id = existing;
    delete from meets where id = existing;
  end if;

  insert into meets (team_id, name, meet_date, course, source, source_url, uploaded_by)
    values (p_team, v_name, v_date, v_course, nullif(p_meet->>'source', ''),
            left(nullif(p_meet->>'source_url', ''), 500), auth.uid())
    returning id into m;

  for s in select * from jsonb_array_elements(p_swims) loop
    if swimmer_team((s->>'swimmer_id')::uuid) is distinct from p_team then
      raise exception 'A swimmer in this upload is not on your team';
    end if;
    insert into results (team_id, swimmer_id, meet_id, distance, stroke, course, time_cs, splits_cs, split_len,
                         status, dq_reason, place, age_at_meet, name_in_results, meet_name, meet_date, uploaded_by)
    values (
      p_team, (s->>'swimmer_id')::uuid, m, (s->>'distance')::int, s->>'stroke', v_course,
      nullif(s->>'time_cs', '')::int,
      case when jsonb_typeof(s->'splits_cs') = 'array' and jsonb_array_length(s->'splits_cs') > 0
           then array(select jsonb_array_elements_text(s->'splits_cs')::int) end,
      nullif(s->>'split_len', '')::int,
      coalesce(nullif(s->>'status', ''), 'ok'),
      left(nullif(s->>'dq_reason', ''), 200),
      nullif(s->>'place', '')::int,
      nullif(s->>'age', '')::int,
      left(nullif(s->>'name_in_results', ''), 120),
      v_name, v_date, auth.uid()
    );
  end loop;
  return m;
end $$;

-- Coach saves seed times for a meet (adds new ones, updates any already saved)
create or replace function public.add_seed_times(p_meet uuid, p_seeds jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare m meets%rowtype; s jsonb; n int := 0;
begin
  select * into m from meets where id = p_meet;
  if m.id is null or not is_team_coach(m.team_id) then raise exception 'Only coaches on this team can add seed times'; end if;
  if jsonb_typeof(p_seeds) <> 'array' then raise exception 'Seeds must be a list'; end if;
  for s in select * from jsonb_array_elements(p_seeds) loop
    if swimmer_team((s->>'swimmer_id')::uuid) is distinct from m.team_id then
      raise exception 'A swimmer in these seed times is not on your team';
    end if;
    insert into seed_times (team_id, swimmer_id, meet_id, distance, stroke, course, time_cs, created_by)
    values (m.team_id, (s->>'swimmer_id')::uuid, p_meet, (s->>'distance')::int, s->>'stroke', m.course,
            (s->>'time_cs')::int, auth.uid())
    on conflict (meet_id, swimmer_id, distance, stroke) do update set time_cs = excluded.time_cs;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- Automatic results ----------
alter table public.teams add column if not exists results_source_url text check (char_length(results_source_url) <= 500);
alter table public.teams add column if not exists results_checked_at timestamptz;

create table if not exists public.results_inbox (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  source_url  text not null check (char_length(source_url) <= 500),
  kind        text not null default 'meet' check (kind in ('meet', 'seeds')),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'dismissed', 'not_ours')),
  meet_name   text check (char_length(meet_name) <= 160),
  meet_date   date,
  course      text check (course in ('SCY', 'LCM', 'SCM', 'MIXED')),
  meet_id     uuid references public.meets(id) on delete set null,
  payload     jsonb,
  summary     jsonb,
  found_at    timestamptz not null default now(),
  decided_by  uuid references auth.users(id),
  decided_at  timestamptz,
  unique (team_id, source_url)
);
alter table public.results_inbox enable row level security;
drop policy if exists inbox_select on public.results_inbox;
drop policy if exists inbox_insert on public.results_inbox;
drop policy if exists inbox_update on public.results_inbox;
create policy inbox_select on public.results_inbox for select to authenticated using (is_team_coach(team_id));
create policy inbox_insert on public.results_inbox for insert to authenticated with check (is_team_coach(team_id));
create policy inbox_update on public.results_inbox for update to authenticated
  using (is_team_coach(team_id)) with check (is_team_coach(team_id));

create or replace function public.mark_results_checked(p_team uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_team_coach(p_team) then raise exception 'Not a coach on this team'; end if;
  update teams set results_checked_at = now() where id = p_team;
end $$;

-- ---------- Attendance ----------
-- Coach: open a practice with everyone in the group marked "here" (parent-reported absences stay)
create or replace function public.start_practice(p_group uuid, p_date date, p_session text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid; p uuid;
begin
  select team_id into t from groups where id = p_group;
  if t is null or not is_team_coach(t) then raise exception 'Only coaches on this team can take attendance'; end if;
  if p_session not in ('AM', 'PM') then raise exception 'Practice must be AM or PM'; end if;
  insert into practices (team_id, group_id, practice_date, session) values (t, p_group, p_date, p_session)
    on conflict (group_id, practice_date, session) do nothing;
  select id into p from practices where group_id = p_group and practice_date = p_date and session = p_session;
  insert into attendance (practice_id, swimmer_id, status, updated_by)
    select p, sw.id, 'here', auth.uid() from swimmers sw
    where sw.group_id = p_group and not sw.archived
    on conflict (practice_id, swimmer_id) do nothing;
  return p;
end $$;

-- Parent: report their own swimmer out ahead of time (today or later)
create or replace function public.report_absence(p_swimmer uuid, p_date date, p_session text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare g uuid; t uuid; p uuid;
begin
  if not is_guardian(p_swimmer) then raise exception 'Only a parent or guardian can report an absence'; end if;
  if p_date < current_date then raise exception 'Absences can only be reported for today or later'; end if;
  if p_date > current_date + 60 then raise exception 'Report absences up to 60 days ahead'; end if;
  if p_session not in ('AM', 'PM') then raise exception 'Practice must be AM or PM'; end if;
  select group_id, team_id into g, t from swimmers where id = p_swimmer;
  if g is null then raise exception 'This swimmer isn''t in a training group yet'; end if;
  insert into practices (team_id, group_id, practice_date, session) values (t, g, p_date, p_session)
    on conflict (group_id, practice_date, session) do nothing;
  select id into p from practices where group_id = g and practice_date = p_date and session = p_session;
  if exists (select 1 from attendance where practice_id = p and swimmer_id = p_swimmer and not parent_reported) then
    raise exception 'The coach has already taken attendance for that practice';
  end if;
  insert into attendance (practice_id, swimmer_id, status, parent_reported, reason, updated_by)
    values (p, p_swimmer, 'out', true, left(nullif(trim(p_reason), ''), 200), auth.uid())
    on conflict (practice_id, swimmer_id) do update
      set status = 'out', parent_reported = true, reason = excluded.reason, updated_by = auth.uid(), updated_at = now();
end $$;

-- Parent: take back an absence they reported (today or later)
create or replace function public.cancel_absence(p_swimmer uuid, p_date date, p_session text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_guardian(p_swimmer) then raise exception 'Only a parent or guardian can change an absence'; end if;
  if p_date < current_date then raise exception 'Past attendance can''t be changed'; end if;
  delete from attendance a using practices p
   where a.practice_id = p.id and a.swimmer_id = p_swimmer and a.parent_reported
     and p.practice_date = p_date and p.session = p_session;
end $$;

-- ---------- Grants ----------
revoke all on public.seed_times, public.results_inbox from anon;
revoke insert, update, delete on public.seed_times from authenticated;
grant select on public.seed_times to authenticated;
grant select, insert, update on public.results_inbox to authenticated;

revoke all on function public.add_seed_times(uuid, jsonb) from anon, public;
revoke all on function public.mark_results_checked(uuid) from anon, public;
revoke all on function public.start_practice(uuid, date, text) from anon, public;
revoke all on function public.report_absence(uuid, date, text, text) from anon, public;
revoke all on function public.cancel_absence(uuid, date, text) from anon, public;
grant execute on function public.add_seed_times(uuid, jsonb) to authenticated;
grant execute on function public.mark_results_checked(uuid) to authenticated;
grant execute on function public.start_practice(uuid, date, text) to authenticated;
grant execute on function public.report_absence(uuid, date, text, text) to authenticated;
grant execute on function public.cancel_absence(uuid, date, text) to authenticated;
