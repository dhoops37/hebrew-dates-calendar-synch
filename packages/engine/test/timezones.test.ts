/**
 * Time-zone and daylight-saving behaviour.
 *
 * Two failure modes are guarded here, both of which produce calendar events
 * that are wrong by an hour or by a day and are hard to spot in review:
 *
 *  1. A sunset-to-sunset window built by adding 24 hours to a local wall-clock
 *     time. Across a daylight-saving boundary that is off by an hour.
 *  2. A calendar day derived from the *server's* zone rather than the
 *     location's. That is invisible on a UTC server and breaks in production
 *     the moment the server moves, so these tests deliberately run under
 *     TZ=America/Los_Angeles (see vitest.config.ts) and additionally re-run
 *     the engine under several other zones.
 */
import { describe, expect, it } from 'vitest';
import { sunsetOn, formatInZone } from '../src/sunset';
import { getSeedLocation } from '../src/locations';
import { generateOccurrences, civilDateInZone } from '../src/occurrences';
import type { CalculationLocation, CivilDate } from '../src/types';

function requireLocation(id: string): CalculationLocation {
  const location = getSeedLocation(id);
  if (!location) throw new Error(`missing seed location ${id}`);
  return location;
}

function sunsetEpoch(location: CalculationLocation, date: CivilDate): number {
  const result = sunsetOn(location, date);
  if (result.status !== 'ok') throw new Error(`no sunset for ${JSON.stringify(date)}`);
  return result.epochMs;
}

function offsetOf(location: CalculationLocation, date: CivilDate): string {
  const result = sunsetOn(location, date);
  if (result.status !== 'ok') throw new Error('no sunset');
  return result.utcOffset;
}

describe('the host time zone must not affect any result', () => {
  const zones = ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Niue', 'Asia/Kolkata'];

  it('produces identical sunsets under every host zone', () => {
    const location = requireLocation('seed:jerusalem');
    const date = { year: 2024, month: 6, day: 20 };
    const original = process.env.TZ;
    const results = new Set<string>();
    try {
      for (const zone of zones) {
        process.env.TZ = zone;
        const result = sunsetOn(location, date);
        expect(result.status).toBe('ok');
        if (result.status === 'ok') results.add(result.iso);
      }
    } finally {
      process.env.TZ = original;
    }
    expect([...results]).toHaveLength(1);
  });

  it('produces identical occurrences under every host zone', () => {
    const location = requireLocation('seed:melbourne');
    const original = process.env.TZ;
    const signatures = new Set<string>();
    try {
      for (const zone of zones) {
        process.env.TZ = zone;
        const result = generateOccurrences({
          sourceRecordId: 'record-1',
          type: 'birthday',
          displayName: 'Test',
          origin: { month: 'NISAN', day: 10 },
          location,
          displayMode: 'exact_sunset',
          count: 5,
          nowEpochMs: Date.UTC(2025, 0, 15, 12, 0, 0),
        });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') continue;
        signatures.add(
          result.occurrences.map((o) => `${o.hebrewYear}|${o.timing?.startIso}`).join(','),
        );
      }
    } finally {
      process.env.TZ = original;
    }
    expect([...signatures]).toHaveLength(1);
  });

  it('reads the civil date from the location zone, not the host zone', () => {
    // 2025-01-15T12:00Z is still 04:00 on the 15th in Los Angeles but already
    // 23:00 on the 15th in Melbourne and 01:00 on the 16th in Auckland.
    const epochMs = Date.UTC(2025, 0, 15, 12, 0, 0);
    expect(civilDateInZone(epochMs, 'America/Los_Angeles')).toEqual({
      year: 2025,
      month: 1,
      day: 15,
    });
    expect(civilDateInZone(epochMs, 'Pacific/Auckland')).toEqual({ year: 2025, month: 1, day: 16 });
  });
});

