import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { JWKS_URL, PLATFORM, TEST_ISSUER, keyDocument, signToken } from "../support/on-behalf";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
  const apiKey = { findUnique: vi.fn(), update: vi.fn() };
  const note = { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() };
  const organisation = { upsert: vi.fn() };
  return { apiKey, note, organisation, dbMock: { apiKey, note, organisation } };
});
vi.mock("@/lib/db", () => ({ db: h.dbMock }));

import { GET as describeRoute } from "@/app/api/mcp/describe/route";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { GET as listNotesRoute, POST as createNoteRoute } from "@/app/api/v1/notes/route";
import { requireApiKey } from "@/lib/api-auth";
import { ApiError } from "@/lib/api-errors";
import { hashApiKey } from "@/lib/api-keys";
import { OBO_REQUESTS_PER_MINUTE, __resetOboDoorForTests } from "@/lib/tool-door/obo-door";
import { __resetReleaseGateForTests } from "@/lib/tool-door/release-gate";
import { __clearAccessCacheForTests, workerAccessContext } from "@/lib/platform/access";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

/**
 * The token path through the Lab's one machine entry `requireApiKey`, the
 * release gate on the key path, and the two door routes (connection layer
 * contract, stage 6, 2.4, 2.6, 2.7).
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const COL = "55555555-5555-4555-8555-555555555555";
const AUD = "examplelab";

interface PersonAnswer {
  productRole?: "user" | "product_admin" | null;
  revokedAt?: string | null;
  memberActive?: boolean | null;
  status?: number;
}

let persons: Record<string, PersonAnswer>;
let released: () => Response;
let calls: { url: string; headers: Record<string, string>; body?: string; method?: string }[];

function personBody(userId: string, answer: PersonAnswer) {
  return {
    success: true,
    data: {
      userId,
      organisationId: ORG,
      email: null,
      orgRole: null,
      revokedAt: answer.revokedAt ?? null,
      memberActive: answer.memberActive === undefined ? true : answer.memberActive,
      collections: [{ id: "c-sales", name: "Sales", isOwner: false }],
      settings: { membersMayShareOrg: true, membersMayCreateCollections: true },
      product: {
        key: AUD,
        productRole: answer.productRole === undefined ? "user" : answer.productRole,
        governed: true,
        accessMode: "assigned",
        personalAllowed: true,
      },
      grantedLevels: {},
    },
  };
}

function fakeFetch() {
  return vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
    });
    if (input === JWKS_URL) return Response.json(keyDocument());
    const person = /\/api\/access\/orgs\/([^/]+)\/users\/([^/]+)\/context\?product=examplelab$/.exec(input);
    if (person) {
      const answer = persons[decodeURIComponent(person[2])];
      if (!answer) return Response.json({ success: false, error: { code: "NOT_FOUND" } }, { status: 404 });
      if (answer.status && answer.status !== 200) return Response.json({ success: false }, { status: answer.status });
      return Response.json(personBody(decodeURIComponent(person[2]), answer));
    }
    if (input.startsWith(`${PLATFORM}/api/registry/released`)) return released();
    if (input.startsWith("http://127.0.0.1:3390/api/v1/notes")) return Response.json({ data: [] });
    throw new Error(`unexpected fetch ${input}`);
  });
}

function req(path: string, headers: Record<string, string>, init: { method?: string; body?: unknown } = {}) {
  return new NextRequest(`http://lab.test${path}`, {
    method: init.method ?? "GET",
    headers: { ...headers, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

const personCalls = () => calls.filter((c) => c.url.includes("/api/access/orgs/"));
const releaseCalls = () => calls.filter((c) => c.url.includes("/api/registry/released"));

beforeEach(() => {
  vi.clearAllMocks();
  persons = { [USER]: {}, [OWNER]: {} };
  released = () =>
    Response.json({
      success: true,
      data: { organisationId: ORG, product: AUD, kind: "lab", organisationStatus: "active", released: true },
    });
  calls = [];
  vi.stubEnv("PLATFORM_API_URL", PLATFORM);
  vi.stubEnv("PLATFORM_API_KEY", "examplelab-service-key");
  vi.stubEnv("ON_BEHALF_ISSUER", TEST_ISSUER);
  // A Suite address makes this a "server": no local fallback, the gate applies.
  vi.stubEnv("NEXT_PUBLIC_PLATFORM_URL", "https://suite.test");
  vi.stubEnv("JWT_SECRET", "");
  vi.stubEnv("ALLOW_LOCAL_JWT", "");
  vi.stubEnv("MCP_SELF_BASE_URL", "");
  vi.stubEnv("PORT", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://examplelab-staging.beyondles.ai");
  // These tests pin the shared tool door's own token limit (1200); the Lab's
  // limit (src/lib/rate-limit.ts) is switched off here and tested on its own.
  vi.stubEnv("ON_BEHALF_RATE_LIMIT_PER_MINUTE", "0");
  vi.stubGlobal("fetch", fakeFetch());
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.organisation.upsert.mockResolvedValue({});
  h.apiKey.update.mockResolvedValue({});
  h.note.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "n-new", ...data }));
  h.note.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetOboDoorForTests();
  __resetReleaseGateForTests();
  __clearAccessCacheForTests();
  __resetRateLimitForTests();
});

describe("requireApiKey: the token path (2.4)", () => {
  it("a person token (no agent) gets the person's view, checked at the platform", async () => {
    const token = signToken({ aud: AUD, org: ORG, sub: USER, role: "admin", cp: "bookinglab", jti: "aaaaaaaa-aaaa-4aaa-8aaa-000000000101" });
    const key = await requireApiKey(req("/api/v1/notes", bearer(token)));
    expect(key).toMatchObject({
      organisationId: ORG,
      keyId: "obo:aaaaaaaa-aaaa-4aaa-8aaa-000000000101",
      keyName: "bookinglab",
      createdByUserId: USER,
      kind: "user",
      via: "on-behalf",
      onBehalf: { callingProduct: "bookinglab", userId: USER, role: "admin", agent: null, tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000101" },
    });
    expect(key.access).toMatchObject({ userId: USER, organisationId: ORG, productRole: "user", collections: [{ id: "c-sales" }] });
    expect(personCalls()).toHaveLength(1);
    expect(personCalls()[0].headers["X-API-Key"]).toBe("examplelab-service-key");
    // Tokens are never checked against the release state (D6.3).
    expect(releaseCalls()).toHaveLength(0);
  });

  it("an organisation agent gets the worker view (workerAccessContext), no person asked", async () => {
    const token = signToken({ aud: AUD, org: ORG, agt: { id: "a-1", level: "organisation" } });
    const key = await requireApiKey(req("/api/v1/notes", bearer(token)));
    expect(key.access).toEqual(workerAccessContext(ORG));
    expect(key).toMatchObject({ kind: "worker", createdByUserId: null, via: "on-behalf" });
    expect(personCalls()).toHaveLength(0);
  });

  it("an organisation agent next to a person still gets the worker view, and the person is checked", async () => {
    const token = signToken({ aud: AUD, org: ORG, sub: USER, agt: { id: "a-1", level: "organisation" } });
    const key = await requireApiKey(req("/api/v1/notes", bearer(token)));
    expect(key.access).toEqual(workerAccessContext(ORG));
    expect(personCalls()).toHaveLength(1);
  });

  it("a collection agent gets the collection-agent view", async () => {
    const token = signToken({ aud: AUD, org: ORG, agt: { id: "a-2", level: "collection", col: COL } });
    const key = await requireApiKey(req("/api/v1/notes", bearer(token)));
    expect(key.access).toMatchObject({
      userId: "",
      source: "agent",
      collections: [{ id: COL, name: COL, isOwner: false }],
      personalAllowed: false,
      membersMayShareOrg: false,
      membersMayCreateCollections: false,
      orgRole: "member",
      productRole: "user",
    });
    expect(key.kind).toBe("worker");
  });

  it("a private agent gets its owner's view; owner and sub are both checked", async () => {
    const alone = signToken({ aud: AUD, org: ORG, agt: { id: "a-3", level: "private", owner: OWNER } });
    const key = await requireApiKey(req("/api/v1/notes", bearer(alone)));
    expect(key.access.userId).toBe(OWNER);
    expect(key.createdByUserId).toBe(OWNER);
    expect(personCalls().map((c) => c.url)).toEqual([
      `${PLATFORM}/api/access/orgs/${ORG}/users/${OWNER}/context?product=examplelab`,
    ]);

    __clearAccessCacheForTests();
    calls = [];
    const withSub = signToken({ aud: AUD, org: ORG, sub: USER, agt: { id: "a-3", level: "private", owner: OWNER } });
    const both = await requireApiKey(req("/api/v1/notes", bearer(withSub)));
    expect(both.access.userId).toBe(OWNER);
    expect(personCalls()).toHaveLength(2);

    persons[USER] = { memberActive: false };
    __clearAccessCacheForTests();
    const refused = await refusal(requireApiKey(req("/api/v1/notes", bearer(withSub))));
    expect(refused.status).toBe(401);
  });

  it("neither agent nor person: the worker view", async () => {
    const token = signToken({ aud: AUD, org: ORG });
    const key = await requireApiKey(req("/api/v1/notes", bearer(token)));
    expect(key.access).toEqual(workerAccessContext(ORG));
    expect(personCalls()).toHaveLength(0);
  });

  it("the floor is compared per token, in both orders, on one cached answer", async () => {
    const now = Math.floor(Date.now() / 1000);
    persons[USER] = { revokedAt: new Date((now - 10) * 1000).toISOString() };

    const older = signToken({ aud: AUD, org: ORG, sub: USER, iat: now - 20 });
    const newer = signToken({ aud: AUD, org: ORG, sub: USER, iat: now - 5 });

    const refused = await refusal(requireApiKey(req("/api/v1/notes", bearer(older))));
    expect(refused.status).toBe(401);
    expect(refused.code).toBe("unauthorized");
    expect(refused.headers["WWW-Authenticate"]).toBe('Bearer error="invalid_token"');
    expect((await requireApiKey(req("/api/v1/notes", bearer(newer)))).access.userId).toBe(USER);
    // The answer is cached, never the verdict: the older token is still refused afterwards.
    expect((await refusal(requireApiKey(req("/api/v1/notes", bearer(older))))).status).toBe(401);
    expect(personCalls()).toHaveLength(1);
  });

  it("memberActive false: 401 person_gone", async () => {
    persons[USER] = { memberActive: false };
    const refused = await refusal(requireApiKey(req("/api/v1/notes", bearer(signToken({ aud: AUD, org: ORG, sub: USER })))));
    expect(refused).toMatchObject({ status: 401, code: "person_gone" });
  });

  it("no product access: 403 no_product_access", async () => {
    persons[USER] = { productRole: null };
    const refused = await refusal(requireApiKey(req("/api/v1/notes", bearer(signToken({ aud: AUD, org: ORG, sub: USER })))));
    expect(refused).toMatchObject({ status: 403, code: "no_product_access" });
  });

  it("person answer 404 or 403: 403 no_product_access, not a retryable 503", async () => {
    const token = signToken({ aud: AUD, org: ORG, sub: USER });
    persons[USER] = { status: 404 };
    expect(await refusal(requireApiKey(req("/api/v1/notes", bearer(token))))).toMatchObject({
      status: 403,
      code: "no_product_access",
    });
    __clearAccessCacheForTests();
    persons[USER] = { status: 403 };
    expect(await refusal(requireApiKey(req("/api/v1/notes", bearer(token))))).toMatchObject({
      status: 403,
      code: "no_product_access",
    });
    // Test changed because it pinned "a person-level 403/404 is not cached" (#339): the shared client
    // caches a clear refusal for 60 s, like every clear answer (never a failure, see the 5xx case).
    // After the cache is dropped the next answer counts.
    __clearAccessCacheForTests();
    persons[USER] = {};
    expect((await requireApiKey(req("/api/v1/notes", bearer(token)))).access.userId).toBe(USER);
    expect(personCalls()).toHaveLength(3);
  });

  it("platform unreachable or 5xx: 503, and the failure is not cached", async () => {
    persons[USER] = { status: 502 };
    const token = signToken({ aud: AUD, org: ORG, sub: USER });
    expect(await refusal(requireApiKey(req("/api/v1/notes", bearer(token))))).toMatchObject({
      status: 503,
      code: "token_check_unavailable",
    });
    persons[USER] = {};
    expect((await requireApiKey(req("/api/v1/notes", bearer(token)))).access.userId).toBe(USER);
    expect(personCalls()).toHaveLength(2);
  });

  it("a refused token answers 401 with the challenge", async () => {
    const refused = await refusal(requireApiKey(req("/api/v1/notes", bearer(signToken({ aud: "bookinglab", org: ORG, sub: USER })))));
    expect(refused).toMatchObject({ status: 401, code: "unauthorized" });
    expect(refused.headers["WWW-Authenticate"]).toBe('Bearer error="invalid_token"');
  });

  it("token and x-api-key together: 400 ambiguous_credential", async () => {
    const token = signToken({ aud: AUD, org: ORG, sub: USER });
    const refused = await refusal(requireApiKey(req("/api/v1/notes", { ...bearer(token), "x-api-key": "examplelab_x" })));
    expect(refused).toMatchObject({ status: 400, code: "ambiguous_credential" });
    expect(h.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it("over 1,200 requests a minute: 429 with Retry-After", async () => {
    const token = signToken({ aud: AUD, org: ORG, agt: { id: "a-1", level: "organisation" } });
    for (let i = 0; i < OBO_REQUESTS_PER_MINUTE; i += 1) await requireApiKey(req("/api/v1/notes", bearer(token)));
    const refused = await refusal(requireApiKey(req("/api/v1/notes", bearer(token))));
    expect(refused).toMatchObject({ status: 429, code: "rate_limited" });
    expect(Number(refused.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("creates the organisation row before a write, not on a read", async () => {
    const token = signToken({ aud: AUD, org: ORG, sub: USER });
    await requireApiKey(req("/api/v1/notes", bearer(token)));
    expect(h.organisation.upsert).not.toHaveBeenCalled();
    await requireApiKey(req("/api/v1/notes", bearer(token), { method: "POST", body: { title: "x" } }));
    expect(h.organisation.upsert).toHaveBeenCalledWith({
      where: { id: ORG },
      create: { id: ORG, slug: ORG, name: ORG },
      update: {},
    });
  });
});

describe("requireApiKey: configuration and the key path", () => {
  const WORKER_KEY = "examplelab_worker_secret";

  beforeEach(() => {
    h.apiKey.findUnique.mockImplementation(async ({ where }: { where: { keyHash: string } }) =>
      where.keyHash === hashApiKey(WORKER_KEY)
        ? {
            id: "k-1",
            name: "nightly",
            organisationId: ORG,
            keyHash: hashApiKey(WORKER_KEY),
            createdByUserId: null,
            kind: "WORKER",
            createdAt: new Date("2026-09-01T00:00:00Z"),
            revokedAt: null,
            lastUsedAt: null,
          }
        : null,
    );
  });

  it("without ON_BEHALF_ISSUER a token answers 503, a key still works", async () => {
    vi.stubEnv("ON_BEHALF_ISSUER", "");
    const token = signToken({ aud: AUD, org: ORG, sub: USER });
    expect(await refusal(requireApiKey(req("/api/v1/notes", bearer(token))))).toMatchObject({
      status: 503,
      code: "token_check_unavailable",
    });
    const key = await requireApiKey(req("/api/v1/notes", { "x-api-key": WORKER_KEY }));
    expect(key).toMatchObject({ via: "api-key", onBehalf: null, kind: "worker", organisationId: ORG });
  });

  it("a key passes the release gate with the Lab's own service key", async () => {
    await requireApiKey(req("/api/v1/notes", { "x-api-key": WORKER_KEY }));
    expect(releaseCalls().map((c) => c.url)).toEqual([`${PLATFORM}/api/registry/released?organisationId=${ORG}`]);
    expect(releaseCalls()[0].headers["X-API-Key"]).toBe("examplelab-service-key");
  });

  it("a key of an organisation the Lab is not released for: 403 lab_not_released", async () => {
    released = () =>
      Response.json({
        success: true,
        data: { organisationId: ORG, product: AUD, kind: "lab", organisationStatus: "active", released: false },
      });
    expect(await refusal(requireApiKey(req("/api/v1/notes", { "x-api-key": WORKER_KEY })))).toMatchObject({
      status: 403,
      code: "lab_not_released",
    });
  });

  it("an unknown key is 401 before the gate is asked", async () => {
    expect(await refusal(requireApiKey(req("/api/v1/notes", { "x-api-key": "nope" })))).toMatchObject({ status: 401 });
    expect(releaseCalls()).toHaveLength(0);
  });

  it("local mode (no Suite address): the gate is not applied", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_URL", "");
    await requireApiKey(req("/api/v1/notes", { "x-api-key": WORKER_KEY }));
    expect(releaseCalls()).toHaveLength(0);
  });
});

describe("the collection agent at /api/v1/notes", () => {
  const agentToken = () => signToken({ aud: AUD, org: ORG, agt: { id: "a-2", level: "collection", col: COL } });

  it("creates a note without visibility as COLLECTION in agt.col", async () => {
    const res = await createNoteRoute(req("/api/v1/notes", bearer(agentToken()), { method: "POST", body: { title: "Agent note" } }));
    expect(res.status).toBe(201);
    expect(h.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { organisationId: ORG, title: "Agent note", body: "", visibility: "COLLECTION", collectionId: COL, ownerUserId: "" },
      }),
    );
  });

  it("is refused when it names a visibility", async () => {
    for (const visibility of ["organisation", "private"]) {
      const res = await createNoteRoute(
        req("/api/v1/notes", bearer(agentToken()), { method: "POST", body: { title: "x", visibility } }),
      );
      expect(res.status, visibility).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }
    expect(h.note.create).not.toHaveBeenCalled();
  });

  it("lists organisation rows and its collection's rows only", async () => {
    await listNotesRoute(req("/api/v1/notes", bearer(agentToken())));
    const where = h.note.findMany.mock.calls[0][0].where.AND[0];
    expect(where).toEqual({
      organisationId: ORG,
      OR: [{ visibility: "ORGANISATION" }, { visibility: "COLLECTION", collectionId: { in: [COL] } }],
    });
  });

  it("an organisation agent lists organisation rows only (no PRIVATE row, no COLLECTION row)", async () => {
    const token = signToken({ aud: AUD, org: ORG, agt: { id: "a-1", level: "organisation" } });
    await listNotesRoute(req("/api/v1/notes", bearer(token)));
    // Test changed because it pinned the old query shape `{ organisationId, visibility }` (#339, policy P4):
    // the shared `visibilityWhere` writes the same rows as `OR: [{ visibility: "ORGANISATION" }]`.
    expect(h.note.findMany.mock.calls[0][0].where.AND[0]).toEqual({
      organisationId: ORG,
      OR: [{ visibility: "ORGANISATION" }],
    });
  });

  it("a person token without visibility still creates a private note", async () => {
    const token = signToken({ aud: AUD, org: ORG, sub: USER });
    const res = await createNoteRoute(req("/api/v1/notes", bearer(token), { method: "POST", body: { title: "Mine" } }));
    expect(res.status).toBe(201);
    expect(h.note.create.mock.calls[0][0].data).toMatchObject({ visibility: "PRIVATE", ownerUserId: USER });
  });
});

describe("POST /api/mcp", () => {
  const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });

  it("tools/list with a token carries title and annotations", async () => {
    const token = signToken({ aud: AUD, org: ORG, sub: USER });
    const res = await mcpRoute(req("/api/mcp", bearer(token), { method: "POST", body: rpc("tools/list") }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<Record<string, unknown>> } };
    expect(body.result.tools.map((t) => t.name)).toEqual([
      "examplelab_list_notes",
      "examplelab_get_note",
      "examplelab_create_note",
      "examplelab_update_note",
      "examplelab_delete_note",
    ]);
    expect(body.result.tools[0]).toMatchObject({
      title: "List notes",
      annotations: { title: "List notes", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    expect(body.result.tools.some((t) => "_meta" in t)).toBe(false);
  });

  it("tools/call forwards exactly the token to the self-call and writes the log line", async () => {
    const log = vi.mocked(console.log);
    const token = signToken({ aud: AUD, org: ORG, sub: USER, cp: "bookinglab", jti: "aaaaaaaa-aaaa-4aaa-8aaa-000000000202" });
    const res = await mcpRoute(
      req("/api/mcp", bearer(token), { method: "POST", body: rpc("tools/call", { name: "examplelab_list_notes", arguments: {} }) }),
    );
    expect(res.status).toBe(200);
    const self = calls.find((c) => c.url.startsWith("http://127.0.0.1:3390/api/v1/notes"));
    expect(self?.headers).toEqual({ authorization: `Bearer ${token}` });
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(
      `[tool-door] via=on-behalf cp=bookinglab org=${ORG} sub=${USER} agent=- tool=examplelab_list_notes outcome=ok jti=aaaaaaaa-aaaa-4aaa-8aaa-000000000202`,
    );
  });

  it("maps refusals to the JSON-RPC codes of the contract", async () => {
    const token = signToken({ aud: AUD, org: ORG, sub: USER });
    const ambiguous = await mcpRoute(req("/api/mcp", { ...bearer(token), "x-api-key": "k" }, { method: "POST", body: rpc("tools/list") }));
    expect(ambiguous.status).toBe(400);
    expect(((await ambiguous.json()) as { error: { code: number } }).error.code).toBe(-32600);

    const wrong = await mcpRoute(
      req("/api/mcp", bearer(signToken({ aud: "bookinglab", org: ORG })), { method: "POST", body: rpc("tools/list") }),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    expect(((await wrong.json()) as { error: { code: number } }).error.code).toBe(-32001);

    persons[USER] = { productRole: null };
    const forbidden = await mcpRoute(req("/api/mcp", bearer(token), { method: "POST", body: rpc("tools/list") }));
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: { code: number } }).error.code).toBe(-32002);

    vi.stubEnv("ON_BEHALF_ISSUER", "");
    const unconfigured = await mcpRoute(req("/api/mcp", bearer(token), { method: "POST", body: rpc("tools/list") }));
    expect(unconfigured.status).toBe(503);
    expect(((await unconfigured.json()) as { error: { code: number } }).error.code).toBe(-32003);
  });

  it("answers 429 with -32029 and Retry-After", async () => {
    const token = signToken({ aud: AUD, org: ORG, agt: { id: "a-1", level: "organisation" } });
    for (let i = 0; i < OBO_REQUESTS_PER_MINUTE; i += 1) await requireApiKey(req("/api/v1/notes", bearer(token)));
    const res = await mcpRoute(req("/api/mcp", bearer(token), { method: "POST", body: rpc("tools/list") }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32029);
  });
});

describe("GET /api/mcp/describe", () => {
  it("describes the catalogue for a token", async () => {
    const res = await describeRoute(req("/api/mcp/describe", bearer(signToken({ aud: AUD, org: ORG, sub: USER }))));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown> & { tools: Array<Record<string, unknown>> };
    expect(body).toMatchObject({
      product: "examplelab",
      name: "ExampleLab",
      version: "1.0.0",
      protocol: "mcp",
      toolDoorUrl: "https://examplelab-staging.beyondles.ai/api/mcp",
      toolPrefix: "examplelab_",
    });
    expect(body.tools.map((t) => [t.name, t.access, t.idempotent, t.capability, t.available])).toEqual([
      ["examplelab_list_notes", "read", true, null, true],
      ["examplelab_get_note", "read", true, null, true],
      ["examplelab_create_note", "write", false, null, true],
      ["examplelab_update_note", "write", true, null, true],
      ["examplelab_delete_note", "destructive", false, null, true],
    ]);
    expect(body.tools[2].title).toEqual({ de: "Notiz anlegen", en: "Create a note" });
  });

  it("refuses like /api/mcp, as plain JSON in the Lab's envelope", async () => {
    const res = await describeRoute(req("/api/mcp/describe", bearer(signToken({ aud: "leadlab", org: ORG }))));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "The on-behalf token is not valid for this service." },
    });
    const none = await describeRoute(req("/api/mcp/describe", {}));
    expect(none.status).toBe(401);
  });
});
