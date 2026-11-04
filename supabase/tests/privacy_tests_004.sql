-- Tests for migration 004 (Batch 2). Run after the 001–003 tests.
\set ON_ERROR_STOP on
set role authenticated;

-- Coach A: a meet with a seed time for Maya
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into ctx select 'seedMeet', import_meet((select v::uuid from ctx where k='teamA'),
  '{"name":"Seed Test Meet","meet_date":"2026-10-20","course":"SCY"}'::jsonb,
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='maya'), 'distance', 100, 'stroke', 'FR', 'time_cs', 6100)))::text;
select pg_temp.expect(add_seed_times((select v::uuid from ctx where k='seedMeet'),
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='maya'), 'distance', 100, 'stroke', 'FR', 'time_cs', 5950)))= 1,
  'coach saves a seed time');
select pg_temp.expect(add_seed_times((select v::uuid from ctx where k='seedMeet'),
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='maya'), 'distance', 100, 'stroke', 'FR', 'time_cs', 5940)))= 1,
  'saving again replaces, not duplicates');
select pg_temp.expect((select count(*) from seed_times) = 1 and (select time_cs from seed_times) = 5940, 'one seed kept, latest value');
select pg_temp.expect((select course from seed_times) = 'SCY', 'seed takes the meet course');
select pg_temp.expect_error($$ insert into seed_times (team_id, swimmer_id, meet_id, distance, stroke, course, time_cs, created_by)
  values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='maya'), (select v::uuid from ctx where k='seedMeet'),
          50, 'FR', 'SCY', 2500, auth.uid()) $$, 'seeds cannot be written directly');

-- Families see their own swimmer's seeds; others don't
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect((select count(*) from seed_times) = 1, 'Maya''s parent sees her seed time');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
select pg_temp.expect((select count(*) from seed_times) = 0, 'another family sees no seed times');
select pg_temp.expect_error($$ select add_seed_times((select v::uuid from ctx where k='seedMeet'), '[]'::jsonb) $$, 'a parent cannot add seed times');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect((select count(*) from seed_times) = 0, 'other team''s coach sees no seed times');
select pg_temp.expect_error($$ select add_seed_times((select v::uuid from ctx where k='seedMeet'), '[]'::jsonb) $$, 'other coach cannot add seed times');

-- Results inbox: coach only
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into results_inbox (team_id, source_url, meet_name, meet_date, course, payload, summary)
  values ((select v::uuid from ctx where k='teamA'), 'https://www.pacswim.org/x.htm', 'Auto Meet', '2026-11-01', 'SCY', '{"swims":[]}', '{"matched":3}');
select pg_temp.expect((select count(*) from results_inbox) = 1, 'coach sees the results inbox');
update results_inbox set status = 'dismissed';
select pg_temp.expect((select status from results_inbox) = 'dismissed', 'coach can dismiss an inbox item');
select mark_results_checked((select v::uuid from ctx where k='teamA'));
select pg_temp.expect((select results_checked_at from teams where id = (select v::uuid from ctx where k='teamA')) is not null, 'coach records a results check');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect((select count(*) from results_inbox) = 0, 'parents never see the results inbox');
select pg_temp.expect_error($$ insert into results_inbox (team_id, source_url) values ((select v::uuid from ctx where k='teamA'), 'https://x') $$,
  'parents cannot add to the inbox');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect((select count(*) from results_inbox) = 0, 'other coach cannot see our inbox');
select pg_temp.expect_error($$ select mark_results_checked((select v::uuid from ctx where k='teamA')) $$, 'other coach cannot touch our team');

-- Attendance: start a practice
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into ctx select 'prac', start_practice((select v::uuid from ctx where k='senior'), current_date + 1, 'AM')::text;
select pg_temp.expect((select count(*) from attendance where practice_id = (select v::uuid from ctx where k='prac') and status = 'here')
  = (select count(*) from swimmers where group_id = (select v::uuid from ctx where k='senior') and not archived), 'everyone starts here');
select pg_temp.expect(start_practice((select v::uuid from ctx where k='senior'), current_date + 1, 'AM')::text = (select v from ctx where k='prac'),
  'starting again reuses the same practice');
update attendance set status = 'late', updated_by = auth.uid()
  where practice_id = (select v::uuid from ctx where k='prac') and swimmer_id = (select v::uuid from ctx where k='maya');
select pg_temp.expect((select status from attendance where practice_id = (select v::uuid from ctx where k='prac')
  and swimmer_id = (select v::uuid from ctx where k='maya')) = 'late', 'coach taps Maya to late');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect_error($$ select start_practice((select v::uuid from ctx where k='senior'), current_date, 'PM') $$, 'other coach cannot start our practice');

-- Parents report absences ahead, for their own swimmer only
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select report_absence((select v::uuid from ctx where k='maya'), current_date + 3, 'PM', 'Dentist');
select pg_temp.expect((select count(*) from attendance a join practices p on p.id = a.practice_id
  where a.parent_reported and p.practice_date = current_date + 3) = 1, 'parent reports Maya out ahead');
select pg_temp.expect_error($$ select report_absence((select v::uuid from ctx where k='maya'), current_date - 1, 'PM') $$, 'no reporting for past days');
select pg_temp.expect_error($$ select report_absence((select v::uuid from ctx where k='maya'), current_date + 1, 'AM') $$,
  'cannot override attendance the coach already took');
select pg_temp.expect_error($$ select report_absence((select v::uuid from ctx where k='leo'), current_date + 3, 'PM') $$, 'cannot report someone else''s swimmer');
select cancel_absence((select v::uuid from ctx where k='maya'), current_date + 3, 'PM');
select pg_temp.expect((select count(*) from attendance a join practices p on p.id = a.practice_id
  where a.parent_reported and p.practice_date = current_date + 3) = 0, 'parent cancels the absence');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
select pg_temp.expect_error($$ select report_absence((select v::uuid from ctx where k='maya'), current_date + 2, 'PM') $$, 'a swimmer cannot report their own absence');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000ff');
select pg_temp.expect_error($$ select report_absence((select v::uuid from ctx where k='maya'), current_date + 2, 'PM') $$, 'a stranger cannot report an absence');

-- Notes to several swimmers at once still follow the rules
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into notes (team_id, swimmer_id, author_id, body, tag)
  select (select v::uuid from ctx where k='teamA'), id, auth.uid(), 'Batch two note', 'keep_working' from swimmers
  where team_id = (select v::uuid from ctx where k='teamA') and first_name in ('Maya', 'Leo');
select pg_temp.expect((select count(*) from notes where body = 'Batch two note') = 2, 'coach sends one note to two swimmers');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
select pg_temp.expect((select count(*) from notes where body = 'Batch two note') = 1, 'each family sees only their own copy');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect_error($$ insert into notes (team_id, swimmer_id, author_id, body)
  values ((select v::uuid from ctx where k='teamA'), (select v::uuid from ctx where k='maya'), auth.uid(), 'hi') $$, 'other coach cannot note our swimmers');

reset role;
\echo ALL BATCH 2 TESTS PASSED
