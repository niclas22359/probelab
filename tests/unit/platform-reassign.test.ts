import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ORG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FROM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/**
 * A tiny in-memory table pair, so "two organisations" and "a second run gives
 * zeros" are checked against rows, not only against call arguments.
 */
const h = vi.hoisted(() => {
  type NoteRow = { id: string; organisationId: string; ownerUserId: string; visibility: string; collectionId: string | null };
  type KeyRow = { id: string; organisationId: string; createdByUserId: string | null; revokedAt: Date | null; kind: string };
  const state = { notes: [] as NoteRow[], keys: [] as KeyRow[] };

  const note = {
    updateMany: vi.fn(async ({ where, data }: { where: { organisationId: string; ownerUserId: string }; data: { ownerUserId: string } }) => {
      const hits = state.notes.filter((n) => n.organisationId === where.organisationId && n.ownerUserId === where.ownerUserId);
      for (const n of hits) n.ownerUserId = data.ownerUserId;
      return { count: hits.length };
    }),
  };
  const apiKey = {
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { organisationId: string; createdByUserId: string; revokedAt: null };
        data: { revokedAt: Date };
      }) => {
        const hits = state.keys.filter(
          (k) => k.organisationId === where.organisationId && k.createdByUserId === where.createdByUserId && k.revokedAt === null,
        );
        for (const k of hits) k.revokedAt = data.revokedAt;
        return { count: hits.length };
      },
    ),
  };
  const transaction = vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations));
  return { state, note, apiKey, transaction, dbMock: { note, apiKey, $transaction: transaction } };
});
vi.mock("@/lib/db", () => ({ db: h.dbMock }));

import { POST } from "@/app/api/platform/reassign-owner/route";
import { reassignOwner } from "@/server/services/platform-reassign";

function req(body: unknown, key?: string): NextRequest {
  return new NextRequest("http://lab.test/api/platform/reassign-owner", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.notes = [
    { id: "n1", organisationId: ORG, ownerUserId: FROM, visibility: "PRIVATE", collectionId: null },
    { id: "n2", organisationId: ORG, ownerUserId: FROM, visibility: "COLLECTION", collectionId: "c1" },
    { id: "n3", organisationId: ORG, ownerUserId: "someone-else", visibility: "ORGANISATION", collectionId: null },
    { id: "n4", organisationId: OTHER_ORG, ownerUserId: FROM, visibility: "PRIVATE", collectionId: null },
  ];
  h.state.keys = [
    { id: "k1", organisationId: ORG, createdByUserId: FROM, revokedAt: null, kind: "USER" },
    { id: "k2", organisationId: ORG, createdByUserId: FROM, revokedAt: new Date("2026-01-01"), kind: "USER" },
    { id: "k3", organisationId: ORG, createdByUserId: null, revokedAt: null, kind: "WORKER" },
    { id: "k4", organisationId: OTHER_ORG, createdByUserId: FROM, revokedAt: null, kind: "USER" },
  ];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reassignOwner", () => {
  it("issues exactly the two statements, each scoped to organisation and person, in one transaction", async () => {
    const now = new Date("2026-10-03T12:00:00Z");
    await reassignOwner(ORG, FROM, TO, now);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.note.updateMany).toHaveBeenCalledWith({
      where: { organisationId: ORG, ownerUserId: FROM },
      data: { ownerUserId: TO },
    });
    expect(h.apiKey.updateMany).toHaveBeenCalledWith({
      where: { organisationId: ORG, createdByUserId: FROM, revokedAt: null },
      data: { revokedAt: now },
    });
  });

  it("touches one organisation only, keeps visibility and collection, leaves WORKER keys", async () => {
    const out = await reassignOwner(ORG, FROM, TO);
    expect(out).toEqual({ reassigned: { note: 2 }, revokedApiKeys: 1 });
    expect(h.state.notes.map((n) => [n.id, n.ownerUserId, n.visibility, n.collectionId])).toEqual([
      ["n1", TO, "PRIVATE", null],
      ["n2", TO, "COLLECTION", "c1"],
      ["n3", "someone-else", "ORGANISATION", null],
      ["n4", FROM, "PRIVATE", null],
    ]);
    expect(h.state.keys.filter((k) => k.revokedAt === null).map((k) => k.id)).toEqual(["k3", "k4"]);
  });

  it("a second run counts zeros", async () => {
    await reassignOwner(ORG, FROM, TO);
    expect(await reassignOwner(ORG, FROM, TO)).toEqual({ reassigned: { note: 0 }, revokedApiKeys: 0 });
  });
});

describe("POST /api/platform/reassign-owner", () => {
  const body = { organisationId: ORG, fromUserId: FROM, toUserId: TO };

  it("is closed with 503 EXPORT_NOT_CONFIGURED while the export key is unset", async () => {
    vi.stubEnv("PLATFORM_EXPORT_KEY", "");
    const res = await POST(req(body, "anything"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("EXPORT_NOT_CONFIGURED");
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("answers 401 UNAUTHORIZED for a wrong or missing key", async () => {
    vi.stubEnv("PLATFORM_EXPORT_KEY", "right");
    vi.stubEnv("PLATFORM_DELETE_KEY", "delete-key");
    for (const key of ["wrong", "delete-key", undefined]) {
      const res = await POST(req(body, key));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
    }
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("answers 400 VALIDATION for bad ids, a missing body and the same person twice", async () => {
    vi.stubEnv("PLATFORM_EXPORT_KEY", "right");
    for (const bad of [
      "not json",
      {},
      { ...body, organisationId: "nope" },
      { ...body, fromUserId: "nope" },
      { ...body, toUserId: undefined },
      { ...body, toUserId: FROM },
      { ...body, toUserId: FROM.toUpperCase() },
    ]) {
      const res = await POST(req(bad, "right"));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");
    }
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("answers 200 with the counts, and zeros for an unknown organisation and a second run", async () => {
    vi.stubEnv("PLATFORM_EXPORT_KEY", "right");
    const first = await POST(req(body, "right"));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({
      success: true,
      data: { source: "examplelab", organisationId: ORG, reassigned: { note: 2 }, revokedApiKeys: 1 },
    });

    const again = await POST(req(body, "right"));
    expect(((await again.json()) as { data: unknown }).data).toEqual({
      source: "examplelab",
      organisationId: ORG,
      reassigned: { note: 0 },
      revokedApiKeys: 0,
    });

    const unknown = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const none = await POST(req({ ...body, organisationId: unknown }, "right"));
    expect(((await none.json()) as { data: unknown }).data).toEqual({
      source: "examplelab",
      organisationId: unknown,
      reassigned: { note: 0 },
      revokedApiKeys: 0,
    });
  });

  it("answers 500 when the transaction fails", async () => {
    vi.stubEnv("PLATFORM_EXPORT_KEY", "right");
    h.transaction.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req(body, "right"));
    expect(res.status).toBe(500);
  });
});
