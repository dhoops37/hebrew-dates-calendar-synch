/**
 * One dataset, several members' calendars, in different cities.
 *
 * This is the property the two-layer split exists for (decision #18): the Hebrew
 * dates are resolved once and shared, while every destination gets its own
 * sunset window, its own external event ID and its own content hash.
 */
import { describe, expect, it } from 'vitest';
import { currentHebrewDateAt, resolveOccurrences, type HebrewOccurrence } from '../src/occurrences';
import {
  renderForDestination,
  renderForDestinationCalendar,
  renderForDestinations,
  type DestinationCalendar,
  type SourceRecordContent,
} from '../src/destinations';
import { generateOccurrences } from '../src/generate';
import {
  confirmLocation,
  getSeedLocation,
  suggestLocationForTimezone,
} from '../src/locations';
import { civilToAbsolute } from '../src/hebrewCalendar';
import type { CalculationLocation } from '../src/types';

function requireLocation(id: string): CalculationLocation {
  const location = getSeedLocation(id);
  if (!location) throw new Error(`missing seed location ${id}`);
  return location;
}

const jerusalem = requireLocation('seed:jerusalem');
const newYork = requireLocation('seed:new-york');
const melbourne = requireLocation('seed:melbourne');
const tromso = requireLocation('seed:tromso');

const NOW = Date.UTC(2025, 0, 15, 12, 0, 0);

const record: SourceRecordContent = { type: 'personal_yahrzeit', displayName: 'Zayde' };

/** Three siblings in three countries, sharing one family dataset. */
const family: DestinationCalendar[] = [
  {
    id: 'dest-jerusalem',
    destinationType: 'google',
    location: jerusalem,
    displayMode: 'exact_sunset',
  },
  { id: 'dest-new-york', destinationType: 'google', location: newYork, displayMode: 'exact_sunset' },
  {
    id: 'dest-melbourne',
    destinationType: 'ical_feed',
    location: melbourne,
    displayMode: 'two_day_all_day',
  },
];

function sharedOccurrences(count = 5): HebrewOccurrence[] {
  const result = resolveOccurrences({
    sourceRecordId: 'record-shared',
    type: 'personal_yahrzeit',
    origin: { month: 'TEVET', day: 12, year: 5784 },
    count,
    // One anchor location decides "has today's occurrence finished"; each
    // destination still renders its own times.
    from: currentHebrewDateAt(jerusalem, NOW),
  });
  if (result.status !== 'ok') throw new Error('expected occurrences');
  return result.occurrences;
}

describe('occurrences are location-free', () => {
  const occurrences = sharedOccurrences();

  it('carry no times, no time zone and no location', () => {
    for (const occurrence of occurrences) {
      // Deliberately absent: the whole point of the split.
      expect(occurrence).not.toHaveProperty('timing');
      expect(occurrence).not.toHaveProperty('start');
      expect(occurrence).not.toHaveProperty('locationSnapshot');
      expect(occurrence).not.toHaveProperty('title');
    }
  });

  it('carry the Hebrew date, the Gregorian days and the rule that produced them', () => {
    const first = occurrences[0]!;
    expect(first.hebrewDate.year).toBeGreaterThan(5784);
    expect(first.ruleApplied).toBe('SAME_MONTH_AND_DAY');
    expect(civilToAbsolute(first.precedingGregorianDate)).toBe(
      civilToAbsolute(first.gregorianDate) - 1,
    );
    expect(civilToAbsolute(first.followingGregorianDate)).toBe(
      civilToAbsolute(first.gregorianDate) + 1,
    );
  });

  it('are identical no matter which destination will consume them', () => {
    const again = sharedOccurrences();
    expect(JSON.stringify(again)).toBe(JSON.stringify(occurrences));
  });
});

