import "server-only";

import { db } from "@/lib/db";
import { hashApiKey, hashEquals } from "@/lib/api-keys";
import { ApiError } from "@/lib/api-errors";
import { MACHINE_DENY_STATUS } from "@/lib/platform-client/core/types";
import { LAB_KEY } from "@/lib/lab";
import { ensureOrganisationById } from "@/lib/rbac";
import {
  getApiKeyAccessContext,
  getOnBehalfAccessContext,
  localFallbackAllowed,
  type AccessContext,
  type MachineDenyReason,
} from "@/lib/platform/access";
import { checkOnBehalfToken, onBehalfBearer } from "@/lib/tool-door/obo-door";
import { checkLabReleased } from "@/lib/tool-door/release-gate";
import { checkRateLimit, type RateDoor } from "@/lib/rate-limit";
import { missingScopes, onBehalfScopes, type GrantedScopes, type Scope } from "@/lib/scopes";

/**
 * The door for machines. It accepts TWO credentials:
 *
 *  1. `x-api-key` — a key this Lab issued. Two kinds:
 *     - USER   — created for a PERSON. Acts in her view of TODAY: the Lab asks
 *                the platform per request what she may see. Lost access = dead
 *                key (403), not "then only organisation-wide".
 *     - WORKER — created for the ORGANISATION. No person behind it: only
 *                organisation-wide rows, nothing private, survives departures.
 *     Every key also passes the RELEASE GATE: it works only for organisations
 *     the Lab is released for in the Suite (src/lib/tool-door/release-gate.ts).
 *
 *  2. `Authorization: Bearer <on-behalf token>` — another Beyondles product
 *     (Beyondles HorAIzon, another Lab) calling on behalf of an organisation,
 *     a person or an agent. The platform signed it for audience = this Lab.
 *     The view follows the agent: organisation agent = worker view,
 *     collection agent = its collection, private agent = its owner, no agent
 *     = the person (`sub`), neither = worker view. Every named person is
 *     checked at the platform (floor, membership, product access).
 *
 * After the credential: the RATE LIMIT (`src/lib/rate-limit.ts`, 429 with
 * `Retry-After`) per key or per calling product, and the SCOPES the
 * credential carries (`src/lib/scopes.ts`); each route asks for the scopes of
 * its function with `requireScope` (through `src/server/machine-door.ts`).
 *
 * Both together are refused (`400 ambiguous_credential`). People keep coming
 * through the Suite cookie (`src/lib/rbac.ts`). The middleware lets `/api/v1`
 * and `/api/mcp` through without a cookie; the security boundary is THIS
 * file, running in the Node process with database access.
 */

export interface OnBehalfCaller {
  /** `claims.cp` */
  callingProduct: string;
  /** `claims.sub` */
  userId: string | null;
  role: "owner" | "admin" | "member" | null;
  agent: { id: string; level: "private" | "collection" | "organisation"; owner?: string; col?: string } | null;
  /** `claims.jti` */
  tokenId: string;
  issuedAt: Date;
}

export interface ApiKeyContext {
  organisationId: string;
  /** For a token: `obo:<jti>`. */
  keyId: string;
  /** For a token: the calling product. */
  keyName: string;
  /** For a token: the person whose view applies, or `null`. */
  createdByUserId: string | null;
  /**
   * For a token: `user` with a person, `worker` without one. For a token the
   * kind never chooses the view, and a route reserved for WORKER KEYS must
   * also require `via === "api-key"`.
   */
  kind: "user" | "worker";
  access: AccessContext;
  via: "api-key" | "on-behalf";
  onBehalf: OnBehalfCaller | null;
  /** Key: the stored scopes (`*` = legacy full access). Token: `onBehalfScopes`. */
  scopes: GrantedScopes;
}

/** 403 `insufficient_scope` unless the credential carries every scope in `needed`. */
export function requireScope(key: Pick<ApiKeyContext, "scopes">, needed: readonly Scope[]): void {
  const missing = missingScopes(key.scopes, needed);
  if (missing.length > 0) {
    throw new ApiError(
      403,
      "insufficient_scope",
      `This credential lacks the scope(s) ${missing.join(", ")}. A product admin creates a key with them in the Lab's settings.`,
    );
  }
}

function doorOf(request: Request): RateDoor {
  try {
    return new URL(request.url).pathname.startsWith("/api/mcp") ? "mcp" : "v1";
  } catch {
    return "v1";
  }
}

function enforceRateLimit(request: Request, credential: "key" | "on-behalf", subject: string): void {
  const decision = checkRateLimit({ door: doorOf(request), credential, subject });
  if (!decision.allowed) {
    throw new ApiError(429, "rate_limited", "Too many requests for this credential. Wait and try again.", undefined, {
      "Retry-After": String(decision.retryAfterSeconds),
    });
  }
}

const LAST_USED_GRANULARITY_MS = 60_000;

/** The status of each refusal is the access contract's (policy P3); the texts are this Lab's. */
const DENIALS: Record<MachineDenyReason, string> = {
  KEY_OWNER_NO_ACCESS:
    "The person who created this key has no access to this Lab. The key never sees more than they do.",
  KEY_REVOKED:
    "This key was issued before its creator's access was revoked and is no longer valid. Create a new one.",
  PERSON_GONE:
    "The person who created this key is no longer a member of the organisation. Create a new key.",
  KEY_CHECK_UNAVAILABLE:
    "The access of this key could not be checked right now. Unchecked is not served — try again later.",
};

const INVALID_TOKEN_CHALLENGE = { "WWW-Authenticate": 'Bearer error="invalid_token"' } as const;
const REFUSED_TOKEN_MESSAGE = "The on-behalf token is not valid for this service.";

