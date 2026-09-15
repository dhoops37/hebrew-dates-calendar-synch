/**
 * The scopes this application requests, and nothing more.
 *
 * `calendar.app.created` is the only Calendar scope. It grants access **solely
 * to calendars this application created**, which is exactly the product: a
 * dedicated "Hebrew Dates" calendar. The app cannot read the user's other
 * calendars, cannot see their meetings, and cannot modify anything it did not
 * make. That is worth stating plainly because the broader `calendar` and
 * `calendar.events` scopes are the obvious defaults and both would let this
 * application read a user's entire schedule.
 *
 * `openid` and `email` identify the user so an account can exist at all. They
 * are not Calendar scopes and grant no calendar access.
 *
 * Deliberately NOT requested:
 *   - `calendar` / `calendar.events` — full read/write over every calendar.
 *   - `calendar.readonly` — read access to every calendar.
 *   - `calendar.calendarlist` — the list of calendars the user subscribes to.
 *   - `profile` — a name and picture the product does not use.
 *
 * Whether Google classifies `calendar.app.created` as sensitive, and therefore
 * what verification is required, must be read from the Google Cloud Console for
 * this specific project rather than assumed here. See docs/ARCHITECTURE.md.
 */

export const SCOPE_OPENID = 'openid';
export const SCOPE_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';

/** Read/write access limited to calendars created by this application. */
export const SCOPE_CALENDAR_APP_CREATED =
  'https://www.googleapis.com/auth/calendar.app.created';

/** Requested at sign-in, in this order. */
export const REQUESTED_SCOPES = [
  SCOPE_OPENID,
  SCOPE_EMAIL,
  SCOPE_CALENDAR_APP_CREATED,
] as const;

export const REQUESTED_SCOPE_STRING = REQUESTED_SCOPES.join(' ');

/**
 * The scopes without which the product cannot function.
 *
 * Google's consent screen lets a user untick individual scopes, and the token
 * response reports what was actually granted. A user who declined the calendar
 * scope must be told so, not left with an account that silently syncs nothing.
 */
export const REQUIRED_SCOPES = [SCOPE_CALENDAR_APP_CREATED] as const;

export interface ScopeCheck {
  granted: string[];
  missing: string[];
  sufficient: boolean;
}

/**
 * Compare what Google granted with what is needed.
 *
 * `openid`/`email` are checked loosely because Google reports them
 * inconsistently — sometimes as bare `openid`, sometimes as the full
 * userinfo.email URL — and neither is required for calendar sync to work.
 */
export function checkScopes(grantedScopeString: string): ScopeCheck {
  const granted = grantedScopeString.split(/\s+/).filter(Boolean);
  const grantedSet = new Set(granted);
  const missing = REQUIRED_SCOPES.filter((scope) => !grantedSet.has(scope));
  return { granted, missing, sufficient: missing.length === 0 };
}
