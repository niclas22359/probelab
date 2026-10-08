import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One product-level test per finding of the access inventory that applies to
 * this template (CONTRACT 4.3, FINDINGS-COVERAGE.md), plus the behaviour the
 * contract changes on purpose (policies P1 and P3). Each case was run against
 * the code on origin/develop first and failed there; it passes because the
 * product's files now delegate to `src/lib/platform-client`.
 *
 * The tests use the product's own exports only, so they prove the wiring, not
 * the shared code (that has its own tests upstream).
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  apiKey: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: { apiKey: h.apiKey } }));

import { canEdit, canSee } from "@/lib/access-rules";
import { requireApiKey } from "@/lib/api-auth";
import { hashApiKey } from "@/lib/api-keys";
import { __clearGateCacheForTests, getLabGate } from "@/lib/platform-access";
import {
  __clearAccessCacheForTests,
  emptyGrants,
  getAccessContext,
  getApiKeyAccessContext,
  localAccessContext,
  type AccessContext,
} from "@/lib/platform/access";
import { accessDoorState } from "@/lib/platform/door";
import { complete } from "@/lib/platform/llm";
import { sendMail } from "@/lib/platform/mail";

const ORG = "11111111-1111-4111-8111-111111111111";
const ANNA = "22222222-2222-4222-8222-222222222222";
const BEN = "33333333-3333-4333-8333-333333333333";
const MINTED = new Date("2026-09-01T10:00:00.000Z");

/** A governed person with product access, built from the product's own factory. */
function person(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    ...localAccessContext({ userId: ANNA, email: "anna@example.test", organisationId: ORG, role: "member" }),
    source: "platform",
    governed: true,
    productRole: "user",
    ...overrides,
  };
}

/** The `data` of `/api/access/me` and of the machine route, as platform-api sends it. */
function contextBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: ANNA,
    organisationId: ORG,
    email: "anna@example.test",
    orgRole: "member",
    collections: [],
    settings: { membersMayShareOrg: true, membersMayCreateCollections: true },
    product: {
      key: "examplelab",
      productRole: "user",
      mayPublish: false,
      releaseStep: null,
      accessMode: "assigned",
      personalAllowed: true,
      governed: true,
    },
    grantedObjects: {},
    grantedLevels: {},
    revokedAt: null,
    memberActive: true,
    ...patch,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const envelope = (data: unknown) => json({ success: true, data });

/** The error page of a gateway in front of the platform: status 200, not JSON. */
const unreadable = () => new Response("<html>bad gateway</html>", { status: 200 });

