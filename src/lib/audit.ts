import { LAB_KEY } from "@/lib/lab";
import type { Actor } from "@/lib/actor";
import { readDoorConfig } from "@/lib/platform/door";
import { createProtocolClient } from "@/lib/platform-client/core/protocol";
import type { AuditActor, AuditLine } from "@/lib/platform-client/core/types";

/**
 * The audit trail (platform protocol) of this Lab. Written by the SERVICE,
 * never by an action or a route, so every door produces the same line.
 *
 * The line (action, object, title, details) is identical whichever door was
 * used. Only the actor form differs, because the platform needs it so:
 *
 *   ui                          { token }           the person's Suite token
 *   api-key / on-behalf person  { actorUserId }     the person behind the credential
 *                                                   (platform marks it `background`)
 *   worker / token w/o person   { system: true }    nobody sat at it; the Suite shows "System"
 *
 * Never a person taken from the data being processed, never a fallback to an
 * admin (platform contract round 3 no. 2, round 5 no. 2).
 *
 * Like every protocol line it NEVER throws: an outage of the platform must not
 * undo or block the write it reports. Failures are logged by the shared client.
 * Without a platform door (local development) nothing is written.
 *
 * Action names: the platform's `object.*` vocabulary where it fits
 * (`object.created`, `object.updated`, `object.visibility_changed`,
 * `object.deleted`), otherwise `<LAB_KEY>.<what>`.
 */

export type AuditInput = Omit<AuditLine, "organisationId">;

export function auditActorOf(actor: Actor): AuditActor {
  if (actor.door === "ui" && actor.sessionToken)
    return { token: actor.sessionToken };
  if (actor.personUserId) return { actorUserId: actor.personUserId };
  return { system: true };
}

const client = createProtocolClient({
  productKey: LAB_KEY,
  door: () => readDoorConfig(),
  defaultObjectType: "note",
});

type Writer = (actor: AuditActor, line: AuditLine) => Promise<boolean>;

let writer: Writer = (actor, line) => client.audit(actor, line);

export async function recordAudit(
  actor: Actor,
  input: AuditInput,
): Promise<boolean> {
  try {
    return await writer(auditActorOf(actor), {
      ...input,
      organisationId: actor.organisationId,
    });
  } catch {
    return false;
  }
}

/** Tests only: capture lines instead of sending them. Returns the restore function. */
export function __setAuditWriterForTests(next: Writer): () => void {
  const previous = writer;
  writer = next;
  return () => {
    writer = previous;
  };
}
