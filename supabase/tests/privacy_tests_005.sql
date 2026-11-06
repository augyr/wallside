\set ON_ERROR_STOP on
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect((select gender from swimmers where id = (select v::uuid from ctx where k='leo')) is null, 'gender starts empty');
select import_meet((select v::uuid from ctx where k='teamA'), '{"name":"Gender Meet","meet_date":"2026-11-02","course":"SCY"}'::jsonb,
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='leo'), 'distance', 50, 'stroke', 'FR', 'time_cs', 3000, 'gender', 'M')));
select pg_temp.expect((select gender from swimmers where id = (select v::uuid from ctx where k='leo')) = 'M', 'gender filled from results');
update swimmers set gender = 'F' where id = (select v::uuid from ctx where k='leo');
select import_meet((select v::uuid from ctx where k='teamA'), '{"name":"Gender Meet 2","meet_date":"2026-11-03","course":"SCY"}'::jsonb,
  jsonb_build_array(jsonb_build_object('swimmer_id', (select v from ctx where k='leo'), 'distance', 50, 'stroke', 'FR', 'time_cs', 3000, 'gender', 'M')));
select pg_temp.expect((select gender from swimmers where id = (select v::uuid from ctx where k='leo')) = 'F', 'results never overwrite a gender the coach set');
reset role;
\echo ALL STANDARDS TESTS PASSED