describe('one dataset rendered for a family in three cities', () => {
  const occurrences = sharedOccurrences();
  const rendered = renderForDestinations(occurrences, record, family);

  it('produces one list per destination, all the same length', () => {
    expect([...rendered.keys()]).toEqual(['dest-jerusalem', 'dest-new-york', 'dest-melbourne']);
    for (const events of rendered.values()) {
      expect(events).toHaveLength(occurrences.length);
    }
  });

  it('gives every member the same Hebrew dates', () => {
    const hebrewDates = [...rendered.values()].map((events) =>
      events.map((event) => `${event.hebrewYear}-${event.hebrewDate.month}-${event.hebrewDate.day}`),
    );
    expect(hebrewDates[1]).toEqual(hebrewDates[0]);
    expect(hebrewDates[2]).toEqual(hebrewDates[0]);
  });

  it('gives every member the same occurrence keys, because it is one anniversary', () => {
    const keys = [...rendered.values()].map((events) => events.map((event) => event.key));
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]).toEqual(keys[0]);
  });

  it('but different sunset windows, because they are in different places', () => {
    const jlm = rendered.get('dest-jerusalem')![0]!;
    const nyc = rendered.get('dest-new-york')![0]!;
    expect(jlm.timing!.startEpochMs).not.toBe(nyc.timing!.startEpochMs);
    expect(jlm.timing!.startIso).toMatch(/\+0[23]:00$/);
    expect(nyc.timing!.startIso).toMatch(/-0[45]:00$/);
    // Jerusalem's sunset comes first in absolute time; New York is far west.
    expect(jlm.timing!.startEpochMs).toBeLessThan(nyc.timing!.startEpochMs);
  });

  it('and different external event IDs, so two calendars never collide', () => {
    const allIds = [...rendered.values()].flatMap((events) =>
      events.map((event) => event.googleEventId),
    );
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const id of allIds) expect(id).toMatch(/^[a-v0-9]+$/);
  });

  it('and different content hashes, so each is reconciled independently', () => {
    const hashes = [...rendered.values()].map((events) => events.map((e) => e.contentHash));
    expect(hashes[1]).not.toEqual(hashes[0]);
    expect(hashes[2]).not.toEqual(hashes[0]);
  });

  it('honours each destination its own display mode', () => {
    const melbourneEvents = rendered.get('dest-melbourne')!;
    expect(melbourneEvents[0]!.description).toContain('Across both calendar days');
    expect(rendered.get('dest-jerusalem')![0]!.description).toContain('Exact sunset times');
  });

  it('names each destination its own calculation location in the description', () => {
    expect(rendered.get('dest-jerusalem')![0]!.description).toContain('Jerusalem');
    expect(rendered.get('dest-new-york')![0]!.description).toContain('New York');
    expect(rendered.get('dest-melbourne')![0]!.description).toContain('Melbourne');
  });

  it('stamps each event with its destination', () => {
    for (const [destinationId, events] of rendered) {
      for (const event of events) expect(event.destinationCalendarId).toBe(destinationId);
    }
  });

  it('resolves the Hebrew dates once, not once per member', () => {
    // A property test rather than a spy: rendering must not be able to change
    // the Hebrew date, so mutating nothing shared is provable by equality.
    const before = JSON.stringify(occurrences);
    renderForDestinations(occurrences, record, family);
    expect(JSON.stringify(occurrences)).toBe(before);
  });

  it('rejects two destinations sharing an ID', () => {
    expect(() =>
      renderForDestinations(occurrences, record, [family[0]!, { ...family[1]!, id: family[0]!.id }]),
    ).toThrow(/Duplicate destination/);
  });
});

