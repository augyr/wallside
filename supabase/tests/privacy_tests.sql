-- Privacy rule tests. Each check raises an error if a rule is broken.
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'coach@a.test'),
  ('00000000-0000-0000-0000-00000000000b', 'coach@b.test'),
  ('00000000-0000-0000-0000-0000000000a1', 'mayamom@a.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'mayadad@a.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'leomom@a.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'maya@a.test'),
  ('00000000-0000-0000-0000-0000000000ff', 'stranger@x.test'),
  ('00000000-0000-0000-0000-0000000000a5', 'third@a.test');

create temp table ctx (k text primary key, v text);
grant all on ctx to authenticated;

create or replace function pg_temp.as_user(u text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u, false);
end $$;

create or replace function pg_temp.expect(cond boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'FAILED: %', msg; end if;
  raise notice 'ok  %', msg;
end $$;

create or replace function pg_temp.expect_error(stmt text, msg text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'ok  % (blocked: %)', msg, sqlerrm;
    return;
  end;
  raise exception 'FAILED (was allowed): %', msg;
end $$;


set role authenticated;

-- ---------------- Coach A builds a team ----------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into ctx values ('teamA', create_team('Riverside Aquatics', array['Senior','Age Group','Novice'])::text);
select pg_temp.expect((select count(*) from groups where team_id = (select v::uuid from ctx where k='teamA')) = 3, 'coach sees 3 groups');

insert into swimmers (team_id, group_id, first_name, last_name, birth_year)
select (select v::uuid from ctx where k='teamA'), id, 'Maya', 'Rivera', 2012 from groups where name='Senior';
insert into swimmers (team_id, group_id, first_name, last_name, birth_year)
select (select v::uuid from ctx where k='teamA'), id, 'Leo', 'Kim', 2017 from groups where name='Novice';
insert into ctx select 'maya', id::text from swimmers where first_name='Maya';
insert into ctx select 'leo', id::text from swimmers where first_name='Leo';
insert into ctx select 'senior', id::text from groups where name='Senior';

select pg_temp.expect(create_missing_invites((select v::uuid from ctx where k='teamA')) = 2, 'codes made for 2 swimmers');
insert into ctx select 'mayaCode', code from invites where swimmer_id=(select v::uuid from ctx where k='maya');
insert into ctx select 'leoCode', code from invites where swimmer_id=(select v::uuid from ctx where k='leo');
select pg_temp.expect((select v from ctx where k='mayaCode') ~ '^MAYA-[A-Z2-9]{4}$', 'code looks like MAYA-XXXX');

-- Coach writes a note BEFORE any parent joins, plus a group note
insert into notes (team_id, swimmer_id, author_id, focus, body, tag)
values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='maya'), auth.uid(), 'Breakouts', 'Breakouts on time for 4 reps.', 'great');
insert into notes (team_id, group_id, author_id, body)
values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='senior'), auth.uid(), 'Great aerobic set today.');
insert into results (team_id, swimmer_id, distance, stroke, course, time_cs, meet_date, uploaded_by)
values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='maya'), 100, 'FR', 'SCY', 5984, '2026-11-01', auth.uid());
insert into practices (team_id, group_id, practice_date, session)
values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='senior'), '2026-11-03', 'AM'),
       ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='senior'), '2026-11-03', 'PM');
insert into attendance (practice_id, swimmer_id, status, updated_by)
select id, (select v::uuid from ctx where k='maya'), 'here', auth.uid() from practices where session='AM';

-- ---------------- Stranger before claiming ----------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000ff');
select pg_temp.expect((select count(*) from swimmers) = 0, 'stranger sees no swimmers');
select pg_temp.expect((select count(*) from teams) = 0, 'stranger sees no teams');
select pg_temp.expect((select count(*) from notes) = 0, 'stranger sees no notes');
select pg_temp.expect((select count(*) from results) = 0, 'stranger sees no results');
select pg_temp.expect((select count(*) from invites) = 0, 'stranger cannot list invite codes');
select pg_temp.expect((select count(*) from preview_invite('NOPE-1234')) = 0, 'bad code previews nothing');
select pg_temp.expect_error($$ select claim_invite('NOPE-1234') $$, 'bad code cannot be claimed');

