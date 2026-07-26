/**
 * The golden-date set (PRD 35.2).
 *
 * Every calculation-engine change must run against this fixed set. Rows are
 * tagged by how they were established:
 *
 *  - `anchor`     - independently verifiable from widely published civil dates
 *                   of well-known Jewish dates. These are the rows that would
 *                   catch a systematically wrong calendar. Note that the
 *                   published "first night" of a festival is the *evening
 *                   before* the Gregorian date recorded here, because a Hebrew
 *                   day starts at sunset.
 *  - `characteristic` - year-structure rows (leap years, short/long Cheshvan
 *                   and Kislev) that pin the shape of specific Hebrew years.
 *  - `regression` - snapshots of current engine output. They do not prove
 *                   correctness; they detect unintended change.
 *
 * A qualified reviewer should sign off the `anchor` rows before public launch
 * (PRD 35.6). Until then they are marked with the public event they came from.
 */
export type GoldenSource = 'anchor' | 'characteristic' | 'regression';

export interface GoldenDate {
  /** Hebrew year, month number (Nisan = 1), day. */
  hebrew: { year: number; month: number; day: number };
  /** ISO calendar day on which that Hebrew date's *daytime* falls. */
  gregorian: string;
  source: GoldenSource;
  note: string;
}

export const GOLDEN_DATES: GoldenDate[] = [
  {
    hebrew: { year: 5784, month: 7, day: 1 },
    gregorian: '2023-09-16',
    source: 'anchor',
    note: 'Rosh Hashana 5784, first day (began the evening of 15 Sep 2023)',
  },
  {
    hebrew: { year: 5784, month: 7, day: 10 },
    gregorian: '2023-09-25',
    source: 'anchor',
    note: 'Yom Kippur 5784 (Kol Nidrei the evening of 24 Sep 2023)',
  },
  {
    hebrew: { year: 5784, month: 7, day: 15 },
    gregorian: '2023-09-30',
    source: 'anchor',
    note: 'Sukkot 5784, first day (began the evening of 29 Sep 2023)',
  },
  {
    hebrew: { year: 5784, month: 9, day: 25 },
    gregorian: '2023-12-08',
    source: 'anchor',
    note: 'Chanukah 5784, first day (first candle the evening of 7 Dec 2023)',
  },
  {
    hebrew: { year: 5784, month: 13, day: 14 },
    gregorian: '2024-03-24',
    source: 'anchor',
    note: 'Purim 5784, in Adar II of a leap year (megillah the evening of 23 Mar 2024)',
  },
  {
    hebrew: { year: 5784, month: 1, day: 15 },
    gregorian: '2024-04-23',
    source: 'anchor',
    note: 'Pesach 5784, first day (first seder the evening of 22 Apr 2024)',
  },
  {
    hebrew: { year: 5784, month: 3, day: 6 },
    gregorian: '2024-06-12',
    source: 'anchor',
    note: 'Shavuot 5784, first day (began the evening of 11 Jun 2024)',
  },
  {
    hebrew: { year: 5785, month: 7, day: 1 },
    gregorian: '2024-10-03',
    source: 'anchor',
    note: 'Rosh Hashana 5785, first day (began the evening of 2 Oct 2024)',
  },
  {
    hebrew: { year: 5785, month: 7, day: 10 },
    gregorian: '2024-10-12',
    source: 'anchor',
    note: 'Yom Kippur 5785 (Kol Nidrei the evening of 11 Oct 2024)',
  },
  {
    hebrew: { year: 5785, month: 9, day: 25 },
    gregorian: '2024-12-26',
    source: 'anchor',
    note: 'Chanukah 5785, first day (first candle the evening of 25 Dec 2024)',
  },
  {
    hebrew: { year: 5785, month: 12, day: 14 },
    gregorian: '2025-03-14',
    source: 'anchor',
    note: 'Purim 5785, in Adar of an ordinary year (megillah the evening of 13 Mar 2025)',
  },
  {
    hebrew: { year: 5785, month: 1, day: 15 },
    gregorian: '2025-04-13',
    source: 'anchor',
    note: 'Pesach 5785, first day (first seder the evening of 12 Apr 2025)',
  },
  {
    hebrew: { year: 5785, month: 3, day: 6 },
    gregorian: '2025-06-02',
    source: 'anchor',
    note: 'Shavuot 5785, first day (began the evening of 1 Jun 2025)',
  },
  {
    hebrew: { year: 5786, month: 7, day: 1 },
    gregorian: '2025-09-23',
    source: 'anchor',
    note: 'Rosh Hashana 5786, first day (began the evening of 22 Sep 2025)',
  },
  {
    hebrew: { year: 5786, month: 7, day: 10 },
    gregorian: '2025-10-02',
    source: 'anchor',
    note: 'Yom Kippur 5786 (Kol Nidrei the evening of 1 Oct 2025)',
  },
  {
    hebrew: { year: 5786, month: 1, day: 15 },
    gregorian: '2026-04-02',
    source: 'anchor',
    note: 'Pesach 5786, first day (first seder the evening of 1 Apr 2026)',
  },
  {
    hebrew: { year: 5787, month: 7, day: 1 },
    gregorian: '2026-09-12',
    source: 'anchor',
    note: 'Rosh Hashana 5787, first day (began the evening of 11 Sep 2026)',
  },
  {
    hebrew: { year: 5784, month: 8, day: 29 },
    gregorian: '2023-11-13',
    source: 'characteristic',
    note: 'Last day of a 29-day Cheshvan in 5784; 30 Cheshvan does not exist that year',
  },
  {
    hebrew: { year: 5785, month: 8, day: 30 },
    gregorian: '2024-12-01',
    source: 'characteristic',
    note: '30 Cheshvan exists in 5785, which has a long Cheshvan',
  },
  {
    hebrew: { year: 5785, month: 9, day: 30 },
    gregorian: '2024-12-31',
    source: 'characteristic',
    note: '30 Kislev exists in 5785, which has a long Kislev',
  },
  {
    hebrew: { year: 5784, month: 12, day: 30 },
    gregorian: '2024-03-10',
    source: 'characteristic',
    note: '30 Adar I - only exists in a leap year',
  },
  {
    hebrew: { year: 5738, month: 2, day: 5 },
    gregorian: '1978-05-12',
    source: 'regression',
    note: 'Historical date used by the sunset and DST tests',
  },
  {
    hebrew: { year: 5700, month: 7, day: 1 },
    gregorian: '1939-09-14',
    source: 'regression',
    note: 'Early-20th-century year, guards against era drift',
  },
  {
    hebrew: { year: 5800, month: 7, day: 1 },
    gregorian: '2039-09-19',
    source: 'regression',
    note: 'End of the currently generated horizon',
  },
];

