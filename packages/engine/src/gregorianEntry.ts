/**
 * Interpreting a Gregorian date the user typed in.
 *
 * A Hebrew day runs from sunset to sunset, so a Gregorian calendar date maps to
 * *two* possible Hebrew dates depending on whether the event happened before or
 * after sunset. The PRD is explicit (16.3, and "Instructions to the Coding
 * Agent"): when the user does not know, the engine must not choose. This module
 * is the only place that interpretation happens.
 */
import type {
  CalculationLocation,
  CivilDate,
  DecisionRequired,
  HebrewDate,
  HebrewMonthName,
  SunsetResult,
  SunsetStatus,
} from './types';
import { absoluteToHebrew, civilToAbsolute, monthNameFor } from './hebrewCalendar';
import { sunsetOn } from './sunset';

export interface GregorianInterpretationInput {
  gregorianDate: CivilDate;
  sunsetStatus: SunsetStatus;
  /** Optional: when supplied, the actual sunset time is returned to help the user decide. */
  location?: CalculationLocation;
}

export interface InterpretedHebrewDate {
  hebrewDate: HebrewDate;
  monthName: HebrewMonthName;
}

export interface GregorianInterpretationResolved {
  status: 'resolved';
  interpretation: InterpretedHebrewDate;
  /** Sunset on the entered Gregorian date, when a location was supplied. */
  sunsetOnEnteredDate?: SunsetResult;
}

export type GregorianInterpretation =
  | GregorianInterpretationResolved
  | DecisionRequired<InterpretedHebrewDate>;

/** The Hebrew date whose *daytime* falls on this Gregorian date. */
export function hebrewDateForDaytimeOf(gregorianDate: CivilDate): InterpretedHebrewDate {
  const hebrewDate = absoluteToHebrew(civilToAbsolute(gregorianDate));
  return { hebrewDate, monthName: monthNameFor(hebrewDate.month, hebrewDate.year) };
}

/** The Hebrew date that begins at sunset on this Gregorian date. */
export function hebrewDateForEveningOf(gregorianDate: CivilDate): InterpretedHebrewDate {
  const hebrewDate = absoluteToHebrew(civilToAbsolute(gregorianDate) + 1);
  return { hebrewDate, monthName: monthNameFor(hebrewDate.month, hebrewDate.year) };
}

export function interpretGregorianEntry(
  input: GregorianInterpretationInput,
): GregorianInterpretation {
  const beforeSunset = hebrewDateForDaytimeOf(input.gregorianDate);
  const afterSunset = hebrewDateForEveningOf(input.gregorianDate);
  const sunsetOnEnteredDate = input.location
    ? sunsetOn(input.location, input.gregorianDate)
    : undefined;

  if (input.sunsetStatus === 'unknown') {
    return {
      status: 'needs_user_decision',
      code: 'UNKNOWN_SUNSET_STATUS',
      question: 'Did this happen before or after sunset?',
      explanation:
        'A Hebrew date begins at sunset, so this Gregorian date corresponds to two ' +
        'different Hebrew dates. Hebrew Dates will not choose for you. A birth ' +
        'certificate, a death certificate, a burial record, or a relative who was ' +
        'there can usually settle it.' +
        (sunsetOnEnteredDate?.status === 'ok'
          ? ` Sunset at the selected location on this date was ${sunsetOnEnteredDate.iso}.`
          : ''),
      options: [
        {
          id: 'before_sunset',
          label: `Before sunset - ${describe(beforeSunset)}`,
          value: beforeSunset,
        },
        {
          id: 'after_sunset',
          label: `After sunset - ${describe(afterSunset)}`,
          value: afterSunset,
        },
      ],
    };
  }

  return {
    status: 'resolved',
    interpretation: input.sunsetStatus === 'before_sunset' ? beforeSunset : afterSunset,
    ...(sunsetOnEnteredDate ? { sunsetOnEnteredDate } : {}),
  };
}

function describe(interpreted: InterpretedHebrewDate): string {
  return `${interpreted.hebrewDate.day} ${prettyMonth(interpreted.monthName)} ${interpreted.hebrewDate.year}`;
}

function prettyMonth(name: HebrewMonthName): string {
  return name
    .split('_')
    .map((part, index) =>
      index === 0
        ? part.charAt(0) + part.slice(1).toLowerCase()
        : part === 'I'
          ? 'I'
          : part === 'II'
            ? 'II'
            : part,
    )
    .join(' ');
}
