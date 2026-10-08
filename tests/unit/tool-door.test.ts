import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import vectors from "../fixtures/on-behalf-vectors.json";
import { JWKS_URL, PLATFORM, TEST_ISSUER, keyDocument, signToken } from "../support/on-behalf";

import { describeToolDoor } from "@/lib/tool-door/describe";
import { logToolCall } from "@/lib/tool-door/call-log";
import { LabToolCallError, createLabToolClient } from "@/lib/tool-door/lab-client";
import {
  OBO_REQUESTS_PER_MINUTE,
  __resetOboDoorForTests,
  checkOnBehalfToken,
  oboDoorState,
  onBehalfBearer,
} from "@/lib/tool-door/obo-door";
import {
  RELEASE_CACHE_MS,
  RELEASE_GRACE_MS,
  __resetReleaseGateForTests,
  checkLabReleased,
} from "@/lib/tool-door/release-gate";

/**
 * The shared tool-door files (connection layer contract, stage 6, 2.5):
 * credential reading, token check, rate limit, release gate, describe answer,
 * call log, and the Lab-to-Lab client.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";

function request(headers: Record<string, string>): Request {
  return new Request("http://lab.test/api/mcp", { method: "POST", headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  __resetOboDoorForTests();
  __resetReleaseGateForTests();
});

describe("onBehalfBearer", () => {
  const token = signToken({ aud: "examplelab", org: ORG, sub: USER });

  it("finds an on-behalf token in Authorization", () => {
    expect(onBehalfBearer(request({ authorization: `Bearer ${token}` }))).toEqual({ token });
  });

  it("a blk_-style bearer, a Suite JWT or no header is not a token", () => {
    expect(onBehalfBearer(request({ authorization: "Bearer blk_0123456789abcdef" }))).toBeNull();
    const suiteJwt = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.e30.sig`;
    expect(onBehalfBearer(request({ authorization: `Bearer ${suiteJwt}` }))).toBeNull();
    expect(onBehalfBearer(request({ "x-api-key": "examplelab_abc" }))).toBeNull();
    expect(onBehalfBearer(request({}))).toBeNull();
  });

  it("a token next to an x-api-key is ambiguous", () => {
    expect(onBehalfBearer(request({ authorization: `Bearer ${token}`, "x-api-key": "examplelab_abc" }))).toEqual({
      ambiguous: true,
    });
  });
});

describe("oboDoorState", () => {
  it("ok only with issuer and platform address", () => {
    expect(oboDoorState({ PLATFORM_API_URL: PLATFORM, ON_BEHALF_ISSUER: TEST_ISSUER })).toBe("ok");
    expect(oboDoorState({ PLATFORM_API_URL: PLATFORM, ON_BEHALF_ISSUER: " " })).toBe("unconfigured");
    expect(oboDoorState({ PLATFORM_API_URL: "", ON_BEHALF_ISSUER: TEST_ISSUER })).toBe("unconfigured");
  });

  it("reads the process environment by default", () => {
    vi.stubEnv("PLATFORM_API_URL", PLATFORM);
    vi.stubEnv("ON_BEHALF_ISSUER", "");
    expect(oboDoorState()).toBe("unconfigured");
    vi.stubEnv("ON_BEHALF_ISSUER", TEST_ISSUER);
    expect(oboDoorState()).toBe("ok");
  });
});

describe("checkOnBehalfToken", () => {
  let jwksCalls = 0;
  let jwksUp = true;

  beforeEach(() => {
    jwksCalls = 0;
    jwksUp = true;
    vi.stubEnv("PLATFORM_API_URL", PLATFORM);
    vi.stubEnv("ON_BEHALF_ISSUER", TEST_ISSUER);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input === JWKS_URL) {
          jwksCalls += 1;
          if (!jwksUp) throw new Error("ECONNREFUSED");
          return Response.json(keyDocument());
        }
        throw new Error(`unexpected fetch ${input}`);
      }),
    );
  });

  it("accepts a token for this audience and returns its claims", async () => {
    const token = signToken({ aud: "examplelab", org: ORG, sub: USER, cp: "leadlab" });
    const check = await checkOnBehalfToken(token, "examplelab");
    expect(check).toMatchObject({ ok: true, claims: { aud: "examplelab", cp: "leadlab", org: ORG, sub: USER } });
    expect(jwksCalls).toBe(1);
  });

  it("answers 503 without configuration, before anything is fetched", async () => {
    vi.stubEnv("ON_BEHALF_ISSUER", "");
    const check = await checkOnBehalfToken(signToken({ aud: "examplelab", org: ORG }), "examplelab");
    expect(check).toMatchObject({ ok: false, status: 503, code: "token_check_unavailable" });
    expect(jwksCalls).toBe(0);
  });

  it("answers 503 when the platform's keys cannot be fetched", async () => {
    jwksUp = false;
    const check = await checkOnBehalfToken(signToken({ aud: "examplelab", org: ORG }), "examplelab");
    expect(check).toMatchObject({ ok: false, status: 503, code: "token_check_unavailable" });
  });

  it("refuses another audience with 401 and one log line per reason and minute", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const foreign = signToken({ aud: "bookinglab", org: ORG, sub: USER });
    const first = await checkOnBehalfToken(foreign, "examplelab");
    const second = await checkOnBehalfToken(foreign, "examplelab");
    expect(first).toEqual({
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "The on-behalf token is not valid for this service.",
    });
    expect(second).toEqual(first);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(["[on-behalf] refused reason=wrong_audience"]);
  });

  it("refuses an expired token and a token of another issuer with the same answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const expired = signToken({ aud: "examplelab", org: ORG, iat: Math.floor(Date.now() / 1000) - 3600 });
    const otherIssuer = signToken({ aud: "examplelab", org: ORG, iss: "beyondles-platform:other" });
    expect(await checkOnBehalfToken(expired, "examplelab")).toMatchObject({ ok: false, status: 401 });
    expect(await checkOnBehalfToken(otherIssuer, "examplelab")).toMatchObject({ ok: false, status: 401 });
    expect(await checkOnBehalfToken(vectors.tokens.VALID, "examplelab")).toMatchObject({ ok: false, status: 401 });
  });

  it("builds one verifier per audience", async () => {
    await checkOnBehalfToken(signToken({ aud: "examplelab", org: ORG }), "examplelab");
    await checkOnBehalfToken(signToken({ aud: "examplelab", org: ORG }), "examplelab");
    await checkOnBehalfToken(signToken({ aud: "otherlab", org: ORG }), "otherlab");
    expect(jwksCalls).toBe(2);
  });

  it("limits 1,200 requests per minute per calling product and organisation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T10:00:00Z"));
    const token = signToken({ aud: "examplelab", org: ORG, cp: "leadlab" });
    for (let i = 0; i < OBO_REQUESTS_PER_MINUTE; i += 1) {
      expect((await checkOnBehalfToken(token, "examplelab")).ok).toBe(true);
    }
    const over = await checkOnBehalfToken(token, "examplelab");
    expect(over).toMatchObject({ ok: false, status: 429, code: "rate_limited", retryAfterSeconds: 60 });

    // Another calling product for the same organisation has its own window.
    const other = signToken({ aud: "examplelab", org: ORG, cp: "horaizon" });
    expect((await checkOnBehalfToken(other, "examplelab")).ok).toBe(true);

    vi.setSystemTime(new Date("2026-10-03T10:01:00Z"));
    const fresh = signToken({ aud: "examplelab", org: ORG, cp: "leadlab" });
    expect((await checkOnBehalfToken(fresh, "examplelab")).ok).toBe(true);
  });
});

describe("checkLabReleased", () => {
  const RELEASED_URL = `${PLATFORM}/api/registry/released?organisationId=${ORG}`;

  function platform(answers: Array<() => Response | Promise<Response>>) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, headers: init?.headers as Record<string, string> });
      const next = answers.shift();
      if (!next) throw new Error("no more answers");
      return next();
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const released = (value: boolean) => () =>
    Response.json({
      success: true,
      data: { organisationId: ORG, product: "examplelab", kind: "lab", organisationStatus: "active", released: value },
    });

  beforeEach(() => {
    vi.stubEnv("PLATFORM_API_URL", `${PLATFORM}/`);
    vi.stubEnv("PLATFORM_API_KEY", "examplelab-service-key");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("local mode: not applied, nothing asked", async () => {
    const { calls, fetchImpl } = platform([]);
    expect(await checkLabReleased(ORG, { localMode: true, fetchImpl })).toEqual({ ok: true, applied: false });
    expect(calls).toHaveLength(0);
  });

  it("without address or key: 503 release_check_unavailable", async () => {
    vi.stubEnv("PLATFORM_API_KEY", "");
    const { fetchImpl } = platform([]);
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl })).toMatchObject({
      ok: false,
      status: 503,
      code: "release_check_unavailable",
    });
  });

  it("released: ok, asked with the Lab's own key, cached 60 seconds", async () => {
    let now = 1_000_000;
    const { calls, fetchImpl } = platform([released(true), released(true)]);
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl, now: () => now })).toEqual({
      ok: true,
      applied: true,
    });
    expect(calls[0].url).toBe(RELEASED_URL);
    expect(calls[0].headers["X-API-Key"]).toBe("examplelab-service-key");
    now += RELEASE_CACHE_MS - 1;
    await checkLabReleased(ORG, { localMode: false, fetchImpl, now: () => now });
    expect(calls).toHaveLength(1);
    now += 2;
    await checkLabReleased(ORG, { localMode: false, fetchImpl, now: () => now });
    expect(calls).toHaveLength(2);
  });

  it("not released: 403 lab_not_released, cached 60 seconds", async () => {
    const now = 1_000_000;
    const { calls, fetchImpl } = platform([released(false)]);
    const verdict = await checkLabReleased(ORG, { localMode: false, fetchImpl, now: () => now });
    expect(verdict).toEqual({
      ok: false,
      status: 403,
      code: "lab_not_released",
      message: "This Lab is not released for your organisation in the Beyondles Suite.",
    });
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl, now: () => now })).toEqual(verdict);
    expect(calls).toHaveLength(1);
  });

  it("the platform's own 404 NOT_FOUND (no such route yet): not applied, logged once", async () => {
    const warn = vi.mocked(console.warn);
    const notFound = () =>
      Response.json({ success: false, error: { code: "NOT_FOUND", message: "Route not found" } }, { status: 404 });
    const { fetchImpl } = platform([notFound, notFound]);
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl })).toEqual({ ok: true, applied: false });
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl })).toEqual({ ok: true, applied: false });
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith("[release-gate] not applied:"))).toHaveLength(1);
  });

  it("503 MEMBERSHIP_SOURCE_OUTDATED: not applied", async () => {
    const { fetchImpl } = platform([
      () =>
        Response.json(
          { success: false, error: { code: "MEMBERSHIP_SOURCE_OUTDATED", message: "…" } },
          { status: 503 },
        ),
    ]);
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl })).toEqual({ ok: true, applied: false });
  });

  it("a 404 with an HTML body or another JSON body is an outage, not 'not applied'", async () => {
    const html = () => new Response("<html>Cloudflare</html>", { status: 404, headers: { "content-type": "text/html" } });
    const otherJson = () => Response.json({ error: "not here" }, { status: 404 });
    const otherCode = () => Response.json({ success: false, error: { code: "PRODUCT_UNKNOWN" } }, { status: 404 });
    for (const answer of [html, otherJson, otherCode]) {
      __resetReleaseGateForTests();
      const { fetchImpl } = platform([answer]);
      expect(await checkLabReleased(ORG, { localMode: false, fetchImpl })).toMatchObject({
        ok: false,
        status: 503,
        code: "release_check_unavailable",
      });
    }
  });

  it("an outage within 15 minutes of the last 'released' passes, after that it does not", async () => {
    let now = 1_000_000;
    const down = () => {
      throw new Error("ECONNREFUSED");
    };
    const fiveHundred = () => Response.json({ success: false, error: { code: "INTERNAL" } }, { status: 500 });
    const { calls, fetchImpl } = platform([released(true), down, fiveHundred, down]);
    const at = () => now;
    expect((await checkLabReleased(ORG, { localMode: false, fetchImpl, now: at })).ok).toBe(true);

    now += RELEASE_CACHE_MS + 1;
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl, now: at })).toEqual({ ok: true, applied: true });
    // Outages are never cached: the next request asks again.
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl, now: at })).toEqual({ ok: true, applied: true });
    expect(calls).toHaveLength(3);

    now = 1_000_000 + RELEASE_GRACE_MS + 1;
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl, now: at })).toMatchObject({
      ok: false,
      status: 503,
      code: "release_check_unavailable",
    });
  });

  it("an outage without any earlier 'released' is 503", async () => {
    const { fetchImpl } = platform([() => Response.json({}, { status: 401 })]);
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl })).toMatchObject({ ok: false, status: 503 });
  });

  it("a 'not released' ends the grace of an earlier 'released'", async () => {
    let now = 1_000_000;
    const down = () => {
      throw new Error("ECONNREFUSED");
    };
    const { fetchImpl } = platform([released(true), released(false), down]);
    const at = () => now;
    await checkLabReleased(ORG, { localMode: false, fetchImpl, now: at });
    now += RELEASE_CACHE_MS + 1;
    expect((await checkLabReleased(ORG, { localMode: false, fetchImpl, now: at })).ok).toBe(false);
    now += RELEASE_CACHE_MS + 1;
    expect(await checkLabReleased(ORG, { localMode: false, fetchImpl, now: at })).toMatchObject({ status: 503 });
  });
});

describe("describeToolDoor", () => {
  it("lists the tools in catalogue order with markers, availability and the door address", () => {
    const description = describeToolDoor({
      product: "examplelab",
      name: "ExampleLab",
      version: "1.0.0",
      toolPrefix: "examplelab_",
      appUrl: "https://examplelab-staging.beyondles.ai/",
      tools: [
        {
          name: "examplelab_list_notes",
          description: "List.",
          inputSchema: { type: "object", properties: {} },
          access: "read",
          idempotent: true,
          title: { de: "Notizen auflisten", en: "List notes" },
        },
        {
          name: "examplelab_send",
          description: "Send.",
          inputSchema: { type: "object", properties: {} },
          access: "destructive",
          idempotent: false,
          title: { de: "Senden", en: "Send" },
          capability: "mail.send",
          scopes: ["write", "notes:delete"],
        },
      ],
      isAvailable: (name) => name !== "examplelab_send",
    });
    expect(description).toEqual({
      product: "examplelab",
      name: "ExampleLab",
      version: "1.0.0",
      protocol: "mcp",
      toolDoorUrl: "https://examplelab-staging.beyondles.ai/api/mcp",
      toolPrefix: "examplelab_",
      tools: [
        {
          name: "examplelab_list_notes",
          title: { de: "Notizen auflisten", en: "List notes" },
          description: "List.",
          access: "read",
          idempotent: true,
          capability: null,
          available: true,
          scopes: [],
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "examplelab_send",
          title: { de: "Senden", en: "Send" },
          description: "Send.",
          access: "destructive",
          idempotent: false,
          capability: "mail.send",
          available: false,
          scopes: ["write", "notes:delete"],
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  });

  it("toolDoorUrl is null without an app address", () => {
    const base = { product: "x", name: "X", version: "1", toolPrefix: "xx_", tools: [], isAvailable: () => true };
    expect(describeToolDoor({ ...base, appUrl: null }).toolDoorUrl).toBeNull();
    expect(describeToolDoor({ ...base, appUrl: "  " }).toolDoorUrl).toBeNull();
  });
});

describe("logToolCall", () => {
  it("writes one line without arguments or results", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logToolCall({
      via: "on-behalf",
      callingProduct: "bookinglab",
      organisationId: ORG,
      userId: USER,
      agentLevel: "private",
      tool: "examplelab_list_notes",
      outcome: "ok",
      tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    });
    logToolCall({
      via: "api-key",
      callingProduct: null,
      organisationId: ORG,
      userId: null,
      agentLevel: null,
      tool: "examplelab_get_note",
      outcome: "error",
      tokenId: null,
    });
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      `[tool-door] via=on-behalf cp=bookinglab org=${ORG} sub=${USER} agent=private tool=examplelab_list_notes outcome=ok jti=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1`,
      `[tool-door] via=api-key cp=- org=${ORG} sub=- agent=- tool=examplelab_get_note outcome=error jti=-`,
    ]);
  });
});

describe("createLabToolClient", () => {
  const DOOR = "https://bookinglab-staging.beyondles.ai/api/mcp";

  function fakePlatform(doorAnswers: Array<() => Response>) {
    const seen: { url: string; init?: RequestInit }[] = [];
    let issued = 0;
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      seen.push({ url: input, init });
      if (input === `${PLATFORM}/api/registry/products`) {
        return Response.json({
          success: true,
          data: {
            products: [
              { key: "bookinglab", kind: "lab", toolDoorUrl: DOOR },
              { key: "suite", kind: "core", toolDoorUrl: null },
            ],
          },
        });
      }
      if (input === `${PLATFORM}/api/on-behalf/token`) {
        issued += 1;
        return Response.json({
          success: true,
          data: { token: `token-${issued}`, tokenType: "Bearer", expiresAt: new Date(Date.now() + 300_000).toISOString() },
        });
      }
      if (input === DOOR) {
        const next = doorAnswers.shift();
        if (!next) throw new Error("no door answer left");
        return next();
      }
      throw new Error(`unexpected fetch ${input}`);
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  const ok = () =>
    Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[]" }] } });

  it("finds the door in the registry, gets a token with the Lab's own key and posts one tools/call", async () => {
    const { seen, fetchImpl } = fakePlatform([ok]);
    const client = createLabToolClient({ platformApiUrl: `${PLATFORM}/`, apiKey: "leadlab-key", fetchImpl });
    const result = await client.callTool({
      audience: "bookinglab",
      organisationId: ORG,
      userId: USER,
      tool: "booking_list_pages",
      arguments: { limit: 5 },
    });
    expect(result).toEqual({ content: [{ type: "text", text: "[]" }] });

    const tokenCall = seen.find((s) => s.url.endsWith("/api/on-behalf/token"));
    expect((tokenCall?.init?.headers as Record<string, string>)["X-API-Key"]).toBe("leadlab-key");
    expect(JSON.parse(String(tokenCall?.init?.body))).toEqual({ audience: "bookinglab", organisationId: ORG, userId: USER });

    const doorCall = seen.find((s) => s.url === DOOR);
    expect((doorCall?.init?.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
    expect(JSON.parse(String(doorCall?.init?.body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "booking_list_pages", arguments: { limit: 5 } },
    });
  });

  it("caches the registry for 5 minutes", async () => {
    const { seen, fetchImpl } = fakePlatform([ok, ok]);
    const client = createLabToolClient({ platformApiUrl: PLATFORM, apiKey: "k", fetchImpl });
    await client.callTool({ audience: "bookinglab", organisationId: ORG, tool: "booking_stats" });
    await client.callTool({ audience: "bookinglab", organisationId: ORG, tool: "booking_stats" });
    expect(seen.filter((s) => s.url.endsWith("/api/registry/products"))).toHaveLength(1);
  });

  it("on 401 forgets the token and tries exactly once more", async () => {
    const refused = () => Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "no" }, id: null }, { status: 401 });
    const { seen, fetchImpl } = fakePlatform([refused, ok]);
    const client = createLabToolClient({ platformApiUrl: PLATFORM, apiKey: "k", fetchImpl });
    await client.callTool({ audience: "bookinglab", organisationId: ORG, tool: "booking_stats" });
    const doorCalls = seen.filter((s) => s.url === DOOR);
    expect(doorCalls.map((c) => (c.init?.headers as Record<string, string>).Authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);

    const again = fakePlatform([refused, refused]);
    const second = createLabToolClient({ platformApiUrl: PLATFORM, apiKey: "k", fetchImpl: again.fetchImpl });
    await expect(second.callTool({ audience: "bookinglab", organisationId: ORG, tool: "booking_stats" })).rejects.toMatchObject({
      code: "RPC_-32001",
      status: 401,
    });
    expect(again.seen.filter((s) => s.url === DOOR)).toHaveLength(2);
  });

  it("refuses a product without a tool door and an unknown product", async () => {
    const { fetchImpl } = fakePlatform([]);
    const client = createLabToolClient({ platformApiUrl: PLATFORM, apiKey: "k", fetchImpl });
    await expect(client.callTool({ audience: "suite", organisationId: ORG, tool: "x" })).rejects.toBeInstanceOf(
      LabToolCallError,
    );
    await expect(client.callTool({ audience: "nolab", organisationId: ORG, tool: "x" })).rejects.toMatchObject({
      code: "TARGET_UNKNOWN",
    });
  });
});