-- ---------------- Maya's mom claims Maya's code ----------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect((select swimmer_first || ' ' || swimmer_initial from preview_invite((select v from ctx where k='mayaCode'))) = 'Maya R', 'preview shows first name + last initial only');
select pg_temp.expect(claim_invite((select v from ctx where k='mayaCode'), 'mom') = (select v::uuid from ctx where k='maya'), 'mom claims Maya');
select pg_temp.expect((select count(*) from swimmers) = 1, 'mom sees exactly 1 swimmer');
select pg_temp.expect((select first_name from swimmers) = 'Maya', 'and it is Maya');
select pg_temp.expect((select count(*) from notes where swimmer_id is not null) = 1, 'mom sees the note written before she joined');
select pg_temp.expect((select count(*) from notes where group_id is not null) = 1, 'mom sees the Senior group note');
select pg_temp.expect((select count(*) from results) = 1, 'mom sees Maya''s result');
select pg_temp.expect((select count(*) from teams) = 1, 'mom sees the team name');
select pg_temp.expect((select count(*) from invites) = 0, 'mom cannot see coach invite codes');
select pg_temp.expect((select count(*) from practices) = 2, 'mom sees Maya''s group practices');
select pg_temp.expect((select count(*) from attendance) = 1, 'mom sees Maya''s attendance');

-- Parents cannot do coach things
select pg_temp.expect_error($$ insert into results (team_id, swimmer_id, distance, stroke, course, time_cs, meet_date, uploaded_by)
  values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='maya'), 50, 'FR', 'SCY', 2800, '2026-11-01', auth.uid()) $$,
  'parent cannot upload results');
select pg_temp.expect_error($$ insert into notes (team_id, swimmer_id, author_id, body)
  values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='maya'), auth.uid(), 'fake coach note') $$,
  'parent cannot write coach notes');
select pg_temp.expect_error($$ insert into swimmers (team_id, first_name, last_name) values ((select v::uuid from ctx where k='teamA'), 'X', 'Y') $$,
  'parent cannot add swimmers');
select pg_temp.expect_error($$ select create_invite((select v::uuid from ctx where k='leo'), 'guardian') $$, 'parent cannot make parent codes');
delete from notes; select pg_temp.expect((select count(*) from notes) = 2, 'parent cannot delete notes');
update attendance set status = 'out'; select pg_temp.expect((select status from attendance limit 1) = 'here', 'parent cannot change attendance after the fact');

-- Parent can: reply, report an absence, add a goal
insert into note_replies (note_id, author_id, body) select id, auth.uid(), 'Thanks coach!' from notes where swimmer_id is not null;
select pg_temp.expect((select count(*) from note_replies) = 1, 'mom can reply to Maya''s note');
insert into attendance (practice_id, swimmer_id, status, parent_reported, reason, updated_by)
select id, (select v::uuid from ctx where k='maya'), 'out', true, 'Dentist', auth.uid() from practices where session='PM';
select pg_temp.expect((select count(*) from attendance where parent_reported) = 1, 'mom can report Maya out for PM');
select pg_temp.expect_error($$ insert into attendance (practice_id, swimmer_id, status, parent_reported, updated_by)
  select id, (select v::uuid from ctx where k='maya'), 'here', true, auth.uid() from practices where session='PM' limit 1 $$,
  'parent cannot mark herself "here"');
insert into goals (swimmer_id, created_by, kind, title, course) values ((select v::uuid from ctx where k='maya'), auth.uid(), 'time', '100 free under 59.00', 'SCY');
select pg_temp.expect((select count(*) from goals) = 1, 'mom can add a goal for Maya');
select pg_temp.expect_error($$ insert into goals (swimmer_id, created_by, kind, title) values ((select v::uuid from ctx where k='leo'), auth.uid(), 'other', 'x') $$,
  'mom cannot add goals for another family''s swimmer');

-- Leo is under 13: no swimmer login allowed
select pg_temp.expect_error($$ select create_invite((select v::uuid from ctx where k='leo'), 'swimmer') $$, 'mom cannot make a login for someone else''s kid');
-- Maya is 13+: mom invites her
insert into ctx values ('mayaSwimCode', create_invite((select v::uuid from ctx where k='maya'), 'swimmer'));

