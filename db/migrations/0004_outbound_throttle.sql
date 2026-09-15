-- 0004_outbound_throttle.sql
--
-- A shared gate on outbound requests to a third-party API whose usage policy
-- limits the *application*, not the caller.
--
-- OpenStreetMap's Nominatim is the case that requires it: its policy is an
-- absolute maximum of one request per second from an application, and being
-- over it is grounds for a block. The existing throttle was in process memory,
-- which limits one Vercel instance. With N instances serving requests, N per
-- second go out — and the policy is not expressed per instance.
--
-- `rate_limits` cannot do this job. That table answers "has this caller had
-- too many?" and refuses when they have. Here the answer must be "wait your
-- turn", because a user searching for their town should not have their search
-- fail merely because a different user on a different instance searched 200ms
-- ago. So this table stores a *reservation*: the earliest instant the next
-- request may leave. Each caller atomically takes that instant as its slot and
-- pushes the marker one interval further.

BEGIN;

CREATE TABLE outbound_throttle (
  -- One row per rate-limited upstream, e.g. 'nominatim'. The caller names it;
  -- this table does not care what the name means.
  throttle_key       text PRIMARY KEY,

  -- The earliest instant at which the next request may be sent. A caller reads
  -- this under FOR UPDATE, takes max(it, now) as its own slot, and writes back
  -- that slot plus the minimum interval.
  --
  -- It therefore runs *ahead* of now() whenever requests are queued, and the
  -- distance ahead is exactly the current queue depth.
  next_available_at  timestamptz NOT NULL,

  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Deliberately no index beyond the primary key. This table holds one row per
-- upstream — single digits, forever — so every access is by key, and an index
-- on `updated_at` would only add write cost. It also needs no purge for the
-- same reason: unlike `rate_limits`, it does not grow with the number of
-- distinct callers.

COMMIT;
