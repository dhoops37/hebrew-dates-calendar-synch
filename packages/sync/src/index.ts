/**
 * @hebrew-dates/sync — the reconciliation planner.
 *
 * Given what *should* be in a calendar and what the database records as
 * *actually* being there, decide the set of writes that closes the gap.
 *
 * This is a pure function on purpose. It is the highest-risk logic in the
 * product — get it wrong and users see duplicate yahrzeits, or worse, a missing
 * one — and keeping it free of network and database lets the whole decision
 * table be tested exhaustively in milliseconds. The Google client is a separate,
 * dumb executor of the plan this produces.
 *
 * ## Why convergent rather than event-sourced
 *
 * The planner never needs to have observed every intermediate state. It compares
 * desired against actual and issues the difference, so a missed webhook, a
 * crashed worker, a token that expired mid-run, or a user who deleted an event
 * by hand in Google all heal on the next pass.
 *
 * ## The safety properties it is responsible for
 *
 * 1. **No duplicates.** Every desired event is addressed by its occurrence key,
 *    so a retry after an ambiguous timeout updates rather than re-creates.
 * 2. **No silent wrong data.** A destination whose calculation location the user
 *    has not confirmed is blocked entirely: a wrong location is a wrong sunset
 *    every year, forever, and it would look authoritative.
 * 3. **The past is preserved.** Removing a record or changing a location does
 *    not rewrite history unless explicitly asked.
 * 4. **Failures are bounded.** Backoff is respected, and permanently failed
 *    states are reported rather than retried into a wall.
 */
export * from './plan';
