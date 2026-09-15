/**
 * @hebrew-dates/google-calendar — mapping a rendered occurrence to a Google
 * Calendar `Event` resource.
 *
 * Pure and credential-free on purpose: this is where the product's promises turn
 * into a specific API payload, and every one of those choices is worth pinning
 * in a test before a token exists to send it with.
 *
 * ## Decisions this file encodes
 *
 * - **`id` is deterministic**, derived upstream from the occurrence key and the
 *   destination. A retried insert therefore addresses the same event: Google
 *   answers 409 rather than creating a second one. Google requires base32hex
 *   (`[a-v0-9]`), 5–1024 characters, and the ID must be unique per calendar
 *   *including deleted events*, so the executor treats 409 as "exists, fetch and
 *   compare", never as a fatal error.
 * - **`transparency: 'transparent'`** always. A Hebrew date is not an
 *   appointment and must never make someone look busy.
 * - **`visibility: 'default'`** by default, so the calendar's own sharing
 *   settings decide who sees the details. A shared family calendar is the main
 *   way this product is used, and marking every event private would defeat it.
 *   `private` stays available per destination.
 * - **Timed events carry both an offset and a `timeZone`.** The offset comes
 *   from the *calculation location*, because that is where the sun set. The
 *   `timeZone` is the destination calendar's own zone, which only affects how a
 *   client renders an already-absolute instant. These are different things and
 *   are kept separate.
 * - **All-day events use `date`, and `end.date` is exclusive.** Covering two
 *   Gregorian days means `start = D-1`, `end = D+1`.
 * - **Provenance goes in `extendedProperties.private`**, which is queryable via
 *   `privateExtendedProperty` — that is how the reconciler finds app-managed
 *   events it has lost track of. Nothing sensitive goes in there.
 */
export * from './payload';
