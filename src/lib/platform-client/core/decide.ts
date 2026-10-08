/**
 * platform-client: who gets in.
 *
 * Three doors, one set of rules:
 *
 *  - a person (`resolvePersonAccess`): the Suite gate first, then the door state, then the
 *    platform's answer, then the policy for an organisation that has decided nothing yet;
 *  - an API key (`resolveKeyAccess`): the key acts as the person who created it, asked per
 *    call, and the verdict is computed from the platform's answer every time;
 *  - a scheduled job (`resolveJobAccess`): a named person without a credential.
 *
 * All input and output is injected (`me`, `gate`, `userContext`, the member-table lookup), so
 * the same decision serves a cookie session, a bearer API and a worker, and this file needs
 * neither a framework nor a database.
 *
 * The three `resolve…` functions and `applyUngoverned` never throw: a rejected callback is
 * read as "could not check", and "could not check" is never "may enter".
 *
 * This file imports `types.ts` and `contexts.ts` only.
 */

import { localAccessContext, localKeyAccessContext, workerAccessContext } from "./contexts";
import {
  MACHINE_DENY_STATUS,
  type AccessContext,
  type AccessDenyReason,
  type JobAccessInput,
  type KeyAccess,
  type KeyAccessInput,
  type LabGate,
  type LegacyRoleMap,
  type Logger,
  type MachineAnswer,
  type MachineDenyCode,
  type MachineVerdict,
  type MeResult,
  type PersonAccess,
  type PersonAccessInput,
  type ProductRole,
  type UngovernedPolicy,
} from "./types";

/* ---------------------------------------------------------------------------- predicates */

/**
 * May this caller use the product at all?
 *
 * ONE condition: there is a product role. Not "or the organisation is ungoverned": that was
 * the open window in which every signed-in Suite member got in (B7). Who gets in while an
 * organisation is ungoverned is settled BEFORE anybody asks here, by {@link applyUngoverned}.
 */
export function hasProductAccess(ctx: { productRole: ProductRole | null }): boolean {
  return ctx.productRole !== null;
}

/** Administrator of this product. Not: administrator of the organisation. */
export function isProductAdmin(ctx: { productRole: ProductRole | null }): boolean {
  return ctx.productRole === "product_admin";
}

/** Owner or admin of the Suite organisation. Never a source of product access (round 3). */
export function isOrgAdmin(ctx: { orgRole: string }): boolean {
  const role = typeof ctx.orgRole === "string" ? ctx.orgRole.trim().toLowerCase() : "";
  return role === "owner" || role === "admin";
}

/** "May publish" (round 5): a product admin always, a user by the switch, nobody without a role. */
export function mayPublish(ctx: { productRole: ProductRole | null; mayPublish: boolean }): boolean {
  if (ctx.productRole === null) return false;
  return ctx.productRole === "product_admin" || ctx.mayPublish === true;
}

/* ----------------------------------------------------------------- ungoverned (policy P2) */

/**
 * The mapping from a Lab's frozen member table to a product role. The shared code owns it, so
 * every Lab maps the same way. Exact and case-sensitive; anything unknown is no access.
 * Without `roleMap` the table is the Labs' `MemberRole` enum; a product with other role names
 * passes its own table (`UngovernedPolicy.roleMap`).
 */
export function legacyProductRole(
  memberRole: string | null | undefined,
  roleMap?: LegacyRoleMap,
): ProductRole | null {
  if (roleMap !== undefined && roleMap !== null) {
    // A product whose member table has other role names (ContentLab: ADMIN / EMPLOYEE, or
    // ADMIN / MEMBER / NONE) passes its own table. Read by OWN keys only: a role column that
    // holds `constructor` must not find what every object inherits.
    if (typeof memberRole !== "string") return null;
    if (!Object.prototype.hasOwnProperty.call(roleMap, memberRole)) return null;
    const mapped: unknown = roleMap[memberRole];
    return mapped === "product_admin" || mapped === "user" ? mapped : null;
  }
  if (memberRole === "OWNER" || memberRole === "ADMIN") return "product_admin";
  if (memberRole === "EDITOR" || memberRole === "VIEWER") return "user";
  return null;
}

/**
 * Who may use the product while the organisation has decided nothing (`governed: false`).
 *
 * In that window the platform says `productRole: null` about everybody. "Then everybody may
 * enter" tears the door open; "then nobody may" takes an organisation's Lab away overnight.
 * So what decided before keeps deciding: the frozen member table.
 *
 *  - A row exists: its role decides. An explicit `NONE` stays a no, also for the owner.
 *  - No row, and the host keeps the owner floor: the owner of the Suite organisation gets in
 *    as product admin, nobody else.
 *  - No row, no floor: nobody.
 */
