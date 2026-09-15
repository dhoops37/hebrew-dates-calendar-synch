import { describe, expect, it } from 'vitest';
import { classifyPolarDay, formatInZone, sunsetOn } from '../src/sunset';
import {
  atSeaLevel,
  confirmLocation,
  getSeedLocation,
  SEED_LOCATIONS,
  suggestLocationForTimezone,
} from '../src/locations';
import { SUNSET_REFERENCES } from './fixtures/golden-dates';
import type { CalculationLocation, CivilDate } from '../src/types';

function parseDate(iso: string): CivilDate {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

function localMinutes(epochMs: number, timezoneId: string): number {
  const [hours, minutes] = formatInZone(epochMs, timezoneId, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .split(':')
    .map(Number) as [number, number];
  return hours * 60 + minutes;
}

function requireLocation(id: string): CalculationLocation {
  const location = getSeedLocation(id);
  if (!location) throw new Error(`missing seed location ${id}`);
  return location;
}

describe('sunset against independently published times (PRD 35.3)', () => {
  // Published tables round to the minute and differ slightly on the exact
  // coordinates of a "city", so agreement is asserted to within two minutes.
  //
  // These are all *sea-level* figures, which is what almost every published
  // table gives, so the comparison pins `useElevation: false` explicitly. The
  // seed catalogue itself now defaults to elevation-on, which is checked
  // separately below.
  it.each(SUNSET_REFERENCES)(
    '$locationId on $date sets around $expectedLocalTime at sea level ($note)',
    ({ locationId, date, expectedLocalTime }) => {
      const location = atSeaLevel(requireLocation(locationId));
      const result = sunsetOn(location, parseDate(date));
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      const [expectedHours, expectedMinutes] = expectedLocalTime.split(':').map(Number) as [
        number,
        number,
      ];
      const actual = localMinutes(result.epochMs, location.timezoneId);
      expect(Math.abs(actual - (expectedHours * 60 + expectedMinutes))).toBeLessThanOrEqual(2);
    },
  );

  it('returns an RFC 3339 string carrying the location offset, not a floating time', () => {
    const result = sunsetOn(atSeaLevel(requireLocation('seed:new-york')), {
      year: 2024,
      month: 6,
      day: 20,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.iso).toMatch(/^2024-06-20T20:30:\d\d-04:00$/);
    expect(result.utcOffset).toBe('-04:00');
    expect(new Date(result.iso).getTime()).toBe(result.epochMs);
  });
});

describe('sunset behaves sensibly everywhere in the seed catalogue', () => {
  it('produces a sunset in the afternoon or evening on the equinox', () => {
    for (const location of SEED_LOCATIONS) {
      const result = sunsetOn(location, { year: 2025, month: 3, day: 20 });
      expect(result.status, location.displayName).toBe('ok');
      if (result.status !== 'ok') continue;
      const minutes = localMinutes(result.epochMs, location.timezoneId);
      // Everywhere on Earth, equinox sunset is near local solar 18:00; the
      // spread comes from time-zone width and daylight saving.
      expect(minutes, `${location.displayName} set at ${result.iso}`).toBeGreaterThan(15 * 60);
      expect(minutes, `${location.displayName} set at ${result.iso}`).toBeLessThan(21 * 60);
    }
  });

  it('moves sunset later as summer approaches in the northern hemisphere', () => {
    const location = requireLocation('seed:new-york');
    let previous = -Infinity;
    for (const day of ['2024-03-20', '2024-04-20', '2024-05-20', '2024-06-15']) {
      const result = sunsetOn(location, parseDate(day));
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const minutes = localMinutes(result.epochMs, location.timezoneId);
      expect(minutes).toBeGreaterThan(previous);
      previous = minutes;
    }
  });

  it('moves sunset earlier as summer approaches in the southern hemisphere', () => {
    const location = requireLocation('seed:melbourne');
    const june = sunsetOn(location, { year: 2024, month: 6, day: 21 });
    const december = sunsetOn(location, { year: 2024, month: 12, day: 21 });
    expect(june.status).toBe('ok');
    expect(december.status).toBe('ok');
    if (june.status !== 'ok' || december.status !== 'ok') return;
    expect(localMinutes(december.epochMs, location.timezoneId)).toBeGreaterThan(
      localMinutes(june.epochMs, location.timezoneId),
    );
  });
});

describe('places where the sun does not set', () => {
  const tromso = requireLocation('seed:tromso');

  it('reports midnight sun instead of an invalid date', () => {
    const result = sunsetOn(tromso, { year: 2024, month: 6, day: 21 });
    expect(result.status).toBe('no_sunset');
    if (result.status !== 'no_sunset') return;
    expect(result.reason).toBe('midnight_sun');
    expect(result.timezoneId).toBe('Europe/Oslo');
  });

  it('reports polar night in midwinter', () => {
    const result = sunsetOn(tromso, { year: 2024, month: 12, day: 21 });
    expect(result.status).toBe('no_sunset');
    if (result.status !== 'no_sunset') return;
    expect(result.reason).toBe('polar_night');
  });

  it('still calculates sunset there in spring and autumn', () => {
    for (const date of ['2024-03-20', '2024-09-22']) {
      expect(sunsetOn(tromso, parseDate(date)).status).toBe('ok');
    }
  });

  it('classifies the polar day correctly in both hemispheres', () => {
    expect(classifyPolarDay(78.2, { year: 2024, month: 6, day: 21 })).toBe('midnight_sun');
    expect(classifyPolarDay(78.2, { year: 2024, month: 12, day: 21 })).toBe('polar_night');
    expect(classifyPolarDay(-78.2, { year: 2024, month: 6, day: 21 })).toBe('polar_night');
    expect(classifyPolarDay(-78.2, { year: 2024, month: 12, day: 21 })).toBe('midnight_sun');
  });
});

describe('elevation', () => {
  it('is applied by default for every seed location that has an elevation', () => {
    // The product decision is elevation-on. It is set explicitly on the data
    // rather than defaulted in code, so that what was applied is always visible
    // in the calculation snapshot.
    for (const location of SEED_LOCATIONS) {
      if (location.elevationMeters === undefined) continue;
      expect(location.useElevation, location.displayName).toBe(true);
    }
  });

  it('moves sunset measurably later than the sea-level figure', () => {
    const withElevation = requireLocation('seed:jerusalem');
    const seaLevel = atSeaLevel(withElevation);
    const date = { year: 2024, month: 6, day: 20 };

    const a = sunsetOn(seaLevel, date);
    const b = sunsetOn(withElevation, date);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    if (a.status !== 'ok' || b.status !== 'ok') return;

    // Higher ground sees the sun set later. Jerusalem at ~750 m gains about five
    // minutes, which is why `useElevation` belongs in the calculation snapshot
    // and not in display preferences: flipping it moves real calendar events.
    expect(b.epochMs).toBeGreaterThan(a.epochMs);
    const differenceMinutes = (b.epochMs - a.epochMs) / 60000;
    expect(differenceMinutes).toBeGreaterThan(3);
    expect(differenceMinutes).toBeLessThan(8);
  });

  it('makes no difference at a location that is at sea level anyway', () => {
    const telAviv = requireLocation('seed:tel-aviv'); // 5 m
    const date = { year: 2024, month: 6, day: 20 };
    const a = sunsetOn(atSeaLevel(telAviv), date);
    const b = sunsetOn(telAviv, date);
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('expected sunsets');
    expect(Math.abs(b.epochMs - a.epochMs) / 1000).toBeLessThan(30);
  });

  it('records the flag on the snapshot either way', () => {
    const location: CalculationLocation = requireLocation('seed:jerusalem');
    expect(location.useElevation).toBe(true);
    expect(atSeaLevel(location).useElevation).toBe(false);
    // The elevation value itself is retained even when unused, so a later
    // change of mind can be recalculated without re-geocoding.
    expect(atSeaLevel(location).elevationMeters).toBe(location.elevationMeters);
  });
});

describe('suggesting a location from a time zone (setup convenience)', () => {
  it('finds a catalogue city in the same zone', () => {
    expect(suggestLocationForTimezone('Asia/Jerusalem')?.location.timezoneId).toBe(
      'Asia/Jerusalem',
    );
    expect(suggestLocationForTimezone('America/New_York')?.location.timezoneId).toBe(
      'America/New_York',
    );
    expect(suggestLocationForTimezone('Australia/Melbourne')?.location.id).toBe('seed:melbourne');
  });

  it('falls back to the same region rather than guessing wildly', () => {
    // An unlisted US zone should not land the user in Jerusalem.
    const suggestion = suggestLocationForTimezone('America/Detroit');
    expect(suggestion?.location.timezoneId.startsWith('America/')).toBe(true);
  });

  it('returns nothing rather than a wrong guess for an unknown region', () => {
    expect(suggestLocationForTimezone('Antarctica/Vostok')).toBeUndefined();
    expect(suggestLocationForTimezone(undefined)).toBeUndefined();
  });

  it('never returns a confirmed location: a suggestion is a question', () => {
    const suggestion = suggestLocationForTimezone('Asia/Jerusalem');
    expect(suggestion?.requiresConfirmation).toBe(true);
    expect(suggestion?.location.confirmedByUser).toBe(false);
    expect(suggestion?.location.source).toBe('timezone_suggestion');
    expect(suggestion?.derivedFromTimezoneId).toBe('Asia/Jerusalem');
  });

  it('says where the suggestion came from, and that the zone is not the place', () => {
    const fromDevice = suggestLocationForTimezone('Europe/London');
    expect(fromDevice?.explanation).toMatch(/device's time zone/);
    expect(fromDevice?.explanation).toMatch(/not from the time zone/);

    const fromCalendar = suggestLocationForTimezone('Europe/London', 'calendar_timezone_hint');
    expect(fromCalendar?.explanation).toMatch(/calendar's time zone/);
    expect(fromCalendar?.location.source).toBe('calendar_timezone_hint');
  });

  it('confirmLocation is the only route from suggestion to usable location', () => {
    const suggestion = suggestLocationForTimezone('Asia/Jerusalem')!;
    const confirmed = confirmLocation(suggestion.location);
    expect(confirmed.confirmedByUser).toBe(true);
    expect(confirmed.source).toBe('user_selected');
    // Geography is untouched by confirming — only provenance changes.
    expect(confirmed.latitude).toBe(suggestion.location.latitude);
    expect(confirmed.longitude).toBe(suggestion.location.longitude);
    expect(confirmed.timezoneId).toBe(suggestion.location.timezoneId);
  });
});

describe('historical dates', () => {
  it('applies the daylight-saving rules that were actually in force', () => {
    // The USA observed DST from late April in 1978, so 12 May is on DST.
    const result = sunsetOn(requireLocation('seed:new-york'), { year: 1978, month: 5, day: 12 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.utcOffset).toBe('-04:00');
    expect(result.iso.startsWith('1978-05-12T20:0')).toBe(true);
  });

  it('uses standard time for a 1978 January date', () => {
    const result = sunsetOn(requireLocation('seed:new-york'), { year: 1978, month: 1, day: 15 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.utcOffset).toBe('-05:00');
  });
});
