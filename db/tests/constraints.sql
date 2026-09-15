-- Constraint verification for 0001_init.sql, by hand.
--
-- SUPERSEDED for CI by `packages/db/test/integration/constraints.test.ts`, which
-- covers everything here plus 0002, pins the constraint name each rejection came
-- from, and runs from `pnpm test:db`. This file is kept because reading a
-- rejection in psql is the fastest way to understand a constraint, and because
-- it needs nothing but psql.
--
-- Run against a throwaway database after applying the migrations:
--   createdb hebrewdates_test
--   DATABASE_URL=postgres://.../hebrewdates_test pnpm db:migrate
--   psql -d hebrewdates_test -f db/tests/constraints.sql
--
-- Every step labelled REJECT must print an ERROR, and every ACCEPT must not.
-- These are product rules expressed as constraints, so a regression here is a
-- regression in behaviour, not merely in schema style.
--
-- Verified against PostgreSQL 16: every step behaves as labelled.

-- Does the schema actually enforce the product rules?
\set ON_ERROR_STOP off
\pset tuples_only on

-- Seed: one household, two members in two cities, one shared dataset.
INSERT INTO users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'a@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.test');
INSERT INTO owners (id, kind, name)
  VALUES ('33333333-3333-3333-3333-333333333333', 'household', 'The Family');
INSERT INTO owner_members (owner_id, user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'admin'),
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'editor');
INSERT INTO datasets (id, owner_id, name)
  VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'Family dates');

-- Note the calendar_timezone_hint: Aharon's Google calendar is set to UTC even
-- though he lives in Jerusalem. That must not affect his sunset times.
INSERT INTO destination_calendars
  (id, dataset_id, user_id, name, destination_type, calendar_timezone_hint) VALUES
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444',
   '11111111-1111-1111-1111-111111111111', 'Aharon — Jerusalem', 'google', 'UTC'),
  ('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444',
   '22222222-2222-2222-2222-222222222222', 'Batya — Melbourne', 'ical_feed', 'Australia/Melbourne');

INSERT INTO calendar_locations
  (destination_calendar_id, display_name, country_code, latitude, longitude, elevation_meters,
   timezone_id, source, confirmed_at, confirmed_by_user_id)
VALUES
  ('55555555-5555-5555-5555-555555555555', 'Jerusalem, Israel', 'IL', 31.7683, 35.2137, 754,
   'Asia/Jerusalem', 'user_selected', now(), '11111111-1111-1111-1111-111111111111'),
  -- Batya's is a suggestion she has NOT confirmed yet.
  ('66666666-6666-6666-6666-666666666666', 'Melbourne, Australia', 'AU', -37.8136, 144.9631, 31,
   'Australia/Melbourne', 'calendar_timezone_hint', NULL, NULL);

\echo '--- 1. elevation defaults to true (decision #8)'
SELECT 'use_elevation=' || use_elevation FROM calendar_locations LIMIT 1;

\echo '--- 2. events default to Google visibility "default" (calendar sharing governs)'
SELECT 'visibility=' || event_visibility FROM destination_calendars LIMIT 1;

\echo '--- 2b. REJECT: any visibility outside Google''s vocabulary'
INSERT INTO destination_calendars (dataset_id, name, destination_type, event_visibility)
  VALUES ('44444444-4444-4444-4444-444444444444', 'Bad', 'google', 'calendar_default');

\echo '--- 2c. location and calendar time zone are separate columns and may differ'
SELECT 'calendar hint=' || dc.calendar_timezone_hint || ' | location zone=' || cl.timezone_id
       || ' | lat=' || cl.latitude
  FROM destination_calendars dc
  JOIN calendar_locations cl ON cl.destination_calendar_id = dc.id
 WHERE dc.id = '55555555-5555-5555-5555-555555555555';

\echo '--- 2d. which destinations are NOT cleared to receive events (unconfirmed location)'
SELECT 'unconfirmed: ' || dc.name || ' (source=' || cl.source || ')'
  FROM calendar_locations cl
  JOIN destination_calendars dc ON dc.id = cl.destination_calendar_id
 WHERE cl.confirmed_at IS NULL;