/**
 * Year characteristics (PRD 17: leap years, Cheshvan, Kislev).
 * Every Hebrew year is one of six shapes; this table pins the shape of the
 * years the other tests rely on.
 */
export interface YearCharacteristic {
  year: number;
  isLeap: boolean;
  monthsInYear: 12 | 13;
  cheshvanDays: 29 | 30;
  kislevDays: 29 | 30;
  daysInYear: 353 | 354 | 355 | 383 | 384 | 385;
}

export const YEAR_CHARACTERISTICS: YearCharacteristic[] = [
  { year: 5780, isLeap: false, monthsInYear: 12, cheshvanDays: 30, kislevDays: 30, daysInYear: 355 },
  { year: 5781, isLeap: false, monthsInYear: 12, cheshvanDays: 29, kislevDays: 29, daysInYear: 353 },
  { year: 5782, isLeap: true, monthsInYear: 13, cheshvanDays: 29, kislevDays: 30, daysInYear: 384 },
  { year: 5783, isLeap: false, monthsInYear: 12, cheshvanDays: 30, kislevDays: 30, daysInYear: 355 },
  { year: 5784, isLeap: true, monthsInYear: 13, cheshvanDays: 29, kislevDays: 29, daysInYear: 383 },
  { year: 5785, isLeap: false, monthsInYear: 12, cheshvanDays: 30, kislevDays: 30, daysInYear: 355 },
  { year: 5786, isLeap: false, monthsInYear: 12, cheshvanDays: 29, kislevDays: 30, daysInYear: 354 },
  { year: 5787, isLeap: true, monthsInYear: 13, cheshvanDays: 30, kislevDays: 30, daysInYear: 385 },
  { year: 5788, isLeap: false, monthsInYear: 12, cheshvanDays: 30, kislevDays: 30, daysInYear: 355 },
  { year: 5789, isLeap: false, monthsInYear: 12, cheshvanDays: 29, kislevDays: 30, daysInYear: 354 },
  { year: 5790, isLeap: true, monthsInYear: 13, cheshvanDays: 29, kislevDays: 29, daysInYear: 383 },
  { year: 5791, isLeap: false, monthsInYear: 12, cheshvanDays: 30, kislevDays: 30, daysInYear: 355 },
  { year: 5792, isLeap: false, monthsInYear: 12, cheshvanDays: 29, kislevDays: 30, daysInYear: 354 },
  { year: 5793, isLeap: true, monthsInYear: 13, cheshvanDays: 29, kislevDays: 29, daysInYear: 383 },
  { year: 5794, isLeap: false, monthsInYear: 12, cheshvanDays: 30, kislevDays: 30, daysInYear: 355 },
  { year: 5795, isLeap: true, monthsInYear: 13, cheshvanDays: 30, kislevDays: 30, daysInYear: 385 },
  { year: 5796, isLeap: false, monthsInYear: 12, cheshvanDays: 29, kislevDays: 30, daysInYear: 354 },
  { year: 5797, isLeap: false, monthsInYear: 12, cheshvanDays: 29, kislevDays: 29, daysInYear: 353 },
  { year: 5798, isLeap: true, monthsInYear: 13, cheshvanDays: 30, kislevDays: 30, daysInYear: 385 },
  { year: 5799, isLeap: false, monthsInYear: 12, cheshvanDays: 29, kislevDays: 30, daysInYear: 354 },
  { year: 5800, isLeap: false, monthsInYear: 12, cheshvanDays: 30, kislevDays: 30, daysInYear: 355 },
];

