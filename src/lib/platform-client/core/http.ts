/**
 * platform-client: the one place that sends a request to platform-api.
 *
 * Every call of the access layer goes through here, so the headers, the timeout and the
 * reading of the answer envelope exist once. Two forms of the same call:
 *
 *  - `platformFetch` reports what happened and never throws. The context client decides by
 *    status what an answer means and what may be cached.
 *  - `platformRequest` throws `PlatformError`. Grant and collection calls must fail loudly
 *    (CONTRACT 4.1: "grant calls always throw on failure").
 *
 * Replaces the private `call()` of every Lab's `platform/protocol.ts` and the hand-written
 * request plus envelope blocks in every `platform/access.ts`.
 *
 * Rules (API.md section 0): this file imports `types.ts` only, reads no environment, and looks
 * the global `fetch` up at the moment a request is sent.
 */

import {
  PlatformError,
  type FetchLike,
  type HttpRequestInit,
  type HttpResponseLike,
  type PlatformReply,
  type PlatformRequest,
} from "./types";

/** The sentence for a request that did not complete and whose cause carries no message. */
const UNREACHABLE = "The platform could not be reached.";

/** Marks a body that is not JSON. `undefined` cannot serve: it never comes out of `json()`. */
const NOT_JSON: unique symbol = Symbol("not-json");

/**
 * The `fetch` to send with.
 *
 * Without an injected one the global is looked up WHEN THE REQUEST IS SENT, never at import
 * time and never when a client is created: product tests stub the global after the module was
 * loaded, and a copy taken earlier would be the old one for ever.
 *
 * Never throws. Without any global `fetch` the returned function rejects, which both callers
 * below treat as a network error.
 */
export function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  return (url, init) => {
    const current = (globalThis as { fetch?: unknown }).fetch;
    if (typeof current !== "function") {
      return Promise.reject(new Error("No fetch is available in this runtime."));
    }
    return (current as FetchLike)(url, init);
  };
}

/** A JSON object: not `null`, not an array, not a primitive. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : UNREACHABLE;
}

/**
 * Sends the request. Rejects when it does not complete: refused, DNS, timeout, abort, no
 * `fetch`, or a `fetch` that throws before it returns a promise.
 */
async function send(request: PlatformRequest): Promise<HttpResponseLike> {
  const headers: Record<string, string> = { "X-API-Key": request.door.apiKey };
  // WHICH person asks. Without a token the service key alone carries the call (machine route,
  // background and system protocol lines); the header is then left out, not sent empty. A
  // token that is blank after trimming is no token (API.md section 0, rule 11).
  if (typeof request.token === "string" && request.token.trim() !== "") {
    headers.Authorization = `Bearer ${request.token}`;
  }
  headers.Accept = "application/json";

  const init: HttpRequestInit = { method: request.method, headers };
  if (request.body !== undefined && request.body !== null) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(request.body);
  }
  // An access answer must never come out of a cache between the product and the platform.
  init.cache = "no-store";
  init.signal = AbortSignal.timeout(request.timeoutMs);

  const response: unknown = await resolveFetch(request.fetch)(
    `${request.door.baseUrl}${request.path}`,
    init,
  );
  // A `fetch` that resolves to nothing gave no answer. Reading a status off it would throw
  // something that is neither a result nor a `PlatformError`.
  if (typeof response !== "object" || response === null) {
    throw new Error("The platform gave no answer.");
  }
  return response as HttpResponseLike;
}

/** The HTTP status of an answer; `0` when the answer carries none. Never a success. */
function statusOf(response: HttpResponseLike): number {
  return typeof response.status === "number" ? response.status : 0;
}

/** The parsed body, or {@link NOT_JSON}. A body that cannot be read is not an error here. */
async function readBody(response: HttpResponseLike): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return NOT_JSON;
  }
}

/** `error.code` and `error.message` of a failure envelope, each only when it is a string. */
function readError(body: unknown): { code: string | null; message: string | null } {
  const error = isJsonObject(body) ? body.error : null;
  if (!isJsonObject(error)) return { code: null, message: null };
  return {
    code: typeof error.code === "string" ? error.code : null,
    message: typeof error.message === "string" ? error.message : null,
  };
}

/**
 * One call, reported instead of thrown. Never throws.
 *
 * `data` is handed out only for a success the caller can rely on: status 2xx, a JSON body,
 * `success === true`, and `data` a JSON object. Everything else is `data: null`, and the
 * caller decides by `status` what that means.
 */
export async function platformFetch(request: PlatformRequest): Promise<PlatformReply> {
  let response: HttpResponseLike;
  try {
    response = await send(request);
  } catch (cause) {
    return { kind: "network", message: messageOf(cause) };
  }

  const status = statusOf(response);
  const body = await readBody(response);
  const error = readError(body);
  const data =
    isSuccessStatus(status) && isJsonObject(body) && body.success === true && isJsonObject(body.data)
      ? body.data
      : null;

  return {
    kind: "response",
    status,
    data,
    errorCode: error.code,
    errorMessage: error.message,
  };
}

/**
 * One call that must succeed. Returns the envelope's `data` object, `{}` when a success
 * carries none. Throws `PlatformError` and nothing else:
 *
 *  - `NETWORK` (status 0) when the request did not complete,
 *  - the platform's own `error.code` when it names one,
 *  - `HTTP_<status>` otherwise.
 */
export async function platformRequest(request: PlatformRequest): Promise<Record<string, unknown>> {
  let response: HttpResponseLike;
  try {
    response = await send(request);
  } catch (cause) {
    throw new PlatformError("NETWORK", messageOf(cause), 0);
  }

  const status = statusOf(response);
  const body = await readBody(response);

  if (body === NOT_JSON) {
    // A successful answer without a body (a delete, a 204) is a success with nothing to say.
    if (isSuccessStatus(status)) return {};
    throw new PlatformError(
      `HTTP_${status}`,
      `The platform answered ${status} without a JSON body.`,
      status,
    );
  }

  if (isJsonObject(body) && body.success === true) {
    return isJsonObject(body.data) ? body.data : {};
  }

  const error = readError(body);
  throw new PlatformError(
    error.code ?? `HTTP_${status}`,
    error.message ?? `The platform answered ${status}.`,
    status,
  );
}
