/**
 * Stable identifiers and content hashing.
 *
 * These are what make synchronisation idempotent (PRD 19.5). Two properties
 * matter:
 *
 *  - **Stable**: the identifier for (source record, Hebrew year) is the same on
 *    every run, on every machine, forever. A retry after a timeout that
 *    actually succeeded therefore addresses the same destination event instead
 *    of creating a duplicate.
 *  - **Content-addressed**: the content hash changes if and only if something
 *    that reaches the destination event changes, so reconciliation can skip
 *    writes that would be no-ops.
 *
 * Note the `sequence` field. It is 0 today, but it is inside the identifier
 * from the start so that a future convention which observes a date twice in one
 * Hebrew year (e.g. both Adars) does not require re-keying every existing
 * event. See docs/DATA-MODEL.md.
 */
import { createHash } from 'node:crypto';

export interface OccurrenceKeyInput {
  sourceRecordId: string;
  hebrewYear: number;
  /** Reserved for conventions that produce more than one occurrence per year. */
  sequence?: number;
}

/** Deterministic 32-character hex key for one occurrence. */
export function occurrenceKey(input: OccurrenceKeyInput): string {
  const sequence = input.sequence ?? 0;
  return createHash('sha256')
    .update(`hebrew-dates:occurrence:v1:${input.sourceRecordId}:${input.hebrewYear}:${sequence}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Google Calendar event IDs must be base32hex ([a-v0-9]), 5-1024 characters,
 * and unique per calendar. Deriving one from the occurrence key lets an insert
 * be retried safely: a duplicate insert fails with 409 rather than creating a
 * second event.
 */
export function googleEventId(occurrenceKeyHex: string): string {
  const digest = createHash('sha256')
    .update(`hebrew-dates:google-event:v1:${occurrenceKeyHex}`)
    .digest();
  return `hd${toBase32Hex(digest).slice(0, 30)}`;
}

const BASE32HEX_ALPHABET = '0123456789abcdefghijklmnopqrstuv';

function toBase32Hex(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32HEX_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32HEX_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Hash of everything that would be written to a destination event.
 * Key order in the input object must not affect the result, so keys are sorted
 * recursively before serialising.
 */
export function contentHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 32);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