const userKey = {
  keyId: "key-1",
  organisationId: ORG,
  createdByUserId: ANNA,
  mintedAt: MINTED,
  kind: "user" as const,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // A configured server: Suite attached, platform door set, sessions NOT
  // verified locally (CI sets JWT_SECRET + ALLOW_LOCAL_JWT at job level).
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("JWT_SECRET", "");
  vi.stubEnv("ALLOW_LOCAL_JWT", "");
  vi.stubEnv("NEXT_PUBLIC_PLATFORM_URL", "https://suite.test");
  vi.stubEnv("PLATFORM_API_URL", "https://platform.test");
  vi.stubEnv("PLATFORM_API_KEY", "examplelab-service-key");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  __clearAccessCacheForTests();
  __clearGateCacheForTests();
  h.apiKey.findUnique.mockReset();
  h.apiKey.update.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("[B1] a view grant never yields edit", () => {
  it("Anna's note sits in collection c1; Ben is not in c1 and holds a VIEW grant: he sees it and must not edit it", () => {
    const row = { id: "n2", ownerUserId: ANNA, visibility: "COLLECTION" as const, collectionId: "c1" };
    const ben = person({ userId: BEN, grantedIds: { ...emptyGrants(), note: { view: ["n2"], edit: [] } } });
    expect(canSee(ben, "note", row)).toBe(true);
    expect(canEdit(ben, "note", row)).toBe(false);
  });
});

describe("[B9] 'only me' switched off makes the own private row read-only", () => {
  it("the owner still sees her private note but cannot edit it until it is moved", () => {
    const row = { id: "n1", ownerUserId: ANNA, visibility: "PRIVATE" as const, collectionId: null };
    const anna = person({ personalAllowed: false });
    expect(canSee(anna, "note", row)).toBe(true);
    expect(canEdit(anna, "note", row)).toBe(false);
  });
});

describe("[B12] the machine path never caches 'could not check' as 'the owner has no access'", () => {
  it("an unreadable 200 is KEY_CHECK_UNAVAILABLE (503) and the platform is asked again on the next call", async () => {
    fetchMock.mockImplementation(async () => unreadable());
    const first = await getApiKeyAccessContext(userKey);
    expect(first).toMatchObject({ ok: false, reason: "KEY_CHECK_UNAVAILABLE" });
    const second = await getApiKeyAccessContext(userKey);
    expect(second).toMatchObject({ ok: false, reason: "KEY_CHECK_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a 403 about the product's service key (PRODUCT_MISMATCH) is 'could not check', not cached", async () => {
    fetchMock.mockImplementation(async () =>
      json({ success: false, error: { code: "PRODUCT_MISMATCH", message: "wrong product" } }, 403),
    );
    expect(await getApiKeyAccessContext(userKey)).toMatchObject({ ok: false, reason: "KEY_CHECK_UNAVAILABLE" });
    expect(await getApiKeyAccessContext(userKey)).toMatchObject({ ok: false, reason: "KEY_CHECK_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a 403 about the person stays a cached KEY_OWNER_NO_ACCESS", async () => {
    fetchMock.mockImplementation(async () =>
      json({ success: false, error: { code: "FORBIDDEN", message: "no" } }, 403),
    );
    expect(await getApiKeyAccessContext(userKey)).toMatchObject({ ok: false, reason: "KEY_OWNER_NO_ACCESS" });
    expect(await getApiKeyAccessContext(userKey)).toMatchObject({ ok: false, reason: "KEY_OWNER_NO_ACCESS" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("[B13] a key minted in the same millisecond as the token floor is dead", () => {
  it("mintedAt === revokedAt answers KEY_REVOKED", async () => {
    fetchMock.mockImplementation(async () => envelope(contextBody({ revokedAt: MINTED.toISOString() })));
    expect(await getApiKeyAccessContext(userKey)).toMatchObject({ ok: false, reason: "KEY_REVOKED" });
  });

  it("a key minted one millisecond after the floor lives", async () => {
    fetchMock.mockImplementation(async () =>
      envelope(contextBody({ revokedAt: new Date(MINTED.getTime() - 1).toISOString() })),
    );
    const result = await getApiKeyAccessContext(userKey);
    expect(result.ok).toBe(true);
  });
});

describe("[B15] an unreadable /me answer is not cached as 'no access'", () => {
  it("the next request asks the platform again", async () => {
    fetchMock.mockImplementation(async () => unreadable());
    expect(await getAccessContext("token-anna")).toBeNull();
    expect(await getAccessContext("token-anna")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a 200 without the product block is unreadable too, and not cached", async () => {
    const body = contextBody();
    delete body.product;
    fetchMock.mockImplementation(async () => envelope(body));
    expect(await getAccessContext("token-anna")).toBeNull();
    expect(await getAccessContext("token-anna")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("[B17] the Suite gate reason 'organisation' is passed through", () => {
  it("open because the organisation is on the exception list", async () => {
    fetchMock.mockImplementation(async () =>
      json({ allowed: true, reason: "organisation", lab: { key: "examplelab", name: "ExampleLab", enabled: false } }),
    );
    const gate = await getLabGate("token-anna");
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBe("organisation");
  });
});

describe("[P3] API keys act as their creator, checked per call", () => {
  it("a USER key without a creator is refused, never served as a worker", async () => {
    const result = await getApiKeyAccessContext({ ...userKey, createdByUserId: null });
    expect(result).toMatchObject({ ok: false, reason: "KEY_OWNER_NO_ACCESS" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the key door takes the kind from the row: an ownerless USER row is 403, not a worker", async () => {
    const plaintext = "examplelab_ownerless";
    h.apiKey.findUnique.mockResolvedValue({
      id: "key-9",
      name: "ownerless",
      organisationId: ORG,
      keyHash: hashApiKey(plaintext),
      createdByUserId: null,
      kind: "USER",
      createdAt: MINTED,
      revokedAt: null,
      lastUsedAt: null,
    });
    // The key door first asks the Suite's release switch (tool door); answer "released".
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/api/registry/released") ? envelope({ released: true }) : json({}, 500),
    );
    const request = new Request("http://lab.test/api/v1/notes", { headers: { "x-api-key": plaintext } });
    await expect(requireApiKey(request)).rejects.toMatchObject({ status: 403, code: "KEY_OWNER_NO_ACCESS" });
  });

  it("a person whose Suite membership ended (memberActive false) is PERSON_GONE (403)", async () => {
    fetchMock.mockImplementation(async () => envelope(contextBody({ memberActive: false })));
    expect(await getApiKeyAccessContext(userKey)).toMatchObject({ ok: false, reason: "PERSON_GONE" });
  });

  it("two keys of the same person share one platform answer; the verdict is computed per key", async () => {
    fetchMock.mockImplementation(async () => envelope(contextBody({ revokedAt: MINTED.toISOString() })));
    const older = await getApiKeyAccessContext({ ...userKey, keyId: "key-old" });
    const younger = await getApiKeyAccessContext({
      ...userKey,
      keyId: "key-new",
      mintedAt: new Date(MINTED.getTime() + 1),
    });
    expect(older).toMatchObject({ ok: false, reason: "KEY_REVOKED" });
    expect(younger.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("[P1] one door vocabulary", () => {
  it("a placeholder from an example file does not count as a platform key", () => {
    vi.stubEnv("PLATFORM_API_KEY", "<your-platform-key>");
    expect(accessDoorState()).toBe("unconfigured");
  });

  it("local development without a Suite reports 'local'", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_URL", "");
    vi.stubEnv("PLATFORM_API_URL", "");
    vi.stubEnv("PLATFORM_API_KEY", "");
    expect(accessDoorState()).toBe("local");
  });

  it("a production process with a Suite and no door is 'unconfigured' and refuses user keys", async () => {
    vi.stubEnv("PLATFORM_API_URL", "");
    vi.stubEnv("PLATFORM_API_KEY", "");
    expect(accessDoorState()).toBe("unconfigured");
    expect(await getApiKeyAccessContext(userKey)).toMatchObject({ ok: false, reason: "KEY_CHECK_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * `readDoorConfig` is not only the access door's: the AI door (`llm.ts`) and
 * the mail door (`mail.ts`) read the same address and key through it. The P1
 * reading of a placeholder therefore reaches them too. Pinned here so the side
 * effect is a known, tested behaviour and not a surprise for a Lab built from
 * the template: such a value answers DOOR_NOT_CONFIGURED (503) without a
 * request, where origin/develop sent the request and got a platform 401.
 */
describe("[P1] the AI and mail doors share readDoorConfig with the access door", () => {
  const llmRequest = { organisationId: ORG, action: "summarise", messages: [{ role: "user" as const, content: "hi" }] };
  const mailRequest = {
    organisationId: ORG,
    action: "notify",
    to: [{ email: "anna@example.test" }],
    subject: "Hello",
    text: "Hello",
    idempotencyKey: "note-1:notify",
  };

  /** What the platform answers a key it does not know (what origin/develop got). */
  const refuseServiceKey = () =>
    fetchMock.mockImplementation(async () =>
      json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid API key" } }, 401),
    );

  it("a placeholder key answers DOOR_NOT_CONFIGURED on both doors, and nothing is sent", async () => {
    refuseServiceKey();
    vi.stubEnv("PLATFORM_API_KEY", "<your-platform-key>");
    expect(await complete(llmRequest)).toMatchObject({ ok: false, status: 503, code: "DOOR_NOT_CONFIGURED" });
    expect(await sendMail(mailRequest)).toMatchObject({ ok: false, status: 503, code: "DOOR_NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a sentinel word as key, or an address that is no http(s) URL, answers the same", async () => {
    refuseServiceKey();
    vi.stubEnv("PLATFORM_API_KEY", "changeme");
    expect(await complete(llmRequest)).toMatchObject({ ok: false, code: "DOOR_NOT_CONFIGURED" });
    vi.stubEnv("PLATFORM_API_KEY", "examplelab-service-key");
    vi.stubEnv("PLATFORM_API_URL", "platform.test");
    expect(await sendMail(mailRequest)).toMatchObject({ ok: false, code: "DOOR_NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("control: with a real address and key both doors send their request", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await complete(llmRequest)).toMatchObject({ ok: false, code: "NETWORK" });
    expect(await sendMail(mailRequest)).toMatchObject({ ok: false, code: "NETWORK" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://platform.test/api/llm/complete",
      "https://platform.test/api/mail/send",
      "https://platform.test/api/mail/send",
    ]);
  });
});