describe('per-destination settings', () => {
  const [occurrence] = sharedOccurrences(1) as [HebrewOccurrence];

  it('defaults events to Google visibility "default", so calendar sharing governs', () => {
    const event = renderForDestination(occurrence, record, family[0]!);
    expect(event.visibility).toBe('default');
  });

  it('lets a destination opt into per-event private visibility', () => {
    const event = renderForDestination(occurrence, record, {
      ...family[0]!,
      visibility: 'private',
    });
    expect(event.visibility).toBe('private');
    // Visibility reaches the destination, so it must move the hash.
    expect(event.contentHash).not.toBe(
      renderForDestination(occurrence, record, family[0]!).contentHash,
    );
  });

  it('renders the Hebrew title for a Hebrew-language destination', () => {
    const event = renderForDestination(occurrence, record, { ...family[0]!, language: 'he' });
    expect(event.title).toMatch(/[֐-׿]/);
  });

  it('warns per destination where the sun does not set', () => {
    // Same Hebrew date; only the northern member cannot have exact times.
    const summer = resolveOccurrences({
      sourceRecordId: 'record-summer',
      type: 'birthday',
      origin: { month: 'SIVAN', day: 25 },
      count: 1,
      from: currentHebrewDateAt(jerusalem, NOW),
    });
    if (summer.status !== 'ok') throw new Error('expected occurrences');
    const shared = summer.occurrences[0]!;

    const north = renderForDestination(shared, record, {
      id: 'dest-tromso',
      destinationType: 'google',
      location: tromso,
      displayMode: 'exact_sunset',
    });
    const south = renderForDestination(shared, record, family[0]!);

    expect(north.timing).toBeNull();
    expect(north.warnings.some((w) => w.code === 'NO_SUNSET')).toBe(true);
    expect(south.timing).not.toBeNull();
    // The Hebrew date is shared even though one member has no sunset.
    expect(north.hebrewDate).toEqual(south.hebrewDate);
    expect(north.key).toBe(south.key);
  });

  it('carries an ambiguity to every destination, since it is a property of the date', () => {
    const adar = resolveOccurrences({
      sourceRecordId: 'record-adar',
      type: 'personal_yahrzeit',
      origin: { month: 'ADAR', day: 10, year: 5785 },
      count: 3,
      from: currentHebrewDateAt(jerusalem, NOW),
    });
    if (adar.status !== 'ok') throw new Error('expected occurrences');
    const flagged = adar.occurrences.find((o) => o.ambiguities.length > 0)!;
    for (const destination of family) {
      const event = renderForDestination(flagged, record, destination);
      expect(event.warnings.some((w) => w.code === 'AMBIGUOUS_HEBREW_DATE')).toBe(true);
    }
  });
});

describe('calculation location is separate from calendar time zone', () => {
  const [occurrence] = sharedOccurrences(1) as [HebrewOccurrence];
  const confirmedJerusalem = confirmLocation(jerusalem);

  it('calculates sunset from the location, not from the calendar time zone', () => {
    // Same location, wildly different calendar zones. The instants must not move.
    const base = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      location: confirmedJerusalem,
      displayMode: 'exact_sunset',
    });
    for (const hint of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      const withHint = renderForDestination(occurrence, record, {
        id: 'd',
        destinationType: 'google',
        location: confirmedJerusalem,
        displayMode: 'exact_sunset',
        calendarTimezoneHint: hint,
      });
      expect(withHint.timing!.startEpochMs, hint).toBe(base.timing!.startEpochMs);
      expect(withHint.timing!.endEpochMs, hint).toBe(base.timing!.endEpochMs);
      // The ISO strings still carry the LOCATION's offset, not the hint's.
      expect(withHint.timing!.startIso).toBe(base.timing!.startIso);
    }
  });

  it('changing the location changes the times; changing the hint does not', () => {
    const inJerusalem = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      location: confirmedJerusalem,
      displayMode: 'exact_sunset',
      calendarTimezoneHint: 'Asia/Jerusalem',
    });
    const inMelbourne = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      location: confirmLocation(melbourne),
      // Deliberately the WRONG hint for Melbourne, to prove it is not an input.
      displayMode: 'exact_sunset',
      calendarTimezoneHint: 'Asia/Jerusalem',
    });
    expect(inMelbourne.timing!.startEpochMs).not.toBe(inJerusalem.timing!.startEpochMs);
    // Sunset was computed from Melbourne's coordinates: the offset proves it.
    expect(inMelbourne.timing!.startIso).toMatch(/\+1[01]:00$/);
  });

  it('uses the calendar zone only to say how the client should display it', () => {
    const event = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      location: confirmedJerusalem,
      displayMode: 'exact_sunset',
      calendarTimezoneHint: 'America/New_York',
    });
    expect(event.displayTimezoneId).toBe('America/New_York');
    expect(event.locationSnapshot.timezoneId).toBe('Asia/Jerusalem');
  });

  it('falls back to the location zone for display when no hint is known', () => {
    const event = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      location: confirmedJerusalem,
      displayMode: 'exact_sunset',
    });
    expect(event.displayTimezoneId).toBe('Asia/Jerusalem');
  });

  it('records the display zone in the content hash, since it reaches the event', () => {
    const a = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      location: confirmedJerusalem,
      displayMode: 'exact_sunset',
      calendarTimezoneHint: 'Asia/Jerusalem',
    });
    const b = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      location: confirmedJerusalem,
      displayMode: 'exact_sunset',
      calendarTimezoneHint: 'America/New_York',
    });
    expect(b.contentHash).not.toBe(a.contentHash);
    // ...but the calculated instants are identical, which is the whole point.
    expect(b.timing!.startEpochMs).toBe(a.timing!.startEpochMs);
  });

  it('keeps the location snapshot pointing at coordinates, not just a zone', () => {
    const event = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      location: confirmedJerusalem,
      displayMode: 'exact_sunset',
    });
    expect(event.locationSnapshot.latitude).toBeCloseTo(31.7683, 3);
    expect(event.locationSnapshot.longitude).toBeCloseTo(35.2137, 3);
    expect(event.locationSnapshot.useElevation).toBe(true);
  });
});

