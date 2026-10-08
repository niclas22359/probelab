/**
 * A share save, in three steps: read the body the share dialog sends (`parseSharePatch`),
 * decide what has to happen (`planSharePatch`, pure), and run it in the one safe order
 * (`executeSharePlan`).
 *
 * This file sends nothing. The host supplies the writes (its platform client for the grants
 * and the protocol, its own database update for the container); the shared code owns the
 * validation, the owner rule, the diff and the ORDER.
 *
 * Why the order is fixed (CONTRACT section 4.1: grants, container, audit): the individual
 * grants live in the platform and can fail, the container columns live in the product's own
 * database. Container first means the likely bad outcome is the worst one: the object is
 * already visible to the whole organisation, the removal of a grant did not happen, and the
 * dialog says "could not be saved". The person tries again and does not know that half of it
 * already applies. Grants first means: when the platform fails, NOTHING of the container
 * has changed, and the message is literally true.
 */
import {
  canManage,
  checkContainerChoice,
  normaliseVisibility,
  toPlatformVisibility,
} from "./rules";
import type {
  AuditLine,
  ContainerChoice,
  GrantLevel,
  PlatformVisibility,
  RuleContext,
  ShareExecution,
  ShareGrant,
  ShareObject,
  SharePatch,
  SharePlan,
  SharePlanErrorCode,
  SharePlanResult,
  ShareSteps,
} from "./types";

/** The longest collection id a patch may carry (LeadLab `containerInputSchema`). */
const COLLECTION_ID_MAX = 200;

/** The longest user id a patch may carry (LeadLab's share route schema). */
const USER_ID_MAX = 200;

/**
 * The most entries `add`, `levels` and `remove` may carry each (LeadLab's share route schema).
 * Every entry becomes one request to the platform, sent one after the other with a timeout of
 * its own, so a body without a limit would be a save that never answers.
 */
const LIST_MAX = 200;

type ParsedPatch =
  | { ok: true; patch: SharePatch }
  | { ok: false; code: "VALIDATION"; status: 400; message: string };

function invalid(message: string): { ok: false; code: "VALIDATION"; status: 400; message: string } {
  return { ok: false, code: "VALIDATION", status: 400, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A string that is not empty after trimming, trimmed; else `null`. */
function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readPlatformVisibility(value: unknown): PlatformVisibility | null {
  if (value === "private" || value === "collection" || value === "organisation") return value;
  return null;
}

function readLevel(value: unknown): GrantLevel | null {
  return value === "view" || value === "edit" ? value : null;
}

/** A user id: not empty and at most {@link USER_ID_MAX} characters after trimming; else `null`. */
function readUserId(value: unknown): string | null {
  const userId = nonEmptyText(value);
  return userId !== null && userId.length <= USER_ID_MAX ? userId : null;
}

/** At most {@link LIST_MAX} entries `{ userId, level }`, or `null` when the value is not exactly that. */
function readGrants(value: unknown): ShareGrant[] | null {
  if (!Array.isArray(value) || value.length > LIST_MAX) return null;
  const grants: ShareGrant[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    const userId = readUserId(entry.userId);
    const level = readLevel(entry.level);
    if (userId === null || level === null) return null;
    grants.push({ userId, level });
  }
  return grants;
}

/** At most {@link LIST_MAX} user ids, trimmed, or `null` when the value is not exactly that. */
function readUserIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > LIST_MAX) return null;
  const userIds: string[] = [];
  for (const entry of value) {
    const userId = readUserId(entry);
    if (userId === null) return null;
    userIds.push(userId);
  }
  return userIds;
}

/**
 * Reads the body of a share save. Every field is optional; the result carries only the
 * fields that were present. Strings are trimmed, unknown fields are ignored. A field whose
 * value is `undefined` counts as not sent.
 *
 * The dialog calls `save()` once with the difference between what it loaded and what the
 * person left behind, so every key that arrives is an instruction. That is why a present
 * field with a wrong value refuses the whole body instead of being skipped.
 */