-- ---------------- Dad claims same code (2 uses) ----------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
select pg_temp.expect(claim_invite((select v from ctx where k='mayaCode'), 'dad') is not null, 'dad claims the same code');
select pg_temp.expect((select count(*) from swimmers) = 1, 'dad sees Maya only');

-- Third person tries the used-up code
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a5');
select pg_temp.expect_error($$ select claim_invite((select v from ctx where k='mayaCode')) $$, 'code stops working after 2 parents');

-- ---------------- Maya (swimmer) claims her own login ----------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
select pg_temp.expect(claim_invite((select v from ctx where k='mayaSwimCode')) is not null, 'Maya claims her swimmer code');
select pg_temp.expect((select count(*) from swimmers) = 1, 'Maya sees only herself');
select pg_temp.expect((select count(*) from notes) = 2, 'Maya sees her note and group note');
select pg_temp.expect((select count(*) from goals) = 1, 'Maya sees her goal');
select pg_temp.expect_error($$ select create_invite((select v::uuid from ctx where k='maya'), 'swimmer') $$, 'swimmer cannot make more logins');

-- ---------------- Leo's mom: sees Leo, never Maya ----------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
select pg_temp.expect(claim_invite((select v from ctx where k='leoCode')) is not null, 'Leo''s mom claims Leo');
select pg_temp.expect((select count(*) from swimmers) = 1 and (select first_name from swimmers) = 'Leo', 'Leo''s mom sees only Leo');
select pg_temp.expect((select count(*) from notes) = 0, 'Leo''s mom sees no notes about Maya or Senior group');
select pg_temp.expect((select count(*) from results) = 0, 'Leo''s mom sees no Maya results');
select pg_temp.expect((select count(*) from goals) = 0, 'Leo''s mom sees no Maya goals');
select pg_temp.expect((select count(*) from note_replies) = 0, 'Leo''s mom sees no replies on Maya''s notes');
select pg_temp.expect((select count(*) from attendance) = 0, 'Leo''s mom sees no Maya attendance');
select pg_temp.expect((select count(*) from guardians) = 1, 'Leo''s mom sees only her own guardian link');

-- ---------------- Coach B (other team) sees nothing of team A ----------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
insert into ctx values ('teamB', create_team('Other Club', array['Senior']));
select pg_temp.expect((select count(*) from swimmers) = 0, 'other coach sees none of team A''s swimmers');
select pg_temp.expect((select count(*) from notes) = 0, 'other coach sees none of team A''s notes');
select pg_temp.expect((select count(*) from teams) = 1, 'other coach sees only own team');
select pg_temp.expect_error($$ insert into swimmers (team_id, first_name, last_name) values ((select v::uuid from ctx where k='teamA'), 'X', 'Y') $$,
  'other coach cannot add swimmers to team A');
select pg_temp.expect_error($$ insert into notes (team_id, swimmer_id, author_id, body)
  values ((select v::uuid from ctx where k='teamB'), (select v::uuid from ctx where k='maya'), auth.uid(), 'sneaky') $$,
  'other coach cannot note team A swimmer via own team');

-- ---------------- Coach A: corrections, no deletes ----------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
delete from notes; select pg_temp.expect((select count(*) from notes) = 2, 'coach cannot delete notes either');
select correct_note((select id from notes where swimmer_id is not null), 'Meant 5 reps, not 4.');
select pg_temp.expect((select correction from notes where swimmer_id is not null) is not null, 'coach can mark a note corrected');
select pg_temp.expect((select count(*) from guardians) = 3, 'coach sees all 3 linked parents on the team');
select pg_temp.expect((select count(*) from swimmer_accounts) = 1, 'coach sees Maya has her own login');
select pg_temp.expect((select count(*) from profiles) >= 4, 'coach can see names of linked family members');
select pg_temp.expect_error($$ insert into results (team_id, swimmer_id, distance, stroke, course, time_cs, meet_date, uploaded_by)
  values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='maya'), 100, 'FR', 'SCM', 6000, '2026-11-01', auth.uid()) $$,
  'short course meters is rejected (SCY and LCM only)');

reset role;
\echo ALL PRIVACY TESTS PASSED