\echo '--- 2e. REJECT: a confirmation with no confirmer recorded'
UPDATE calendar_locations SET confirmed_at = now()
 WHERE destination_calendar_id = '66666666-6666-6666-6666-666666666666';

\echo '--- 2f. ACCEPT: confirming properly, with who confirmed it'
UPDATE calendar_locations
   SET confirmed_at = now(), confirmed_by_user_id = '22222222-2222-2222-2222-222222222222',
       source = 'user_selected'
 WHERE destination_calendar_id = '66666666-6666-6666-6666-666666666666';
SELECT 'confirmed locations: ' || count(*) FROM calendar_locations WHERE confirmed_at IS NOT NULL;

\echo '--- 3. pausing hides future events (decision #13)'
SELECT 'pause=' || pause_behaviour FROM datasets LIMIT 1;

\echo '--- 4. convention defaults to BOTH Adars (decision #4)'
INSERT INTO source_records (id, dataset_id, type, display_name, hebrew_month, hebrew_day, original_hebrew_year)
  VALUES ('77777777-7777-7777-7777-777777777777', '44444444-4444-4444-4444-444444444444',
          'personal_yahrzeit', 'Zayde', 'ADAR', 10, 5785);
SELECT 'convention=' || (calculation_convention->>'adarOrdinaryYahrzeitInLeapYear') FROM source_records;

\echo '--- 5. REJECT: yahrzeit on 30 Cheshvan with no Hebrew year of death'
INSERT INTO source_records (dataset_id, type, display_name, hebrew_month, hebrew_day)
  VALUES ('44444444-4444-4444-4444-444444444444', 'personal_yahrzeit', 'Unknown', 'CHESHVAN', 30);

\echo '--- 6. ACCEPT: the same record once the year is supplied'
INSERT INTO source_records (dataset_id, type, display_name, hebrew_month, hebrew_day, original_hebrew_year)
  VALUES ('44444444-4444-4444-4444-444444444444', 'personal_yahrzeit', 'Known', 'CHESHVAN', 30, 5783);

\echo '--- 7. ACCEPT: a BIRTHDAY on 30 Cheshvan with no year (rules do not need it)'
INSERT INTO source_records (dataset_id, type, display_name, hebrew_month, hebrew_day)
  VALUES ('44444444-4444-4444-4444-444444444444', 'birthday', 'Birthday', 'CHESHVAN', 30);

\echo '--- 8. REJECT: a Gregorian date with no before/after-sunset answer'
INSERT INTO source_records (dataset_id, type, display_name, hebrew_month, hebrew_day, original_gregorian_date)
  VALUES ('44444444-4444-4444-4444-444444444444', 'birthday', 'No sunset status', 'IYYAR', 5, '1978-05-12');

\echo '--- 9. REJECT: 30 Adar II, which never exists'
INSERT INTO source_records (dataset_id, type, display_name, hebrew_month, hebrew_day)
  VALUES ('44444444-4444-4444-4444-444444444444', 'birthday', 'Impossible', 'ADAR_II', 30);

\echo '--- 10. two observances in one Hebrew year (both Adars) are allowed'
INSERT INTO generated_occurrences
  (id, source_record_id, hebrew_year, sequence, occurrence_key, hebrew_month, hebrew_day,
   gregorian_date, calculation_version, rule_applied)
VALUES
  ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777', 5787, 0,
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0', 12, 10, '2027-02-17', '1.0.0', 'ADAR_ORDINARY_TO_ADAR_I'),
  ('99999999-9999-9999-9999-999999999999', '77777777-7777-7777-7777-777777777777', 5787, 1,
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 13, 10, '2027-03-19', '1.0.0', 'ADAR_ORDINARY_TO_ADAR_II');
SELECT 'occurrences in 5787: ' || count(*) FROM generated_occurrences WHERE hebrew_year = 5787;

\echo '--- 11. REJECT: a third occurrence reusing sequence 0'
INSERT INTO generated_occurrences
  (source_record_id, hebrew_year, sequence, occurrence_key, hebrew_month, hebrew_day,
   gregorian_date, calculation_version, rule_applied)
VALUES ('77777777-7777-7777-7777-777777777777', 5787, 0, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        12, 10, '2027-02-17', '1.0.0', 'ADAR_ORDINARY_TO_ADAR_I');