export function ungovernedProductRole(
  memberRole: string | null | undefined,
  orgRole: string,
  options: { ownerFloor: boolean; roleMap?: LegacyRoleMap },
): ProductRole | null {
  if (memberRole !== null && memberRole !== undefined) {
    return legacyProductRole(memberRole, options.roleMap);
  }
  if (options.ownerFloor !== true) return null;
  const role = typeof orgRole === "string" ? orgRole.trim().toLowerCase() : "";
  return role === "owner" ? "product_admin" : null;
}

/**
 * Lays the ungoverned policy over a context the PLATFORM delivered, and only over such a one.
 * Never throws.
 *
 *  1. governed: unchanged, and the member table is not even asked.
 *  2. not from the platform (local, key, worker): unchanged. The member table is never
 *     consulted for those (rule 6c no. 3; B11 is by design).
 *  3. `refuse`: unchanged, the platform's word stands.
 *  4. `everyone`: every member counts as a user.
 *  5. `legacy`: the member table decides, and REPLACES the platform's role; `mayPublish`
 *     follows the new role (see the comment in the code).
 *  6. `legacy` and the lookup fails: no access, with no owner floor. A host that wants the
 *     softer behaviour catches inside its lookup and returns `null`; with `ownerFloor: true`
 *     that `null` reads as "no row" and lets the owner in, so a host that wants "no access
 *     on a database failure" must let the lookup throw.
 */
export async function applyUngoverned<T extends string>(
  ctx: AccessContext<T>,
  policy: UngovernedPolicy,
  log: Logger = console,
): Promise<AccessContext<T>> {
  if (ctx.governed === true) return ctx;
  if (ctx.source !== "platform") return ctx;

  try {
    if (policy.mode === "everyone") {
      return { ...ctx, productRole: ctx.productRole ?? "user", productRoleSource: "everyone" };
    }
    if (policy.mode !== "legacy") return ctx;

    const memberRole = await policy.lookupMemberRole(ctx.organisationId, ctx.userId);
    const productRole = ungovernedProductRole(memberRole, ctx.orgRole, {
      ownerFloor: policy.ownerFloor,
      ...(policy.roleMap !== undefined ? { roleMap: policy.roleMap } : {}),
    });
    return {
      ...ctx,
      productRole,
      // The member table replaces the platform's role, so the platform's publish switch,
      // which belonged to THAT role, cannot simply stay: a product admin the table demotes
      // to user would keep publishing. The table has no switch of its own: an admin
      // publishes, nobody without a role does, and a user keeps the platform's switch only
      // when the platform gave the very same role.
      mayPublish:
        productRole === "product_admin"
          ? true
          : productRole === null
            ? false
            : ctx.productRole === productRole && ctx.mayPublish === true,
      productRoleSource: "legacy",
    };
  } catch (cause) {
    try {
      log.error(
        "[platform-access] the member table could not be read for an ungoverned organisation. " +
          "The person is treated as having no access.",
        cause,
      );
    } catch {
      // A log sink that throws must not turn a refusal into an error.
    }
    return { ...ctx, productRole: null, mayPublish: false, productRoleSource: "legacy" };
  }
}

/* ------------------------------------------------------------- machine verdict (policy P3) */

function deny(code: MachineDenyCode): { ok: false; code: MachineDenyCode; status: 403 | 503 } {
  return { ok: false, code, status: MACHINE_DENY_STATUS[code] };
}

/**
 * The shared table of both verdicts. Whether the floor is compared is a flag of its own, never
 * read from the mint time: a key whose `mintedAt` is `null` (a nullable column, raw SQL, a
 * mapping slip of a JavaScript caller) must not look like "there is no credential" and skip
 * the floor.
 */