/**
 * Reads the credential, checks it and returns organisation plus view.
 * Key path: 401 for missing, unknown or revoked (all three answer the same, so
 * a guessed key learns nothing). 403/503 only after that.
 */
export async function requireApiKey(request: Request): Promise<ApiKeyContext> {
  const bearer = onBehalfBearer(request);
  if (bearer && "ambiguous" in bearer) {
    throw new ApiError(
      400,
      "ambiguous_credential",
      "Send either an on-behalf token or an x-api-key, never both.",
    );
  }
  if (bearer) return requireOnBehalf(request, bearer.token);

  const plaintext = request.headers.get("x-api-key")?.trim();
  if (!plaintext) throw new ApiError(401, "unauthorized", "Header x-api-key is missing.");

  const hash = hashApiKey(plaintext);
  const row = await db.apiKey.findUnique({
    where: { keyHash: hash },
    select: {
      id: true,
      name: true,
      organisationId: true,
      keyHash: true,
      createdByUserId: true,
      kind: true,
      createdAt: true,
      revokedAt: true,
      lastUsedAt: true,
      scopes: true,
    },
  });

  if (!row || row.revokedAt || !hashEquals(row.keyHash, hash)) {
    throw new ApiError(401, "unauthorized", "API key invalid.");
  }

  enforceRateLimit(request, "key", `key:${row.id}`);

  // Level 1 for machines: the Suite's release switch, asked through the platform.
  const release = await checkLabReleased(row.organisationId, { localMode: localFallbackAllowed() });
  if (!release.ok) throw new ApiError(release.status, release.code, release.message);

  // The kind is the row's. A USER row without a creator stays a user key and
  // is refused (policy P3); only a WORKER row acts for nobody.
  const kind: "user" | "worker" = row.kind === "WORKER" ? "worker" : "user";

  const access = await getApiKeyAccessContext({
    keyId: row.id,
    organisationId: row.organisationId,
    createdByUserId: row.createdByUserId,
    mintedAt: row.createdAt,
    kind,
  });
  if (!access.ok) {
    throw new ApiError(MACHINE_DENY_STATUS[access.reason], access.reason, DENIALS[access.reason]);
  }

  await rememberUse(row.id, row.lastUsedAt);

  return {
    organisationId: row.organisationId,
    keyId: row.id,
    keyName: row.name,
    createdByUserId: row.createdByUserId,
    kind,
    access: access.context,
    via: "api-key",
    onBehalf: null,
    scopes: row.scopes,
  };
}

/** Steps 1 to 6 of the token path (connection layer contract, stage 6, 2.4). */
async function requireOnBehalf(request: Request, token: string): Promise<ApiKeyContext> {
  const check = await checkOnBehalfToken(token, LAB_KEY);
  if (!check.ok) {
    const headers: Record<string, string> =
      check.status === 401
        ? { ...INVALID_TOKEN_CHALLENGE }
        : check.retryAfterSeconds !== undefined
          ? { "Retry-After": String(check.retryAfterSeconds) }
          : {};
    throw new ApiError(check.status, check.code, check.message, undefined, headers);
  }

  const { claims } = check;
  enforceRateLimit(request, "on-behalf", `cp:${claims.cp}:${claims.org}`);
  const agent = claims.agt ?? null;
  const issuedAt = new Date(claims.iat * 1000);
  const access = await getOnBehalfAccessContext({
    organisationId: claims.org,
    personUserId: claims.sub ?? null,
    issuedAt,
    agent,
  });
  if (!access.ok) {
    switch (access.reason) {
      case "KEY_REVOKED":
        throw new ApiError(401, "unauthorized", REFUSED_TOKEN_MESSAGE, undefined, INVALID_TOKEN_CHALLENGE);
      case "PERSON_GONE":
        throw new ApiError(
          401,
          "person_gone",
          "The person named by this token is no longer a member of the organisation.",
          undefined,
          INVALID_TOKEN_CHALLENGE,
        );
      case "KEY_OWNER_NO_ACCESS":
        throw new ApiError(403, "no_product_access", "The person named by this token has no access to this Lab.");
      default:
        throw new ApiError(
          503,
          "token_check_unavailable",
          "The person named by this token could not be checked right now; try again later.",
        );
    }
  }

  // The organisation mirror row, created on first use by a token before a write.
  if (isWrite(request)) await ensureOrganisationById(claims.org);

  const person = access.context.userId || null;
  return {
    organisationId: claims.org,
    keyId: `obo:${claims.jti}`,
    keyName: claims.cp,
    createdByUserId: person,
    kind: person ? "user" : "worker",
    access: access.context,
    via: "on-behalf",
    onBehalf: {
      callingProduct: claims.cp,
      userId: claims.sub ?? null,
      role: claims.role ?? null,
      agent,
      tokenId: claims.jti,
      issuedAt,
    },
    scopes: onBehalfScopes({ personUserId: person }),
  };
}

/** A request that may write a row. `/api/mcp` itself writes nothing; its self-call to `/api/v1` does. */
function isWrite(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  try {
    return !new URL(request.url).pathname.startsWith("/api/mcp");
  } catch {
    return true;
  }
}

/** Best effort, at most once a minute; a failed write never fails the request. */
async function rememberUse(keyId: string, lastUsedAt: Date | null): Promise<void> {
  const now = Date.now();
  if (lastUsedAt && now - lastUsedAt.getTime() < LAST_USED_GRANULARITY_MS) return;
  try {
    await db.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date(now) } });
  } catch (error) {
    console.warn("[api-auth] lastUsedAt could not be written:", error);
  }
}
