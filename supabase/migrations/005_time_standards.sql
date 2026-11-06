-- =====================================================================
-- Wallside migration 005 — time standards
-- Run once in Supabase: SQL Editor → New query → paste → Run.
--
-- Cuts differ for girls and boys, so swimmers get a gender (F/M). It fills in
-- automatically from the event titles in uploaded results, and the coach can set it.
-- =====================================================================

alter table public.swimmers add column if not exists gender text check (gender in ('F', 'M'));

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
    -- Girls/boys from the event title fills in the swimmer's gender if it isn't set yet
    if s->>'gender' in ('F', 'M') then
      update swimmers set gender = s->>'gender' where id = (s->>'swimmer_id')::uuid and gender is null;
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