describe('daylight-saving transitions', () => {
  it('keeps a sunset-to-sunset window at about 24 hours across a spring-forward', () => {
    // The clocks in New York jump forward on 10 March 2024. Sunset is defined
    // by the sun, so the absolute length of the Hebrew day barely changes -
    // only the wall-clock labels move.
    const location = requireLocation('seed:new-york');
    const start = sunsetEpoch(location, { year: 2024, month: 3, day: 9 });
    const end = sunsetEpoch(location, { year: 2024, month: 3, day: 10 });
    const hours = (end - start) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);

    // ...and the local time jumps by roughly an hour, which is what the user sees.
    const startLocal = formatInZone(start, location.timezoneId, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const endLocal = formatInZone(end, location.timezoneId, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(startLocal).toMatch(/^17:5\d$/);
    expect(endLocal).toMatch(/^18:5\d$/);
    expect(offsetOf(location, { year: 2024, month: 3, day: 9 })).toBe('-05:00');
    expect(offsetOf(location, { year: 2024, month: 3, day: 10 })).toBe('-04:00');
  });

  it('keeps a sunset-to-sunset window at about 24 hours across a fall-back', () => {
    const location = requireLocation('seed:new-york');
    const start = sunsetEpoch(location, { year: 2024, month: 11, day: 2 });
    const end = sunsetEpoch(location, { year: 2024, month: 11, day: 3 });
    const hours = (end - start) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
    expect(offsetOf(location, { year: 2024, month: 11, day: 2 })).toBe('-04:00');
    expect(offsetOf(location, { year: 2024, month: 11, day: 3 })).toBe('-05:00');
  });

  it('handles the southern-hemisphere transitions', () => {
    const location = requireLocation('seed:melbourne');
    // DST starts on 6 October 2024 and ends on 6 April 2025 in Victoria.
    expect(offsetOf(location, { year: 2024, month: 10, day: 5 })).toBe('+10:00');
    expect(offsetOf(location, { year: 2024, month: 10, day: 6 })).toBe('+11:00');
    expect(offsetOf(location, { year: 2025, month: 4, day: 5 })).toBe('+11:00');
    expect(offsetOf(location, { year: 2025, month: 4, day: 6 })).toBe('+10:00');

    const start = sunsetEpoch(location, { year: 2024, month: 10, day: 5 });
    const end = sunsetEpoch(location, { year: 2024, month: 10, day: 6 });
    expect((end - start) / 3_600_000).toBeGreaterThan(23.9);
    expect((end - start) / 3_600_000).toBeLessThan(24.1);
  });

  it('handles the Israeli transitions, which differ from both the US and the EU', () => {
    const location = requireLocation('seed:jerusalem');
    // Israel's DST runs from the Friday before the last Sunday in March to the
    // last Sunday in October.
    expect(offsetOf(location, { year: 2024, month: 3, day: 28 })).toBe('+02:00');
    expect(offsetOf(location, { year: 2024, month: 3, day: 29 })).toBe('+03:00');
    expect(offsetOf(location, { year: 2024, month: 10, day: 26 })).toBe('+03:00');
    expect(offsetOf(location, { year: 2024, month: 10, day: 27 })).toBe('+02:00');
  });

  it('never changes offset in a zone without daylight saving', () => {
    const location = requireLocation('seed:phoenix');
    for (const month of [1, 3, 4, 7, 10, 11, 12]) {
      expect(offsetOf(location, { year: 2024, month, day: 15 })).toBe('-07:00');
    }
  });

  it('keeps every sunset-to-sunset window near 24 hours across a whole year', () => {
    const location = requireLocation('seed:london');
    let abs = Date.UTC(2024, 0, 1);
    let previous: number | null = null;
    for (let day = 0; day < 365; day++) {
      const date = new Date(abs + day * 86_400_000);
      const epoch = sunsetEpoch(location, {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      });
      if (previous !== null) {
        const hours = (epoch - previous) / 3_600_000;
        expect(hours, `day ${day}`).toBeGreaterThan(23.9);
        expect(hours, `day ${day}`).toBeLessThan(24.1);
      }
      previous = epoch;
    }
    expect(abs).toBeGreaterThan(0);
  });
});
