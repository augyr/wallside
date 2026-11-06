-- Tests for migration 003 (swimmer-first logins). Run after privacy_tests.sql and privacy_tests_002.sql.
\set ON_ERROR_STOP on
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'teen@a.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'teenparent@a.test');
set role authenticated;

-- Coach adds a 15-year-old with no family yet, and a note for them
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into swimmers (team_id, group_id, first_name, last_name, birth_year)
  values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='senior'), 'Rowan', 'Vance', 2011);
insert into ctx select 'rowan', id::text from swimmers where first_name = 'Rowan';
insert into notes (team_id, swimmer_id, author_id, body)
  values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='rowan'), auth.uid(), 'Great turns today.');
insert into ctx select 'rowanNote', id::text from notes where body = 'Great turns today.';
insert into results (team_id, swimmer_id, distance, stroke, course, time_cs, meet_date, uploaded_by)
  values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='rowan'), 100, 'FR', 'SCY', 5600, '2026-10-01', auth.uid());

select pg_temp.expect(create_missing_swimmer_invites((select v::uuid from ctx where k='teamA')) >= 1, 'coach makes swimmer codes for 13+');
insert into ctx select 'rowanCode', code from invites where swimmer_id = (select v::uuid from ctx where k='rowan') and kind = 'swimmer' and not revoked;
select pg_temp.expect((select count(*) from invites where swimmer_id = (select v::uuid from ctx where k='leo') and kind = 'swimmer') = 0,
  'no swimmer code for an under-13');
select pg_temp.expect_error($$ select create_invite((select v::uuid from ctx where k='leo'), 'swimmer') $$, 'coach cannot make a login for an under-13');
select pg_temp.expect_error($$ select create_invite((select v::uuid from ctx where k='maya'), 'swimmer') $$, 'no second login for a swimmer who has one');

-- Other team's coach and unrelated parents can't
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect_error($$ select create_invite((select v::uuid from ctx where k='rowan'), 'swimmer') $$, 'other coach cannot make a swimmer code');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
select pg_temp.expect_error($$ select create_invite((select v::uuid from ctx where k='rowan'), 'swimmer') $$, 'another family cannot make a swimmer code');

-- The teen claims their login first
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.expect(claim_invite((select v from ctx where k='rowanCode')) = (select v::uuid from ctx where k='rowan'), 'teen claims their own login first');
select pg_temp.expect((select count(*) from swimmers) = 1, 'teen sees only themself');
select pg_temp.expect((select count(*) from results) = 1, 'teen sees their own times');
select pg_temp.expect((select count(*) from notes) = 0, 'messages locked: no coach notes before a parent joins');
select pg_temp.expect((select count(*) from notes where group_id is not null) = 0, 'messages locked: no group notes before a parent joins');
select pg_temp.expect_error($$ insert into note_replies (note_id, author_id, body)
  values ((select v::uuid from ctx where k='rowanNote'), auth.uid(), 'hi') $$ , 'teen cannot reply before a parent joins');
insert into goals (swimmer_id, created_by, kind, title) values ((select v::uuid from ctx where k='rowan'), auth.uid(), 'practice', 'Make every morning practice');
select pg_temp.expect((select count(*) from goals) = 1, 'teen can set their own goals');

-- A parent joins; messages unlock for the teen
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into ctx values ('rowanParentCode', create_invite((select v::uuid from ctx where k='rowan'), 'guardian'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c2');
select claim_invite((select v from ctx where k='rowanParentCode'));
select pg_temp.expect((select count(*) from notes) >= 1, 'parent sees coach notes');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.expect((select count(*) from notes where swimmer_id is not null) = 1, 'once a parent joins, the teen sees coach notes');

reset role;
\echo ALL SWIMMER-FIRST TESTS PASSED
