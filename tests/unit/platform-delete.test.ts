import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const ORG = "AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const MODELS = ["note", "apiKey", "organisation"] as const;
  const deleteManyMocks: Record<string, ReturnType<typeof vi.fn>> = {};
  const dbMock: Record<string, Record<string, unknown> | unknown> = {};
  for (const model of MODELS) {
    deleteManyMocks[model] = vi.fn(async () => {
      calls.push(model);
      return { count: model === "note" ? 4 : 1 };
    });
    dbMock[model] = { deleteMany: deleteManyMocks[model] };
  }
  const organisationFindFirst = vi.fn();
  (dbMock.organisation as Record<string, unknown>).findFirst =
    organisationFindFirst;
  const transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>, ...options: unknown[]) => {
      void options;
      return fn(dbMock);
    },
  );
  dbMock.$transaction = transaction;
  return {
    calls,
    MODELS,
    deleteManyMocks,
    dbMock,
    organisationFindFirst,
    transaction,
  };
});
const { calls, MODELS, deleteManyMocks, organisationFindFirst, transaction } =
  h;

vi.mock("@/lib/db", () => ({ db: h.dbMock }));

import { DELETE } from "@/app/api/platform/organisation/route";
import {
  DELETION_PLAN,
  deleteOrganisation,
} from "@/server/services/platform-delete";

function req(query: string, key?: string): NextRequest {
  return new NextRequest(`http://lab.test/api/platform/organisation${query}`, {
    method: "DELETE",
    headers: key ? { "x-api-key": key } : {},
  });
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  organisationFindFirst.mockResolvedValue({ id: ORG.toLowerCase() });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("deleteOrganisation", () => {
  it("deletes every planned table in plan order, organisation last, with counts", async () => {
    const out = await deleteOrganisation(ORG, RUN);
    expect(out.ok).toBe(true);
    expect(out.failures).toEqual([]);
    expect(out.organisationId).toBe(ORG);
    expect(out.runId).toBe(RUN);
    expect(out.items.map((i) => i.target)).toEqual(
      DELETION_PLAN.map((e) => e.table),
    );
    expect(
      out.items.every(
        (i) => i.outcome === "success" && i.action === "delete_rows",
      ),
    ).toBe(true);
    expect(out.items.find((i) => i.target === "notes")?.itemCount).toBe(4);
    expect(calls).toEqual(["note", "apiKey", "organisation"]);
  });

  it("scopes EVERY executor to the stored organisation id (looked up without case)", async () => {
    const stored = ORG.toLowerCase();
    expect(stored).not.toBe(ORG);
    await deleteOrganisation(ORG, RUN);
    expect(organisationFindFirst).toHaveBeenCalledWith({
      where: { id: { equals: ORG, mode: "insensitive" } },
      select: { id: true },
    });
    for (const model of MODELS) {
      expect(deleteManyMocks[model], model).toHaveBeenCalledTimes(1);
      const expected =
        model === "organisation"
          ? { where: { id: stored } }
          : { where: { organisationId: stored } };
      expect(deleteManyMocks[model], model).toHaveBeenCalledWith(expected);
    }
  });

  it("runs the transaction with a timeout above Prisma's 5 s default", async () => {
    await deleteOrganisation(ORG, RUN);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 100_000,
    });
  });

  it("answers an unknown organisation with every item skipped and ok true", async () => {
    organisationFindFirst.mockResolvedValue(null);
    const out = await deleteOrganisation(ORG, RUN);
    expect(out.ok).toBe(true);
    expect(out.items).toHaveLength(DELETION_PLAN.length);
    expect(
      out.items.every((i) => i.outcome === "skipped" && i.itemCount === 0),
    ).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("reports ONE failed item when the transaction throws", async () => {
    transaction.mockRejectedValueOnce(
      new Error("boom with customer@example.com"),
    );
    const out = await deleteOrganisation(ORG, RUN);
    expect(out.ok).toBe(false);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      outcome: "failed",
      detail: "transaction rolled back, nothing was erased",
    });
    expect(out.failures).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("customer@example.com");
  });
});

describe("DELETE /api/platform/organisation", () => {
  const query = `?organisationId=${ORG}&runId=${RUN}`;

  it("is closed with 503 without PLATFORM_DELETE_KEY", async () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "");
    const res = await DELETE(req(query, "k"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "DELETE_NOT_CONFIGURED",
    );
  });

  it("answers 401 for a wrong key and does not touch the database", async () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "right");
    const res = await DELETE(req(query, "wrong"));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(organisationFindFirst).not.toHaveBeenCalled();
  });

  it("answers 400 VALIDATION for a bad organisationId and for a bad runId", async () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "right");
    for (const bad of [
      "",
      `?organisationId=${ORG}`,
      `?runId=${RUN}`,
      `?organisationId=nope&runId=${RUN}`,
      `?organisationId=${ORG}&runId=x`,
    ]) {
      const res = await DELETE(req(bad, "right"));
      expect(res.status, bad).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("VALIDATION");
    }
    expect(organisationFindFirst).not.toHaveBeenCalled();
  });

  it("answers 200 in the platform envelope with no-store", async () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "right");
    const res = await DELETE(req(query, "right"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      success: boolean;
      data: { ok: boolean; organisationId: string; runId: string };
    };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      ok: true,
      organisationId: ORG,
      runId: RUN,
    });
  });
});
