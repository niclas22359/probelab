import "server-only";

import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import jwt, { type JwtPayload } from "jsonwebtoken";

import { localJwtSecret } from "@/lib/jwt-guard";
import { platformUrl } from "@/lib/platform/door";

/**
 * Sign-in through the Beyondles Suite (single sign-on).
 *
 * A Lab has NO login of its own and NO user table. The Suite signs the person
 * in and sets the cookie `platform-auth-token` on `.beyondles.ai`. Because the
 * Lab runs under the same domain, the cookie arrives with every request.
 *
 * Two modes, decided by the environment:
 *
 * 1. ASK THE SUITE (introspection) — the norm on every server. `JWT_SECRET`
 *    is deliberately absent there. The cookie is forwarded to
 *    `GET <NEXT_PUBLIC_PLATFORM_URL>/api/auth/me`; only if the Suite confirms
 *    it does the session count.
 * 2. LOCAL VERIFICATION — only when `JWT_SECRET` + `ALLOW_LOCAL_JWT=true` are
 *    set (CI, E2E, local development). Issuer and audience are those of the
 *    Suite. Whether the secret may be used at all decides `jwt-guard.ts`.
 *
 * Security notes for introspection:
 * - Only the access-token cookie is forwarded, never a refresh token.
 * - Organisation data comes from `jwt.decode` of the EXACT confirmed token
 *   (decode checks no signature — /api/auth/me already did) plus a cross
 *   check: the decoded userId must equal the user the Suite confirmed.
 * - `organisationId` is a claim of the token, NOT a field of the answer:
 *   `/api/auth/me` returns `{ user, products, mfa }` and no organisation.
 * - Results are cached 60 s per token hash. Network errors are NOT cached.
 */

const AUTH_COOKIE_NAME = "platform-auth-token";

/** Must be identical to Suite/Brain/Agent. */
const JWT_ISSUER = "company-brain";
const JWT_AUDIENCE = "brain-app";

const INTROSPECTION_TIMEOUT_MS = 5000;
const INTROSPECTION_CACHE_TTL_MS = 60_000;
const INTROSPECTION_CACHE_MAX = 500;

export interface PlatformSession {
  userId: string;
  email: string;
  name: string;
  /** Role inside the Suite organisation (`owner`, `admin`, `member`). */
  role: string;
  organisationId: string;
  organisationSlug: string;
}

export async function getAuthToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(AUTH_COOKIE_NAME)?.value;
}

/**
 * Builds a session from a (confirmed) token payload. A token without an
 * `organisationId` is rejected: a Lab is fully tenant-bound, and the platform
 * would book calls to nobody. Empty or non-uuid means REJECT, never default.
 */
export function sessionFromPayload(payload: JwtPayload): PlatformSession | null {
  if (payload.type !== "access") return null;

  const organisationId =
    typeof payload.organisationId === "string" ? payload.organisationId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organisationId)) {
    return null;
  }

  return {
    userId: String(payload.userId ?? ""),
    email: String(payload.email ?? ""),
    name: String(payload.name ?? ""),
    role: String(payload.role ?? "member"),
    organisationId,
    organisationSlug:
      typeof payload.organisationSlug === "string"
        ? payload.organisationSlug
        : organisationId,
  };
}

// ---------------------------------------------------------------------------
// Mode 2: local verification (CI, E2E, local development)
// ---------------------------------------------------------------------------

function verifyLocally(token: string, secret: string): PlatformSession | null {
  try {
    const payload = jwt.verify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as JwtPayload;
    return sessionFromPayload(payload);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mode 1: ask the Suite (introspection)
// ---------------------------------------------------------------------------

interface CacheEntry {
  session: PlatformSession | null;
  validUntil: number;
}

const introspectionCache = new Map<string, CacheEntry>();

function cachePut(key: string, session: PlatformSession | null): void {
  if (introspectionCache.size >= INTROSPECTION_CACHE_MAX) {
    const oldest = introspectionCache.keys().next().value;
    if (oldest !== undefined) introspectionCache.delete(oldest);
  }
  introspectionCache.set(key, {
    session,
    validUntil: Date.now() + INTROSPECTION_CACHE_TTL_MS,
  });
}

/** Exported for the unit test; takes a fetch so no network is needed. */
export async function introspect(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PlatformSession | null> {
  const key = createHash("sha256").update(token).digest("hex");
  const hit = introspectionCache.get(key);
  if (hit && hit.validUntil > Date.now()) return hit.session;
  if (hit) introspectionCache.delete(key);

  const suite = platformUrl();
  if (!suite) return null; // no Suite configured and no local secret: nobody

  let res: Response;
  try {
    res = await fetchImpl(`${suite}/api/auth/me`, {
      headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(INTROSPECTION_TIMEOUT_MS),
    });
  } catch {
    return null; // network error: not cached, next request tries again
  }

  if (res.ok) {
    let session: PlatformSession | null = null;
    try {
      const body = (await res.json()) as {
        user?: { id?: string; email?: string; name?: string };
      };
      const decoded = jwt.decode(token);
      if (body.user?.id && decoded && typeof decoded === "object") {
        const candidate = sessionFromPayload(decoded as JwtPayload);
        if (candidate && candidate.userId === body.user.id) {
          session = {
            ...candidate,
            email: body.user.email ?? candidate.email,
            name: body.user.name ?? candidate.name,
          };
        }
      }
    } catch {
      session = null;
    }
    cachePut(key, session);
    return session;
  }

  // A clear rejection (401 signed out, 403 organisation blocked) may be
  // cached; 5xx and rate limits are not.
  if (res.status === 401 || res.status === 403) cachePut(key, null);
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The signed-in session, or `null` when there is none. */
export async function getSession(): Promise<PlatformSession | null> {
  const token = await getAuthToken();
  if (!token) return null;

  const secret = localJwtSecret();
  if (secret) return verifyLocally(token, secret);
  return introspect(token);
}

/** Tests only. */
export function __clearIntrospectionCacheForTests(): void {
  introspectionCache.clear();
}
