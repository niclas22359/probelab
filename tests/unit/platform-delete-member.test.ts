import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const ORG = "AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "CCCCCCCC-cccc-4ccc-8ccc-cccccccccccc";
const TO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const h = vi.hoisted(() => {
  const note = { deleteMany: vi.fn(), updateMany: vi.fn() };
  const apiKey = { deleteMany: vi.fn(), updateMany: vi.fn() };
  const organisationFindFirst = vi.fn();
  const dbMock: Record<string, unknown> = {
    note,
    apiKey,
    organisation: { findFirst: organisationFindFirst },
  };
  const transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>, ...options: unknown[]) => {
      void options;
      return fn(dbMock);
    },
  );
  dbMock.$transaction = transaction;
  return { note, apiKey, organisationFindFirst, dbMock, transaction };
});
const { note, apiKey, organisationFindFirst, transaction } = h;

vi.mock("@/lib/db", () => ({ db: h.dbMock }));

import { DELETE } from "@/app/api/platform/member/route";
import {
  PERSON_PLAN,
  deletePerson,
} from "@/server/services/platform-delete-member";

const STORED_ORG = ORG.toLowerCase();
const CI_USER = { equals: USER, mode: "insensitive" };

function req(query: string, key?: string): NextRequest {
  return new NextRequest(`http://lab.test/api/platform/member${query}`, {
    method: "DELETE",
    headers: key ? { "x-api-key": key } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  organisationFindFirst.mockResolvedValue({ id: STORED_ORG });
  note.deleteMany.mockResolvedValue({ count: 2 });
  note.updateMany.mockResolvedValue({ count: 3 });
  apiKey.deleteMany.mockResolvedValue({ count: 1 });
  apiKey.updateMany.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("deletePerson", () => {
  it("issues exactly the planned statements, each scoped to organisation AND user", async () => {
    const out = await deletePerson(ORG, USER, TO, RUN);
    expect(organisationFindFirst).toHaveBeenCalledWith({
      where: { id: { equals: ORG, mode: "insensitive" } },
      select: { id: true },
    });
    expect(note.deleteMany).toHaveBeenCalledTimes(1);
    expect(note.deleteMany).toHaveBeenCalledWith({
      where: {
        organisationId: STORED_ORG,
        ownerUserId: CI_USER,
        visibility: "PRIVATE",
      },
    });
    expect(note.updateMany).toHaveBeenCalledTimes(1);
    expect(note.updateMany).toHaveBeenCalledWith({
      where: {
        organisationId: STORED_ORG,
        ownerUserId: CI_USER,
        visibility: { not: "PRIVATE" },
      },
      data: { ownerUserId: TO },
    });
    expect(apiKey.deleteMany).toHaveBeenCalledTimes(1);
    expect(apiKey.deleteMany).toHaveBeenCalledWith({
      where: {
        organisationId: STORED_ORG,
        createdByUserId: CI_USER,
        kind: "USER",
      },
    });
    expect(apiKey.updateMany).toHaveBeenCalledTimes(1);
    expect(apiKey.updateMany).toHaveBeenCalledWith({
      where: {
        organisationId: STORED_ORG,
        createdByUserId: CI_USER,
        kind: "WORKER",
      },
      data: { createdByUserId: null },
    });
    expect(out.ok).toBe(true);
    expect(out.userId).toBe(USER);
    expect(out.organisationId).toBe(ORG);
    expect(
      out.items.map((i) => [i.target, i.action, i.itemCount, i.outcome]),
    ).toEqual([
      ["notes.ownerUserId", "delete_rows", 2, "success"],
      ["notes.ownerUserId", "reassign_rows", 3, "success"],
      ["api_keys.createdByUserId", "delete_rows", 1, "success"],
      ["api_keys.createdByUserId", "anonymise_rows", 1, "success"],
    ]);
  });

  it("never lets an undefined or empty value into a filter", async () => {
    await deletePerson(ORG, USER, TO, RUN);
    const wheres = [
      note.deleteMany.mock.calls[0][0].where,
      note.updateMany.mock.calls[0][0].where,
      apiKey.deleteMany.mock.calls[0][0].where,
      apiKey.updateMany.mock.calls[0][0].where,
    ];
    for (const where of wheres) {
      expect(where.organisationId).toBeTruthy();
      expect(JSON.stringify(where)).toContain(USER);
      for (const value of Object.values(where)) {
        expect(value).not.toBeUndefined();
        expect(value).not.toEqual([]);
      }
    }
  });

  it("refuses an empty id or a successor equal to the person", async () => {
    await expect(deletePerson(ORG, "", TO, RUN)).rejects.toThrow();
    await expect(deletePerson(ORG, USER, "", RUN)).rejects.toThrow();
    await expect(
      deletePerson(ORG, USER, USER.toUpperCase(), RUN),
    ).rejects.toThrow();
    expect(note.deleteMany).not.toHaveBeenCalled();
  });

  it("answers an unknown organisation with every item skipped and ok true", async () => {
    organisationFindFirst.mockResolvedValue(null);
    const out = await deletePerson(ORG, USER, TO, RUN);
    expect(out.ok).toBe(true);
    expect(out.items).toHaveLength(PERSON_PLAN.length);
    expect(
      out.items.every((i) => i.outcome === "skipped" && i.itemCount === 0),
    ).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("answers an unknown person (nothing touched) with every item skipped and ok true", async () => {
    for (const m of [
      note.deleteMany,
      note.updateMany,
      apiKey.deleteMany,
      apiKey.updateMany,
    ]) {
      m.mockResolvedValue({ count: 0 });
    }
    const out = await deletePerson(ORG, USER, TO, RUN);
    expect(out.ok).toBe(true);
    expect(
      out.items.every((i) => i.outcome === "skipped" && i.itemCount === 0),
    ).toBe(true);
  });

  it("reports ONE failed item when the transaction throws", async () => {
    transaction.mockRejectedValueOnce(
      new Error("boom with customer@example.com"),
    );
    const out = await deletePerson(ORG, USER, TO, RUN);
    expect(out.ok).toBe(false);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      outcome: "failed",
      detail: "transaction rolled back, nothing was erased",
    });
    expect(JSON.stringify(out)).not.toContain("customer@example.com");
  });

  it("runs the transaction with a timeout above Prisma's 5 s default", async () => {
    await deletePerson(ORG, USER, TO, RUN);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 100_000,
    });
  });
});

describe("DELETE /api/platform/member", () => {
  const query = `?organisationId=${ORG}&userId=${USER}&toUserId=${TO}&runId=${RUN}`;

  it("is closed with 503 without PLATFORM_DELETE_KEY", async () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "");
    const res = await DELETE(req(query, "k"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "DELETE_NOT_CONFIGURED",
    );
  });

  it("answers 401 for a wrong key and refuses the export key", async () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "right");
    vi.stubEnv("PLATFORM_EXPORT_KEY", "export-key");
    for (const key of ["wrong", "export-key", undefined]) {
      const res = await DELETE(req(query, key));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(organisationFindFirst).not.toHaveBeenCalled();
  });

  it("does not fall back to the export key when the delete key is unset", async () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "");
    vi.stubEnv("PLATFORM_EXPORT_KEY", "export-key");
    expect((await DELETE(req(query, "export-key"))).status).toBe(503);
  });

  it("answers 400 VALIDATION for each missing or malformed id and for toUserId = userId", async () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "right");
    const bad = [
      "",
      `?userId=${USER}&toUserId=${TO}&runId=${RUN}`,
      `?organisationId=${ORG}&toUserId=${TO}&runId=${RUN}`,
      `?organisationId=${ORG}&userId=${USER}&runId=${RUN}`,
      `?organisationId=${ORG}&userId=${USER}&toUserId=${TO}`,
      `?organisationId=nope&userId=${USER}&toUserId=${TO}&runId=${RUN}`,
      `?organisationId=${ORG}&userId=nope&toUserId=${TO}&runId=${RUN}`,
      `?organisationId=${ORG}&userId=${USER}&toUserId=nope&runId=${RUN}`,
      `?organisationId=${ORG}&userId=${USER}&toUserId=${TO}&runId=nope`,
      `?organisationId=${ORG}&userId=${USER}&toUserId=${USER.toLowerCase()}&runId=${RUN}`,
    ];
    for (const q of bad) {
      const res = await DELETE(req(q, "right"));
      expect(res.status, q).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("VALIDATION");
    }
    expect(organisationFindFirst).not.toHaveBeenCalled();
  });

  it("answers 200 in the platform envelope with no-store and userId echoed", async () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "right");
    const res = await DELETE(req(query, "right"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      success: boolean;
      data: Record<string, unknown>;
    };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      ok: true,
      organisationId: ORG,
      userId: USER,
      runId: RUN,
    });
  });
});
