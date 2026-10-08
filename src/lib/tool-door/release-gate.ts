/**
 * The release gate for a Lab's machine keys (connection layer contract, stage 6, 2.6).
 *
 * A Lab answers a machine key only for organisations it is released for in the Beyondles Suite
 * (the Lab is enabled, or the organisation has an exception). The Lab asks the platform, which
 * reads the Suite's answer:
 *   `GET <PLATFORM_API_URL>/api/registry/released?organisationId=<org>` with `X-API-Key`.
 * The product asked about is always the caller's own (the platform takes it from the key).
 *
 * Verdicts:
 *  - local or CI mode: not applied;
 *  - `PLATFORM_API_URL` or `PLATFORM_API_KEY` missing: `503 release_check_unavailable`;
 *  - `released: true`: ok, cached 60 seconds, remembered as "last good" for 15 minutes;
 *  - `released: false`: `403 lab_not_released`, cached 60 seconds;
 *  - a platform or Suite of the time before stage 6 (the platform's own `404 NOT_FOUND` body, or
 *    `503 MEMBERSHIP_SOURCE_OUTDATED`): not applied, logged once per process and reason;
 *  - anything else (network, another `404`, `5xx`, `401`, `403`): the last good `released: true`
 *    of this organisation within 15 minutes, otherwise `503 release_check_unavailable`. Never
 *    cached.
 *
 * On-behalf tokens are not checked here: the platform refuses to issue a token for a Lab that is
 * not released (`AUDIENCE_NOT_RELEASED`).
 *
 * THIS FILE IS COPIED VERBATIM into every Lab from the template `beyondles-lab`. Node runtime only.
 */

export type ReleaseVerdict =
  | { ok: true; applied: boolean }
  | { ok: false; status: 403 | 503; code: "lab_not_released" | "release_check_unavailable"; message: string };

export const RELEASE_CACHE_MS = 60_000;
export const RELEASE_GRACE_MS = 15 * 60_000;

const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_MAX = 5_000;

const NOT_RELEASED_MESSAGE = "This Lab is not released for your organisation in the Beyondles Suite.";
const UNAVAILABLE_MESSAGE = "The release of this Lab for your organisation could not be checked right now; try again later.";

const cache = new Map<string, { released: boolean; validUntil: number }>();
const lastGood = new Map<string, number>();
const notAppliedLogged = new Set<string>();

function notReleased(): ReleaseVerdict {
  return { ok: false, status: 403, code: "lab_not_released", message: NOT_RELEASED_MESSAGE };
}

function unavailable(message: string = UNAVAILABLE_MESSAGE): ReleaseVerdict {
  return { ok: false, status: 503, code: "release_check_unavailable", message };
}

function bounded<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key) && map.size >= CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function notApplied(reason: string): ReleaseVerdict {
  if (!notAppliedLogged.has(reason)) {
    notAppliedLogged.add(reason);
    console.warn(`[release-gate] not applied: ${reason}`);
  }
  return { ok: true, applied: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCodeOf(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return typeof body.error.code === "string" ? body.error.code : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function checkLabReleased(
  organisationId: string,
  options: { localMode: boolean; fetchImpl?: typeof fetch; now?: () => number },
): Promise<ReleaseVerdict> {
  if (options.localMode) return { ok: true, applied: false };

  const baseUrl = (process.env.PLATFORM_API_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.PLATFORM_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey) {
    return unavailable("The release check is not configured on this server (PLATFORM_API_URL or PLATFORM_API_KEY is missing).");
  }

  const now = options.now ?? Date.now;
  const key = organisationId.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.validUntil > now()) return hit.released ? { ok: true, applied: true } : notReleased();
  if (hit) cache.delete(key);

  const outage = (): ReleaseVerdict => {
    const good = lastGood.get(key);
    if (good !== undefined && now() - good <= RELEASE_GRACE_MS) return { ok: true, applied: true };
    return unavailable();
  };

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/api/registry/released?organisationId=${encodeURIComponent(organisationId)}`, {
      method: "GET",
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return outage();
  }

  const body = await readJson(response);

  if (response.status === 200) {
    const data = isRecord(body) && body.success === true && isRecord(body.data) ? body.data : null;
    if (!data || typeof data.released !== "boolean") return outage();
    bounded(cache, key, { released: data.released, validUntil: now() + RELEASE_CACHE_MS });
    if (data.released) {
      bounded(lastGood, key, now());
      return { ok: true, applied: true };
    }
    // A "no" ends the grace: an outage right after a switch-off must not reopen the Lab.
    lastGood.delete(key);
    return notReleased();
  }

  // The platform's own catch-all for an unknown route: a platform of the time before stage 6.
  // Any other 404 (a wrong host, a Cloudflare page, another service) is an outage.
  if (response.status === 404 && isRecord(body) && body.success === false && errorCodeOf(body) === "NOT_FOUND") {
    return notApplied("the platform has no /api/registry/released (NOT_FOUND)");
  }
  if (response.status === 503 && errorCodeOf(body) === "MEMBERSHIP_SOURCE_OUTDATED") {
    return notApplied("the Suite does not report released Labs yet (MEMBERSHIP_SOURCE_OUTDATED)");
  }
  return outage();
}

/** Tests only. */
export function __resetReleaseGateForTests(): void {
  cache.clear();
  lastGood.clear();
  notAppliedLogged.clear();
}
