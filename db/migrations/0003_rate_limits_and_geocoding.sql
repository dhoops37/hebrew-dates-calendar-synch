-- 0003_rate_limits_and_geocoding.sql
--
-- Three small additions needed before a real deployment:
--
--   1. A rate-limit counter, so an unauthenticated caller cannot make this
--      application insert rows on their behalf all day.
--   2. Somewhere to record which geocoder resolved a location, now that a
--      location can come from a search rather than a fixed catalogue.
--   3. A relaxation of one CHECK that was too strict: a Gregorian-entered date
--      whose sunset status the user has not yet settled has to be storable as a
--      *draft*, because "ask the user" is a state the product has.

BEGIN;

-- ------------------------------------------------------------ rate limits --

-- A fixed-window counter, keyed by whatever the caller is being limited on.
--
-- Deliberately in Postgres rather than in memory: Vercel runs many instances
-- and an in-memory counter limits one instance rather than one caller, which is
-- the same as not limiting at all. Deliberately not Redis, for the same reason
-- the job queue is not Redis — this is a few rows per minute.
--
-- The window start is stored rather than a sliding log of timestamps. A fixed
-- window lets a caller burst at a boundary, which is an accepted trade: the
-- purpose here is to stop a script hammering the endpoint, not to smooth
-- traffic precisely.
CREATE TABLE rate_limits (
  -- e.g. 'auth.start:203.0.113'. The caller composes it; this table does not
  -- care what the parts mean.
  bucket        text PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The purge query. Old windows are worthless, and this table would otherwise
-- grow one row per distinct caller forever.
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);

-- ------------------------------------------------------------- geocoding --

-- Which provider resolved this location, when one did. Recorded so that a
-- provider change is visible in the data rather than inferred, and so a
-- location resolved by a provider we later stop trusting can be found.
ALTER TABLE calendar_locations
  ADD COLUMN geocoder text;

-- The raw display name the provider returned, before any tidying. Kept
-- separately from `display_name`, which is what the user saw and confirmed:
-- if they are ever different, the one the user agreed to is the one that counts.
ALTER TABLE calendar_locations
  ADD COLUMN geocoder_display_name text;

COMMENT ON COLUMN calendar_locations.geocoder IS
  'Provider that resolved these coordinates (e.g. ''nominatim''), or NULL for a '
  'location taken from the built-in catalogue or entered by hand.';

-- ------------------------------------------- the unresolved-sunset draft --

-- 0001 required that a Gregorian-entered date state which side of sunset it
-- fell on:
--
--   CONSTRAINT gregorian_entry_needs_sunset_status
--     CHECK (original_gregorian_date IS NULL OR sunset_status IS NOT NULL)
--
-- That encoded the right rule — never silently choose a Hebrew date — but it
-- encoded it in a way that made the honest answer unstorable. A user who does
-- not know whether a death was before or after sunset has to be *asked*, and
-- until they answer, the entry exists and is incomplete. Forbidding the row
-- forced the application to throw instead, which is how "I'm not sure" ended up
-- surfacing as an error.
--
-- So the rule moves rather than weakens: an under-specified entry may exist,
-- but it may not be ACTIVE, and the sync planner only ever generates for active
-- records. The database still guarantees that nothing reaches a calendar on a
-- guess.
ALTER TABLE source_records
  DROP CONSTRAINT gregorian_entry_needs_sunset_status;

ALTER TABLE source_records
  ADD CONSTRAINT unresolved_sunset_entry_cannot_be_active
    CHECK (
      original_gregorian_date IS NULL
      OR sunset_status IS NOT NULL
      OR active = false
    );

COMMENT ON CONSTRAINT unresolved_sunset_entry_cannot_be_active ON source_records IS
  'A Gregorian-entered date with no sunset status is a draft awaiting the user''s '
  'answer. It may be stored, but not activated, so no occurrence is ever '
  'generated from a guess.';

-- Drafts are listed prominently in the UI, so they get their own index.
CREATE INDEX source_records_awaiting_sunset_idx
  ON source_records (dataset_id)
  WHERE original_gregorian_date IS NOT NULL
    AND sunset_status IS NULL
    AND deleted_at IS NULL;

COMMIT;
