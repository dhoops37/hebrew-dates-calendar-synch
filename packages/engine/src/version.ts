/**
 * Version stamp recorded on every generated occurrence.
 *
 * Bump `CALCULATION_VERSION` whenever a change could move an already-generated
 * occurrence: a rule change, a library upgrade that changes sunset output, or a
 * change to how instants are derived. Stored occurrences carry the version that
 * produced them, so a background job can find and requeue only what is stale.
 */
export const CALCULATION_VERSION = '1.0.0';

/** Recorded alongside results so a discrepancy report can be reproduced. */
export const CALCULATION_ENGINE = {
  version: CALCULATION_VERSION,
  hebrewCalendarLibrary: '@hebcal/core',
  /** Kept in sync with packages/engine/package.json; asserted in tests. */
  hebrewCalendarLibraryVersion: '6.8.2',
  sunsetAlgorithm: 'NOAA solar calculator (via @hebcal/noaa)',
  anniversaryRuleSource: 'Reingold & Dershowitz, Calendrical Calculations, pp. 111 & 113',
} as const;
