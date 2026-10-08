/**
 * On-behalf tokens: verify helper and client helper (connection layer contract, section 1).
 *
 * platform-api signs a short-lived token (Ed25519, compact JWS) that names the calling product,
 * the target product, the organisation and, where there is one, the person and the agent. Every
 * target verifies it with the platform's PUBLIC keys. No shared secret, no dependency: only
 * `node:crypto` and the global `fetch`.
 *
 * THIS FILE IS COPIED VERBATIM into every product. Do not edit a copy; change the contract and
 * copy again. Node runtime only (never the Edge runtime, never a browser bundle).
 *
 * The token is AUTHENTICATION (which product calls, for which organisation, person, agent).
 * AUTHORISATION stays in the target: it applies its own rules for that person or agent.
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";

export const ON_BEHALF_ALG = "EdDSA";
export const ON_BEHALF_TYP = "beyondles-obo+jwt";
/** A token lives five minutes. A longer one is refused even when it is signed correctly. */
export const ON_BEHALF_MAX_LIFETIME_SECONDS = 300;
/** Tolerance for clock differences between two of our servers. */
export const ON_BEHALF_CLOCK_SKEW_SECONDS = 30;

export type OnBehalfAgentLevel = "private" | "collection" | "organisation";
export type OnBehalfOrgRole = "owner" | "admin" | "member";

/** The agent the calling product acts for. Asserted by the calling product, checked by the platform. */
export interface OnBehalfAgent {
  /** The calling product's own id of the agent. Opaque for everybody else. */
  id: string;
  level: OnBehalfAgentLevel;
  /** Level `private` only: the user id of the agent's owner. */
  owner?: string;
  /** Level `collection` only: the platform collection id of the agent. */
  col?: string;
}

export interface OnBehalfClaims {
  /** `beyondles-platform:staging` or `beyondles-platform:production`. */
  iss: string;
  /** Product key of the target, for example `connections`. */
  aud: string;
  /** Product key of the calling product, for example `horaizon`. */
  cp: string;
  /** Organisation id (uuid, lower case). */
  org: string;
  /** User id (uuid, lower case). Absent when no person is behind the call. */
  sub?: string;
  /** The person's live organisation role. Present exactly when `sub` is present. */
  role?: OnBehalfOrgRole;
  agt?: OnBehalfAgent;
  jti: string;
  iat: number;
  exp: number;
}

export type OnBehalfDenyReason =
  | "malformed"
  | "unsupported"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "invalid_claims"
  | "keys_unavailable"
  | "not_configured";

export type OnBehalfVerdict =
  | { ok: true; claims: OnBehalfClaims }
  | { ok: false; reason: OnBehalfDenyReason };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRODUCT_KEY = /^[a-z0-9_]{2,40}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KEY_ID = /^[A-Za-z0-9_-]{4,32}$/;
const AGENT_ID = /^[\x21-\x7e]{1,128}$/;
const ORG_ROLES: readonly string[] = ["owner", "admin", "member"];
const AGENT_LEVELS: readonly string[] = ["private", "collection", "organisation"];
const ED25519_SIGNATURE_BYTES = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  if (!BASE64URL.test(segment)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Cheap look at the header, WITHOUT any check: does this string claim to be an on-behalf token?
 * For doors that accept several kinds of bearer tokens and must pick the right check.
 */
export function looksLikeOnBehalfToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const header = decodeJsonSegment(parts[0] ?? "");
  return header !== null && header["typ"] === ON_BEHALF_TYP;
}

function readAgent(value: unknown): OnBehalfAgent | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const level = value["level"];
  const owner = value["owner"];
  const col = value["col"];
  if (typeof id !== "string" || !AGENT_ID.test(id)) return null;
  if (typeof level !== "string" || !AGENT_LEVELS.includes(level)) return null;
  if (level === "private") {
    if (typeof owner !== "string" || !UUID.test(owner) || col !== undefined) return null;
    return { id, level, owner };
  }
  if (level === "collection") {
    if (typeof col !== "string" || !UUID.test(col) || owner !== undefined) return null;
    return { id, level, col };
  }
  if (owner !== undefined || col !== undefined) return null;
  return { id, level: "organisation" };
}

