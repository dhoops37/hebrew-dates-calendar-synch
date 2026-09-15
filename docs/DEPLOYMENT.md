# Deployment

Everything here needs accounts I cannot create. The application is built and
tested; these are the steps that turn it into a running deployment.

Do them in this order — each one produces a value the next needs.

---

## 1. Neon (PostgreSQL)

1. Create a project at <https://console.neon.tech>. Any region; pick the one
   nearest your Vercel region to keep latency down.
2. From the project dashboard, **copy both connection strings.** Neon shows them
   under *Connection Details*, with a toggle for "Pooled connection":
   - **Pooled** — the host contains `-pooler.` → this becomes `DATABASE_URL`
   - **Direct** — no `-pooler.` → this becomes `DATABASE_URL_DIRECT`

   These are not interchangeable and the application will refuse to confuse
   them. Migrations take a **session-scoped advisory lock**, held across several
   statements; a transaction pooler could serve those statements from different
   connections, so the lock would protect nothing. `pnpm db:migrate` therefore
   reads `DATABASE_URL_DIRECT` and refuses a `-pooler.` host.

   `DATABASE_URL_DIRECT` is only needed **where you run migrations from** — your
   own machine — not in Vercel. The running application uses the pooled string
   for everything, including the job runner: the job claim is deliberately a
   single statement, so its row locks live and die inside one implicit
   transaction, which a transaction pooler keeps on one connection.

3. Confirm both strings end with `?sslmode=require`. The application refuses a
   remote database without it.

4. Apply the schema from your machine:

   ```bash
   export DATABASE_URL_DIRECT='postgres://...'   # the DIRECT one
   pnpm db:migrate
   pnpm db:status                                 # all three should be APPLIED
   ```

   There are four migrations. `0003_rate_limits_and_geocoding.sql` is the one
   worth knowing about, because it changes a rule rather than only adding
   columns:

   - adds `rate_limits`, which is where the sign-in rate limiter keeps its
     counters. It is in Postgres rather than in memory because Vercel runs many
     instances and an in-memory limit would be per-instance, which is no limit
     at all. Rows older than 24 hours are deleted by the cron tick.
   - adds `calendar_locations.geocoder` and `.geocoder_display_name`, so a
     confirmed place records which service resolved it and under what name.
   - replaces `gregorian_entry_needs_sunset_status` with
     `unresolved_sunset_entry_cannot_be_active`. The old rule made "I don't know
     whether it was before or after sunset" unstorable, which is why the honest
     answer surfaced as an error. The new rule says such a record may exist but
     may not be **active** — so the refusal to guess is enforced by the database,
     and no code path, including one written later, can generate occurrences
     from a guess.

   `0004_outbound_throttle.sql` adds one small table, `outbound_throttle`, which
   holds the shared one-request-per-second reservation for OpenStreetMap's
   Nominatim. It has one row per upstream and never grows, so it needs no purge.

   `db:migrate` is safe to re-run: applied migrations are immutable by checksum
   and re-running is a no-op.

---

## 2. Google Cloud project

One project holds both the OAuth client and the KMS key.

1. Create a project at <https://console.cloud.google.com>.

2. **Enable the APIs.** *APIs & Services → Library*:
   - **Google Calendar API**
   - **Cloud Key Management Service (KMS) API**

3. **Configure the OAuth consent screen.** *APIs & Services → OAuth consent
   screen*:
   - User type: **External**
   - App name, support email, developer contact
   - App domain and privacy policy URL (needed for verification; a placeholder
     is fine while in Testing mode)
   - **Scopes** — add exactly these three:
     - `openid`
     - `.../auth/userinfo.email`
     - `.../auth/calendar.app.created`

     **Read what the Console says about `calendar.app.created` on this page.**
     It states the classification (non-sensitive / sensitive / restricted) and
     therefore what verification is required. I have deliberately not written a
     classification or a duration into these docs, because both change and the
     Console is the only authority. Tell me what it says and I will act on it.
   - Leave the publishing status as **Testing** and add yourself under **Test
     users**. Testing mode works fully for up to 100 users, so you can run a
     real deployment and a beta before verification completes.

