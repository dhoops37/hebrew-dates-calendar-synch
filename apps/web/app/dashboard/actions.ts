'use server';

/**
 * Server actions for the dashboard.
 *
 * Every one of these re-resolves the session and its dataset access from the
 * cookie. Nothing trusts an ID that arrived in the form body: the dataset comes
 * from `CurrentUser`, so a crafted POST cannot name somebody else's.
 *
 * Two shapes recur and both are deliberate:
 *
 *  - **Places are identified, not described.** A form sends a place *id* and
 *    the server re-resolves it from the provider. Trusting coordinates from a
 *    form would let a request store a location the user never saw, which is
 *    exactly what confirmation exists to prevent.
 *  - **A record id is always paired with the session's dataset.** Every service
 *    call takes `user.access`, so a record id belonging to someone else
 *    resolves to "not found" rather than being acted on.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AccessDeniedError,
  checkRateLimit,
  type SourceRecordPatch,
} from '@hebrew-dates/db';
import { GeocodingError } from '@hebrew-dates/geocoding';
import {
  CannotEditWhileAwaitingSunsetError,
  DecisionRequiredError,
  LocationNotConfirmedError,
  acceptSuggestedLocation,
  addDateAndSync,
  confirmPlaceById,
  deleteHebrewDate,
  describeDeletion,
  disconnectGoogle,
  editHebrewDate,
  ensureGoogleCalendar,
  requestReconcile,
  resolveSunsetStatus,
  searchPlaces,
  setDateActive,
  suggestLocation,
  syncDestination,
  type CurrentUser,
  type DeletionPreview,
} from '@hebrew-dates/service';
import { context, signedInUser } from '../../lib/server';

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * The shape `useActionState` calls actions with.
 *
 * Every action takes the previous result even when it ignores it, so the client
 * can bind them all the same way and a caller cannot accidentally pass a
 * FormData where a state was expected.
 */
export type DashboardAction = (
  previous: ActionResult | undefined,
  formData: FormData,
) => Promise<ActionResult>;

async function requireSession(): Promise<CurrentUser> {
  const user = await signedInUser();
  if (!user) redirect('/');
  return user;
}

/* ------------------------------------------------------------- locations -- */

export interface PlaceOption {
  id: string;
  displayName: string;
  shortName: string;
  timezoneId: string;
  provider: string;
  hasElevation: boolean;
}

export interface PlaceSearchResult {
  ok: boolean;
  message: string;
  places: PlaceOption[];
  /** True when only the built-in cities were searchable. */
  degraded: boolean;
}

export type PlaceSearchAction = (
  previous: PlaceSearchResult | undefined,
  formData: FormData,
) => Promise<PlaceSearchResult>;

/**
 * Search for a place.
 *
 * Read-only: nothing is stored and the user's calculation location does not
 * change. Rate limited per user, because each call may reach an upstream
 * geocoder with its own usage policy.
 */
export async function searchPlacesAction(
  _previous: PlaceSearchResult | undefined,
  formData: FormData,
): Promise<PlaceSearchResult> {
  const user = await requireSession();
  const query = String(formData.get('query') ?? '').trim();

  const limit = await checkRateLimit(context().db, 'locationSearch', user.userId);
  if (!limit.allowed) {
    return {
      ok: false,
      message: 'Too many searches just now. Please wait a moment and try again.',
      places: [],
      degraded: false,
    };
  }

  try {
    const outcome = await searchPlaces(context(), { query, limit: 8 });
    return {
      ok: true,
      message:
        outcome.candidates.length === 0
          ? `No places found for “${query}”. Try a larger nearby town.`
          : outcome.degraded
            ? 'Place search is temporarily unavailable, so these are from the built-in city list only.'
            : '',
      places: outcome.candidates.map((candidate) => ({
        id: candidate.id,
        displayName: candidate.displayName,
        shortName: candidate.shortName,
        timezoneId: candidate.timezoneId,
        provider: candidate.provider,
        hasElevation: candidate.elevationMeters !== undefined,
      })),
      degraded: outcome.degraded,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof GeocodingError ? error.message : describe(error),
      places: [],
      degraded: false,
    };
  }
}