function readClaims(payload: Record<string, unknown>): OnBehalfClaims | null {
  const { iss, aud, cp, org, sub, role, agt, jti, iat, exp } = payload;
  if (typeof iss !== "string" || iss === "") return null;
  if (typeof aud !== "string" || !PRODUCT_KEY.test(aud)) return null;
  if (typeof cp !== "string" || !PRODUCT_KEY.test(cp)) return null;
  if (typeof org !== "string" || !UUID.test(org)) return null;
  if (typeof jti !== "string" || jti === "" || jti.length > 64) return null;
  if (typeof iat !== "number" || !Number.isInteger(iat)) return null;
  if (typeof exp !== "number" || !Number.isInteger(exp)) return null;
  const claims: OnBehalfClaims = { iss, aud, cp, org, jti, iat, exp };
  if (sub !== undefined) {
    if (typeof sub !== "string" || !UUID.test(sub)) return null;
    if (typeof role !== "string" || !ORG_ROLES.includes(role)) return null;
    claims.sub = sub;
    claims.role = role as OnBehalfOrgRole;
  } else if (role !== undefined) {
    return null;
  }
  if (agt !== undefined) {
    const agent = readAgent(agt);
    if (!agent) return null;
    claims.agt = agent;
  }
  return claims;
}

/**
 * The check itself, pure and synchronous: signature, issuer, audience, time, claim shapes.
 * `keys` maps key id to public key. `nowMs` is the current time in milliseconds.
 */