export function parseSharePatch(raw: unknown): ParsedPatch {
  if (!isPlainObject(raw)) return invalid("The body must be a JSON object.");

  const patch: SharePatch = {};

  if (raw.visibility !== undefined) {
    const visibility = readPlatformVisibility(raw.visibility);
    if (visibility === null) {
      return invalid("`visibility` must be private, collection or organisation.");
    }
    patch.visibility = visibility;
  }

  if (raw.collectionId !== undefined) {
    if (raw.collectionId === null) {
      patch.collectionId = null;
    } else {
      const collectionId = nonEmptyText(raw.collectionId);
      if (collectionId === null || collectionId.length > COLLECTION_ID_MAX) {
        return invalid("`collectionId` must be a collection id or null.");
      }
      patch.collectionId = collectionId;
    }
  }

  if (raw.add !== undefined) {
    const add = readGrants(raw.add);
    if (add === null) return invalid("`add` must be a list of at most 200 { userId, level }.");
    patch.add = add;
  }

  if (raw.remove !== undefined) {
    const remove = readUserIds(raw.remove);
    if (remove === null) return invalid("`remove` must be a list of at most 200 user ids.");
    patch.remove = remove;
  }

  if (raw.levels !== undefined) {
    const levels = readGrants(raw.levels);
    if (levels === null) {
      return invalid("`levels` must be a list of at most 200 { userId, level }.");
    }
    patch.levels = levels;
  }

  return { ok: true, patch };
}

/** The sentence that goes with a refusal. English; the host shows its own text to the person. */
const PLAN_MESSAGES: Record<Exclude<SharePlanErrorCode, "VALIDATION">, string> = {
  NOT_OWNER: "Only the owner of an object changes its visibility, its collection and its grants.",
  VISIBILITY_NOT_ALLOWED: "The organisation does not allow this visibility for this person.",
  COLLECTION_REQUIRED: "The visibility `collection` needs a collection.",
  COLLECTION_NOT_ALLOWED: "The person is not a member of this collection.",
};

/** The container an object is in now. An unknown stored visibility reads as `PRIVATE`. */
function currentContainer(object: ShareObject): ContainerChoice {
  const collectionId =
    typeof object.collectionId === "string" && object.collectionId.trim() !== ""
      ? object.collectionId
      : null;
  return { visibility: normaliseVisibility(object.visibility) ?? "PRIVATE", collectionId };
}

/**
 * Plans a share save. Pure: no request, no write, the inputs are not changed.
 *
 * The first failing check ends the plan:
 *  1. the body is read with {@link parseSharePatch}                     -> VALIDATION, 400
 *  2. only the owner shares (`canManage`); an edit right is not enough  -> NOT_OWNER, 403
 *  3. the same person in `remove` and in `add` or `levels`              -> VALIDATION, 400
 *  4. the container, ONLY when the patch names `visibility` or `collectionId`: the wanted
 *     container is what the patch says on top of what the object has, checked with
 *     `checkContainerChoice`                                            -> its code and status
 *
 * Behind step 4 (LeadLab's share route): the check runs whenever the patch TOUCHES the
 * container, also when the wanted visibility equals the current one. An owner whose object
 * is private while the organisation switched "only me" off and who sends
 * `{ visibility: "private" }` is refused; the same owner sending only `add` is not.
 *
 * The plan then holds:
 *  - `container`: the checked container when it differs from the current one, else `null`.
 *  - `grantsToPut`: `add` followed by `levels`, without the acting person and the owner (a
 *    grant to oneself is pointless and would leave a row nobody can remove once the object is
 *    handed over), one entry per person: the last level wins, the first position is kept.
 *  - `grantsToDelete`: `remove`, each person once, order kept.
 *  - `auditLines`: `object.visibility_changed` and `object.moved_to_collection`, each ONLY
 *    when the value really changes. The platform writes `grant.added` and `grant.removed`
 *    itself, so there is no line for grants.
 *  - `needsPlatform`: the plan touches grants, which live in the platform only.
 */