/**
 * Confirm a place the user picked from a search.
 *
 * The form sends the place id. The server re-resolves it from the provider and
 * re-derives the time zone from the resolved coordinates, so the values stored
 * are ones the provider stands behind rather than ones that travelled through
 * the browser.
 */
export async function confirmPlaceAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const placeId = String(formData.get('placeId') ?? '');
  if (!placeId) return { ok: false, message: 'Please choose a place from the list.' };

  try {
    const { place } = await confirmPlaceById(context(), user.access, {
      destinationCalendarId: user.destinationCalendarId,
      userId: user.userId,
      placeId,
    });
    revalidatePath('/dashboard');
    return {
      ok: true,
      message:
        `Location set to ${place.displayName}. Sunset times will be calculated there ` +
        `(${place.timezoneId}).`,
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/** Accept a location the app suggested from the browser's time zone. */
export async function acceptSuggestionAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const timezoneId = String(formData.get('timezoneId') ?? '');
  const suggestion = suggestLocation(timezoneId);
  if (!suggestion) {
    return {
      ok: false,
      message:
        `No city is known for the time zone ${timezoneId || '(none)'}. ` +
        'Please search for your city instead.',
    };
  }

  try {
    await confirmPlaceById(context(), user.access, {
      destinationCalendarId: user.destinationCalendarId,
      userId: user.userId,
      placeId: `catalogue:${suggestion.location.id}`,
    });
    await acceptSuggestedLocation(context(), user.access, {
      destinationCalendarId: user.destinationCalendarId,
      userId: user.userId,
    });
  } catch (error) {
    return { ok: false, message: describe(error) };
  }

  revalidatePath('/dashboard');
  return { ok: true, message: `Location confirmed as ${suggestion.location.displayName}.` };
}

/* -------------------------------------------------------------- calendar -- */

export async function createCalendarAction(
  _previous?: ActionResult,
  _formData?: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const result = await ensureGoogleCalendar(context(), user.access, {
      destinationCalendarId: user.destinationCalendarId,
      userId: user.userId,
    });
    revalidatePath('/dashboard');
    return {
      ok: true,
      message: result.recreated
        ? 'Your “Hebrew Dates” calendar had been deleted in Google, so it has been recreated. Press “Sync now” to fill it back in.'
        : result.created
          ? 'Created a “Hebrew Dates” calendar in your Google Calendar.'
          : 'Your “Hebrew Dates” calendar already exists.',
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* ------------------------------------------------------------------ dates -- */

/** Shared validation for add and edit. */
function readDateFields(formData: FormData):
  | { ok: true; fields: DateFields }
  | { ok: false; message: string } {
  const type = String(formData.get('type') ?? '');
  const displayName = String(formData.get('displayName') ?? '').trim();
  const entryMode = String(formData.get('entryMode') ?? 'hebrew');
  const hebrewMonth = String(formData.get('hebrewMonth') ?? '');
  const hebrewDay = Number(formData.get('hebrewDay') ?? 0);
  const yearRaw = String(formData.get('originalHebrewYear') ?? '').trim();
  const gregorianDate = String(formData.get('gregorianDate') ?? '').trim();
  const sunsetStatus = String(formData.get('sunsetStatus') ?? '');
  const relationship = String(formData.get('relationship') ?? '').trim();
  const notes = String(formData.get('notes') ?? '').trim();

  if (type !== 'birthday' && type !== 'personal_yahrzeit') {
    return { ok: false, message: 'Choose whether this is a birthday or a yahrzeit.' };
  }
  if (!displayName) return { ok: false, message: 'Please give this date a name.' };

  if (entryMode === 'gregorian') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(gregorianDate)) {
      return { ok: false, message: 'Please give the Gregorian date as YYYY-MM-DD.' };
    }
    return {
      ok: true,
      fields: {
        type,
        displayName,
        entryMode: 'gregorian',
        gregorianDate,
        // 'unknown' is a real answer, and it is the default: the user is asked
        // rather than nudged towards a guess.
        sunsetStatus:
          sunsetStatus === 'before_sunset' || sunsetStatus === 'after_sunset'
            ? sunsetStatus
            : null,
        relationship: relationship || null,
        notes: notes || null,
      },
    };
  }

  if (!Number.isInteger(hebrewDay) || hebrewDay < 1 || hebrewDay > 30) {
    return { ok: false, message: 'The Hebrew day must be between 1 and 30.' };
  }
  const originalHebrewYear = yearRaw ? Number(yearRaw) : undefined;
  if (yearRaw && (!Number.isInteger(originalHebrewYear) || (originalHebrewYear as number) < 1)) {
    return { ok: false, message: 'The Hebrew year must be a whole number, for example 5750.' };
  }
  // The database enforces this too; saying it here means the user gets a
  // sentence rather than a constraint violation.
  if (
    type === 'personal_yahrzeit' &&
    hebrewDay === 30 &&
    (hebrewMonth === 'CHESHVAN' || hebrewMonth === 'KISLEV') &&
    originalHebrewYear === undefined
  ) {
    return {
      ok: false,
      message:
        'A yahrzeit on the 30th of Cheshvan or Kislev needs the Hebrew year of death: ' +
        'the correct date depends on whether the following year has that day at all.',
    };
  }

  return {
    ok: true,
    fields: {
      type,
      displayName,
      entryMode: 'hebrew',
      hebrewMonth: hebrewMonth as 'NISAN',
      hebrewDay,
      ...(originalHebrewYear !== undefined ? { originalHebrewYear } : {}),
      relationship: relationship || null,
      notes: notes || null,
    },
  };
}

interface DateFieldsCommon {
  type: 'birthday' | 'personal_yahrzeit';
  displayName: string;
  relationship: string | null;
  notes: string | null;
}

type DateFields =
  | (DateFieldsCommon & {
      entryMode: 'hebrew';
      hebrewMonth: 'NISAN';
      hebrewDay: number;
      originalHebrewYear?: number;
    })
  | (DateFieldsCommon & {
      entryMode: 'gregorian';
      gregorianDate: string;
      sunsetStatus: 'before_sunset' | 'after_sunset' | null;
    });

/** Add a Hebrew date and sync it immediately. */
export async function addDateAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const parsed = readDateFields(formData);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const fields = parsed.fields;

  try {
    const result = await addDateAndSync(context(), user.access, {
      userId: user.userId,
      destinationCalendarId: user.destinationCalendarId,
      date:
        fields.entryMode === 'gregorian'
          ? {
              type: fields.type,
              displayName: fields.displayName,
              // A placeholder until the sunset question is answered: the real
              // Hebrew date is computed from the answer, not from these.
              hebrewMonth: 'TISHREI',
              hebrewDay: 1,
              originalGregorianDate: fields.gregorianDate,
              sunsetStatus: fields.sunsetStatus,
              relationship: fields.relationship,
              notes: fields.notes,
            }
          : {
              type: fields.type,
              displayName: fields.displayName,
              hebrewMonth: fields.hebrewMonth,
              hebrewDay: fields.hebrewDay,
              ...(fields.originalHebrewYear !== undefined
                ? { originalHebrewYear: fields.originalHebrewYear }
                : {}),
              relationship: fields.relationship,
              notes: fields.notes,
            },
    });

    revalidatePath('/dashboard');

    // The point of item 1: this is an ordinary outcome with a next step, not
    // an error.
    if (result.awaitingSunsetDecision) {
      return {
        ok: true,
        message:
          `${fields.displayName} has been saved, but Hebrew Dates needs one more answer ` +
          'before it can work out the anniversaries — see “Needs your answer” below.',
      };
    }

    const added = result.sync.created;
    return {
      ok: true,
      message:
        `Added ${fields.displayName}. ${added} event${added === 1 ? '' : 's'} written to your ` +
        'calendar now; the remaining years are being added in the background.' +
        (result.requiresReview
          ? ' This date has an ambiguity worth reviewing — see the note on the entry.'
          : ''),
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/** Answer the sunset question for a draft. */
export async function resolveSunsetAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const sourceRecordId = String(formData.get('sourceRecordId') ?? '');
  const choice = String(formData.get('choice') ?? '');

  if (choice !== 'before_sunset' && choice !== 'after_sunset') {
    // No default. The whole point is that the user chooses.
    return { ok: false, message: 'Please choose before sunset or after sunset.' };
  }

  try {
    const resolved = await resolveSunsetStatus(context(), user.access, {
      sourceRecordId,
      choice,
      destinationCalendarId: user.destinationCalendarId,
    });
    const sync = await syncDestination(context(), user.access, {
      destinationCalendarId: user.destinationCalendarId,
      userId: user.userId,
    });
    await requestReconcile(context(), { datasetId: user.datasetId });

    revalidatePath('/dashboard');
    return {
      ok: true,
      message:
        `Recorded as ${resolved.hebrewDateLabel}. ${sync.created} event` +
        `${sync.created === 1 ? '' : 's'} written to your calendar; the remaining years ` +
        'are being added in the background.',
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/** Edit a date and reconcile the calendar. */
export async function editDateAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const sourceRecordId = String(formData.get('sourceRecordId') ?? '');
  if (!sourceRecordId) return { ok: false, message: 'Which date did you want to edit?' };

  const parsed = readDateFields(formData);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const fields = parsed.fields;

  // Only Hebrew-date fields are editable here. Changing a Gregorian entry's
  // date would re-open the sunset question, which is its own flow.
  const patch: SourceRecordPatch = {
    displayName: fields.displayName,
    relationship: fields.relationship,
    notes: fields.notes,
    ...(fields.entryMode === 'hebrew'
      ? {
          hebrewMonth: fields.hebrewMonth,
          hebrewDay: fields.hebrewDay,
          originalHebrewYear: fields.originalHebrewYear ?? null,
        }
      : {}),
  };

  try {
    const result = await editHebrewDate(context(), user.access, {
      sourceRecordId,
      userId: user.userId,
      destinationCalendarId: user.destinationCalendarId,
      patch,
    });

    revalidatePath('/dashboard');

    if (result.changedFields.length === 0) {
      return { ok: true, message: 'Nothing changed, so nothing was rewritten.' };
    }

    const { sync } = result;
    return {
      ok: true,
      message: result.dateChanged
        ? `Updated. The Hebrew date moved, so ${sync?.updated ?? 0} event` +
          `${(sync?.updated ?? 0) === 1 ? '' : 's'} in your calendar were moved to the new ` +
          'dates. Past events were left where they are.'
        : `Updated. ${sync?.updated ?? 0} event${(sync?.updated ?? 0) === 1 ? '' : 's'} in ` +
          'your calendar were rewritten.',
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export interface DeletePreviewResult {
  ok: boolean;
  message: string;
  preview: DeletionPreview | undefined;
}

/**
 * Say what deleting will do, before doing it.
 *
 * A separate action from the deletion itself so the user reads the numbers and
 * then confirms, rather than pressing one button and finding out.
 */
export async function previewDeleteAction(
  _previous: DeletePreviewResult | undefined,
  formData: FormData,
): Promise<DeletePreviewResult> {
  const user = await requireSession();
  const sourceRecordId = String(formData.get('sourceRecordId') ?? '');
  try {
    const preview = await describeDeletion(context(), user.access, {
      sourceRecordId,
      destinationCalendarId: user.destinationCalendarId,
    });
    return { ok: true, message: '', preview };
  } catch (error) {
    return { ok: false, message: describe(error), preview: undefined };
  }
}

export async function deleteDateAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const sourceRecordId = String(formData.get('sourceRecordId') ?? '');
  if (!sourceRecordId) return { ok: false, message: 'Which date did you want to delete?' };

  try {
    const result = await deleteHebrewDate(context(), user.access, {
      sourceRecordId,
      userId: user.userId,
      destinationCalendarId: user.destinationCalendarId,
    });

    revalidatePath('/dashboard');
    const removed = result.futureEventsRemoved;
    const kept = result.pastEventsKept;
    return {
      ok: true,
      message:
        `Deleted ${result.preview.displayName}. ${removed} event${removed === 1 ? '' : 's'} ` +
        `removed from your Google Calendar` +
        (kept > 0
          ? `; ${kept} that had already passed were left where they are.`
          : '.'),
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function toggleDateActiveAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const sourceRecordId = String(formData.get('sourceRecordId') ?? '');
  const active = formData.get('active') === 'yes';

  try {
    const result = await setDateActive(context(), user.access, {
      sourceRecordId,
      userId: user.userId,
      destinationCalendarId: user.destinationCalendarId,
      active,
    });
    revalidatePath('/dashboard');
    return {
      ok: true,
      message: active
        ? `Resumed. ${result.sync.created} event${result.sync.created === 1 ? '' : 's'} added back.`
        : `Paused. ${result.sync.deleted} future event${result.sync.deleted === 1 ? '' : 's'} ` +
          'removed; the date itself is kept so you can resume it.',
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* ------------------------------------------------------------------- sync -- */

/** Run a sync now, rather than waiting for the next scheduled pass. */
export async function syncNowAction(
  _previous?: ActionResult,
  _formData?: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const result = await syncDestination(context(), user.access, {
      destinationCalendarId: user.destinationCalendarId,
      userId: user.userId,
    });
    revalidatePath('/dashboard');

    if (result.blocked) return { ok: false, message: result.blocked.message };
    if (result.needsReauth) {
      return {
        ok: false,
        message: 'Your Google connection has expired. Please reconnect Google Calendar.',
      };
    }
    if (result.hasMoreWork) {
      // Queue the remainder rather than looping here: a request must not hold a
      // serverless function open for hundreds of writes.
      await requestReconcile(context(), { datasetId: user.datasetId });
    }

    const changed = result.created + result.updated + result.deleted;
    return {
      ok: true,
      message:
        changed === 0
          ? 'Everything is already up to date.'
          : `Added ${result.created}, updated ${result.updated}, removed ${result.deleted}.` +
            (result.hasMoreWork ? ' More is being written in the background.' : ''),
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function disconnectAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const deleteCalendar = formData.get('deleteCalendar') === 'yes';
  try {
    const result = await disconnectGoogle(context(), {
      userId: user.userId,
      deleteCalendar,
    });
    // Disconnecting destroys every session, so there is nothing to revalidate.
    redirect(`/?disconnected=1&calendar=${result.calendarDeleted ? 'deleted' : 'kept'}`);
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/**
 * Turn an error into something worth showing a person.
 *
 * The typed service errors already carry sentences written for a user, so they
 * pass through. Anything else is a bug and gets a generic line rather than a
 * stack trace or a database message.
 */
function describe(error: unknown): string {
  if (error instanceof AccessDeniedError) return 'Not found.';
  if (
    error instanceof LocationNotConfirmedError ||
    error instanceof CannotEditWhileAwaitingSunsetError ||
    error instanceof GeocodingError
  ) {
    return error.message;
  }
  if (error instanceof DecisionRequiredError) return error.question;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