export function verifyOnBehalfToken(
  token: string,
  keys: ReadonlyMap<string, KeyObject>,
  expected: { issuer: string; audience: string },
  nowMs: number,
): OnBehalfVerdict {
  const deny = (reason: OnBehalfDenyReason): OnBehalfVerdict => ({ ok: false, reason });
  if (typeof token !== "string" || token.length > 4096) return deny("malformed");
  const parts = token.split(".");
  if (parts.length !== 3) return deny("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJsonSegment(headerPart);
  if (!header) return deny("malformed");
  if (header["alg"] !== ON_BEHALF_ALG || header["typ"] !== ON_BEHALF_TYP) return deny("unsupported");
  const kid = header["kid"];
  if (typeof kid !== "string" || !KEY_ID.test(kid)) return deny("malformed");
  const key = keys.get(kid);
  if (!key) return deny("unknown_key");

  if (!BASE64URL.test(signaturePart)) return deny("malformed");
  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length !== ED25519_SIGNATURE_BYTES) return deny("bad_signature");
  let signatureOk = false;
  try {
    signatureOk = verifySignature(null, Buffer.from(`${headerPart}.${payloadPart}`, "ascii"), key, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return deny("bad_signature");

  const payload = decodeJsonSegment(payloadPart);
  if (!payload) return deny("malformed");
  if (payload["iss"] !== expected.issuer) return deny("wrong_issuer");
  if (payload["aud"] !== expected.audience) return deny("wrong_audience");
  const claims = readClaims(payload);
  if (!claims) return deny("invalid_claims");
  if (claims.exp <= claims.iat || claims.exp - claims.iat > ON_BEHALF_MAX_LIFETIME_SECONDS) {
    return deny("invalid_claims");
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (nowSeconds >= claims.exp + ON_BEHALF_CLOCK_SKEW_SECONDS) return deny("expired");
  if (nowSeconds < claims.iat - ON_BEHALF_CLOCK_SKEW_SECONDS) return deny("not_yet_valid");
  return { ok: true, claims };
}

/** Reads the platform's key document `{ issuer, keys: [{ kty, crv, kid, x }] }`. Unusable keys are skipped. */
export function importOnBehalfKeys(document: unknown): { issuer: string | null; keys: Map<string, KeyObject> } {
  const keys = new Map<string, KeyObject>();
  if (!isRecord(document)) return { issuer: null, keys };
  const issuer = typeof document["issuer"] === "string" ? document["issuer"] : null;
  const list = Array.isArray(document["keys"]) ? document["keys"] : [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const { kty, crv, kid, x } = entry;
    if (kty !== "OKP" || crv !== "Ed25519") continue;
    if (typeof kid !== "string" || !KEY_ID.test(kid)) continue;
    if (typeof x !== "string" || !BASE64URL.test(x)) continue;
    try {
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
      if (key.asymmetricKeyType === "ed25519") keys.set(kid, key);
    } catch {
      // A key this build cannot read is skipped; a token signed with it is refused as unknown_key.
    }
  }
  return { issuer, keys };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OnBehalfVerifierConfig {
  /** `<PLATFORM_API_URL>/api/on-behalf/jwks` of THIS environment. */
  jwksUrl: string;
  /** The issuer this environment accepts (`ON_BEHALF_ISSUER`). */
  issuer: string;
  /** The product key of the product this code runs in. */
  audience: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** How long fetched keys are used before they are fetched again. Default 10 minutes. */
  keysTtlMs?: number;
  /** Minimum pause between two fetches caused by an unknown key id. Default 30 seconds. */
  refetchCooldownMs?: number;
  /** How long the last good keys stay in use while the platform cannot be reached. Default 24 hours. */
  staleMaxMs?: number;
  /** Default 5 seconds. */
  timeoutMs?: number;
}

export interface OnBehalfVerifier {
  verify(token: string): Promise<OnBehalfVerdict>;
  /** Tests only: forget the fetched keys. */
  reset(): void;
}

/**
 * A verifier with a key cache. One instance per process (module-level singleton in the product's
 * own wrapper). Fail closed: no keys, no accepted token.
 */
export function createOnBehalfVerifier(config: OnBehalfVerifierConfig): OnBehalfVerifier {
  const doFetch: FetchLike = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = config.now ?? Date.now;
  const keysTtlMs = config.keysTtlMs ?? 10 * 60_000;
  const refetchCooldownMs = config.refetchCooldownMs ?? 30_000;
  const staleMaxMs = config.staleMaxMs ?? 24 * 60 * 60_000;
  const timeoutMs = config.timeoutMs ?? 5_000;

  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let lastAttemptAt = 0;
  let inflight: Promise<boolean> | null = null;
  let issuerWarned = false;

  async function load(): Promise<boolean> {
    lastAttemptAt = now();
    try {
      const response = await doFetch(config.jwksUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return false;
      const imported = importOnBehalfKeys(await response.json());
      if (imported.issuer !== config.issuer) {
        if (!issuerWarned) {
          issuerWarned = true;
          console.error(
            `[on-behalf] the platform at ${config.jwksUrl} issues for "${imported.issuer ?? "(none)"}", ` +
              `this service expects "${config.issuer}". Wrong environment? Every on-behalf token is refused.`,
          );
        }
        keys = new Map();
        fetchedAt = 0;
        return false;
      }
      if (imported.keys.size === 0) return false;
      keys = imported.keys;
      fetchedAt = now();
      return true;
    } catch {
      return false;
    }
  }

  function refresh(): Promise<boolean> {
    if (!inflight) {
      inflight = load().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  function keyIdOf(token: string): string | null {
    const header = decodeJsonSegment(token.split(".")[0] ?? "");
    const kid = header ? header["kid"] : undefined;
    return typeof kid === "string" ? kid : null;
  }

  return {
    async verify(token: string): Promise<OnBehalfVerdict> {
      if (!config.jwksUrl || !config.issuer || !config.audience) return { ok: false, reason: "not_configured" };
      const haveKeys = keys.size > 0;
      const stale = !haveKeys || now() - fetchedAt > keysTtlMs;
      const kid = typeof token === "string" ? keyIdOf(token) : null;
      const unknownKey = haveKeys && kid !== null && !keys.has(kid);
      const mayAsk = lastAttemptAt === 0 || now() - lastAttemptAt > refetchCooldownMs;
      // A fetch already in flight is awaited even inside the cooldown: otherwise a call that
      // arrives while the first key fetch runs sees an empty cache and answers keys_unavailable.
      if (inflight) await inflight;
      else if ((stale || unknownKey) && mayAsk) await refresh();
      if (keys.size === 0 || now() - fetchedAt > staleMaxMs) return { ok: false, reason: "keys_unavailable" };
      return verifyOnBehalfToken(token, keys, { issuer: config.issuer, audience: config.audience }, now());
    },
    reset(): void {
      keys = new Map();
      fetchedAt = 0;
      lastAttemptAt = 0;
      issuerWarned = false;
    },
  };
}

/* ------------------------------------------------------------------ client */

export interface OnBehalfTokenRequest {
  /** Product key of the target. */
  audience: string;
  organisationId: string;
  userId?: string | null;
  agent?: {
    id: string;
    level: OnBehalfAgentLevel;
    /** Required for level `private`. */
    ownerUserId?: string;
    /** Required for level `collection`. */
    collectionId?: string;
  } | null;
}

export class OnBehalfError extends Error {
  /** The platform's error code, or `NETWORK` / `BAD_RESPONSE`. */
  readonly code: string;
  /** HTTP status, 0 when the platform did not answer. */
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "OnBehalfError";
    this.code = code;
    this.status = status;
  }
}

export interface OnBehalfClientConfig {
  /** `PLATFORM_API_URL` of THIS environment, without a trailing slash. */
  platformApiUrl: string;
  /** The calling product's own service key (`PLATFORM_API_KEY`). */
  apiKey: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** A cached token is replaced this long before it expires. Default 60 seconds. */
  refreshBeforeMs?: number;
  /** Default 5 seconds. */
  timeoutMs?: number;
  /** Default 1000 cached tokens. */
  maxEntries?: number;
}

export interface OnBehalfClient {
  /** A token for this target, organisation, person and agent. Cached in memory until shortly before it expires. */
  getToken(request: OnBehalfTokenRequest): Promise<string>;
  /** Forget the cached token of exactly this request (after a 401 from its target). */
  forget(request: OnBehalfTokenRequest): void;
  /** Tests only: forget every cached token. */
  clear(): void;
}

export function createOnBehalfClient(config: OnBehalfClientConfig): OnBehalfClient {
  const doFetch: FetchLike = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = config.now ?? Date.now;
  const refreshBeforeMs = config.refreshBeforeMs ?? 60_000;
  const timeoutMs = config.timeoutMs ?? 5_000;
  const maxEntries = config.maxEntries ?? 1_000;
  const cache = new Map<string, { token: string; expiresAtMs: number }>();
  const pending = new Map<string, Promise<string>>();

  function bodyOf(request: OnBehalfTokenRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { audience: request.audience, organisationId: request.organisationId };
    if (request.userId) body["userId"] = request.userId;
    if (request.agent) {
      const agent: Record<string, unknown> = { id: request.agent.id, level: request.agent.level };
      if (request.agent.ownerUserId) agent["ownerUserId"] = request.agent.ownerUserId;
      if (request.agent.collectionId) agent["collectionId"] = request.agent.collectionId;
      body["agent"] = agent;
    }
    return body;
  }

  async function issue(key: string, body: Record<string, unknown>): Promise<string> {
    let response: Response;
    try {
      response = await doFetch(`${config.platformApiUrl.replace(/\/+$/, "")}/api/on-behalf/token`, {
        method: "POST",
        headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new OnBehalfError("NETWORK", 0, "The platform did not answer the token request.");
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = isRecord(parsed) && isRecord(parsed["error"]) ? parsed["error"] : {};
      const code = typeof error["code"] === "string" ? error["code"] : `HTTP_${response.status}`;
      const message = typeof error["message"] === "string" ? error["message"] : "The platform refused the token request.";
      throw new OnBehalfError(code, response.status, message);
    }
    const data = isRecord(parsed) && parsed["success"] === true && isRecord(parsed["data"]) ? parsed["data"] : null;
    const token = data ? data["token"] : undefined;
    const expiresAtMs = data && typeof data["expiresAt"] === "string" ? Date.parse(data["expiresAt"]) : NaN;
    if (typeof token !== "string" || token === "" || !Number.isFinite(expiresAtMs)) {
      throw new OnBehalfError("BAD_RESPONSE", response.status, "The platform answered the token request with a body this build cannot read.");
    }
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { token, expiresAtMs });
    return token;
  }

  return {
    getToken(request: OnBehalfTokenRequest): Promise<string> {
      const body = bodyOf(request);
      const key = JSON.stringify(body);
      const hit = cache.get(key);
      if (hit && hit.expiresAtMs - now() > refreshBeforeMs) return Promise.resolve(hit.token);
      const running = pending.get(key);
      if (running) return running;
      const started = issue(key, body).finally(() => {
        pending.delete(key);
      });
      pending.set(key, started);
      return started;
    },
    forget(request: OnBehalfTokenRequest): void {
      cache.delete(JSON.stringify(bodyOf(request)));
    },
    clear(): void {
      cache.clear();
    },
  };
}
