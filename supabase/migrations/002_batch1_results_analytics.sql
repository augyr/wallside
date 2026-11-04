-- =====================================================================
-- Wallside migration 002 — Batch 1: meet results, analytics, swimmer details
-- Run once in Supabase: SQL Editor → New query → paste → Run.
-- Safe to run on the live database: it only adds things, and the current
-- live app keeps working before and after.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Teams: the code and names used to recognize the team in meet results
-- ---------------------------------------------------------------------
alter table public.teams add column if not exists team_code text
  check (team_code is null or team_code ~ '^[A-Z0-9]{2,8}$');
alter table public.teams add column if not exists team_aliases text[] not null default '{}';

-- ---------------------------------------------------------------------
-- Analytics levels: per group (default) and per swimmer (coach override)
-- ---------------------------------------------------------------------
alter table public.groups add column if not exists analytics_level text
  check (analytics_level in ('developing', 'age_group', 'senior'));
update public.groups set analytics_level = 'senior'
  where analytics_level is null and name ilike '%senior%';

create or replace function public.default_group_level()
returns trigger language plpgsql as $$
begin
  if new.analytics_level is null and new.name ilike '%senior%' then
    new.analytics_level := 'senior';
  end if;
  return new;
end $$;
drop trigger if exists groups_default_level on public.groups;
create trigger groups_default_level before insert on public.groups
  for each row execute function public.default_group_level();

-- ---------------------------------------------------------------------
-- Swimmer details
-- ---------------------------------------------------------------------
alter table public.swimmers add column if not exists also_known_as text[] not null default '{}';
alter table public.swimmers add column if not exists usually_unattached boolean not null default false;
alter table public.swimmers add column if not exists birth_year_estimated boolean not null default false;
alter table public.swimmers add column if not exists analytics_level text
  check (analytics_level in ('developing', 'age_group', 'senior'));

-- ---------------------------------------------------------------------
-- Meets and richer results
-- ---------------------------------------------------------------------
create table if not exists public.meets (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 160),
  meet_date   date not null,
  course      text not null check (course in ('SCY', 'LCM')),
  source      text check (source in ('pdf', 'html', 'manual')),
  uploaded_by uuid not null references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists meets_team_date on public.meets (team_id, meet_date desc);

alter table public.results add column if not exists meet_id uuid references public.meets(id) on delete cascade;
alter table public.results add column if not exists status text not null default 'ok' check (status in ('ok', 'dq'));
alter table public.results add column if not exists dq_reason text check (char_length(dq_reason) <= 200);
alter table public.results add column if not exists place int check (place between 1 and 999);
alter table public.results add column if not exists age_at_meet int check (age_at_meet between 3 and 99);
alter table public.results add column if not exists split_len int check (split_len in (25, 50, 100));
alter table public.results add column if not exists name_in_results text check (char_length(name_in_results) <= 120);
-- A disqualified swim may have no time; every other swim needs one
alter table public.results alter column time_cs drop not null;
alter table public.results drop constraint if exists results_time_needed;
alter table public.results add constraint results_time_needed check (status = 'dq' or time_cs is not null);
create index if not exists results_meet on public.results (meet_id);

-- Every change to a published result is recorded here
create table if not exists public.result_edits (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  result_id   uuid,
  swimmer_id  uuid,
  action      text not null check (action in ('edit', 'delete', 'replaced')),
  before      jsonb,
  after       jsonb,
  edited_by   uuid not null references auth.users(id),
  edited_at   timestamptz not null default now()
);
create index if not exists result_edits_result on public.result_edits (result_id);

-- ---------------------------------------------------------------------
-- Goals: structured target time + coach-set goal splits
-- ---------------------------------------------------------------------
alter table public.goals add column if not exists target_cs int check (target_cs > 0);
alter table public.goals add column if not exists distance int
  check (distance in (25, 50, 100, 200, 400, 500, 800, 1000, 1500, 1650));
alter table public.goals add column if not exists stroke text check (stroke in ('FR', 'BK', 'BR', 'FL', 'IM'));
alter table public.goals add column if not exists goal_splits_cs int[];
alter table public.goals add column if not exists goal_splits_set_by uuid references auth.users(id);

-- Families can create and update goals, but only coaches set goal splits
revoke insert, update on public.goals from authenticated;
grant insert (swimmer_id, created_by, kind, title, course, due_label, status, target_cs, distance, stroke)
  on public.goals to authenticated;
