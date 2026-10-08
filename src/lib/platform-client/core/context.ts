/**
 * platform-client: what the platform says about one caller, and how long that may be believed.
 *
 * Two questions, one answer shape:
 *
 *  - `GET /api/access/me?product=<key>`, with the service key (WHICH product asks) and the
 *    Suite token (WHICH person asks): levels 2 and 3 for a person at a keyboard.
 *  - `GET /api/access/orgs/<org>/users/<user>/context?product=<key>`, with the service key
 *    alone: the same for the person behind an API key or a scheduled job (the machine route).
 *
 * FAIL CLOSED, without overstaying. A clear answer holds for 60 s: a context, or a refusal by
 * the platform. "We could not ask" is NEVER cached (network error, 5xx, any other status, and
 * an answer this build cannot read), so a short outage locks nobody out a minute longer than
 * needed and a bad answer is never stored as "no access" (closes B12 and B15).
 *
 * The machine cache stores the platform's ANSWER per person, never a verdict: whether a key is
 * dead depends on when that key was minted and is computed per call by `decide.machineVerdict`.
 *
 * Every entry is stamped with the time its request was SENT (an older answer never overwrites
 * a newer one), and every answer leaves the cache as a COPY (a caller that changes its context
 * changes nothing for the next caller).
 *
 * Replaces `getAccessContext`, the parser (`toContext`, `toAccessContext`, `zuKontext`,
 * `parseAccessContext`) and the request half of the machine function in every Lab.
 *
 * This file imports `types.ts`, `http.ts` and `node:crypto` only, and reads no environment.
 */

import { createHash } from "node:crypto";

import { platformFetch } from "./http";
import {
  ACCESS_CACHE_MAX,
  ACCESS_CACHE_TTL_MS,
  CONTEXT_TIMEOUT_MS,
  type AccessClient,
  type AccessClientOptions,
  type AccessCollection,
  type AccessContext,
  type ContextSource,
  type GrantedIds,
  type Logger,
  type MachineAnswer,
  type MeOptions,
  type MeResult,
  type OrgRole,
  type ProductRole,
  type TtlCache,
  type TtlCacheOptions,
} from "./types";

/* -------------------------------------------------------------------------------- cache */

/**
 * A small cache: fixed lifetime, bounded size, the oldest entry dropped first.
 *
 * The lifetime is the platform contract's ceiling: a withdrawal must take effect within it.
 */
