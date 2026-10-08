/**
 * platform-client: the writing calls to the platform. Individual grants on an object, the
 * collections a person may offer, and the protocol (audit) in its token, actor, system and
 * batch form.
 *
 * Two stances, on purpose (CONTRACT 4.1, "audit never throws; grant calls always throw"):
 *  - A GRANT is the action itself. It throws, so that the share dialog shows the failure
 *    instead of reporting success and doing nothing.
 *  - A PROTOCOL LINE is the account of an action, not the action. It never throws: an outage
 *    of the platform must not keep an object from being created. It is logged so it shows.
 *
 * The platform cannot know who owns an object. The PRODUCT asserts that the acting person may
 * manage it and must have checked that before (`rules.canManage`).
 *
 * Replaces the `platform/protocol.ts` of leadlab, advisorlab, bookinglab, signaturelab,
 * summarizelab and contentlab, and bookinglab `platform/audit-batch.ts`. The audit action
 * names, product-specific wrappers and the choice of actor stay in the product.
 *
 * Imports `types.ts` and `http.ts` only (API section 0.6). No state at module level: the
 * "logged once" memory lives in the client object.
 */

import { platformRequest } from "./http";
import { AUDIT_BATCH_MAX, PROTOCOL_TIMEOUT_MS, PlatformError, TITLE_MAX } from "./types";
import type { AuditActor, AuditBudgetOptions, AuditBudgetResult, AuditLine } from "./types";
import type { DoorConfig, GrantLevel, GrantRow, Logger, ObjectRemovalResult } from "./types";
import type { PlatformRequest, ProtocolClient, ProtocolClientOptions } from "./types";

/* ---------------------------------------------------------------------------- helpers */

/** A title in the protocol is a reference, not a copy. The platform cuts at the same length. */
function trimTitle(title: string): string {
  return title.trim().slice(0, TITLE_MAX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Blank after trimming counts as empty (API.md section 0, rule 11). */
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function messageOf(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

function codeOf(error: unknown): string {
  return error instanceof PlatformError ? error.code : "UNKNOWN";
}

/**
 * How a protocol call identifies its actor: which token is sent, and which field the body
 * gets. `null` when there is nobody to name, and then nothing is written at all: "a job
 * nobody ordered names nobody" (platform contract round 3 no. 2).
 */
interface ActorForm {
  /** The Suite token of the person at the keyboard, or `null` for the two forms without one. */
  token: string | null;
  /** `{}`, `{ actorUserId }` or `{ system: true }`. Never `actorUserId: null`, never `system: false`. */
  field: Record<string, unknown>;
  system: boolean;
}

function actorForm(actor: AuditActor | null): ActorForm | null {
  if (!isRecord(actor)) return null;
  // The form is chosen by the key that is present, so an empty token is "nobody", not a
  // silent switch to another form.
  if ("token" in actor) {
    return nonEmptyString(actor.token) ? { token: actor.token, field: {}, system: false } : null;
  }
  if ("actorUserId" in actor) {
    return nonEmptyString(actor.actorUserId)
      ? { token: null, field: { actorUserId: actor.actorUserId }, system: false }
      : null;
  }
  if (actor.system === true) return { token: null, field: { system: true }, system: true };
  return null;
}

/**
 * The actor of a caller that may be a person at the keyboard or a job acting for a person.
 * The token wins, then the named person. Never the system form: that one means "nobody asked
 * at a keyboard" and is chosen explicitly by the caller (advisorlab `writeCallerAudit`).
 */
export function auditActorFor(caller: {
  token?: string | null;
  actorUserId?: string | null;
}): AuditActor | null {
  if (nonEmptyString(caller.token)) return { token: caller.token };
  if (nonEmptyString(caller.actorUserId)) return { actorUserId: caller.actorUserId };
  return null;
}

/**
 * Many writes without missing the answer (bookinglab `schreibeMitBudget`).
 *
 * The occasion is the hand-over of ownership at offboarding: every single protocol call may
 * take up to eight seconds, and the platform waits thirty for the route's answer. So there is
 * a clock and a cap:
 *  - Once the budget has run out, no FURTHER item is started. Items already started finish.
 *  - A small number of workers, because the lines of one hand-over share one rate limit.
 * A missing protocol line is a blemish, a missed answer is a failed hand-over: the clock wins.
 *
 * `write` should not throw. If it does, or returns `false`, the item counts as not written.
 * Never throws itself.
 */
export async function runWithBudget<I>(
  items: readonly I[],
  write: (item: I) => Promise<boolean>,
  options: AuditBudgetOptions,
): Promise<AuditBudgetResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  const wanted = Number.isFinite(options.parallel) ? Math.floor(options.parallel) : 1;
  const workers = Math.max(1, Math.min(wanted, items.length));

  let next = 0;
  let written = 0;
  let budgetExhausted = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (next >= items.length) return;
      if (now() >= deadline) {
        budgetExhausted = true;
        return;
      }
      const item = items[next] as I;
      next += 1;
      let done = false;
      try {
        done = (await write(item)) === true;
      } catch {
        done = false;
      }
      if (done) written += 1;
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));

  return { written, skipped: items.length - written, budgetExhausted };
}

