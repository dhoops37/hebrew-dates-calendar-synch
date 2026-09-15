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
   them. Migrations take a session-scoped advisory lock and the job runner uses
   `FOR UPDATE SKIP LOCKED`; a transaction pooler breaks both silently, by
   multiplexing the transaction across connections so the lock protects nothing.

3. Confirm both strings end with `?sslmode=require`. The application refuses a
   remote database without it.

4. Apply the schema from your machine:

   ```bash
   export DATABASE_URL_DIRECT='postgres://...'   # the DIRECT one
   pnpm db:migrate
   pnpm db:status                                 # should show both applied
   ```

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
   | `DATABASE_URL_DIRECT` | the Neon **direct** string |
   | `GOOGLE_OAUTH_CLIENT_ID` | from step 2.4 |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | from step 2.4 |
   | `GOOGLE_OAUTH_REDIRECT_URI` | `https://YOUR-DOMAIN/auth/google/callback` |
   | `KMS_KEY_NAME` | the key resource name from step 2.5 |
   | `GOOGLE_APPLICATION_CREDENTIALS_JSON` | the whole service-account JSON, pasted as one line |
   | `APP_URL` | `https://YOUR-DOMAIN` |
   | `CRON_SECRET` | `openssl rand -hex 32` |

   Do **not** set `LOCAL_ENVELOPE_MASTER_KEY` in production. The application
   refuses to start with it and no KMS key, checking `VERCEL_ENV` as well as
   `NODE_ENV` — a Vercel preview also runs with `NODE_ENV=production`.

3. **Cron.** `vercel.json` registers `/api/cron/sync` every 15 minutes. Vercel
   sends `Authorization: Bearer $CRON_SECRET` automatically. The endpoint
   refuses to run at all without `CRON_SECRET` set, rather than defaulting to
   open: anyone able to call it could exhaust the Google quota every user
   depends on.

   Note that Vercel's Hobby plan allows cron only once per day. If you are on
   Hobby, either upgrade or change the schedule in `vercel.json` to `0 3 * * *`
   and accept that the horizon extends overnight rather than within minutes.

4. Deploy, then visit `/dashboard`. If anything is missing it names the exact
   variable rather than returning a blank error.

---

## 4. Verify it end to end

1. Visit the site and press **Add my dates to Google Calendar**.
2. The consent screen should show exactly three permissions, one of which reads
   like *"See, create, and edit only the calendars created by this app"*. If it
   asks for anything broader, stop — the scope configuration is wrong.
3. Confirm your location.
4. Press **Create my Hebrew Dates calendar**, then check Google Calendar: a new
   calendar named "Hebrew Dates" should appear in your list.
5. Add a date. Events should appear immediately, running sunset to sunset, shown
   as *free* rather than busy.
6. Press **Sync now** again. It should report "Everything is already up to
   date" and issue no writes.
7. Wait for a cron tick (or call the endpoint yourself with the secret) and
   confirm the horizon extends to twenty years.

---

## Local development

```bash
cp apps/web/.env.example apps/web/.env.local
# fill in DATABASE_URL, the OAuth client, and:
#   LOCAL_ENVELOPE_MASTER_KEY=$(openssl rand -base64 32)
#   CRON_SECRET=$(openssl rand -hex 32)

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