\echo '--- 12. THE FAMILY CASE: one occurrence, two members, two different sunset windows'
INSERT INTO destination_events
  (generated_occurrence_id, destination_calendar_id, destination_type, external_calendar_id,
   external_event_id, start_at, end_at, timezone_id, location_snapshot, content_hash, sync_status)
VALUES
  ('88888888-8888-8888-8888-888888888888', '55555555-5555-5555-5555-555555555555', 'google',
   'cal-jlm', 'hdaaa', '2027-02-16T15:32:00Z', '2027-02-17T15:33:00Z', 'Asia/Jerusalem',
   '{"displayName":"Jerusalem, Israel"}', 'hash-jlm-000000000000000000000', 'synced'),
  ('88888888-8888-8888-8888-888888888888', '66666666-6666-6666-6666-666666666666', 'ical_feed',
   'feed-mel', 'hdbbb', '2027-02-16T08:12:00Z', '2027-02-17T08:11:00Z', 'Australia/Melbourne',
   '{"displayName":"Melbourne, Australia"}', 'hash-mel-000000000000000000000', 'synced');
SELECT 'events for one occurrence: ' || count(*) || ' in zones ' || string_agg(timezone_id, ', ' ORDER BY timezone_id)
  FROM destination_events WHERE generated_occurrence_id = '88888888-8888-8888-8888-888888888888';

\echo '--- 13. REJECT: a second event for the same occurrence in the SAME member calendar'
INSERT INTO destination_events
  (generated_occurrence_id, destination_calendar_id, destination_type, external_calendar_id,
   external_event_id, timezone_id, location_snapshot, content_hash, sync_status)
VALUES ('88888888-8888-8888-8888-888888888888', '55555555-5555-5555-5555-555555555555', 'google',
        'cal-jlm', 'hdccc', 'Asia/Jerusalem', '{}', 'hash-dup-000000000000000000000', 'pending');

\echo '--- 14. REJECT: two rows pointing at the same external calendar event'
INSERT INTO destination_events
  (generated_occurrence_id, destination_calendar_id, destination_type, external_calendar_id,
   external_event_id, timezone_id, location_snapshot, content_hash, sync_status)
VALUES ('99999999-9999-9999-9999-999999999999', '55555555-5555-5555-5555-555555555555', 'google',
        'cal-jlm', 'hdaaa', 'Asia/Jerusalem', '{}', 'hash-x-00000000000000000000000', 'pending');

\echo '--- 15. REJECT: a half-specified sunset window'
INSERT INTO destination_events
  (generated_occurrence_id, destination_calendar_id, destination_type, external_calendar_id,
   external_event_id, start_at, timezone_id, location_snapshot, content_hash, sync_status)
VALUES ('99999999-9999-9999-9999-999999999999', '66666666-6666-6666-6666-666666666666', 'ical_feed',
        'feed-mel', 'hdddd', '2027-03-18T08:00:00Z', 'Australia/Melbourne', '{}',
        'hash-y-00000000000000000000000', 'pending');

\echo '--- 16. ACCEPT: no sunset at all (polar latitude) stays representable'
INSERT INTO destination_events
  (generated_occurrence_id, destination_calendar_id, destination_type, external_calendar_id,
   external_event_id, start_at, end_at, timezone_id, location_snapshot, content_hash, sync_status)
VALUES ('99999999-9999-9999-9999-999999999999', '66666666-6666-6666-6666-666666666666', 'ical_feed',
        'feed-mel', 'hdeee', NULL, NULL, 'Australia/Melbourne', '{}',
        'hash-z-00000000000000000000000', 'pending');
SELECT 'all-day-only events: ' || count(*) FROM destination_events WHERE start_at IS NULL;

\echo '--- 17. deleting the dataset cascades to everything below it'
DELETE FROM datasets WHERE id = '44444444-4444-4444-4444-444444444444';
SELECT 'remaining source_records: ' || count(*) FROM source_records;
SELECT 'remaining occurrences: ' || count(*) FROM generated_occurrences;
SELECT 'remaining destination_events: ' || count(*) FROM destination_events;
SELECT 'remaining destination_calendars: ' || count(*) FROM destination_calendars;