export function createTtlCache<V>(options: TtlCacheOptions = {}): TtlCache<V> {
  const ttlMs = options.ttlMs ?? ACCESS_CACHE_TTL_MS;
  const max = options.max ?? ACCESS_CACHE_MAX;
  // The default clock is read on every use, not captured here: `Date.now` taken now would be
  // the real clock for ever, and a product test that switches to fake timers after its client
  // was created (at module scope) would never see an entry expire.
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, { value: V; storedAt: number }>();

  return {
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      if (now() < hit.storedAt + ttlMs) return hit.value;
      entries.delete(key);
      return undefined;
    },
    set(key, value, storedAt) {
      const stamp = typeof storedAt === "number" && Number.isFinite(storedAt) ? storedAt : now();
      const existing = entries.get(key);
      // An answer to an OLDER request never replaces the answer to a newer one. Without this,
      // a slow "ok" that left before a revoke and arrived after it would overwrite the
      // refusal and hold for a full lifetime from its late arrival.
      if (existing !== undefined && existing.storedAt > stamp) return;
      if (existing !== undefined) {
        // Stored again: nothing is dropped, and the entry moves to the young end, so "oldest
        // first" keeps meaning "stored longest ago".
        entries.delete(key);
      } else if (entries.size >= max) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, { value, storedAt: stamp });
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/** sha256 of the token, hex. The raw token is never a map key and never ends up in a dump. */
export function tokenCacheKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* ------------------------------------------------------------------------------- parser */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The trimmed string, or `null` when it is no string or empty after trimming. */
function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asOrgRole(value: unknown): OrgRole {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  return role === "owner" || role === "admin" ? role : "member";
}

function asProductRole(value: unknown): ProductRole | null {
  return value === "product_admin" || value === "user" ? value : null;
}

function asCollections(value: unknown): AccessCollection[] {
  if (!Array.isArray(value)) return [];
  const collections: AccessCollection[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    if (id === null) continue;
    collections.push({ id, name: asString(entry.name) ?? id, isOwner: asBool(entry.isOwner, false) });
  }
  return collections;
}

/**
 * `grantedLevels[<type>]` is the truth about view and edit. `grantedObjects[<type>]` is the
 * same set without a level; it only matters when an older platform does not send the levels
 * yet, and then the CAREFUL right applies: view.
 *
 * An id is in one list only, and edit wins. Types the product did not register are ignored;
 * a registered type the platform does not mention gets two empty lists.
 */
function asGrants<T extends string>(
  body: Record<string, unknown>,
  objectTypes: readonly T[],
): Record<T, GrantedIds> {
  const levelsByType = isRecord(body.grantedLevels) ? body.grantedLevels : {};
  const objectsByType = isRecord(body.grantedObjects) ? body.grantedObjects : {};
  const grants = {} as Record<T, GrantedIds>;

  for (const type of objectTypes) {
    const view = new Set<string>();
    const edit = new Set<string>();

    const levels = levelsByType[type];
    if (isRecord(levels)) {
      for (const [id, level] of Object.entries(levels)) {
        if (id.trim() === "") continue;
        if (level === "edit") edit.add(id);
        else view.add(id);
      }
    }

    const objects = objectsByType[type];
    if (Array.isArray(objects)) {
      for (const entry of objects) {
        const id = asString(entry);
        if (id !== null && !edit.has(id)) view.add(id);
      }
    }

    grants[type] = { view: [...view], edit: [...edit] };
  }

  return grants;
}

/**
 * Reads the `data` object of `/me` or of the machine route, defensively.
 *
 * `null` means "this build cannot read the answer": not an object, no `userId` /
 * `organisationId`, no `product` object, or a `product.governed` that is not a boolean. The two
 * ids are never filled in from the request path: an answer that does not say whom it is about
 * is not an answer.
 *
 * The defaults are the platform contract's: `personalAllowed` true, the two organisation
 * settings true. `mayPublish` is normalised here, so nobody downstream has to
 * repeat the rule: a product admin always, nobody without a product role, otherwise the
 * platform's switch (and without a switch: no).
 */
export function parseAccessContext<T extends string>(
  body: unknown,
  options: { objectTypes: readonly T[]; source?: ContextSource },
): AccessContext<T> | null {
  if (!isRecord(body)) return null;

  const userId = asString(body.userId);
  const organisationId = asString(body.organisationId);
  if (userId === null || organisationId === null) return null;

  // The client always asks with `?product=`, and platform-api then always sends the product
  // block with a real boolean `governed` (`access-context.js` `shapeProduct`). An answer
  // without it comes from a broken platform (version skew, a proxy that dropped the query, a
  // bug). Reading it as "ungoverned, no role" would let a host on the `everyone` policy admit
  // every member, so it is unreadable instead: not cached, nobody gets in.
  if (!isRecord(body.product)) return null;
  const product = body.product;
  if (typeof product.governed !== "boolean") return null;
  const settings = isRecord(body.settings) ? body.settings : {};
  const productRole = asProductRole(product.productRole);

  let mayPublish: boolean;
  if (productRole === "product_admin") mayPublish = true;
  else if (productRole === null) mayPublish = false;
  else mayPublish = asBool(product.mayPublish, false);

  return {
    userId,
    organisationId,
    email: asString(body.email) ?? "",
    orgRole: asOrgRole(body.orgRole),
    productRole,
    governed: product.governed,
    accessMode: product.accessMode === "everyone" ? "everyone" : "assigned",
    mayPublish,
    releaseStep: asString(product.releaseStep),
    collections: asCollections(body.collections),
    grantedIds: asGrants(body, options.objectTypes),
    personalAllowed: asBool(product.personalAllowed, true),
    membersMayShareOrg: asBool(settings.membersMayShareOrg, true),
    membersMayCreateCollections: asBool(settings.membersMayCreateCollections, true),
    source: options.source ?? "platform",
    productRoleSource: "platform",
  };
}

/**
 * Reads the `data` object of the machine route: the context plus the person's token floor
 * (`revokedAt`) and membership (`memberActive`).
 *
 * A floor that is PRESENT but cannot be read makes the whole answer unreadable. Reading it as
 * "no floor" would keep a revoked key alive because of a formatting slip; fail closed. No
 * floor is: `null`, a missing field, an empty string.
 */
export function parseMachineAnswer<T extends string>(
  body: unknown,
  options: { objectTypes: readonly T[] },
): Extract<MachineAnswer<T>, { status: "answer" }> | null {
  const context = parseAccessContext(body, { objectTypes: options.objectTypes, source: "api-key" });
  if (context === null || !isRecord(body)) return null;

  let revokedAt: Date | null = null;
  const rawFloor = body.revokedAt;
  if (rawFloor !== undefined && rawFloor !== null) {
    if (typeof rawFloor !== "string") return null;
    if (rawFloor.trim() !== "") {
      const floor = new Date(rawFloor);
      if (Number.isNaN(floor.getTime())) return null;
      revokedAt = floor;
    }
  }

  const memberActive = typeof body.memberActive === "boolean" ? body.memberActive : null;

  return { status: "answer", context, revokedAt, memberActive };
}

/* -------------------------------------------------------------------------------- copies */

/**
 * A copy of a context that shares nothing changeable with the original: the lists and the
 * grant blocks are new. The caches hand out such copies only, so a host that changes the
 * context it got (while adapting it to its own type, say) changes nothing for the next
 * request or the next key of the same person.
 */
export function copyAccessContext<T extends string>(ctx: AccessContext<T>): AccessContext<T> {
  const grantedIds = {} as Record<T, GrantedIds>;
  for (const type of Object.keys(ctx.grantedIds) as T[]) {
    const grants = ctx.grantedIds[type];
    grantedIds[type] = { view: [...grants.view], edit: [...grants.edit] };
  }
  return {
    ...ctx,
    collections: ctx.collections.map((collection) => ({ ...collection })),
    grantedIds,
  };
}

function copyMeResult<T extends string>(result: MeResult<T>): MeResult<T> {
  return result.status === "ok"
    ? { status: "ok", context: copyAccessContext(result.context) }
    : { ...result };
}

function copyMachineAnswer<T extends string>(answer: MachineAnswer<T>): MachineAnswer<T> {
  if (answer.status !== "answer") return { ...answer };
  return {
    ...answer,
    context: copyAccessContext(answer.context),
    revokedAt: answer.revokedAt === null ? null : new Date(answer.revokedAt.getTime()),
  };
}

/* ------------------------------------------------------------------------------- client */

/** Refusals whose code points at the product's service key or product key, not at the person. */
const SERVICE_KEY_DENIALS: readonly string[] = [
  "ORG_NOT_ALLOWED_FOR_KEY",
  "PRODUCT_MISMATCH",
  "PRODUCT_UNKNOWN",
];

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The client for both context questions. One object per product process (module scope), not
 * one per request: the two caches and the "logged once" memory live inside it.
 *
 * The methods do not use `this`, so a host can hand them over on their own
 * (`userContext: client.userContext`).
 */
export function createAccessClient<T extends string>(
  options: AccessClientOptions<T>,
): AccessClient<T> {
  // One clock for the caches and for the send stamps, read on every use (API section 5).
  const now = options.now ?? (() => Date.now());
  const cacheOptions: TtlCacheOptions = {
    ttlMs: options.ttlMs,
    max: options.max,
    now,
  };
  const meCache = createTtlCache<MeResult<T>>(cacheOptions);
  const machineCache = createTtlCache<MachineAnswer<T>>(cacheOptions);
  const logged = new Set<string>();
  const timeoutMs = options.timeoutMs ?? CONTEXT_TIMEOUT_MS;
  const query = `?product=${options.product.productKey}`;

  /** At most one line per reason and client object, or an outage floods the log. */
  function logOnce(reason: string, message: string): void {
    if (logged.has(reason)) return;
    logged.add(reason);
    const log: Logger = options.log ?? console;
    log.error(`[platform-access] ${message}`);
  }

  /** Stores a result stamped with the time its request was SENT, and hands out a copy. */
  function keepMe(key: string, result: MeResult<T>, sentAt: number): MeResult<T> {
    meCache.set(key, result, sentAt);
    return copyMeResult(result);
  }

  async function me(
    token: string | null | undefined,
    meOptions?: MeOptions,
  ): Promise<MeResult<T>> {
    // Order: token, door, cache, request.
    if (!hasText(token)) return { status: "unauthenticated" };

    const door = options.door();
    if (door === null) return { status: "unavailable", reason: "not-configured" };

    const key = tokenCacheKey(token);
    // `fresh` skips the READ only: the new answer is stored as usual, so a refusal found by a
    // route that mints a key is at once the answer for every other request as well.
    if (meOptions?.fresh !== true) {
      const cached = meCache.get(key);
      if (cached !== undefined) return copyMeResult(cached);
    }

    const sentAt = now();
    const reply = await platformFetch({
      door,
      method: "GET",
      path: `/api/access/me${query}`,
      token,
      timeoutMs,
      fetch: options.fetch,
    });

    if (reply.kind === "network") {
      logOnce(
        "unreachable",
        "the platform did not answer /api/access/me. Everybody is treated as having no access until it does.",
      );
      return { status: "unavailable", reason: "network" };
    }

    if (isSuccessStatus(reply.status)) {
      const context =
        reply.data === null
          ? null
          : parseAccessContext(reply.data, { objectTypes: options.product.objectTypes });
      if (context === null) {
        // NOT cached: "we could not read it" is not "no access" (B15).
        logOnce(
          "bad-response",
          "the platform answered /api/access/me with a body this build cannot read.",
        );
        return { status: "unavailable", reason: "unreadable" };
      }
      return keepMe(key, { status: "ok", context }, sentAt);
    }

    if (reply.status === 401) {
      // CONTRACT 4.1 caches every /me 401 for 60 s. What it MEANS depends on the code:
      // UNAUTHORIZED is the SERVICE KEY being refused, which no person can fix by signing in
      // again, so it is "could not check" and never "sign in" (a signed-in person sent to the
      // Suite sign-in is sent straight back). Every other 401 is the person's token.
      if (reply.errorCode === "UNAUTHORIZED") {
        logOnce(
          "service-key",
          "the platform refused this product's service key on /api/access/me (401 UNAUTHORIZED). Check the platform key of this service.",
        );
        return keepMe(
          key,
          { status: "unavailable", reason: "service-key", httpStatus: 401 },
          sentAt,
        );
      }
      return keepMe(key, { status: "unauthenticated" }, sentAt);
    }

    if (reply.status === 403 || reply.status === 404) {
      if (reply.errorCode !== null && SERVICE_KEY_DENIALS.includes(reply.errorCode)) {
        logOnce(
          `denied-${reply.errorCode}`,
          `the platform refused /api/access/me with ${reply.status} ${reply.errorCode}. ` +
            "This points at the service key or the product key of this service, not at the person.",
        );
      }
      return keepMe(key, { status: "denied", httpStatus: reply.status }, sentAt);
    }

    logOnce(
      `http-${reply.status}`,
      `the platform answered /api/access/me with HTTP ${reply.status}.`,
    );
    return { status: "unavailable", reason: "http", httpStatus: reply.status };
  }

  async function userContext(organisationId: string, userId: string): Promise<MachineAnswer<T>> {
    // Order: ids, door, cache, request.
    const org = typeof organisationId === "string" ? organisationId.trim() : "";
    const user = typeof userId === "string" ? userId.trim() : "";
    if (org === "" || user === "") return { status: "unavailable", reason: "unreadable" };

    const door = options.door();
    if (door === null) return { status: "unavailable", reason: "not-configured" };

    // One entry per person, not per key: the answer does not depend on the key. Both parts
    // are encoded, so no pair of ids can be mistaken for another pair.
    const key = `${encodeURIComponent(org.toLowerCase())}:${encodeURIComponent(user.toLowerCase())}`;
    const cached = machineCache.get(key);
    if (cached !== undefined) return copyMachineAnswer(cached);

    const sentAt = now();
    // No token: a product that keeps a session token to send it again later has built a
    // second, worse session. The service key alone carries this call.
    const reply = await platformFetch({
      door,
      method: "GET",
      path:
        `/api/access/orgs/${encodeURIComponent(org)}` +
        `/users/${encodeURIComponent(user)}/context${query}`,
      timeoutMs,
      fetch: options.fetch,
    });

    if (reply.kind === "network") {
      logOnce(
        "machine-unreachable",
        "the platform did not answer the machine-context route. Every API key is refused until it does.",
      );
      return { status: "unavailable", reason: "network" };
    }

    if (isSuccessStatus(reply.status)) {
      const answer =
        reply.data === null
          ? null
          : parseMachineAnswer(reply.data, { objectTypes: options.product.objectTypes });
      if (answer === null) {
        // NOT cached, and not "the owner has no access" (B12, B15).
        logOnce(
          "machine-bad-response",
          "the platform answered the machine-context route with a body this build cannot read.",
        );
        return { status: "unavailable", reason: "unreadable" };
      }
      // A person without access is a 200 with `productRole: null`: an answer, cached. The
      // refusal is the verdict's.
      machineCache.set(key, answer, sentAt);
      return copyMachineAnswer(answer);
    }

    if (
      (reply.status === 403 || reply.status === 404) &&
      reply.errorCode !== null &&
      SERVICE_KEY_DENIALS.includes(reply.errorCode)
    ) {
      // Policy P3 caches a 403 or 404 FOR THE PERSON. These codes are about the product's
      // service key or product key (its product, its organisation allow-list), not about
      // the person: "could not check", 503 for the key, NOT cached, so fixing the key takes
      // effect at once.
      logOnce(
        `machine-service-key-${reply.errorCode}`,
        `the platform refused the machine-context route with ${reply.status} ${reply.errorCode}. ` +
          "This points at the service key or the product key of this service, not at the person. Every API key is refused until it is fixed.",
      );
      return { status: "unavailable", reason: "http", httpStatus: reply.status };
    }

    if (reply.status === 403 || reply.status === 404) {
      // The platform decided: this product may not ask about this person.
      const detail = reply.errorCode ?? String(reply.status);
      logOnce(
        `machine-denied-${detail}`,
        `the platform refused the machine-context route with ${reply.status}` +
          `${reply.errorCode === null ? "" : ` ${reply.errorCode}`}. Keys of the people concerned are refused.`,
      );
      const answer: MachineAnswer<T> = { status: "no-access", httpStatus: reply.status };
      machineCache.set(key, answer, sentAt);
      return copyMachineAnswer(answer);
    }

    if (reply.status === 401) {
      // The service key itself was refused. That says nothing about the person, so it is
      // "could not check" and NOT cached: fixing the key must take effect at once (policy P3).
      logOnce(
        "machine-service-key",
        "the platform refused this product's service key on the machine-context route (401). Every API key is refused until the key is fixed.",
      );
      return { status: "unavailable", reason: "http", httpStatus: 401 };
    }

    // 5xx, 429, 400 and whatever else: not a decision of the platform about the person.
    logOnce(
      `machine-http-${reply.status}`,
      `the platform answered the machine-context route with HTTP ${reply.status}.`,
    );
    return { status: "unavailable", reason: "http", httpStatus: reply.status };
  }

  function clear(): void {
    meCache.clear();
    machineCache.clear();
    logged.clear();
  }

  return { me, userContext, clear };
}
