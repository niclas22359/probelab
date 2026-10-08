import "server-only";

import { db } from "@/lib/db";

/**
 * The SUCCESSOR rule of the access model: when a person leaves an
 * organisation, the platform asks every product to hand over what that person
 * owns (`POST /api/platform/reassign-owner`).
 *
 * In ONE transaction:
 *  - every note of the organisation owned by `fromUserId` gets
 *    `ownerUserId = toUserId`; visibility and collection stay as they were
 *    (a change of owner is not a share);
 *  - every still active key of the organisation the person created is
 *    revoked (revoked, not deleted: the row stays as evidence). WORKER keys
 *    have no creator and are not touched, so nightly jobs survive a departure.
 *
 * Idempotent: a second run, and an organisation this Lab never saw, count 0.
 * Every object table with an owner column belongs in here; the counts are
 * reported per object type.
 */

export interface ReassignResult {
  reassigned: { note: number };
  revokedApiKeys: number;
}

export async function reassignOwner(
  organisationId: string,
  fromUserId: string,
  toUserId: string,
  now: Date = new Date(),
): Promise<ReassignResult> {
  const [notes, keys] = await db.$transaction([
    db.note.updateMany({
      where: { organisationId, ownerUserId: fromUserId },
      data: { ownerUserId: toUserId },
    }),
    db.apiKey.updateMany({
      where: { organisationId, createdByUserId: fromUserId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
  return { reassigned: { note: notes.count }, revokedApiKeys: keys.count };
}