4. **Create the OAuth client.** *APIs & Services → Credentials → Create
   credentials → OAuth client ID*:
   - Application type: **Web application**
   - **Authorised redirect URIs** — add every URL you will sign in from. They
     must match byte for byte, scheme included:
     - `http://localhost:3000/auth/google/callback`
     - `https://YOUR-PRODUCTION-DOMAIN/auth/google/callback`
     - `https://YOUR-PROJECT.vercel.app/auth/google/callback`

     Vercel preview deployments get a different hostname on every deploy, so
     preview sign-in needs either a stable preview domain or its own OAuth
     client. A mismatch here is the single most common cause of a
     `redirect_uri_mismatch` at the consent screen.
   - Copy the **client ID** and **client secret**.

5. **Create the KMS key.** *Security → Key Management*:
   - Create a **key ring** (e.g. `hebrew-dates`), location `global`
   - Create a key in it (e.g. `oauth-tokens`):
     - Purpose: **Symmetric encrypt/decrypt**
     - Rotation period: 90 days is a reasonable default. Rotation is safe —
       records sealed under an older version stay readable and are re-wrapped
       as they are used.
   - Copy the key's **resource name**. It looks like:

     ```
     projects/PROJECT/locations/global/keyRings/hebrew-dates/cryptoKeys/oauth-tokens
     ```

     Use the **key** name, not a version name. The application refuses a name
     ending in `/cryptoKeyVersions/N`, because pinning writes to a version
     would make rotating the key a silent no-op.

