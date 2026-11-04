-- Privacy and rule tests for migration 002. Run in the same session, right after privacy_tests.sql.
\set ON_ERROR_STOP on
set role authenticated;

-- ---------------- Team code & group level ----------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update teams set team_code = 'PASA', team_aliases = array['Palo Alto Stanford Aquatics'] where id = (select v::uuid from ctx where k='teamA');
select pg_temp.expect((select team_code from teams where id = (select v::uuid from ctx where k='teamA')) = 'PASA', 'head coach sets team code');
select pg_temp.expect((select analytics_level from groups where id = (select v::uuid from ctx where k='senior')) is null
  or (select analytics_level from groups where id = (select v::uuid from ctx where k='senior')) = 'senior', 'existing Senior group ok');
insert into groups (team_id, name) values ((select v::uuid from ctx where k='teamA'), 'Senior 2');
select pg_temp.expect((select analytics_level from groups where name = 'Senior 2') = 'senior', 'new "Senior" group defaults to Senior analytics');
update swimmers set also_known_as = array['Mayita'], usually_unattached = false, birth_year_estimated = true
  where id = (select v::uuid from ctx where k='maya');
select pg_temp.expect((select birth_year_estimated from swimmers where id = (select v::uuid from ctx where k='maya')), 'coach edits swimmer details');

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');  -- Maya's mom
update teams set team_code = 'HACK';
select pg_temp.expect((select team_code from teams) = 'PASA', 'parent cannot change team code');
update swimmers set birth_year = 2000;
select pg_temp.expect((select birth_year from swimmers) = 2012, 'parent cannot edit swimmer details');

-- ---------------- Importing a meet ----------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into ctx values ('meet1', import_meet(
  (select v::uuid from ctx where k='teamA'),
  '{"name":"Fall Super League","meet_date":"2026-09-27","course":"SCY","source":"pdf"}',
  jsonb_build_array(
    jsonb_build_object('swimmer_id', (select v from ctx where k='maya'), 'distance', 100, 'stroke', 'FR', 'time_cs', 5984,
                       'splits_cs', jsonb_build_array(1362, 1531, 1548, 1543), 'split_len', 25, 'place', 3, 'age', 14, 'name_in_results', 'Rivera, Maya'),
    jsonb_build_object('swimmer_id', (select v from ctx where k='maya'), 'distance', 50, 'stroke', 'FL', 'status', 'dq', 'dq_reason', 'One hand touch', 'age', 14),
    jsonb_build_object('swimmer_id', (select v from ctx where k='leo'), 'distance', 25, 'stroke', 'BK', 'time_cs', 2410, 'age', 9)
  ))::text);
select pg_temp.expect((select count(*) from results where meet_id = (select v::uuid from ctx where k='meet1')) = 3, 'coach imports 3 swims');
select pg_temp.expect((select status from results where stroke = 'FL' and meet_id = (select v::uuid from ctx where k='meet1')) = 'dq', 'DQ stored with no time');
select pg_temp.expect((select splits_cs from results where stroke = 'FR' and meet_id = (select v::uuid from ctx where k='meet1')) = array[1362,1531,1548,1543], 'splits stored per lap');

select pg_temp.expect_error($$ select import_meet((select v::uuid from ctx where k='teamA'),
  '{"name":"Fall Super League","meet_date":"2026-09-27","course":"SCY"}',
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='leo'), 'distance', 50, 'stroke', 'FR', 'time_cs', 4000))) $$,
  're-uploading the same meet needs "replace"');
select pg_temp.expect_error($$ select import_meet((select v::uuid from ctx where k='teamA'),
  '{"name":"Some Meet","meet_date":"2026-10-01","course":"SCM"}',
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='leo'), 'distance', 50, 'stroke', 'FR', 'time_cs', 4000))) $$,
  'short course meters meets are rejected');
select pg_temp.expect_error($$ select import_meet((select v::uuid from ctx where k='teamA'),
  '{"name":"Bad Meet","meet_date":"2026-10-01","course":"SCY"}',
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='leo'), 'distance', 50, 'stroke', 'FR'))) $$,
  'a swim that is not a DQ must have a time');

-- Replace the meet: old results removed and logged
insert into ctx values ('meet1b', import_meet(
  (select v::uuid from ctx where k='teamA'),
  '{"name":"Fall Super League","meet_date":"2026-09-27","course":"SCY"}',
  jsonb_build_array(
    jsonb_build_object('swimmer_id', (select v from ctx where k='maya'), 'distance', 100, 'stroke', 'FR', 'time_cs', 5984,
                       'splits_cs', jsonb_build_array(1362, 1531, 1548, 1543), 'split_len', 25),
    jsonb_build_object('swimmer_id', (select v from ctx where k='maya'), 'distance', 50, 'stroke', 'FL', 'status', 'dq', 'dq_reason', 'One hand touch')
  ), true)::text);
select pg_temp.expect((select count(*) from meets where name = 'Fall Super League') = 1, 'replace keeps one copy of the meet');
select pg_temp.expect((select count(*) from results where meet_id = (select v::uuid from ctx where k='meet1b')) = 2, 'replacement has the new swims');
select pg_temp.expect((select count(*) from result_edits where action = 'replaced') = 3, 'replaced swims are logged');