/* ----------------------------------------------------------------------------- client */

export function createProtocolClient(options: ProtocolClientOptions): ProtocolClient {
  const timeoutMs = options.timeoutMs ?? PROTOCOL_TIMEOUT_MS;
  /** Reasons that were already logged. Per client object, emptied by `clear()`. */
  const logged = new Set<string>();

  function log(): Logger {
    return options.log ?? console;
  }

  /**
   * The door, read on every call so a host can read its environment late. A callback that
   * throws is treated as "not configured": a door that cannot be read is no door.
   */
  function readDoor(): DoorConfig | null {
    try {
      return options.door();
    } catch (error) {
      if (!logged.has("door-callback")) {
        logged.add("door-callback");
        log().error("[platform-protocol] the door settings could not be read:", messageOf(error));
      }
      return null;
    }
  }

  /** One call to the platform. Throws `PlatformError` and nothing else. */
  async function request(
    method: PlatformRequest["method"],
    path: string,
    token: string | null,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const door = readDoor();
    if (!door) {
      throw new PlatformError(
        "DOOR_NOT_CONFIGURED",
        "The platform door is not configured: its address or its service key is missing.",
        0,
      );
    }
    return platformRequest({
      door,
      method,
      path,
      token,
      timeoutMs,
      ...(body !== undefined ? { body } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  function organisationPath(organisationId: string): string {
    return `/api/access/orgs/${encodeURIComponent(organisationId)}`;
  }

  function objectPath(organisationId: string, objectType: string, objectId: string): string {
    // `productKey` is the host's own constant and is used as given.
    return (
      `${organisationPath(organisationId)}/objects/${options.productKey}/` +
      `${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`
    );
  }

  /**
   * The body `{ title }` of a deletion, or nothing. The platform writes `object.deleted` only
   * when a title comes along, so an empty one is left out instead of being sent as "".
   */
  function titleBody(title: string | null | undefined): Record<string, unknown> | undefined {
    if (typeof title !== "string") return undefined;
    const trimmed = trimTitle(title);
    return trimmed.length > 0 ? { title: trimmed } : undefined;
  }

  /**
   * The body of ONE line, the same for the single route and for the batch. The actor field is
   * not part of it: on the single route it is spread next to these fields, in a batch it
   * stands at the top level only.
   */
  function lineBody(line: AuditLine): Record<string, unknown> {
    const objectType = line.objectType ?? options.defaultObjectType;
    const body: Record<string, unknown> = { action: line.action };
    if (objectType !== undefined && objectType !== null) body.objectType = objectType;
    if (line.objectId !== undefined && line.objectId !== null) body.objectId = line.objectId;
    if (typeof line.objectTitle === "string") body.objectTitle = trimTitle(line.objectTitle);
    if (nonEmptyString(line.targetUserId)) body.targetUserId = line.targetUserId;
    if (line.details !== undefined && line.details !== null) body.details = line.details;
    return body;
  }

  /* ------------------------------------------------------------ grants and collections */

  async function listGrants(
    token: string,
    organisationId: string,
    objectType: string,
    objectId: string,
  ): Promise<GrantRow[]> {
    const data = await request(
      "GET",
      `${objectPath(organisationId, objectType, objectId)}/grants`,
      token,
    );
    const raw = data.grants;
    if (!Array.isArray(raw)) return [];
    const rows: GrantRow[] = [];
    for (const entry of raw as unknown[]) {
      if (!isRecord(entry) || !nonEmptyString(entry.userId)) continue;
      rows.push({
        userId: entry.userId,
        // Anything but a clear `edit` is the careful right.
        level: entry.level === "edit" ? "edit" : "view",
        grantedBy: typeof entry.grantedBy === "string" ? entry.grantedBy : null,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
      });
    }
    return rows;
  }

  async function putGrant(
    token: string,
    organisationId: string,
    objectType: string,
    objectId: string,
    userId: string,
    level: GrantLevel,
    title: string,
  ): Promise<void> {
    // The title always goes along (platform contract round 2 §8): without it the protocol
    // later shows an id where a name should be.
    await request(
      "PUT",
      `${objectPath(organisationId, objectType, objectId)}/grants/${encodeURIComponent(userId)}`,
      token,
      { level, title: trimTitle(String(title ?? "")) },
    );
  }

  async function deleteGrant(
    token: string,
    organisationId: string,
    objectType: string,
    objectId: string,
    userId: string,
  ): Promise<void> {
    await request(
      "DELETE",
      `${objectPath(organisationId, objectType, objectId)}/grants/${encodeURIComponent(userId)}`,
      token,
    );
  }

  async function deleteObjectGrants(
    token: string,
    organisationId: string,
    objectType: string,
    objectId: string,
    title?: string | null,
  ): Promise<void> {
    // Mandatory at every deletion: if the grants outlived the object, the next object that
    // got the same id would be open to the wrong people.
    await request("DELETE", objectPath(organisationId, objectType, objectId), token, titleBody(title));
  }

  async function removeObject(
    input: Parameters<ProtocolClient["removeObject"]>[0],
  ): Promise<ObjectRemovalResult> {
    try {
      // The platform route needs the token of a person; there is no background form for it.
      if (!nonEmptyString(input.token)) return { ok: false, reason: "no-session" };
      if (!readDoor()) return { ok: false, reason: "door-not-configured" };

      const data = await request(
        "DELETE",
        objectPath(input.organisationId, input.objectType, input.objectId),
        input.token,
        titleBody(input.title),
      );
      return {
        ok: true,
        grantsRemoved: typeof data.grantsRemoved === "number" ? data.grantsRemoved : null,
      };
    } catch (error) {
      // An object that is to go goes, also when the platform is silent. Deleting is the
      // action, this call is the account of it.
      try {
        const what = `${input.objectType} ${input.objectId}`;
        log().error(`[platform-protocol] the grants of the deleted ${what} were not removed:`, messageOf(error));
      } catch {
        // A log sink that throws must not turn a result into a throw.
      }
      return { ok: false, reason: "failed", error };
    }
  }

  async function listCollections(
    token: string,
    organisationId: string,
  ): Promise<{ id: string; name: string }[]> {
    const data = await request("GET", `${organisationPath(organisationId)}/collections`, token);
    const raw = data.collections;
    if (!Array.isArray(raw)) return [];
    const rows: { id: string; name: string }[] = [];
    for (const entry of raw as unknown[]) {
      if (!isRecord(entry) || !nonEmptyString(entry.id)) continue;
      rows.push({ id: entry.id, name: typeof entry.name === "string" ? entry.name : entry.id });
    }
    return rows;
  }

  async function listCollectionMembers(
    token: string,
    organisationId: string,
    collectionId: string,
  ): Promise<string[]> {
    const data = await request(
      "GET",
      `${organisationPath(organisationId)}/collections/${encodeURIComponent(collectionId)}/members`,
      token,
    );
    const raw = data.members;
    if (!Array.isArray(raw)) return [];
    const ids: string[] = [];
    for (const entry of raw as unknown[]) {
      if (isRecord(entry) && nonEmptyString(entry.userId)) ids.push(entry.userId);
    }
    return ids;
  }

  /* ---------------------------------------------------------------------------- audit */

  async function audit(actor: AuditActor | null, line: AuditLine): Promise<boolean> {
    try {
      const form = actorForm(actor);
      if (!form) return false;
      // Without a door there is nothing to write to. That is the normal state of a local
      // setup, not a disturbance, so it is not logged.
      if (!readDoor()) return false;

      try {
        await request("POST", `${organisationPath(line.organisationId)}/audit`, form.token, {
          ...lineBody(line),
          ...form.field,
        });
        return true;
      } catch (error) {
        if (form.system) {
          // An offboarding writes many lines: the same reason is reported ONCE per client,
          // or nobody reads the message any more. Every line is still attempted (round 5 §2:
          // no latch); a failure is a disturbance, not a state to remember.
          const reason = `${line.action}:${codeOf(error)}`;
          if (logged.has(reason)) return false;
          logged.add(reason);
        }
        log().error(
          `[platform-audit] ${line.action} for ${line.objectId ?? "(no object)"} was not recorded:`,
          messageOf(error),
        );
        return false;
      }
    } catch {
      // Whatever went wrong (a malformed line, a log sink that throws): never a throw.
      return false;
    }
  }

  async function sendChunk(
    organisationId: string,
    form: ActorForm,
    chunk: readonly AuditLine[],
    total: number,
  ): Promise<number> {
    try {
      await request("POST", `${organisationPath(organisationId)}/audit/batch`, form.token, {
        lines: chunk.map((line) => lineBody(line)),
        // The form stands at the TOP of the body, never inside a line: the platform decides at
        // its gate who writes and reads only there. A person named per line only is a call
        // without a credential (401), and not a single line is recorded.
        ...form.field,
      });
      return chunk.length;
    } catch (error) {
      // On with the next chunk: a hiccup at line 400 must not take lines 600 to 1000 with it.
      log().error(
        `[platform-audit] ${chunk.length} lines of ${total} were not recorded:`,
        messageOf(error),
      );
      return 0;
    }
  }

  async function auditBatch(actor: AuditActor | null, lines: readonly AuditLine[]): Promise<number> {
    // Counted outside the `try`: whatever stops the run, the lines already accepted stay counted.
    let written = 0;
    try {
      const form = actorForm(actor);
      if (!form || !Array.isArray(lines) || lines.length === 0) return 0;
      if (!readDoor()) return 0;

      // ONE BATCH PER ORGANISATION: the address carries the organisation. Built from the
      // first line only, the lines of a second organisation would land silently in the
      // protocol of the first, in the very place where one looks up who did what.
      const byOrganisation = new Map<string, AuditLine[]>();
      for (const line of lines) {
        const group = byOrganisation.get(line.organisationId);
        if (group) group.push(line);
        else byOrganisation.set(line.organisationId, [line]);
      }

      for (const [organisationId, group] of byOrganisation) {
        for (let start = 0; start < group.length; start += AUDIT_BATCH_MAX) {
          written += await sendChunk(
            organisationId,
            form,
            group.slice(start, start + AUDIT_BATCH_MAX),
            lines.length,
          );
        }
      }
      return written;
    } catch {
      return written;
    }
  }

  function auditWithBudget(
    actor: AuditActor | null,
    lines: readonly AuditLine[],
    budget: AuditBudgetOptions,
  ): Promise<AuditBudgetResult> {
    return runWithBudget(lines, (line) => audit(actor, line), budget);
  }

  function clear(): void {
    logged.clear();
  }

  // Plain closures, no `this`: a host hands single methods on (`putGrant` as a step of a
  // share save) without binding them.
  return {
    listGrants,
    putGrant,
    deleteGrant,
    deleteObjectGrants,
    removeObject,
    listCollections,
    listCollectionMembers,
    audit,
    auditBatch,
    auditWithBudget,
    clear,
  };
}
