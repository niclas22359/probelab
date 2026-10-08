import "server-only";

import type { Actor } from "@/lib/actor";
import { canEdit, chooseContainer, visibleWhere } from "@/lib/access-rules";
import { recordAudit } from "@/lib/audit";
import { LAB_KEY } from "@/lib/lab";
import { ServiceError } from "@/lib/service-errors";
import type { ExpireNotesInput, ListNotesQuery, NoteInput, NoteUpdate } from "@/server/schemas/notes";
import { db } from "@/lib/db";
import { checkDeletion, parseMaxShare } from "@/server/jobs/deletion-guard";
import { assertNotRedacted } from "@/server/retention/redaction";

/**
 * The notes functions — each exists ONCE and does everything that must be
 * identical across the screen, `/api/v1` and MCP:
 *   permission (container rules), container choice (`chooseContainer`, one
 *   default), the write, and the audit line (`recordAudit`).
 * Doors only parse input, build the `Actor`, call here and map errors
 * (`src/lib/service-errors.ts`). Scopes are the door's part
 * (`src/server/machine-door.ts`); every export is listed in
 * `src/server/functions.manifest.ts` (the parity test fails otherwise).
 */

const select = {
  id: true,
  title: true,
  body: true,
  visibility: true,
  ownerUserId: true,
  collectionId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const NOT_FOUND = "Note not found.";

export async function listNotes(actor: Actor, query: Partial<ListNotesQuery> = {}) {
  const search = query.search?.trim();
  return db.note.findMany({
    where: {
      AND: [
        visibleWhere(actor.access, "note"),
        search
          ? { OR: [{ title: { contains: search, mode: "insensitive" } }, { body: { contains: search, mode: "insensitive" } }] }
          : {},
      ],
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(query.limit ?? 50, 1), 100),
    select,
  });
}

export async function countVisibleNotes(actor: Actor): Promise<number> {
  return db.note.count({ where: visibleWhere(actor.access, "note") });
}

/** "Does not exist" and "belongs to somebody else" answer the same. */
export async function getNote(actor: Actor, noteId: string) {
  const note = await db.note.findFirst({ where: { AND: [{ id: noteId }, visibleWhere(actor.access, "note")] }, select });
  if (!note) throw new ServiceError("not_found", NOT_FOUND);
  return note;
}

export async function createNote(actor: Actor, input: NoteInput) {
  const container = chooseContainer(actor.access, input.visibility);
  const note = await db.note.create({
    data: {
      organisationId: actor.organisationId,
      title: input.title,
      body: input.body,
      visibility: container.visibility,
      ...(container.collectionId ? { collectionId: container.collectionId } : {}),
      ownerUserId: actor.access.userId,
    },
    select,
  });
  await recordAudit(actor, {
    action: "object.created",
    objectId: note.id,
    objectTitle: note.title,
    details: { visibility: note.visibility.toLowerCase() },
  });
  return note;
}

export async function updateNote(actor: Actor, noteId: string, patch: NoteUpdate) {
  const current = await getNote(actor, noteId);
  if (!canEdit(actor.access, "note", current)) throw new ServiceError("forbidden", "You may see this note but not change it.");
  // Retention: a redacted note stays redacted (src/server/retention/redaction.ts).
  const lock = await db.note.findFirst({ where: { id: current.id, organisationId: actor.organisationId }, select: { redactedAt: true } });
  if (lock) assertNotRedacted(lock);

  let visibility = current.visibility;
  if (patch.visibility !== undefined) {
    if (current.ownerUserId !== actor.access.userId || !actor.personUserId) {
      throw new ServiceError("forbidden", "Only the owner of a note changes who sees it.");
    }
    visibility = chooseContainer(actor.access, patch.visibility).visibility;
  }

  const note = await db.note.update({
    where: { id: current.id, organisationId: actor.organisationId },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      visibility,
    },
    select,
  });
  if (patch.title !== undefined || patch.body !== undefined) {
    await recordAudit(actor, { action: "object.updated", objectId: note.id, objectTitle: note.title });
  }
  if (visibility !== current.visibility) {
    await recordAudit(actor, {
      action: "object.visibility_changed",
      objectId: note.id,
      objectTitle: note.title,
      details: { from: current.visibility.toLowerCase(), to: visibility.toLowerCase() },
    });
  }
  return note;
}

export async function deleteNote(actor: Actor, noteId: string): Promise<{ id: string; deleted: true }> {
  const current = await getNote(actor, noteId);
  if (!canEdit(actor.access, "note", current)) throw new ServiceError("forbidden", "You may see this note but not delete it.");
  await db.note.delete({ where: { id: current.id, organisationId: actor.organisationId } });
  await recordAudit(actor, { action: "object.deleted", objectId: current.id, objectTitle: current.title });
  return { id: current.id, deleted: true };
}

/**
 * WORKER-TRIGGERED (cron-style): delete organisation-wide notes older than N
 * days. Reachable only through `POST /api/v1/worker/expire-notes` with a
 * WORKER key (`trigger: "worker"` in the manifest); no screen, no tool.
 * Organisation rows only, by construction: a worker sees nothing else.
 */
export async function expireNotes(
  actor: Actor,
  input: ExpireNotesInput,
): Promise<{ deleted: number; expired: number; dryRun: boolean }> {
  if (actor.door !== "worker") throw new ServiceError("forbidden", "Only a worker key runs this job.");
  const cutoff = new Date(Date.now() - input.olderThanDays * 86_400_000);
  const scope = [visibleWhere(actor.access, "note"), { visibility: "ORGANISATION" as const }];
  // Deletion guard (lab learnings, rule 4): count first; more than the
  // allowed share of the organisation's notes in one run is refused.
  const total = await db.note.count({ where: { AND: scope } });
  const expired = await db.note.count({ where: { AND: [...scope, { createdAt: { lt: cutoff } }] } });
  const verdict = checkDeletion({
    toDelete: expired,
    total,
    maxShare: parseMaxShare(process.env.EXPIRE_NOTES_MAX_SHARE),
    allowEmpty: true,
  });
  if (!verdict.ok) {
    throw new ServiceError("conflict", `Refused by the deletion guard (${verdict.reason}): ${expired} of ${total} notes.`);
  }
  if (input.dryRun || expired === 0) return { deleted: 0, expired, dryRun: input.dryRun };

  const result = await db.note.deleteMany({ where: { AND: [...scope, { createdAt: { lt: cutoff } }] } });
  if (result.count > 0) {
    await recordAudit(actor, {
      action: `${LAB_KEY}.notes_expired`,
      details: { deleted: result.count, olderThanDays: input.olderThanDays },
    });
  }
  return { deleted: result.count, expired, dryRun: false };
}