function verdict<T extends string>(
  answer: MachineAnswer<T>,
  credential: { checkFloor: false } | { checkFloor: true; mintedAt: unknown },
): MachineVerdict<T> {
  // An answer of a shape this build does not know is "could not check".
  if (typeof answer !== "object" || answer === null) return deny("KEY_CHECK_UNAVAILABLE");
  if (answer.status === "no-access") return deny("KEY_OWNER_NO_ACCESS");
  if (answer.status !== "answer") return deny("KEY_CHECK_UNAVAILABLE");

  if (credential.checkFloor && answer.revokedAt !== null) {
    // A credential lives only when it is provably YOUNGER than the floor. Anything that is not
    // a Date is "cannot be read" (NaN), and the comparison is written as "not after" so that
    // the same millisecond is dead (B13) and so is every mint time that cannot be read: for
    // every readable pair this is exactly `mintedAt <= revokedAt`.
    // `Date.prototype.getTime` reads the internal time value of a Date of any realm (a test
    // runner or a VM may hand in one that is not an `instanceof` of this realm's Date) and
    // throws for everything else, which then counts as "cannot be read".
    let minted = Number.NaN;
    try {
      minted = Date.prototype.getTime.call(credential.mintedAt);
    } catch {
      // Not a Date: stays NaN, and NaN is never after the floor.
    }
    const mintedAfterFloor = minted > answer.revokedAt.getTime();
    if (!mintedAfterFloor) return deny("KEY_REVOKED");
  }

  if (answer.memberActive === false) return deny("PERSON_GONE");

  // No fallback to "then organisation-visible rows only": that is exactly the state the
  // platform contract forbids (B8).
  if (answer.context.productRole === null) return deny("KEY_OWNER_NO_ACCESS");

  return { ok: true, context: answer.context };
}

/**
 * What a key may do, from the platform's (cached) answer about the person behind it. Pure,
 * and computed on EVERY call: one answer serves every key of that person, and each key gets
 * its own verdict because each has its own mint time.
 *
 * First match wins: could not check (503), refused by the platform, minted at or before the
 * person's token floor, person no longer a member, no product role. All refusals but the
 * first are 403.
 */
export function machineVerdict<T extends string>(
  answer: MachineAnswer<T>,
  key: { mintedAt: Date },
): MachineVerdict<T> {
  const mintedAt: unknown = typeof key === "object" && key !== null ? key.mintedAt : undefined;
  return verdict(answer, { checkFloor: true, mintedAt });
}

/**
 * The same verdict for a caller that names a person without holding a credential of theirs
 * (a scheduled job). There is no mint time, so there is no floor comparison; the membership
 * and the product role still stop it.
 */
export function personVerdict<T extends string>(answer: MachineAnswer<T>): MachineVerdict<T> {
  return verdict(answer, { checkFloor: false });
}

/* -------------------------------------------------------------------------- the three doors */

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The gate as the Suite answered it; anything else (a rejection, no object) counts as closed. */
async function askGate(gate: (token: string) => Promise<LabGate>, token: string): Promise<LabGate> {
  try {
    const answer = await gate(token);
    if (typeof answer === "object" && answer !== null) return answer;
  } catch {
    // Read as unreachable below.
  }
  return { allowed: false, reason: "unreachable", lab: null };
}

/** Levels 2 and 3 from the platform: the context after the ungoverned policy, or why not. */
async function askPlatform<T extends string>(
  input: PersonAccessInput<T>,
  token: string,
): Promise<{ access: AccessContext<T> } | { reason: AccessDenyReason }> {
  let me: MeResult<T>;
  try {
    me = await input.me(token);
  } catch {
    return { reason: "unavailable" };
  }
  if (typeof me !== "object" || me === null) return { reason: "unavailable" };
  if (me.status === "unauthenticated") return { reason: "unauthenticated" };
  if (me.status === "denied") return { reason: "no-product-access" };
  // Fail closed: an outage lets nobody in.
  if (me.status !== "ok") return { reason: "unavailable" };

  const access = await applyUngoverned(me.context, input.ungoverned, input.log);
  if (access.productRole === null) return { reason: "no-product-access" };
  return { access };
}

/**
 * Levels 1 and 2 for one person. Never throws.
 *
 * The decision order is fixed: token, gate, door, platform, ungoverned policy.
 *
 *  - No token: unauthenticated, and nothing is called.
 *  - The Suite gate is closed or unreachable: blocked. Level 1 wins over every product access,
 *    in every door state (closes B10 for any door that uses this function).
 *  - Door `off` or `unconfigured`: unavailable, and the platform is not asked (policy P1;
 *    closes B2, B3, B5).
 *  - Door `local`: the local context. The ungoverned policy is not applied.
 *  - Door `ok`: the platform's answer, then the ungoverned policy, then "has a product role".
 *
 * The gate and the platform are asked at the same time (both answers are needed for a normal
 * page load, and each takes a network round trip when it is not cached); the decision still
 * reads the gate first.
 */
