/**
 * platform-client: helpers for tests. A context factory, the bodies platform-api answers with,
 * and a scriptable stand-in for platform-api and the Suite.
 *
 * This file names no test framework and imports none, because its consumers do not all run
 * the same one. It builds plain values and one plain `fetch` function; assertions stay in the
 * test that uses them.
 *
 * Replaces: advisorlab `tests/helpers/access.ts`, the per-file `me()` / `kontextAntwort()` /
 * `antwort()` helpers in every Lab's tests, the-agent `tests/helpers/accessContext.ts`.
 * A product may keep its own.
 *
 * Imports `types.ts` only (API section 0.6).
 */

import type {
  AccessContext,
  FakeCall,
  FakePlatform,
  FakeReply,
  FetchLike,
  GrantedIds,
  HttpRequestInit,
  HttpResponseLike,
} from "./types";

/* -------------------------------------------------------------------------- contexts */

/**
 * A governed `user`: Anna, member of `org-1`, with product access and nothing shared with her.
 * `patch` is spread over it. `grantedIds` gets two empty lists per entry of `objectTypes`.
 * Every call builds fresh arrays, so two contexts never share one.
 */
export function makeAccessContext<T extends string = string>(
  patch: Partial<AccessContext<T>> = {},
  objectTypes: readonly T[] = [],
): AccessContext<T> {
  const grantedIds = {} as Record<T, GrantedIds>;
  for (const type of objectTypes) grantedIds[type] = { view: [], edit: [] };

  return {
    userId: "u-anna",
    organisationId: "org-1",
    email: "anna@example.test",
    orgRole: "member",
    productRole: "user",
    governed: true,
    accessMode: "assigned",
    mayPublish: false,
    releaseStep: null,
    collections: [],
    grantedIds,
    personalAllowed: true,
    membersMayShareOrg: true,
    membersMayCreateCollections: true,
    source: "platform",
    productRoleSource: "platform",
    ...patch,
  };
}

/* ---------------------------------------------------------------------------- bodies */

/**
 * The `data` of `GET /api/access/me?product=` as platform-api builds it (`access-context.js`).
 * `patch` is spread over the top level: a `product` in the patch replaces the whole block.
 */
export function meBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "u-anna",
    organisationId: "org-1",
    email: "anna@example.test",
    orgRole: "member",
    collections: [],
    settings: { membersMayShareOrg: true, membersMayCreateCollections: true },
    product: {
      key: "testlab",
      productRole: "user",
      mayPublish: false,
      releaseStep: null,
      accessMode: "assigned",
      personalAllowed: true,
      governed: true,
    },
    grantedObjects: {},
    grantedLevels: {},
    ...patch,
  };
}

/**
 * The `data` of the machine route `GET /api/access/orgs/:org/users/:user/context?product=`.
 * It knows neither e-mail address nor organisation role, and it carries the person's token
 * floor (`revokedAt`) and whether the Suite still holds an active membership (`memberActive`).
 */
export function machineBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...meBody(),
    email: null,
    orgRole: null,
    revokedAt: null,
    memberActive: true,
    ...patch,
  };
}

/** The platform's success envelope. */
export function envelope(data: unknown): { success: true; data: unknown } {
  return { success: true, data };
}

/** The platform's failure envelope. The message defaults to the code. */
export function errorEnvelope(
  code: string,
  message: string = code,
): { success: false; error: { code: string; message: string } } {
  return { success: false, error: { code, message } };
}

/** The part of a `fetch` response the shared code reads, with `body` as the parsed JSON. */
export function jsonResponse(body: unknown, status = 200): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/* ------------------------------------------------------------------------------ fake */

interface Route {
  match: string | RegExp;
  reply: FakeReply | ((call: FakeCall) => FakeReply);
}

function matches(match: string | RegExp, target: string): boolean {
  if (typeof match === "string") return target.includes(match);
  // A regular expression with the `g` or `y` flag remembers where it stopped; without this
  // reset it would match only every second request.
  match.lastIndex = 0;
  return match.test(target);
}

/** The request body as a test wants to read it: parsed JSON, or the raw text if it is none. */
function parseBody(body: string | undefined): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function toCall(url: string, init: HttpRequestInit | undefined): FakeCall {
  return {
    url,
    method: (init?.method ?? "GET").toUpperCase(),
    headers: { ...(init?.headers ?? {}) },
    body: parseBody(init?.body),
  };
}

/** That status with a body that is not JSON: `json()` rejects, as `Response#json` does. */
function notJsonResponse(status: number): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("fakePlatform: the body is not JSON");
    },
  };
}

function toResponse(reply: Exclude<FakeReply, "network-error">): HttpResponseLike {
  if (reply === "invalid-json") return notJsonResponse(200);

  const status = reply.status ?? 200;
  if (reply.invalidJson === true) return notJsonResponse(status);
  // `body` is sent as it is (the Suite has no envelope), also when it is `null`.
  if ("body" in reply) return jsonResponse(reply.body, status);
  if (reply.error) return jsonResponse(errorEnvelope(reply.error.code, reply.error.message), status);
  // Neither `body` nor `error`: the success envelope for a 2xx status (with whatever `data`
  // is, also nothing), and a bare failure for any other status.
  if ("data" in reply || (status >= 200 && status < 300)) {
    return jsonResponse(envelope(reply.data), status);
  }
  return jsonResponse({ success: false }, status);
}

/**
 * A scriptable stand-in for platform-api and the Suite.
 *
 *   const fake = createFakePlatform();
 *   fake.respond("/api/access/me", { data: meBody() });
 *   const client = createAccessClient({ product, door, fetch: fake.fetch });
 *
 * A request is matched against `"<METHOD> <url>"`. Of several matching replies the one
 * registered last answers. A request no reply matches is recorded and then rejects with
 * `fakePlatform: no reply for <METHOD> <url>`, so a test must declare every route it expects.
 */
export function createFakePlatform(): FakePlatform {
  const routes: Route[] = [];
  const calls: FakeCall[] = [];

  const fetch: FetchLike = async (url, init) => {
    const call = toCall(String(url), init);
    calls.push(call);

    const target = `${call.method} ${call.url}`;
    let route: Route | undefined;
    for (let index = routes.length - 1; index >= 0; index -= 1) {
      const candidate = routes[index];
      if (candidate !== undefined && matches(candidate.match, target)) {
        route = candidate;
        break;
      }
    }
    if (route === undefined) {
      throw new Error(`fakePlatform: no reply for ${target}`);
    }

    const reply = typeof route.reply === "function" ? route.reply(call) : route.reply;
    if (reply === "network-error") {
      throw new Error(`fakePlatform: network error for ${target}`);
    }
    return toResponse(reply);
  };

  return {
    fetch,
    calls,
    respond(match, reply) {
      routes.push({ match, reply });
    },
    reset() {
      // Emptied in place: a test that holds `fake.calls` keeps looking at the live list.
      routes.length = 0;
      calls.length = 0;
    },
  };
}
