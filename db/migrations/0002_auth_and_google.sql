-- 0002_auth_and_google.sql — sessions, Google OAuth connections, audit log.
--
-- Split from 0001 because it is the first migration that stores a credential,
-- and credential storage deserves to be reviewable on its own.
--
-- Nothing here stores a token in plaintext. Refresh and access tokens are
-- envelope-encrypted by the application before they reach the database: the
-- ciphertext is a data key encrypted under a Google Cloud KMS key, and the key
-- version is stored beside it so rotation is possible without re-reading every
-- row. The database never sees a usable token, and neither does a backup.

BEGIN;

-- ------------------------------------------------------------------ sessions --

-- Server-side sessions. The cookie carries only a random identifier; nothing
-- about the user is derivable from it, and revoking is a DELETE.
CREATE TABLE sessions (
  -- sha256 of the cookie value. Storing the hash means a leaked database does
  -- not hand over usable sessions.
  id              bytea PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  -- Coarse provenance for a security review. Deliberately not a full user agent
  -- string or a precise IP: this is a personal-dates app, not an ad network.
  created_ip_prefix text,

  CONSTRAINT session_expiry_is_in_the_future CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- ------------------------------------------------------------- oauth states --

-- One row per in-flight authorisation request. Holds the PKCE verifier and the
-- CSRF state; deleted the moment the callback consumes it, so a replayed
-- callback finds nothing.
CREATE TABLE oauth_states (
  -- sha256 of the state parameter, for the same reason sessions hash their ID.
  state_hash     bytea PRIMARY KEY,
  -- PKCE code verifier, encrypted: it is a bearer secret for the duration of
  -- the flow.
  encrypted_code_verifier bytea NOT NULL,
  encryption_key_id       text NOT NULL,
  -- Where to send the user afterwards. Validated against an allow-list before
  -- use, so an open redirect cannot be smuggled in here.
  redirect_path  text,
  -- Set when an already-signed-in user is connecting a calendar rather than
  -- signing in for the first time.
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,

  CONSTRAINT oauth_state_expiry_is_in_the_future CHECK (expires_at > created_at)
);

CREATE INDEX oauth_states_expiry_idx ON oauth_states (expires_at);

-- ------------------------------------------------------- google connections --

-- One Google account as connected by one user. Separate from the calendar
-- connection below because one account can legitimately feed several
-- destination calendars.
CREATE TABLE google_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Google's stable subject identifier. Not the email: an email can change.
  google_subject          text NOT NULL,
  email                   citext,

  -- Envelope-encrypted refresh token. The plaintext never touches the database.
  encrypted_refresh_token bytea NOT NULL,
  -- The KMS key version the data key was wrapped with. Rotation re-wraps the
  -- data key and updates this; it does not require the token plaintext.
  encryption_key_id       text NOT NULL,

  -- Access tokens are short-lived and are NOT persisted. They are fetched with
  -- the refresh token and held in memory for the duration of a request or job.
  -- This column records when the last one expires only so a caller can decide
  -- whether to refresh pre-emptively.
  access_token_expires_at timestamptz,

  -- Exactly the scopes Google granted, as returned by the token endpoint. Stored
  -- so a scope change is detectable rather than assumed.
  granted_scopes          text NOT NULL,
  connection_status       text NOT NULL DEFAULT 'connected' CHECK (connection_status IN (
                            'connected', 'needs_reauth', 'revoked')),
  last_error              text,
  connected_at            timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT one_google_account_per_user UNIQUE (user_id, google_subject)
);

CREATE INDEX google_accounts_user_idx ON google_accounts (user_id);

-- Which Google calendar a destination writes to, and who authorised it.
CREATE TABLE google_calendar_connections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_calendar_id uuid NOT NULL UNIQUE
                            REFERENCES destination_calendars(id) ON DELETE CASCADE,
  google_account_id       uuid NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,

  -- Google's calendar ID. Null until the dedicated calendar has been created;
  -- the sync planner blocks writes while it is null.
  google_calendar_id      text,
  -- Whether this app created the calendar. Under the narrow
  -- calendar.app.created scope it always did, and the app must never attempt to
  -- write to a calendar it did not create.
  created_by_app          boolean NOT NULL DEFAULT true,
  last_sync_at            timestamptz,
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT app_owned_calendars_only CHECK (created_by_app)
);

CREATE INDEX google_calendar_connections_account_idx
  ON google_calendar_connections (google_account_id);

-- ----------------------------------------------------------------- audit log --

-- Administrative and security-relevant actions. Required by PRD 30 for
-- famous-yahrzeit editing, and useful well before that for connect/disconnect
-- and location confirmation.
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  subject_type text NOT NULL,
  subject_id   text,
  -- Non-sensitive context only. A serialiser allow-list enforces that; see
  -- docs/DATA-MODEL.md.
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_subject_idx ON audit_log (subject_type, subject_id, at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, at DESC);

-- ------------------------------------------------------------- corrections --

-- 0001 described generated_occurrences.sequence as "always 0 today". That is no
-- longer true: the default Adar convention observes an ordinary-Adar yahrzeit in
-- BOTH Adars of a leap year, so a single Hebrew year legitimately carries two
-- occurrences. 0001 is applied and therefore immutable, so the correction is
-- recorded here where the catalogue will carry it.
COMMENT ON COLUMN generated_occurrences.sequence IS
  'Ordinal within one Hebrew year. 0 for the single occurrence in an ordinary '
  'year and for Adar I in a leap year; 1 for Adar II. These numbers are '
  'load-bearing: they are part of the occurrence key, so reordering them '
  're-keys live calendar events.';

COMMIT;
