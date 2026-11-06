-- =====================================================================
-- Wallside migration 003 — swimmers can claim their login first
-- Run once in Supabase: SQL Editor → New query → paste → Run.
--
-- - A coach can now create a swimmer's own login code (13 and older), so
--   swimmers can join before a parent does.
-- - Unchanged on purpose: coach notes and replies stay hidden from a swimmer
--   until at least one parent or guardian has joined (see notes_select and
--   replies_insert in schema.sql). So messaging is locked until then.
-- - Under 13: still no swimmer login, ever.
-- =====================================================================

create or replace function public.create_invite(p_swimmer uuid, p_kind text default 'guardian')
returns text language plpgsql security definer set search_path = public as $$
declare c text; fname text; byear int;
begin
  select first_name, birth_year into fname, byear from swimmers where id = p_swimmer;
  if fname is null then raise exception 'Swimmer not found'; end if;

  if p_kind = 'guardian' then
    if not is_team_coach(swimmer_team(p_swimmer)) then raise exception 'Only coaches can invite parents'; end if;
    update invites set revoked = true where swimmer_id = p_swimmer and kind = 'guardian' and not revoked;
  elsif p_kind = 'swimmer' then
    if not (is_guardian(p_swimmer) or is_team_coach(swimmer_team(p_swimmer))) then
      raise exception 'Only the swimmer''s coach or parent can create their login code';
    end if;
    if byear is null then raise exception 'Add %''s birth year first — swimmer logins are for ages 13 and up', fname; end if;
    if extract(year from now())::int - byear < 13 then
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

-- Coach: swimmer login codes for every swimmer aged 13+ who has no login and no live code
create or replace function public.create_missing_swimmer_invites(p_team uuid)
returns int language plpgsql security definer set search_path = public as $$
declare s record; n int := 0;
begin
  if not is_team_coach(p_team) then raise exception 'Not a coach on this team'; end if;
  for s in
    select sw.id from swimmers sw
    where sw.team_id = p_team and not sw.archived
      and sw.birth_year is not null and extract(year from now())::int - sw.birth_year >= 13
      and not exists (select 1 from swimmer_accounts a where a.swimmer_id = sw.id)
      and not exists (select 1 from invites i where i.swimmer_id = sw.id and i.kind = 'swimmer'
                      and not i.revoked and i.uses_left > 0 and i.expires_at > now())
  loop
    perform create_invite(s.id, 'swimmer');
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.create_invite(uuid, text) from anon, public;
revoke all on function public.create_missing_swimmer_invites(uuid) from anon, public;
grant execute on function public.create_invite(uuid, text) to authenticated;
grant execute on function public.create_missing_swimmer_invites(uuid) to authenticated;