export async function resolvePersonAccess<T extends string>(
  input: PersonAccessInput<T>,
): Promise<PersonAccess<T>> {
  const doorState = input.door.state;
  const token = input.token;
  if (!hasText(token)) return { ok: false, reason: "unauthenticated", gate: null, doorState };

  let gate: LabGate | null = null;
  try {
    const gateAnswer = askGate(input.gate, token);
    const platformAnswer = doorState === "ok" ? askPlatform(input, token) : null;

    gate = await gateAnswer;
    if (gate.allowed !== true) return { ok: false, reason: "blocked", gate, doorState };

    if (doorState === "local") {
      return {
        ok: true,
        access: localAccessContext(input.session, input.product),
        gate,
        doorState,
      };
    }
    // `off`, `unconfigured`, and any state this build does not know: nobody gets a context.
    if (platformAnswer === null) return { ok: false, reason: "unavailable", gate, doorState };

    const platform = await platformAnswer;
    if ("reason" in platform) return { ok: false, reason: platform.reason, gate, doorState };
    return { ok: true, access: platform.access, gate, doorState };
  } catch {
    // Nothing above is expected to throw. If it does, the answer is still not "may enter".
    return { ok: false, reason: "unavailable", gate, doorState };
  }
}

/** The platform's answer about a person, where a rejection or a non-answer is "could not check". */
async function askUserContext<T extends string>(
  userContext: (organisationId: string, userId: string) => Promise<MachineAnswer<T>>,
  organisationId: string,
  userId: string,
): Promise<MachineAnswer<T>> {
  try {
    const answer = await userContext(organisationId, userId);
    if (typeof answer === "object" && answer !== null) return answer;
  } catch {
    // Read as unavailable below.
  }
  return { status: "unavailable", reason: "network" };
}

/**
 * Policies P1 and P3 for one API key. Never throws.
 *
 *  1. A worker key gets the worker context in EVERY door state, without a request: it hangs
 *     on the organisation, there is nobody to ask the platform about (B19).
 *  2. A user key without a creator is refused. It is not served as a worker.
 *  3. Door `off` or `unconfigured`: 503. No key acts in a view nobody confirmed (B2, B3).
 *  4. Door `local`: the local key context of its creator.
 *  5. Door `ok`: the platform is asked about the creator, and the verdict is computed from
 *     the answer and the key's mint time.
 *
 * There is no member-table lookup in the input, on purpose: the frozen member table is never
 * consulted for a key (B11 is by design).
 */
export async function resolveKeyAccess<T extends string>(
  input: KeyAccessInput<T>,
): Promise<KeyAccess<T>> {
  try {
    const { key, door, product } = input;

    if (key.kind === "worker") {
      return { ok: true, context: workerAccessContext(key.organisationId, product) };
    }

    const createdByUserId = key.createdByUserId;
    if (!hasText(createdByUserId)) return deny("KEY_OWNER_NO_ACCESS");

    if (door.state === "local") {
      return {
        ok: true,
        context: localKeyAccessContext(
          { organisationId: key.organisationId, createdByUserId },
          product,
        ),
      };
    }
    if (door.state !== "ok") return deny("KEY_CHECK_UNAVAILABLE");

    const answer = await askUserContext(input.userContext, key.organisationId, createdByUserId);
    return machineVerdict(answer, { mintedAt: key.mintedAt });
  } catch {
    return deny("KEY_CHECK_UNAVAILABLE");
  }
}

/**
 * A named person without a key: a scheduled job that acts for whoever ordered it. Never throws.
 *
 * Like {@link resolveKeyAccess} for a user key, but with {@link personVerdict}: a job has no
 * mint time, so nothing is compared with the floor. With the door `off` or `unconfigured` the
 * job is refused; it never runs unchecked (closes B5).
 */
export async function resolveJobAccess<T extends string>(
  input: JobAccessInput<T>,
): Promise<KeyAccess<T>> {
  try {
    const { organisationId, userId, door, product } = input;

    if (!hasText(userId)) return deny("KEY_OWNER_NO_ACCESS");

    if (door.state === "local") {
      return {
        ok: true,
        context: localKeyAccessContext({ organisationId, createdByUserId: userId }, product),
      };
    }
    if (door.state !== "ok") return deny("KEY_CHECK_UNAVAILABLE");

    return personVerdict(await askUserContext(input.userContext, organisationId, userId));
  } catch {
    return deny("KEY_CHECK_UNAVAILABLE");
  }
}
