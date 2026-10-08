/**
 * platform-client: the two questions a Lab asks the Beyondles Suite.
 *
 * Level 1 (the gate): every Lab has a switch in the Suite and a list of exceptions. While the
 * Lab is not enabled, NOBODY gets in, also not the owner of an organisation, unless the
 * person's e-mail address or organisation is on the exception list.
 * Members: who belongs to an organisation is decided by the Suite alone; a Lab invites nobody.
 *
 * Both questions go to the Suite with the person's session cookie. The Suite answers plain
 * JSON, without the platform's envelope. A readable answer is cached for 60 s per token; a
 * disturbance (network error, timeout, 5xx, an unreadable body) is NEVER cached and counts as
 * closed: everything that does not clearly say "open" is closed.
 *
 * Replaces `getLabGate` / `getOrganisationMembers` and their cache in every Lab's
 * `platform-access.ts` (advisorlab `checkLabEnabled` and `fetchSuiteMembers`, bookinglab
 * `getLabAccess` and `listSuiteMembers`). The local-mode predicate and the Suite address with
 * its default stay in the product and are passed in as `local` and `suiteUrl`.
 *
 * Imports `types.ts` and, from `context.ts`, the cache and the token key only (API section 0.6).
 */

import { createTtlCache, tokenCacheKey } from "./context";
import {
  AUTH_COOKIE_NAME,
  CONTEXT_TIMEOUT_MS,
  type FetchLike,
  type GateReason,
  type HttpResponseLike,
  type LabGate,
  type OrganisationMembers,
  type SuiteClient,
  type SuiteClientOptions,
  type SuiteMember,
  type TtlCacheOptions,
} from "./types";