grant update (kind, title, course, due_label, status, target_cs, distance, stroke)
  on public.goals to authenticated;

-- ---------------------------------------------------------------------
-- Row level security for the new tables
-- ---------------------------------------------------------------------
alter table public.meets        enable row level security;
alter table public.result_edits enable row level security;

drop policy if exists meets_select on public.meets;
create policy meets_select on public.meets for select to authenticated
  using (team_id in (select my_team_ids()));

drop policy if exists result_edits_select on public.result_edits;
create policy result_edits_select on public.result_edits for select to authenticated
  using (is_team_coach(team_id));

-- Results can now only be removed through delete_result(), which records it
drop policy if exists results_delete on public.results;

-- ---------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------

-- Publish a reviewed meet. p_swims is a list of
-- {swimmer_id, distance, stroke, time_cs, splits_cs, split_len, status, dq_reason, place, age, name_in_results}
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

  insert into meets (team_id, name, meet_date, course, source, uploaded_by)
    values (p_team, v_name, v_date, v_course, nullif(p_meet->>'source', ''), auth.uid())
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

-- Coach fixes a published result (logged)
create or replace function public.update_result(p_result uuid, p_time_cs int, p_status text, p_dq_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r results%rowtype; after results%rowtype;
begin
  select * into r from results where id = p_result;
  if r.id is null or not is_team_coach(r.team_id) then raise exception 'You can only edit your own team''s results'; end if;
  update results set time_cs = p_time_cs, status = coalesce(p_status, status),
         dq_reason = case when coalesce(p_status, status) = 'dq' then left(p_dq_reason, 200) end
   where id = p_result returning * into after;
  insert into result_edits (team_id, result_id, swimmer_id, action, before, after, edited_by)
    values (r.team_id, r.id, r.swimmer_id, 'edit', to_jsonb(r), to_jsonb(after), auth.uid());
end $$;

-- Coach removes a published result (logged)
create or replace function public.delete_result(p_result uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r results%rowtype;
begin
  select * into r from results where id = p_result;
  if r.id is null or not is_team_coach(r.team_id) then raise exception 'You can only remove your own team''s results'; end if;
  insert into result_edits (team_id, result_id, swimmer_id, action, before, edited_by)
    values (r.team_id, r.id, r.swimmer_id, 'delete', to_jsonb(r), auth.uid());
  delete from results where id = p_result;
end $$;

-- Coach removes a whole meet upload (each result logged)
create or replace function public.delete_meet(p_meet uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  select team_id into t from meets where id = p_meet;
  if t is null or not is_team_coach(t) then raise exception 'You can only remove your own team''s meets'; end if;
  insert into result_edits (team_id, result_id, swimmer_id, action, before, edited_by)
    select r.team_id, r.id, r.swimmer_id, 'delete', to_jsonb(r), auth.uid() from results r where r.meet_id = p_meet;
  delete from meets where id = p_meet;
end $$;

-- Coach sets (or clears, with null) the goal splits for a time goal
create or replace function public.set_goal_splits(p_goal uuid, p_splits int[])
returns void language plpgsql security definer set search_path = public as $$
declare g goals%rowtype;
begin
  select * into g from goals where id = p_goal;
  if g.id is null or not is_team_coach(swimmer_team(g.swimmer_id)) then
    raise exception 'Only the swimmer''s coach can set goal splits';
  end if;
  if p_splits is not null and (array_length(p_splits, 1) is null or exists (select 1 from unnest(p_splits) x where x <= 0)) then
    raise exception 'Splits must be positive times';
  end if;
  update goals set goal_splits_cs = p_splits,
                   goal_splits_set_by = case when p_splits is null then null else auth.uid() end
   where id = p_goal;
end $$;

revoke all on function public.import_meet(uuid, jsonb, jsonb, boolean) from anon, public;
revoke all on function public.update_result(uuid, int, text, text) from anon, public;
revoke all on function public.delete_result(uuid) from anon, public;
revoke all on function public.delete_meet(uuid) from anon, public;
revoke all on function public.set_goal_splits(uuid, int[]) from anon, public;
grant execute on function public.import_meet(uuid, jsonb, jsonb, boolean) to authenticated;
grant execute on function public.update_result(uuid, int, text, text) to authenticated;
grant execute on function public.delete_result(uuid) to authenticated;
grant execute on function public.delete_meet(uuid) to authenticated;
grant execute on function public.set_goal_splits(uuid, int[]) to authenticated;
revoke all on public.meets, public.result_edits from anon;
