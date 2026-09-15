'use server';

/**
 * Server actions for the dashboard.
 *
 * Every one of these re-resolves the session and its dataset access from the
 * cookie. Nothing trusts an ID that arrived in the form body: the dataset comes
 * from `CurrentUser`, so a crafted POST cannot name somebody else's.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AccessDeniedError, confirmLocationRow } from '@hebrew-dates/db';
import {
  confirmLocation as saveConfirmedLocation,
  suggestLocation,
  addDateAndSync,
  disconnectGoogle,
  ensureGoogleCalendar,
  requestReconcile,
  syncDestination,
  type CurrentUser,
} from '@hebrew-dates/service';
import { SEED_LOCATIONS } from '@hebrew-dates/engine';
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

/**
 * Confirm a location the user picked from the seed list.
 *
 * The form sends a seed location's id, not coordinates. Trusting coordinates
 * from a form would let a bad request store a location the user never saw,
 * which is precisely what confirmation exists to prevent.
 */
export async function confirmLocationAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const locationId = String(formData.get('locationId') ?? '');
  const seed = SEED_LOCATIONS.find((candidate) => candidate.id === locationId);
  if (!seed) {
    return { ok: false, message: 'Please choose a location from the list.' };
  }

  try {
    await saveConfirmedLocation(context(), user.access, {
      destinationCalendarId: user.destinationCalendarId,
      userId: user.userId,
      location: seed,
      // The calendar's own display zone. Separate from the location's zone by
      // design; here they happen to match because the user picked the place.
      calendarTimezoneHint: seed.timezoneId,
    });
  } catch (error) {
    return { ok: false, message: describe(error) };
  }

  revalidatePath('/dashboard');
  return { ok: true, message: `Location set to ${seed.displayName}.` };
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
        `No location is known for the time zone ${timezoneId || '(none)'}. ` +
        'Please choose the nearest city from the list.',
    };
  }

  try {
    await saveConfirmedLocation(context(), user.access, {
      destinationCalendarId: user.destinationCalendarId,
      userId: user.userId,
      location: suggestion.location,
      calendarTimezoneHint: suggestion.location.timezoneId,
    });
    await confirmLocationRow(context().db, user.access, {
      destinationCalendarId: user.destinationCalendarId,
      userId: user.userId,
    });
  } catch (error) {
    return { ok: false, message: describe(error) };
  }

  revalidatePath('/dashboard');
  return { ok: true, message: `Location confirmed as ${suggestion.location.displayName}.` };
}

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
      message: result.created
        ? 'Created a “Hebrew Dates” calendar in your Google Calendar.'
        : 'Your “Hebrew Dates” calendar already exists.',
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/** Add a Hebrew date and sync it immediately. */
export async function addDateAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();

  const type = String(formData.get('type') ?? '');
  const displayName = String(formData.get('displayName') ?? '').trim();
  const hebrewMonth = String(formData.get('hebrewMonth') ?? '');
  const hebrewDay = Number(formData.get('hebrewDay') ?? 0);
  const originalHebrewYearRaw = String(formData.get('originalHebrewYear') ?? '').trim();

  if (type !== 'birthday' && type !== 'personal_yahrzeit') {
    return { ok: false, message: 'Choose whether this is a birthday or a yahrzeit.' };
  }
  if (!displayName) {
    return { ok: false, message: 'Please give this date a name.' };
  }
  if (!Number.isInteger(hebrewDay) || hebrewDay < 1 || hebrewDay > 30) {
    return { ok: false, message: 'The Hebrew day must be between 1 and 30.' };
  }

  const originalHebrewYear = originalHebrewYearRaw ? Number(originalHebrewYearRaw) : undefined;
  if (originalHebrewYearRaw && !Number.isInteger(originalHebrewYear)) {
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

  try {
    const result = await addDateAndSync(context(), user.access, {
      userId: user.userId,
      destinationCalendarId: user.destinationCalendarId,
      date: {
        type,
        displayName,
        hebrewMonth: hebrewMonth as 'NISAN',
        hebrewDay,
        ...(originalHebrewYear !== undefined ? { originalHebrewYear } : {}),
      },
    });

    revalidatePath('/dashboard');
    const added = result.sync.created;
    return {
      ok: true,
      message:
        `Added ${displayName}. ${added} event${added === 1 ? '' : 's'} written to your ` +
        'calendar now; the remaining years are being added in the background.' +
        (result.requiresReview
          ? ' This date has an ambiguity worth reviewing — see the note on the entry.'
          : ''),
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

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
    redirect(
      `/?disconnected=1&calendar=${result.calendarDeleted ? 'deleted' : 'kept'}`,
    );
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/** Turn an error into something worth showing a person. */
function describe(error: unknown): string {
  if (error instanceof AccessDeniedError) return 'Not found.';
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