type SuiteMembers = Extract<OrganisationMembers, { mode: "suite" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** A token that is blank after trimming is no token (API.md section 0, rule 11). */
function hasToken(token: unknown): token is string {
  return typeof token === "string" && token.trim() !== "";
}

/* --------------------------------------------------------------------------- parsers */

/**
 * Reads the Suite's answer to `GET /api/labs/<key>/access`. `null` when it is not an object.
 *
 * `allowed` is the truth, never the reason text: no wording opens the gate without
 * `allowed === true`. An open gate keeps the reasons this build knows (`enabled`, `exception`,
 * `organisation`) and is labelled `enabled` for any other; a closed gate is always `blocked`.
 */
export function parseLabGate(body: unknown, labKey: string): LabGate | null {
  if (!isRecord(body)) return null;

  const allowed = body.allowed === true;
  let reason: GateReason = "blocked";
  if (allowed) {
    reason =
      body.reason === "enabled" || body.reason === "exception" || body.reason === "organisation"
        ? body.reason
        : "enabled";
  }

  const lab = isRecord(body.lab)
    ? {
        key: text(body.lab.key, labKey),
        name: text(body.lab.name, labKey),
        enabled: body.lab.enabled === true,
      }
    : null;

  return { allowed, reason, lab };
}

/**
 * Reads the Suite's answer to `GET /api/organisations/current/members`. `null` when it is not
 * an object. A row without a user id is left out instead of being guessed at.
 */
export function parseOrganisationMembers(body: unknown): SuiteMembers | null {
  if (!isRecord(body)) return null;

  const organisation = isRecord(body.organisation) ? body.organisation : {};
  const members: SuiteMember[] = [];
  if (Array.isArray(body.members)) {
    for (const entry of body.members as unknown[]) {
      if (!isRecord(entry)) continue;
      if (typeof entry.userId !== "string" || entry.userId.length === 0) continue;
      members.push({
        userId: entry.userId,
        email: text(entry.email, "").toLowerCase(),
        name: text(entry.name, ""),
        role: text(entry.role, "member"),
        joinedAt: typeof entry.joinedAt === "string" ? entry.joinedAt : null,
      });
    }
  }

  return {
    mode: "suite",
    organisation: {
      id: text(organisation.id, ""),
      slug: text(organisation.slug, ""),
      name: text(organisation.name, ""),
    },
    members,
  };
}

/* ---------------------------------------------------------------------------- client */

const BLOCKED: LabGate = { allowed: false, reason: "blocked", lab: null };
const UNREACHABLE: LabGate = { allowed: false, reason: "unreachable", lab: null };
const LOCAL: LabGate = { allowed: true, reason: "local", lab: null };

/** What one request to the Suite gave: a status with the parsed body, or no answer at all. */
type SuiteReply = { answered: false } | { answered: true; status: number; body: unknown };

/** A copy that shares nothing changeable with the cached gate. */
function copyGate(gate: LabGate): LabGate {
  return { ...gate, lab: gate.lab === null ? null : { ...gate.lab } };
}

/** A copy that shares nothing changeable with the cached member list. */
function copyMembers(members: SuiteMembers): SuiteMembers {
  return {
    mode: "suite",
    organisation: { ...members.organisation },
    members: members.members.map((member) => ({ ...member })),
  };
}

export function createSuiteClient(options: SuiteClientOptions): SuiteClient {
  // The default clock is read on every use, not captured here: a product test that switches
  // to fake timers after this client was created must still see an entry expire.
  const now = options.now ?? (() => Date.now());
  const cacheOptions: TtlCacheOptions = { now };
  if (options.ttlMs !== undefined) cacheOptions.ttlMs = options.ttlMs;
  if (options.max !== undefined) cacheOptions.max = options.max;

  // Two caches inside the client object, none at module level.
  const gateCache = createTtlCache<LabGate>(cacheOptions);
  const membersCache = createTtlCache<SuiteMembers>(cacheOptions);

  const timeoutMs = options.timeoutMs ?? CONTEXT_TIMEOUT_MS;
  const cookieName = options.cookieName ?? AUTH_COOKIE_NAME;

  /**
   * The host's local mode (sessions verified locally, no Suite), read on every call. A
   * predicate that throws is "not local": not knowing never opens the gate by itself.
   */
  function isLocal(): boolean {
    try {
      return options.local() === true;
    } catch {
      return false;
    }
  }

  /** `GET <suiteUrl()><path>` with the person's cookie and no other credential. Never throws. */
  async function ask(path: string, token: string): Promise<SuiteReply> {
    let response: HttpResponseLike;
    try {
      let base = String(options.suiteUrl());
      while (base.endsWith("/")) base = base.slice(0, -1);

      // The global `fetch` is looked up now, when the request is sent, never at import or
      // creation time: product tests stub the global after the module was loaded.
      const send: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
      response = await send(`${base}${path}`, {
        method: "GET",
        headers: { cookie: `${cookieName}=${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { answered: false };
    }

    const status = Number(response.status);
    if (!isSuccess(status)) return { answered: true, status, body: undefined };
    try {
      return { answered: true, status, body: await response.json() };
    } catch {
      // A 2xx answer whose body is not JSON is no answer.
      return { answered: false };
    }
  }

  function isSuccess(status: number): boolean {
    return status >= 200 && status < 300;
  }

  async function gate(token: string | null | undefined): Promise<LabGate> {
    try {
      if (isLocal()) return { ...LOCAL };
      // Without a cookie there is no session to ask about. Fail closed, nothing is sent.
      if (!hasToken(token)) return { ...BLOCKED };

      const key = tokenCacheKey(token);
      // Every answer from the cache is a copy: a host that changes the gate it got changes
      // nothing for the next request of that person.
      const hit = gateCache.get(key);
      if (hit !== undefined) return copyGate(hit);

      // Stamped with the time the request was SENT: an answer to an older request never
      // overwrites a newer one, and its lifetime does not start late.
      const sentAt = now();
      const reply = await ask(`/api/labs/${options.labKey}/access`, token);
      if (!reply.answered) return { ...UNREACHABLE };

      if (isSuccess(reply.status)) {
        const parsed = parseLabGate(reply.body, options.labKey);
        if (!parsed) return { ...UNREACHABLE };
        // Open or closed: a readable decision of the Suite is cached.
        gateCache.set(key, parsed, sentAt);
        return copyGate(parsed);
      }

      // A clear refusal (signed out, Lab unknown) may be cached; 5xx and a rate limit may not:
      // the next request asks again.
      if (reply.status === 401 || reply.status === 403 || reply.status === 404) {
        const closed: LabGate = { ...BLOCKED };
        gateCache.set(key, closed, sentAt);
        return copyGate(closed);
      }
      return { ...UNREACHABLE };
    } catch {
      return { ...UNREACHABLE };
    }
  }

  async function members(token: string | null | undefined): Promise<OrganisationMembers> {
    try {
      if (isLocal()) return { mode: "local" };
      if (!hasToken(token)) return { mode: "unreachable" };

      const key = tokenCacheKey(token);
      const hit = membersCache.get(key);
      if (hit !== undefined) return copyMembers(hit);

      const sentAt = now();
      const reply = await ask("/api/organisations/current/members", token);
      // A disturbance is "unreachable", never an empty list: an empty list would be the claim
      // that the organisation has no members.
      if (!reply.answered || !isSuccess(reply.status)) return { mode: "unreachable" };

      const parsed = parseOrganisationMembers(reply.body);
      if (!parsed) return { mode: "unreachable" };
      membersCache.set(key, parsed, sentAt);
      return copyMembers(parsed);
    } catch {
      return { mode: "unreachable" };
    }
  }

  function clear(): void {
    gateCache.clear();
    membersCache.clear();
  }

  // Plain closures, no `this`: a host passes `gate` on as a function (`resolvePersonAccess`).
  // `local()` is the host's own predicate and opens the gate without a request. A host builds
  // it with `config.localSessionMode`, which carries the production lock (HOST-CONTRACT 2).
  return { gate, members, clear };
}
