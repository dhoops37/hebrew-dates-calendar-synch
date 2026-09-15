/**
 * `tz-lookup` ships no types. It has exactly one export.
 *
 * Declared here rather than pulled from DefinitelyTyped because the surface is
 * a single function and an extra dependency for one signature is not worth it.
 */
declare module 'tz-lookup' {
  /** The IANA zone containing a point. Throws for out-of-range input. */
  export default function tzLookup(latitude: number, longitude: number): string;
}