describe('an unconfirmed location must not silently become a calculation', () => {
  const [occurrence] = sharedOccurrences(1) as [HebrewOccurrence];

  it('warns when the location has not been confirmed by the user', () => {
    const event = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      // A seed catalogue entry is a candidate, not a confirmed choice.
      location: jerusalem,
      displayMode: 'exact_sunset',
    });
    const warning = event.warnings.find((w) => w.code === 'LOCATION_NOT_CONFIRMED');
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('Jerusalem');
    expect(warning!.message).toMatch(/time zone covers a lot of ground|half an hour/);
  });

  it('is silent once the user has confirmed', () => {
    const event = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      location: confirmLocation(jerusalem),
      displayMode: 'exact_sunset',
    });
    expect(event.warnings.some((w) => w.code === 'LOCATION_NOT_CONFIRMED')).toBe(false);
  });

  it('still renders a preview, because that is what the user is confirming', () => {
    const event = renderForDestination(occurrence, record, {
      id: 'd',
      destinationType: 'google',
      location: suggestLocationForTimezone('Asia/Jerusalem')!.location,
      displayMode: 'exact_sunset',
    });
    expect(event.timing).not.toBeNull();
    expect(event.title).toContain('Zayde');
    expect(event.warnings.some((w) => w.code === 'LOCATION_NOT_CONFIRMED')).toBe(true);
  });
});

describe('both Adars across a family', () => {
  it('gives every member both observances, with matching keys and their own times', () => {
    const result = resolveOccurrences({
      sourceRecordId: 'record-adar',
      type: 'personal_yahrzeit',
      origin: { month: 'ADAR', day: 10, year: 5785 },
      count: 5,
      from: currentHebrewDateAt(jerusalem, NOW),
    });
    if (result.status !== 'ok') throw new Error('expected occurrences');
    expect(result.hebrewYearsGenerated).toBe(5);
    expect(result.occurrences.length).toBeGreaterThan(5);

    const rendered = renderForDestinations(result.occurrences, record, family);
    for (const events of rendered.values()) {
      expect(events).toHaveLength(result.occurrences.length);
      expect(events.filter((e) => e.sequence === 1).length).toBeGreaterThan(0);
    }
    // The pair is the same anniversary everywhere.
    const keysByDestination = [...rendered.values()].map((events) => events.map((e) => e.key));
    expect(keysByDestination[1]).toEqual(keysByDestination[0]);
  });
});

describe('the single-destination wrapper stays equivalent', () => {
  it('produces the same events as the two-step API', () => {
    const from = currentHebrewDateAt(jerusalem, NOW);
    const resolved = resolveOccurrences({
      sourceRecordId: 'record-1',
      type: 'birthday',
      origin: { month: 'NISAN', day: 10 },
      count: 5,
      from,
    });
    if (resolved.status !== 'ok') throw new Error('expected occurrences');
    const twoStep = renderForDestinationCalendar(
      resolved.occurrences,
      { type: 'birthday', displayName: 'David' },
      {
        id: 'default',
        destinationType: 'google',
        location: jerusalem,
        displayMode: 'exact_sunset',
      },
    );

    const wrapped = generateOccurrences({
      sourceRecordId: 'record-1',
      type: 'birthday',
      displayName: 'David',
      origin: { month: 'NISAN', day: 10 },
      location: jerusalem,
      displayMode: 'exact_sunset',
      count: 5,
      nowEpochMs: NOW,
    });
    if (wrapped.status !== 'ok') throw new Error('expected occurrences');

    expect(JSON.stringify(wrapped.occurrences)).toBe(JSON.stringify(twoStep));
  });
});
