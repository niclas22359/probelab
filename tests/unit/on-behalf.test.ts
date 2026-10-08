import { createPrivateKey, sign as signBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOnBehalfClient,
  createOnBehalfVerifier,
  importOnBehalfKeys,
  looksLikeOnBehalfToken,
  OnBehalfError,
  verifyOnBehalfToken,
  type OnBehalfTokenRequest,
} from "@/lib/platform/on-behalf";

import vectors from "../fixtures/on-behalf-vectors.json";

/**
 * The on-behalf module is copied verbatim from the connection layer contract
 * (section 1.6). These tests pin it against the vectors of section 1.7: the
 * same tokens, the same key and the same clock in every product. The key pair
 * in the fixture is TEST ONLY and protects nothing.
 */

const { tokens, claims, nowMs, issuer, audience } = vectors;
const expected = { issuer, audience };
const keys = importOnBehalfKeys(vectors.keyDocument).keys;

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const HEADER = { alg: "EdDSA", typ: "beyondles-obo+jwt", kid: vectors.keyId };

/** Signs with the TEST key, the way the platform does (header and claim order as given). */
function sign(payload: unknown, header: unknown = HEADER): string {
  const key = createPrivateKey({
    key: Buffer.from(vectors.privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const signingInput = `${encode(header)}.${encode(payload)}`;
  return `${signingInput}.${signBytes(null, Buffer.from(signingInput, "ascii"), key).toString("base64url")}`;
}

/** The payload and signature of VALID behind another header. */
function withHeader(header: unknown): string {
  const [, payload, signature] = tokens.VALID.split(".");
  return `${encode(header)}.${payload}.${signature}`;
}

/** A copy without the named members. */
function omit<T extends object, K extends keyof T>(value: T, ...names: K[]): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  for (const name of names) delete copy[name];
  return copy as Omit<T, K>;
}

afterEach(() => vi.restoreAllMocks());

describe("verifyOnBehalfToken against the contract vectors (1.7)", () => {
  it("the test signer of this file reproduces the vectors byte for byte", () => {
    expect(sign(claims.VALID)).toBe(tokens.VALID);
    expect(sign(claims.VALID_AGENT)).toBe(tokens.VALID_AGENT);
  });

  it("VALID gives exactly the claims of the vector", () => {
    expect(verifyOnBehalfToken(tokens.VALID, keys, expected, nowMs)).toEqual({ ok: true, claims: claims.VALID });
  });

  it("VALID_AGENT gives exactly the claims of the vector, without a person", () => {
    const verdict = verifyOnBehalfToken(tokens.VALID_AGENT, keys, expected, nowMs);
    expect(verdict).toEqual({ ok: true, claims: claims.VALID_AGENT });
    expect(verdict.ok && "sub" in verdict.claims).toBe(false);
  });

  it.each([
    ["EXPIRED", tokens.EXPIRED, "expired"],
    ["WRONG_AUDIENCE", tokens.WRONG_AUDIENCE, "wrong_audience"],
    ["WRONG_ISSUER", tokens.WRONG_ISSUER, "wrong_issuer"],
  ])("%s is refused as %s", (_name, token, reason) => {
    expect(verifyOnBehalfToken(token, keys, expected, nowMs)).toEqual({ ok: false, reason });
  });

  it("30 seconds of clock tolerance on both ends, not one more", () => {
    expect(verifyOnBehalfToken(tokens.VALID, keys, expected, 1790000329000).ok).toBe(true);
    expect(verifyOnBehalfToken(tokens.VALID, keys, expected, 1790000330000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyOnBehalfToken(tokens.VALID, keys, expected, 1789999969000)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
    expect(verifyOnBehalfToken(tokens.VALID, keys, expected, 1789999970000).ok).toBe(true);
  });

  it("a payload swapped under a foreign signature is a bad signature", () => {
    const [header, , signature] = tokens.VALID.split(".");
    const swapped = `${header}.${tokens.VALID_AGENT.split(".")[1]}.${signature}`;
    expect(verifyOnBehalfToken(swapped, keys, expected, nowMs)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("a key id the verifier does not hold is an unknown key", () => {
    expect(verifyOnBehalfToken(tokens.VALID, new Map(), expected, nowMs)).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });

  it.each([
    ["HS256 and typ JWT", { alg: "HS256", typ: "JWT", kid: "test-only-1" }],
    ["alg none", { alg: "none", typ: "beyondles-obo+jwt", kid: "test-only-1" }],
  ])("another algorithm or type is unsupported: %s", (_name, header) => {
    expect(verifyOnBehalfToken(withHeader(header), keys, expected, nowMs)).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it.each(["a.b", "not a token", "", "a.b.c.d"])("%j is malformed", (token) => {
    expect(verifyOnBehalfToken(token, keys, expected, nowMs)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("claim rules beyond the vectors (1.1)", () => {
  const base = claims.VALID;
  const deny = (payload: unknown) => verifyOnBehalfToken(sign(payload), keys, expected, nowMs);

  it("a lifetime above 300 seconds is refused although it is signed correctly", () => {
    expect(deny({ ...base, exp: base.iat + 301 })).toEqual({ ok: false, reason: "invalid_claims" });
    expect(deny({ ...base, exp: base.iat })).toEqual({ ok: false, reason: "invalid_claims" });
  });

  it("a person without a role, and a role without a person, are refused", () => {
    const withoutRole = omit(base, "role");
    const withoutPerson = omit(base, "sub");
    expect(deny(withoutRole)).toEqual({ ok: false, reason: "invalid_claims" });
    expect(deny(withoutPerson)).toEqual({ ok: false, reason: "invalid_claims" });
    expect(deny({ ...base, role: "superuser" })).toEqual({ ok: false, reason: "invalid_claims" });
  });

  it("an audience given as a list is not this service's audience", () => {
    expect(deny({ ...base, aud: ["connections"] })).toEqual({ ok: false, reason: "wrong_audience" });
  });

  it("an agent carries exactly the fields of its level", () => {
    const noPerson = omit(base, "sub", "role");
    const owner = "33333333-3333-4333-8333-333333333333";
    const col = "55555555-5555-4555-8555-555555555555";
    const agent = (agt: unknown) => deny({ ...noPerson, agt });

    expect(agent({ id: "a-1", level: "private", owner })).toMatchObject({
      ok: true,
      claims: { agt: { id: "a-1", level: "private", owner } },
    });
    expect(agent({ id: "a-1", level: "organisation" })).toMatchObject({
      ok: true,
      claims: { agt: { id: "a-1", level: "organisation" } },
    });
    for (const broken of [
      { id: "a-1", level: "private" },
      { id: "a-1", level: "private", owner, col },
      { id: "a-1", level: "collection", owner },
      { id: "a-1", level: "organisation", owner },
      { id: "a 1", level: "organisation" },
      { id: "a-1", level: "everyone" },
    ]) {
      expect(agent(broken), JSON.stringify(broken)).toEqual({ ok: false, reason: "invalid_claims" });
    }
  });
});

describe("looksLikeOnBehalfToken", () => {
  it("recognises the token by its header type, without checking anything", () => {
    expect(looksLikeOnBehalfToken(tokens.VALID)).toBe(true);
    expect(looksLikeOnBehalfToken(tokens.EXPIRED)).toBe(true);
    expect(looksLikeOnBehalfToken(withHeader({ alg: "HS256", typ: "JWT" }))).toBe(false);
    expect(looksLikeOnBehalfToken("apl_0123456789abcdef")).toBe(false);
    expect(looksLikeOnBehalfToken("")).toBe(false);
  });
});

describe("importOnBehalfKeys", () => {
  it("reads the platform's key document", () => {
    const imported = importOnBehalfKeys(vectors.keyDocument);
    expect(imported.issuer).toBe(issuer);
    expect([...imported.keys.keys()]).toEqual(["test-only-1"]);
  });

  it("skips what it cannot use and never throws", () => {
    const good = vectors.keyDocument.keys[0];
    const imported = importOnBehalfKeys({
      issuer,
      keys: [
        { ...good, kty: "RSA" },
        { ...good, crv: "P-256" },
        { ...good, kid: "x" },
        { ...good, kid: "broken-key", x: "!!" },
        "not an object",
        good,
      ],
    });
    expect([...imported.keys.keys()]).toEqual(["test-only-1"]);
    expect(importOnBehalfKeys(null)).toEqual({ issuer: null, keys: new Map() });
    expect(importOnBehalfKeys({ keys: "none" }).keys.size).toBe(0);
  });
});

describe("createOnBehalfVerifier: the key cache", () => {
  const JWKS_URL = "https://platform.test/api/on-behalf/jwks";

  function setup(answer: () => Response | Promise<Response> = () => Response.json(vectors.keyDocument)) {
    const clock = { now: nowMs };
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => answer());
    const verifier = createOnBehalfVerifier({
      jwksUrl: JWKS_URL,
      issuer,
      audience,
      fetchImpl,
      now: () => clock.now,
    });
    return { clock, fetchImpl, verifier };
  }

  it("fetches the keys once and uses them for ten minutes", async () => {
    const { clock, fetchImpl, verifier } = setup();
    expect(await verifier.verify(tokens.VALID)).toEqual({ ok: true, claims: claims.VALID });
    expect(await verifier.verify(tokens.VALID_AGENT)).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(JWKS_URL);

    clock.now += 10 * 60_000 + 1;
    await verifier.verify(tokens.VALID);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("without an issuer, an address or an audience nothing is accepted and nothing is fetched", async () => {
    const fetchImpl = vi.fn(async () => Response.json(vectors.keyDocument));
    for (const config of [
      { jwksUrl: JWKS_URL, issuer: "", audience },
      { jwksUrl: "", issuer, audience },
      { jwksUrl: JWKS_URL, issuer, audience: "" },
    ]) {
      const verifier = createOnBehalfVerifier({ ...config, fetchImpl, now: () => nowMs });
      expect(await verifier.verify(tokens.VALID)).toEqual({ ok: false, reason: "not_configured" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed while the platform has never answered", async () => {
    const down = setup(() => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(await down.verifier.verify(tokens.VALID)).toEqual({ ok: false, reason: "keys_unavailable" });

    const closed = setup(() => Response.json({ success: false }, { status: 503 }));
    expect(await closed.verifier.verify(tokens.VALID)).toEqual({ ok: false, reason: "keys_unavailable" });

    const empty = setup(() => Response.json({ issuer, keys: [] }));
    expect(await empty.verifier.verify(tokens.VALID)).toEqual({ ok: false, reason: "keys_unavailable" });
  });

  it("keeps the last good keys while the platform is down, for at most 24 hours", async () => {
    let up = true;
    const { clock, verifier } = setup(() => {
      if (!up) throw new Error("down");
      return Response.json(vectors.keyDocument);
    });
    expect((await verifier.verify(tokens.VALID)).ok).toBe(true);

    up = false;
    clock.now += 11 * 60_000;
    // The keys are still usable; the token itself is too old by now.
    expect(await verifier.verify(tokens.VALID)).toEqual({ ok: false, reason: "expired" });

    clock.now += 24 * 60 * 60_000;
    expect(await verifier.verify(tokens.VALID)).toEqual({ ok: false, reason: "keys_unavailable" });
  });

  it("a platform of another environment is refused with one loud line", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { clock, verifier } = setup(() =>
      Response.json({ ...vectors.keyDocument, issuer: "beyondles-platform:production" }),
    );
    expect(await verifier.verify(tokens.VALID)).toEqual({ ok: false, reason: "keys_unavailable" });
    clock.now += 31_000;
    expect(await verifier.verify(tokens.VALID)).toEqual({ ok: false, reason: "keys_unavailable" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("Wrong environment?");
  });

  it("an unknown key id asks the platform again at once, then at most every 30 seconds", async () => {
    const { clock, fetchImpl, verifier } = setup();
    const foreign = withHeader({ ...HEADER, kid: "rotated-key-2" });

    await verifier.verify(tokens.VALID);
    clock.now += 31_000;
    expect(await verifier.verify(foreign)).toEqual({ ok: false, reason: "unknown_key" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock.now += 5_000;
    expect(await verifier.verify(foreign)).toEqual({ ok: false, reason: "unknown_key" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock.now += 31_000;
    await verifier.verify(foreign);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("parallel first calls all wait for the one key fetch in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetchImpl, verifier } = setup(async () => {
      await gate;
      return Response.json(vectors.keyDocument);
    });
    const first = verifier.verify(tokens.VALID);
    const second = verifier.verify(tokens.VALID_AGENT);
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parallel first calls still fail closed when the key fetch fails", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { verifier } = setup(async () => {
      await gate;
      return new Response("down", { status: 502 });
    });
    const first = verifier.verify(tokens.VALID);
    const second = verifier.verify(tokens.VALID);
    release();
    expect(await first).toEqual({ ok: false, reason: "keys_unavailable" });
    expect(await second).toEqual({ ok: false, reason: "keys_unavailable" });
  });

  it("reset forgets the fetched keys", async () => {
    const { fetchImpl, verifier } = setup();
    await verifier.verify(tokens.VALID);
    verifier.reset();
    await verifier.verify(tokens.VALID);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("createOnBehalfClient", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const forSuite: OnBehalfTokenRequest = { audience: "suite", organisationId: ORG };
  const forConnections: OnBehalfTokenRequest = {
    audience: "connections",
    organisationId: ORG,
    userId: "33333333-3333-4333-8333-333333333333",
    agent: { id: "agent-7", level: "collection", collectionId: "55555555-5555-4555-8555-555555555555" },
  };

  function platform() {
    let issued = 0;
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      issued += 1;
      const body = JSON.parse(String(init?.body)) as { audience: string };
      return Response.json({
        success: true,
        data: {
          token: `token-${body.audience}-${issued}`,
          tokenType: "Bearer",
          expiresAt: new Date(nowMs + 300_000).toISOString(),
          issuedAt: new Date(nowMs).toISOString(),
          kid: "test-only-1",
        },
      });
    });
    return fetchImpl;
  }

  it("asks the platform with the product's own service key and the request as body", async () => {
    const fetchImpl = platform();
    const client = createOnBehalfClient({
      platformApiUrl: "https://platform.test/",
      apiKey: "service-key",
      fetchImpl,
      now: () => nowMs,
    });
    await client.getToken(forConnections);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://platform.test/api/on-behalf/token");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe("service-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      audience: "connections",
      organisationId: ORG,
      userId: "33333333-3333-4333-8333-333333333333",
      agent: { id: "agent-7", level: "collection", collectionId: "55555555-5555-4555-8555-555555555555" },
    });
  });

  it("caches two different requests, and forget drops exactly one of them", async () => {
    const fetchImpl = platform();
    const client = createOnBehalfClient({
      platformApiUrl: "https://platform.test",
      apiKey: "service-key",
      fetchImpl,
      now: () => nowMs,
    });

    expect(await client.getToken(forSuite)).toBe("token-suite-1");
    expect(await client.getToken(forConnections)).toBe("token-connections-2");
    expect(await client.getToken(forSuite)).toBe("token-suite-1");
    expect(await client.getToken(forConnections)).toBe("token-connections-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    client.forget(forConnections);
    expect(await client.getToken(forConnections)).toBe("token-connections-3");
    expect(await client.getToken(forSuite)).toBe("token-suite-1");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("replaces a token a minute before it expires", async () => {
    const fetchImpl = platform();
    let now = nowMs;
    const client = createOnBehalfClient({
      platformApiUrl: "https://platform.test",
      apiKey: "service-key",
      fetchImpl,
      now: () => now,
    });
    await client.getToken(forSuite);
    now += 239_000;
    expect(await client.getToken(forSuite)).toBe("token-suite-1");
    now += 2_000;
    expect(await client.getToken(forSuite)).toBe("token-suite-2");
  });

  it("two callers asking at the same moment share one request", async () => {
    const fetchImpl = platform();
    const client = createOnBehalfClient({
      platformApiUrl: "https://platform.test",
      apiKey: "service-key",
      fetchImpl,
      now: () => nowMs,
    });
    const [first, second] = await Promise.all([client.getToken(forSuite), client.getToken(forSuite)]);
    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("hands the platform's refusal on with its code, and caches nothing of it", async () => {
    const fetchImpl = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json(
          { success: false, error: { code: "USER_NOT_MEMBER", message: "Not a member." } },
          { status: 403 },
        ),
      )
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(Response.json({ success: true, data: { token: "", expiresAt: "soon" } }));
    const client = createOnBehalfClient({
      platformApiUrl: "https://platform.test",
      apiKey: "service-key",
      fetchImpl,
      now: () => nowMs,
    });

    const refused = await client.getToken(forSuite).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(OnBehalfError);
    expect(refused).toMatchObject({ code: "USER_NOT_MEMBER", status: 403, message: "Not a member." });

    expect(await client.getToken(forSuite).catch((error: unknown) => error)).toMatchObject({
      code: "NETWORK",
      status: 0,
    });
    expect(await client.getToken(forSuite).catch((error: unknown) => error)).toMatchObject({
      code: "BAD_RESPONSE",
      status: 200,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
