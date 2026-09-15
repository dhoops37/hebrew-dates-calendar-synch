/**
 * @hebrew-dates/geocoding — turning what a user typed into a place.
 *
 * Every result is a *candidate*, never a calculation location. Only a user
 * confirming a specific candidate makes it one, and only `packages/service`
 * performs that conversion. A time zone alone is never a location: see
 * `types.ts` for why that distinction is load-bearing rather than pedantic.
 */
export * from './types';
export * from './timezone';
export * from './catalogue';
export * from './nominatim';
export * from './composite';
export * from './resolve';
