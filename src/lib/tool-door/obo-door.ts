import {
  createOnBehalfVerifier,
  looksLikeOnBehalfToken,
  type OnBehalfClaims,
  type OnBehalfDenyReason,
  type OnBehalfVerifier,
} from "@/lib/platform/on-behalf";

/**
 * The on-behalf part of a Lab's tool door (connection layer contract, stage 6, 2.4/2.5).
 *
 * Another Beyondles product (Beyondles HorAIzon, another Lab) calls this Lab with
 * `Authorization: Bearer <on-behalf token>`: a five-minute token the platform signed for
 * audience = this Lab. This file reads that credential, verifies the token (steps 1 and 2 of the
 * token path), applies the rate limit (step 3) and writes the refusal log line. Whose view the
 * token gets and the person check (steps 4 and 5) are the Lab's own, in its machine entry.
 *
 * How a verdict becomes an answer:
 *  - `ON_BEHALF_ISSUER` or `PLATFORM_API_URL` missing, or the platform's keys cannot be fetched:
 *    `503 token_check_unavailable`;
 *  - every other refusal: `401 unauthorized` with one message for all reasons; the reason goes to
 *    the log only, as `[on-behalf] refused reason=<reason>`, at most once a minute per reason;
 *  - more than 1,200 requests per minute for one calling product and organisation: `429`.
 *
 * THIS FILE IS COPIED VERBATIM into every Lab from the template `beyondles-lab`. Node runtime
 * only (never `middleware.ts`, never a client component).
 */

export type OboDoorState = "ok" | "unconfigured";

type Env = Record<string, string | undefined>;

/** Spelled out on purpose: the deployment tests look for exactly `process.env.NAME`. */
function currentEnv(): Env {
  return {
    PLATFORM_API_URL: process.env.PLATFORM_API_URL,
    ON_BEHALF_ISSUER: process.env.ON_BEHALF_ISSUER,
  };
}

/** `ok` when this environment's issuer and the platform's address are both set. */
export function oboDoorState(env: Env = currentEnv()): OboDoorState {
  const base = (env.PLATFORM_API_URL ?? "").trim();
  const issuer = (env.ON_BEHALF_ISSUER ?? "").trim();
  return base && issuer ? "ok" : "unconfigured";
}

/**
 * null: no on-behalf token in Authorization.
 *
 * Only a bearer that looks like an on-behalf token (its header type) counts; any other bearer
 * (a Lab's own `blk_…` key, a Suite token) is left to the Lab's existing path. A token next to
 * an `x-api-key` header is ambiguous and refused by the caller with `400`.
 */
export function onBehalfBearer(request: Request): { token: string } | { ambiguous: true } | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return null;
  const token = match[1];
  if (!looksLikeOnBehalfToken(token)) return null;
  if ((request.headers.get("x-api-key") ?? "").trim()) return { ambiguous: true };
  return { token };
}

export type OboCheck =
  | { ok: true; claims: OnBehalfClaims }
  | {
      ok: false;
      status: 401 | 429 | 503;
      code: "unauthorized" | "rate_limited" | "token_check_unavailable";
      message: string;
      retryAfterSeconds?: number;
    };

export const OBO_REQUESTS_PER_MINUTE = 1200;

const WINDOW_MS = 60_000;
const RATE_MAX_ENTRIES = 10_000;
const REFUSAL_LOG_INTERVAL_MS = 60_000;

const REFUSED_MESSAGE = "The on-behalf token is not valid for this service.";

const verifiers = new Map<string, OnBehalfVerifier>();
const windows = new Map<string, { startedAt: number; count: number }>();
const lastRefusalLogAt = new Map<OnBehalfDenyReason, number>();

/** One verifier per audience and process, built on first use (never at build time). */
function verifierFor(audience: string): OnBehalfVerifier {
  let verifier = verifiers.get(audience);
  if (!verifier) {
    const base = (process.env.PLATFORM_API_URL ?? "").trim().replace(/\/+$/, "");
    verifier = createOnBehalfVerifier({
      jwksUrl: base ? `${base}/api/on-behalf/jwks` : "",
      issuer: (process.env.ON_BEHALF_ISSUER ?? "").trim(),
      audience,
    });
    verifiers.set(audience, verifier);
  }
  return verifier;
}

function logRefusal(reason: OnBehalfDenyReason): void {
  const now = Date.now();
  const last = lastRefusalLogAt.get(reason);
  if (last !== undefined && now - last < REFUSAL_LOG_INTERVAL_MS) return;
  lastRefusalLogAt.set(reason, now);
  console.warn(`[on-behalf] refused reason=${reason}`);
}

/** Fixed one-minute window per calling product and organisation, in memory. */
function hit(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now();
  let entry = windows.get(key);
  if (!entry || now - entry.startedAt >= WINDOW_MS) {
    if (!entry && windows.size >= RATE_MAX_ENTRIES) {
      for (const [k, v] of windows) if (now - v.startedAt >= WINDOW_MS) windows.delete(k);
      if (windows.size >= RATE_MAX_ENTRIES) {
        const oldest = windows.keys().next().value;
        if (oldest !== undefined) windows.delete(oldest);
      }
    }
    entry = { startedAt: now, count: 0 };
    windows.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > OBO_REQUESTS_PER_MINUTE) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.startedAt + WINDOW_MS - now) / 1000)) };
  }
  return { allowed: true };
}

/** Steps 1 to 3 of the token path. One verifier per audience and process, built on first use. */
export async function checkOnBehalfToken(token: string, audience: string): Promise<OboCheck> {
  if (oboDoorState() !== "ok") {
    return {
      ok: false,
      status: 503,
      code: "token_check_unavailable",
      message: "On-behalf tokens are not configured on this server (ON_BEHALF_ISSUER or PLATFORM_API_URL is missing).",
    };
  }

  const verdict = await verifierFor(audience).verify(token);
  if (!verdict.ok) {
    if (verdict.reason === "keys_unavailable" || verdict.reason === "not_configured") {
      return {
        ok: false,
        status: 503,
        code: "token_check_unavailable",
        message: "The on-behalf token could not be checked right now; try again later.",
      };
    }
    logRefusal(verdict.reason);
    return { ok: false, status: 401, code: "unauthorized", message: REFUSED_MESSAGE };
  }

  const rate = hit(`${verdict.claims.cp}:${verdict.claims.org}`);
  if (!rate.allowed) {
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      message: `Too many requests for this product and organisation (${OBO_REQUESTS_PER_MINUTE} per minute).`,
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }
  return { ok: true, claims: verdict.claims };
}

/** Tests only: forget verifiers (and their keys), rate windows and the refusal log memory. */
export function __resetOboDoorForTests(): void {
  verifiers.clear();
  windows.clear();
  lastRefusalLogAt.clear();
}