-- Coach fixes and removes results, both logged; direct deletes do nothing
select update_result((select id from results where stroke = 'FR' and meet_id = (select v::uuid from ctx where k='meet1b')), 5980, 'ok', null);
select pg_temp.expect((select time_cs from results where stroke = 'FR' and meet_id = (select v::uuid from ctx where k='meet1b')) = 5980, 'coach fixes a time');
select pg_temp.expect((select count(*) from result_edits where action = 'edit') = 1, 'the fix is logged');
delete from results;
select pg_temp.expect((select count(*) from results where meet_id = (select v::uuid from ctx where k='meet1b')) = 2, 'results cannot be deleted directly (must use delete_result)');

-- Goals: family sets target, coach sets splits
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');  -- Maya's mom
insert into goals (swimmer_id, created_by, kind, title, course, distance, stroke, target_cs)
  values ((select v::uuid from ctx where k='maya'), auth.uid(), 'time', '100 Free under 59.00', 'SCY', 100, 'FR', 5900);
insert into ctx select 'goal', id::text from goals where target_cs = 5900;
select pg_temp.expect((select count(*) from ctx where k='goal') = 1, 'parent creates a time goal with a target');
select pg_temp.expect_error($$ update goals set goal_splits_cs = array[1300,1500,1500,1600] where id = (select v::uuid from ctx where k='goal') $$,
  'parent cannot write goal splits directly');
select pg_temp.expect_error($$ insert into goals (swimmer_id, created_by, kind, title, goal_splits_cs)
  values ((select v::uuid from ctx where k='maya'), auth.uid(), 'time', 'x', array[1]) $$, 'parent cannot insert goal splits');
select pg_temp.expect_error($$ select set_goal_splits((select v::uuid from ctx where k='goal'), array[1354,1511,1520,1515]) $$,
  'parent cannot set goal splits');
update goals set target_cs = 5890 where id = (select v::uuid from ctx where k='goal');
select pg_temp.expect((select target_cs from goals where id = (select v::uuid from ctx where k='goal')) = 5890, 'parent can adjust their goal time');

-- Parent permissions on results
select pg_temp.expect((select count(*) from meets) = 1, 'parent sees their team''s meet');
select pg_temp.expect((select count(*) from results where meet_id = (select v::uuid from ctx where k='meet1b')) = 2, 'parent sees Maya''s results');
select pg_temp.expect((select count(*) from result_edits) = 0, 'parent cannot see the edit log');
select pg_temp.expect_error($$ select import_meet((select v::uuid from ctx where k='teamA'),
  '{"name":"Parent Meet","meet_date":"2026-10-02","course":"SCY"}',
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='maya'), 'distance', 50, 'stroke', 'FR', 'time_cs', 2500))) $$,
  'parent cannot import results');
select pg_temp.expect_error($$ select update_result((select id from results where stroke = 'FR' limit 1), 100, 'ok', null) $$,
  'parent cannot edit results');
select pg_temp.expect_error($$ select delete_result((select id from results where stroke = 'FR' limit 1)) $$,
  'parent cannot remove results');

-- Leo's mom: nothing of Maya's
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
select pg_temp.expect((select count(*) from results) = 0, 'Leo''s mom sees no Maya results (Leo''s swim was replaced away)');
select pg_temp.expect((select count(*) from goals) = 0, 'Leo''s mom sees no Maya goals');

-- Coach sets goal splits; family sees them
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select set_goal_splits((select v::uuid from ctx where k='goal'), array[1354, 1511, 1513, 1512]);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');  -- Maya herself
select pg_temp.expect((select goal_splits_cs from goals where id = (select v::uuid from ctx where k='goal')) = array[1354,1511,1513,1512],
  'swimmer sees coach''s goal splits');

-- ---------------- Other team ----------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect((select count(*) from meets) = 0, 'other coach cannot see team A meets');
select pg_temp.expect((select count(*) from result_edits) = 0, 'other coach cannot see team A edit log');
select pg_temp.expect_error($$ select import_meet((select v::uuid from ctx where k='teamA'),
  '{"name":"Sneaky","meet_date":"2026-10-02","course":"SCY"}',
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='maya'), 'distance', 50, 'stroke', 'FR', 'time_cs', 2500))) $$,
  'other coach cannot import into team A');
select pg_temp.expect_error($$ select import_meet((select v::uuid from ctx where k='teamB'),
  '{"name":"Sneaky","meet_date":"2026-10-02","course":"SCY"}',
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='maya'), 'distance', 50, 'stroke', 'FR', 'time_cs', 2500))) $$,
  'other coach cannot add team A swimmers to their own meet');
select pg_temp.expect_error($$ select set_goal_splits((select v::uuid from ctx where k='goal'), array[1,2]) $$,
  'other coach cannot set team A goal splits');
select pg_temp.expect_error($$ select delete_meet((select v::uuid from ctx where k='meet1b')) $$,
  'other coach cannot delete team A meets');

-- ---------------- Coach removes a meet ----------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select delete_meet((select v::uuid from ctx where k='meet1b'));
select pg_temp.expect((select count(*) from meets) = 0, 'coach removes a meet');
select pg_temp.expect((select count(*) from result_edits where action = 'delete') = 2, 'removed swims are logged');

reset role;
\echo ALL BATCH 1 PRIVACY TESTS PASSED
