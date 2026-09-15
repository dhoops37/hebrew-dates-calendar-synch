/**
 * Authorisation: the single gate every dataset-scoped query goes through.
 *
 * Cross-tenant leakage is the highest-impact bug this system could have — one
 * family seeing another family's dates of death — so access is resolved from the
 * session in exactly one place rather than checked ad hoc per route.
 *
 * The rule: **never trust an ID from the request path.** A caller supplies a
 * dataset ID and a session; this module decides whether that pairing is real,
 * and every repository function takes the resulting `DatasetAccess` token rather
 * than a bare ID. A route that forgets the check cannot type-check.
 */
import type { Kysely } from 'kysely';
import type { Database, MemberRole } from './schema';

export class AccessDeniedError extends Error {
  constructor(message = 'Not found') {
    // Deliberately indistinguishable from "does not exist": telling an attacker
    // that a dataset exists but is not theirs is itself a disclosure.
    super(message);
  }
}

/**
 * Proof that a user may act on a dataset at a given level. Only `authorise`
 * constructs one, and the private brand stops a caller fabricating it.
 */
export interface DatasetAccess {
  readonly datasetId: string;
  readonly userId: string;
  readonly role: MemberRole;
  /** @internal */
  readonly __brand: 'DatasetAccess';
}

const ROLE_RANK: Record<MemberRole, number> = { viewer: 1, editor: 2, admin: 3 };

/**
 * Resolve and check access in one step.
 *
 * `minimumRole` matters now that datasets are shared: a viewer must not be able
 * to edit a source record, because that would change what appears in another
 * member's calendar.
 */
export async function authorise(
  db: Kysely<Database>,
  params: { datasetId: string; userId: string; minimumRole: MemberRole },
): Promise<DatasetAccess> {
  const row = await db
    .selectFrom('datasets')
    .innerJoin('owner_members', 'owner_members.owner_id', 'datasets.owner_id')
    .select(['datasets.id as dataset_id', 'owner_members.role as role'])
    .where('datasets.id', '=', params.datasetId)
    .where('owner_members.user_id', '=', params.userId)
    .where('datasets.active', '=', true)
    .executeTakeFirst();

  if (!row) throw new AccessDeniedError();
  if (ROLE_RANK[row.role] < ROLE_RANK[params.minimumRole]) {
    throw new AccessDeniedError();
  }

  return {
    datasetId: row.dataset_id,
    userId: params.userId,
    role: row.role,
    __brand: 'DatasetAccess',
  } as DatasetAccess;
}

/**
 * Resolve access via a destination calendar rather than a dataset, since the
 * sync paths are addressed by calendar. Returns the dataset access plus the
 * calendar, so callers cannot accidentally use a calendar from another dataset.
 */
export async function authoriseDestination(
  db: Kysely<Database>,
  params: { destinationCalendarId: string; userId: string; minimumRole: MemberRole },
): Promise<{ access: DatasetAccess; destinationCalendarId: string; datasetId: string }> {
  const row = await db
    .selectFrom('destination_calendars')
    .innerJoin('datasets', 'datasets.id', 'destination_calendars.dataset_id')
    .innerJoin('owner_members', 'owner_members.owner_id', 'datasets.owner_id')
    .select([
      'destination_calendars.id as destination_calendar_id',
      'datasets.id as dataset_id',
      'owner_members.role as role',
    ])
    .where('destination_calendars.id', '=', params.destinationCalendarId)
    .where('owner_members.user_id', '=', params.userId)
    .where('destination_calendars.active', '=', true)
    .executeTakeFirst();

  if (!row) throw new AccessDeniedError();
  if (ROLE_RANK[row.role] < ROLE_RANK[params.minimumRole]) {
    throw new AccessDeniedError();
  }

  return {
    access: {
      datasetId: row.dataset_id,
      userId: params.userId,
      role: row.role,
      __brand: 'DatasetAccess',
    } as DatasetAccess,
    destinationCalendarId: row.destination_calendar_id,
    datasetId: row.dataset_id,
  };
}

/**
 * Access for a background job, which has no session.
 *
 * Jobs act on datasets nobody is currently signed in to, so they cannot resolve
 * a membership. This is the only way to obtain access without a user, it is
 * named so that it stands out in review, and it records which job claimed it.
 */
export function systemAccess(datasetId: string, jobId: string): DatasetAccess {
  return {
    datasetId,
    userId: `system:job:${jobId}`,
    role: 'admin',
    __brand: 'DatasetAccess',
  } as DatasetAccess;
}

export function isSystemAccess(access: DatasetAccess): boolean {
  return access.userId.startsWith('system:');
}