export function planSharePatch(input: {
  ctx: RuleContext;
  object: ShareObject;
  patch: unknown;
}): SharePlanResult {
  const { ctx, object } = input;

  const parsed = parseSharePatch(input.patch);
  if (!parsed.ok) return parsed;
  const patch = parsed.patch;

  if (!canManage(ctx, object)) {
    return { ok: false, code: "NOT_OWNER", status: 403, message: PLAN_MESSAGES.NOT_OWNER };
  }

  const requested = [...(patch.add ?? []), ...(patch.levels ?? [])];
  const removed = patch.remove ?? [];
  if (requested.some((grant) => removed.includes(grant.userId))) {
    return invalid("A person cannot be added and removed in the same save.");
  }

  const before = currentContainer(object);
  let container: ContainerChoice | null = null;
  const auditLines: AuditLine[] = [];

  if (patch.visibility !== undefined || patch.collectionId !== undefined) {
    const checked = checkContainerChoice(ctx, {
      visibility: patch.visibility ?? before.visibility,
      collectionId: patch.collectionId !== undefined ? patch.collectionId : before.collectionId,
    });
    if (!checked.ok) {
      if (checked.code === "VALIDATION") return invalid("The container is not valid.");
      return {
        ok: false,
        code: checked.code,
        status: checked.status,
        message: PLAN_MESSAGES[checked.code],
      };
    }

    const after = checked.value;
    const visibilityChanged = after.visibility !== before.visibility;
    const collectionChanged = after.collectionId !== before.collectionId;
    if (visibilityChanged || collectionChanged) container = after;

    const lineBase = {
      organisationId: object.organisationId,
      objectType: object.type,
      objectId: object.id,
      objectTitle: object.title,
    };
    if (visibilityChanged) {
      auditLines.push({
        ...lineBase,
        action: "object.visibility_changed",
        details: {
          from: toPlatformVisibility(before.visibility),
          to: toPlatformVisibility(after.visibility),
        },
      });
    }
    if (collectionChanged) {
      auditLines.push({
        ...lineBase,
        action: "object.moved_to_collection",
        details: { collectionId: after.collectionId },
      });
    }
  }

  const grantsToPut: ShareGrant[] = [];
  for (const grant of requested) {
    if (grant.userId === ctx.userId || grant.userId === object.ownerUserId) continue;
    const existing = grantsToPut.find((entry) => entry.userId === grant.userId);
    if (existing) existing.level = grant.level;
    else grantsToPut.push({ userId: grant.userId, level: grant.level });
  }

  const grantsToDelete: string[] = [];
  for (const userId of removed) {
    if (!grantsToDelete.includes(userId)) grantsToDelete.push(userId);
  }

  return {
    ok: true,
    plan: {
      grantsToPut,
      grantsToDelete,
      container,
      auditLines,
      needsPlatform: grantsToPut.length + grantsToDelete.length > 0,
    },
  };
}

/**
 * Runs a plan in the fixed order. Never throws.
 *
 *  1. Grants: every put, one after the other, then every delete. The first failure ends the
 *     run with `stage: "grants"`; the container and the protocol are NOT touched.
 *  2. Container, when the plan has one. A failure ends the run with `stage: "container"`;
 *     the protocol is not written, because nothing it would report has happened.
 *  3. Protocol lines. The protocol is the account, not the action: a line that fails or
 *     answers `false` is counted as not written and changes nothing about the outcome.
 */
export async function executeSharePlan(plan: SharePlan, steps: ShareSteps): Promise<ShareExecution> {
  try {
    for (const grant of plan.grantsToPut) await steps.putGrant(grant);
    for (const userId of plan.grantsToDelete) await steps.deleteGrant(userId);
  } catch (error) {
    return { ok: false, stage: "grants", error };
  }

  try {
    if (plan.container) await steps.writeContainer(plan.container);
  } catch (error) {
    return { ok: false, stage: "container", error };
  }

  let auditWritten = 0;
  try {
    for (const line of plan.auditLines) {
      try {
        if ((await steps.audit(line)) !== false) auditWritten += 1;
      } catch {
        // Counted as not written. The next line is still attempted.
      }
    }
  } catch {
    // A plan whose lines cannot be read writes none. The grants and the container stand.
  }
  return { ok: true, auditWritten };
}
