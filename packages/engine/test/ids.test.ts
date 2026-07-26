/**
 * Idempotency primitives (PRD 19.5, risk "Duplicate calendar events").
 */
import { describe, expect, it } from 'vitest';
import { contentHash, googleEventId, occurrenceKey, stableStringify } from '../src/ids';
import { generateOccurrences } from '../src/occurrences';
import { getSeedLocation } from '../src/locations';

const jerusalem = getSeedLocation('seed:jerusalem')!;
const NOW = Date.UTC(2025, 0, 15, 12, 0, 0);

describe('occurrence keys', () => {
  it('is stable for the same source record and Hebrew year', () => {
    const first = occurrenceKey({ sourceRecordId: 'record-1', hebrewYear: 5786 });
    const second = occurrenceKey({ sourceRecordId: 'record-1', hebrewYear: 5786 });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs across source records, years and sequences', () => {
    const keys = new Set([
      occurrenceKey({ sourceRecordId: 'record-1', hebrewYear: 5786 }),
      occurrenceKey({ sourceRecordId: 'record-2', hebrewYear: 5786 }),
      occurrenceKey({ sourceRecordId: 'record-1', hebrewYear: 5787 }),
      occurrenceKey({ sourceRecordId: 'record-1', hebrewYear: 5786, sequence: 1 }),
    ]);
    expect(keys.size).toBe(4);
  });

  it('treats an omitted sequence as sequence zero', () => {
    expect(occurrenceKey({ sourceRecordId: 'record-1', hebrewYear: 5786 })).toBe(
      occurrenceKey({ sourceRecordId: 'record-1', hebrewYear: 5786, sequence: 0 }),
    );
  });
});

describe('Google event IDs', () => {
  const id = googleEventId(occurrenceKey({ sourceRecordId: 'record-1', hebrewYear: 5786 }));

  it('uses only characters Google accepts (base32hex) and a legal length', () => {
    expect(id).toMatch(/^[a-v0-9]+$/);
    expect(id.length).toBeGreaterThanOrEqual(5);
    expect(id.length).toBeLessThanOrEqual(1024);
  });

  it('is deterministic, so a retried insert addresses the same event', () => {
    expect(googleEventId(occurrenceKey({ sourceRecordId: 'record-1', hebrewYear: 5786 }))).toBe(id);
  });

  it('is unique across a realistic set of records and years', () => {
    const ids = new Set<string>();
    for (let record = 0; record < 50; record++) {
      for (let year = 5786; year < 5806; year++) {
        ids.add(googleEventId(occurrenceKey({ sourceRecordId: `record-${record}`, hebrewYear: year })));
      }
    }
    expect(ids.size).toBe(50 * 20);
  });
});

describe('content hashing', () => {
  it('ignores key order', () => {
    expect(contentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(contentHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('ignores undefined values but not null', () => {
    expect(contentHash({ a: 1, b: undefined })).toBe(contentHash({ a: 1 }));
    expect(contentHash({ a: 1, b: null })).not.toBe(contentHash({ a: 1 }));
  });

  it('changes when any meaningful field changes', () => {
    const base = { title: 'x', startIso: '2025-01-01T17:00:00+02:00' };
    expect(contentHash({ ...base, title: 'y' })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, startIso: '2025-01-01T17:01:00+02:00' })).not.toBe(
      contentHash(base),
    );
  });

  it('serialises arrays in order', () => {
    expect(stableStringify([1, 2])).toBe('[1,2]');
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });
});

describe('reconciliation behaviour end to end', () => {
  function run(location = jerusalem, displayName = 'David') {
    const result = generateOccurrences({
      sourceRecordId: 'record-1',
      type: 'birthday',
      displayName,
      origin: { month: 'NISAN', day: 10 },
      location,
      displayMode: 'exact_sunset',
      count: 20,
      nowEpochMs: NOW,
    });
    if (result.status !== 'ok') throw new Error('expected occurrences');
    return result.occurrences;
  }

  it('produces the same keys and hashes on a repeat run, so a re-sync is a no-op', () => {
    const first = run();
    const second = run();
    expect(second.map((o) => o.key)).toEqual(first.map((o) => o.key));
    expect(second.map((o) => o.contentHash)).toEqual(first.map((o) => o.contentHash));
    expect(second.map((o) => o.googleEventId)).toEqual(first.map((o) => o.googleEventId));
  });

  it('keeps the keys but changes the hashes when the location changes', () => {
    // A location change must update existing events rather than create new ones.
    const before = run();
    const after = run(getSeedLocation('seed:new-york')!);
    expect(after.map((o) => o.key)).toEqual(before.map((o) => o.key));
    expect(after.map((o) => o.contentHash)).not.toEqual(before.map((o) => o.contentHash));
  });

  it('changes the hashes when the title changes', () => {
    const before = run();
    const after = run(jerusalem, 'Dovid');
    expect(after.map((o) => o.key)).toEqual(before.map((o) => o.key));
    expect(after[0]!.contentHash).not.toBe(before[0]!.contentHash);
  });

  it('gives every occurrence in a run a unique key', () => {
    const occurrences = run();
    expect(new Set(occurrences.map((o) => o.key)).size).toBe(occurrences.length);
    expect(new Set(occurrences.map((o) => o.googleEventId)).size).toBe(occurrences.length);
  });
});