6. **Create a service account for the application** and give it access to the
   key. *IAM & Admin → Service Accounts → Create*:
   - Name it something like `hebrew-dates-app`
   - Grant it **`roles/cloudkms.cryptoKeyEncrypterDecrypter`** *on that key*
     (from the key's own permissions panel, not project-wide)
   - It also needs to read the key's primary version, which is covered by
     **`roles/cloudkms.viewer`** on the key ring
   - Create a **JSON key** and download it

   That JSON is a credential. Do not commit it.

---

## 3. Vercel

1. Import the repository at <https://vercel.com/new>. `vercel.json` in the
   repository root already sets the build command, the output directory and the
   cron schedule, so the defaults should need no adjustment.

2. **Environment variables** — *Settings → Environment Variables*. Set these for
   Production (and Preview, if you want preview sign-in to work):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon **pooled** string |
   | `GOOGLE_OAUTH_CLIENT_ID` | from step 2.4 |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | from step 2.4 |
   | `GOOGLE_OAUTH_REDIRECT_URI` | `https://YOUR-DOMAIN/auth/google/callback` |
   | `KMS_KEY_NAME` | the key resource name from step 2.5 |
   | `GOOGLE_APPLICATION_CREDENTIALS_JSON` | the whole service-account JSON, pasted as one line |
   | `APP_URL` | `https://YOUR-DOMAIN` |
   | `CRON_SECRET` | `openssl rand -hex 32` |
   | `GEOCODER_USER_AGENT` | `HebrewDates/1.0 (https://YOUR-DOMAIN; you@example.com)` |

   `GEOCODER_USER_AGENT` is the only optional one, and it is the one that
   decides whether city search works. It enables the OpenStreetMap Nominatim
   backend, which needs no API key but whose usage policy requires a User-Agent
   identifying the deployment and a way to contact whoever runs it. Unset, the
   application falls back to a built-in list of 22 cities — it still works, but
   it will not find most people's town, and the dashboard's Connection panel
   says which backend is in use.

   Put a real contact address in it. An application that cannot be contacted
   about a problem gets blocked rather than emailed.

   Two further variables exist and are optional:

   | Variable | Effect |
   |---|---|
   | `GEOCODER_ENDPOINT` | Point at a self-hosted Nominatim or a compatible mirror instead of the public service. |
   | `GEOCODER_UNTHROTTLED` | `1` lifts the shared one-request-per-second gate. **Only honoured together with `GEOCODER_ENDPOINT`**, because lifting it against the public service is precisely what its policy forbids. |

   The one-per-second limit is enforced **application-wide**, not per user and
   not per instance: the reservation lives in the `outbound_throttle` table, so
   however many Vercel instances are warm, they take turns from one shared
   queue. If the queue is more than six seconds deep the search falls back to
   the built-in city list rather than leaving someone watching a spinner.
   Results are cached for ten minutes, including confirmations, so refining a
   search or stepping back does not re-ask. An unreachable Nominatim degrades to
   the built-in list and logs a warning, so a quiet outage is visible.

   The dashboard's Connection panel states which backend is in use and whether
   the shared limit is in force. If it ever says the limit is **not** in force
   while live search is on, stop and fix that before letting anyone else use the
   deployment.

   Do **not** set `LOCAL_ENVELOPE_MASTER_KEY` in production. The application
   refuses to start with it and no KMS key, checking `VERCEL_ENV` as well as
   `NODE_ENV` — a Vercel preview also runs with `NODE_ENV=production`.

3. **Cron.** `vercel.json` registers `/api/cron/sync` **once a day at 03:00
   UTC** (`0 3 * * *`). Vercel sends `Authorization: Bearer $CRON_SECRET`
   automatically. The endpoint refuses to run at all without `CRON_SECRET` set,
   rather than defaulting to open: anyone able to call it could exhaust the
   Google quota every user depends on.

   Daily is chosen so the repository deploys on **Vercel Hobby**, which permits
   cron only once per day and will reject a more frequent schedule. Nothing the
   private beta needs is lost by it — see below.

   **What the daily schedule delays.** Adding a date writes the first two
   Hebrew years synchronously, so events appear in Google Calendar
   immediately; the remaining eighteen are queued and arrive on the next tick.
   Retries after a transient Google failure also wait for a tick. Neither
   matters for personal use, and **Sync now** on the dashboard runs the same
   work on demand whenever you do not want to wait.

   **Switching back on Vercel Pro.** Change the one line in `vercel.json`:

   ```json
   "crons": [{ "path": "/api/cron/sync", "schedule": "*/15 * * * *" }]
   ```

   and redeploy — the schedule is read from the deployed `vercel.json`, so there
   is nothing to configure in the dashboard. Every-15-minutes is what the design
   assumes: `maxDuration` is 60s, the runner has its own smaller time budget and
   requeues what it cannot finish, and jobs are idempotent under
   `FOR UPDATE SKIP LOCKED`, so overlapping invocations claim different work.
   Nothing else needs to change at any frequency down to about a minute.

4. Deploy, then visit `/dashboard`. If anything is missing it names the exact
   variable rather than returning a blank error.

---

## 4. Verify it end to end

This is the whole individual flow. Do it against the real deployment with your
own Google account, and check Google Calendar itself at each step rather than
trusting the dashboard.

1. **Sign in.** Visit the site and press **Add my dates to Google Calendar**.
   The consent screen should show exactly three permissions, one of which reads
   like *"See, create, and edit only the calendars created by this app"*. If it
   asks for anything broader, stop — the scope configuration is wrong.

2. **Confirm your location.** Search for your town. You should see the resolved
   name, its time zone and its coordinates *before* anything is saved, and you
   have to press **Use this location** for it to become a calculation location.
   A time zone alone is never enough: a zone spans hundreds of miles and sunset
   differs across it by the better part of an hour.

   If search returns nothing but the 22-city list, `GEOCODER_USER_AGENT` is not
   set — check the Connection panel at the bottom of the dashboard, which names
   the backend in use.

3. **Create the calendar.** Press **Create my Hebrew Dates calendar**, then
   check Google Calendar: a new calendar named "Hebrew Dates" appears in your
   list. Nothing is written to any other calendar, and the app cannot see them.

4. **Add a Hebrew date.** Events appear immediately, running sunset to sunset,
   shown as *free* rather than busy. Each year is its own event on its own
   Gregorian date — there is deliberately no yearly recurrence, because a
   Gregorian yearly rule is wrong for a Hebrew date.

5. **Add a date by English date, and answer the sunset question.** Choose *I
   know the English (Gregorian) date*, enter one, and leave **I am not sure**
   selected. The dashboard should then show, above everything else:

   - both candidate Hebrew dates, a day apart;
   - the calculated local sunset at your confirmed location on that date;
   - why the answer matters;
   - and where people usually find it out.

   Nothing is written to the calendar until you choose. Confirm that: the date
   is in your list marked *awaiting your answer*, and Google Calendar has no
   events for it. Then choose one, and the events appear.

6. **Sync again.** Press **Sync now**. It should report "Everything is already
   up to date" and issue no writes.

7. **Edit.** Change the Hebrew date on one of your entries. Watch the
   reconciliation: every future event moves to its new Gregorian date, and the
   **Google event IDs stay the same** — the app issues PATCHes rather than
   deleting and recreating, so a reminder you added by hand survives and you are
   not re-notified about twenty years at once. Check one event in Google
   Calendar before and after to confirm it moved rather than being replaced.

8. **Delete.** Press **Delete** on an entry. Before committing, it tells you
   exactly how many future events will be removed and how many past ones will
   be kept, from the same counts the deletion then acts on. Confirm, then check
   Google Calendar: future events gone, past anniversaries still there. That
   last part is the policy, not an oversight — an anniversary someone has
   already observed stays in their calendar.

9. **Let the cron tick.** Wait for a tick (or call the endpoint yourself with
   the secret) and confirm the horizon extends to twenty years.

---

## Local development

```bash
cp apps/web/.env.example apps/web/.env.local
# fill in DATABASE_URL, the OAuth client, and:
#   LOCAL_ENVELOPE_MASTER_KEY=$(openssl rand -base64 32)
#   CRON_SECRET=$(openssl rand -hex 32)
# optionally, to make city search work locally:
#   GEOCODER_USER_AGENT=HebrewDates/0.1 (local dev; you@example.com)

pnpm install
pnpm db:migrate
pnpm dev            # http://localhost:3000
```

Use `pnpm dev`, not `pnpm start`: `next start` sets `NODE_ENV=production` and
the local key manager correctly refuses to run there.

### Running the tests

```bash
pnpm test           # every package; database suites skip if no database

# With a database, which is how the integration suites actually run:
export TEST_DATABASE_URL='postgres://user@localhost:5432/postgres'
pnpm test
```

`TEST_DATABASE_URL` must point at a database where the user may `CREATE
DATABASE`: each integration file creates and drops its own throwaway database,
so a failing test cannot poison its neighbours.

---

## Rate limits

Three endpoints are limited, by a fixed window kept in the `rate_limits` table:

| What | Limit | Window | Keyed by |
|---|---|---|---|
| `/auth/google/start` | 20 | 15 minutes | client `/24` (or IPv6 `/48`) |
| `/auth/google/callback` | 40 | 15 minutes | client `/24` |
| place search | 60 | 5 minutes | signed-in user |

The sign-in limits exist because `/auth/google/start` writes a row and issues a
redirect for anyone who asks; without a limit, a loop over it fills
`oauth_states` and burns the OAuth client's quota. The counters are keyed by a
three-octet prefix rather than a full address — enough to stop a loop, less than
is needed to track anyone.

The counting is one atomic upsert, so concurrent instances cannot each let a
request through; this is verified in the test suite with ten concurrent
connections against a limit of three. Exceeding a limit returns a readable 429
page with `retry-after`, and the first rejection in a window records an
`auth.rate_limited` audit event carrying the prefix and the attempt count.

To raise a limit, change `RATE_LIMITS` in `packages/db/src/rate-limit.ts`. To see
what is currently limited:

```sql
SELECT bucket, attempts, window_start FROM rate_limits ORDER BY updated_at DESC;
```

The cron tick deletes rows whose window closed more than 24 hours ago, so the
table does not grow.

---

## A note on service-account keys

The KMS credential in `GOOGLE_APPLICATION_CREDENTIALS_JSON` is a long-lived
private key in an environment variable. That is acceptable for a private beta
with one operator, and it is what the steps above set up.

It is not where this should end up. Workload Identity Federation lets Vercel
exchange a short-lived OIDC token for Google credentials with no stored private
key at all, which removes the one secret here that cannot be rotated by
rotating something else. It is listed in `docs/ROADMAP.md` as a gate before
public launch, not before personal use.

---

## What to do about key rotation

Nothing, normally. KMS rotates on its schedule, new writes use the new primary
version, and existing records are re-wrapped the next time each account's token
is used. To see how many records are still on an old version:

```sql
SELECT encryption_key_id, count(*)
  FROM google_accounts
 GROUP BY encryption_key_id;
```

If you ever need to force it, touching each account's token read path is enough
— there is no separate migration to run.
