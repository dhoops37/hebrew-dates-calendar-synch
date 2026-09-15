/**
 * @hebrew-dates/google-client — Google OAuth and Calendar, over `fetch`.
 *
 * Deliberately thin: this package speaks to Google and classifies what comes
 * back. It holds no database, no encryption and no scheduling; those live in
 * @hebrew-dates/service, which composes them.
 */
export * from './scopes';
export * from './errors';
export * from './oauth';
export * from './calendar';