/**
 * Independently published sunset times, used to check the astronomy rather
 * than to snapshot it. Tolerance is +/- 2 minutes: published tables round, and
 * differ slightly on refraction and on the exact coordinates of a "city".
 */
export interface SunsetReference {
  locationId: string;
  date: string;
  /** Expected local wall-clock time, HH:MM, in the location's zone. */
  expectedLocalTime: string;
  note: string;
}

export const SUNSET_REFERENCES: SunsetReference[] = [
  {
    locationId: 'seed:new-york',
    date: '2024-06-20',
    expectedLocalTime: '20:31',
    note: 'Summer solstice, EDT',
  },
  {
    locationId: 'seed:new-york',
    date: '2024-12-21',
    expectedLocalTime: '16:32',
    note: 'Winter solstice, EST',
  },
  {
    locationId: 'seed:jerusalem',
    date: '2024-06-20',
    expectedLocalTime: '19:48',
    note: 'Summer solstice, IDT, sea level',
  },
  {
    locationId: 'seed:jerusalem',
    date: '2024-12-21',
    expectedLocalTime: '16:39',
    note: 'Winter solstice, IST, sea level',
  },
  {
    locationId: 'seed:london',
    date: '2024-06-21',
    expectedLocalTime: '21:21',
    note: 'Summer solstice, BST, high latitude',
  },
  {
    locationId: 'seed:los-angeles',
    date: '2024-06-20',
    expectedLocalTime: '20:08',
    note: 'Summer solstice, PDT',
  },
  {
    locationId: 'seed:melbourne',
    date: '2024-06-21',
    expectedLocalTime: '17:08',
    note: 'Southern-hemisphere midwinter, AEST',
  },
  {
    locationId: 'seed:sydney',
    date: '2024-12-21',
    expectedLocalTime: '20:06',
    note: 'Southern-hemisphere midsummer, AEDT',
  },
  {
    locationId: 'seed:phoenix',
    date: '2024-07-01',
    expectedLocalTime: '19:42',
    note: 'No daylight saving anywhere in the year',
  },
];
