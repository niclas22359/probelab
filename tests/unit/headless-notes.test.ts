import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * HEADLESS BY CONSTRUCTION, end to end on the notes example: the same
 * function through the screen (server action), REST (`/api/v1`) and MCP
 * (`/api/mcp`) writes the same row and the same audit line; scopes, the
 * worker-only rule, the rate limit and the container default hold at every
 * door. Local mode (no Suite, no platform door): keys get the local view of
 * their creator, the release gate is not applied.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
  const apiKey = { findUnique: vi.fn(), update: vi.fn() };
  const note = {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  };
  const organisation = { upsert: vi.fn() };
  const jobRun = { upsert: vi.fn() };
  return {
    apiKey,
    note,
    organisation,
    jobRun,
    dbMock: { apiKey, note, organisation, jobRun },
    session: { current: null as unknown },
  };
});
vi.mock("@/lib/db", () => ({ db: h.dbMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/rbac", async (original) => ({
  ...(await original<typeof import("@/lib/rbac")>()),
  requireAccessOrNull: async () => h.session.current,
}));

import { GET as describeRoute } from "@/app/api/mcp/describe/route";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { GET as openApiRoute } from "@/app/api/v1/openapi.json/route";
import {
  DELETE as deleteNoteRoute,
  GET as getNoteRoute,
  PATCH as patchNoteRoute,
} from "@/app/api/v1/notes/[noteId]/route";
import {
  GET as listNotesRoute,
  POST as createNoteRoute,
} from "@/app/api/v1/notes/route";
import { POST as expireRoute } from "@/app/api/v1/worker/expire-notes/route";
import { __setAuditWriterForTests } from "@/lib/audit";
import { hashApiKey } from "@/lib/api-keys";
import { apiKeyAccessContext } from "@/lib/platform/access";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import type { AuditActor, AuditLine } from "@/lib/platform-client/core/types";
import { createNoteAction, deleteNoteAction } from "@/server/actions/notes";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const NOTE_ID = "99999999-9999-4999-8999-999999999999";

const KEYS: Record<string, { kind: "USER" | "WORKER"; scopes: string[] }> = {
  user_rw: { kind: "USER", scopes: ["read", "write"] },
  user_read: { kind: "USER", scopes: ["read"] },
  user_legacy: { kind: "USER", scopes: ["*"] },
  user_delete: { kind: "USER", scopes: ["read", "write", "notes:delete"] },
  worker_rw: { kind: "WORKER", scopes: ["read", "write"] },
  worker_job: { kind: "WORKER", scopes: ["write", "notes:delete"] },
};

let audit: { actor: AuditActor; line: AuditLine }[];
let restoreAudit: () => void;

function keyRow(plaintext: string) {
  const spec = KEYS[plaintext];
  if (!spec) return null;
  return {
    id: `k-${plaintext}`,
    name: plaintext,
    organisationId: ORG,
    keyHash: hashApiKey(plaintext),
    createdByUserId: spec.kind === "WORKER" ? null : USER,
    kind: spec.kind,
    scopes: spec.scopes,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    revokedAt: null,
    lastUsedAt: new Date(),
  };
}

const stored = (data: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  title: "Plan",
  body: "",
  visibility: "PRIVATE",
  ownerUserId: USER,
  collectionId: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  ...data,
});

function req(
  path: string,
  key: string | null,
  init: { method?: string; body?: unknown } = {},
) {
  return new NextRequest(`http://lab.test${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(key ? { "x-api-key": key } : {}),
      ...(init.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const params = { params: Promise.resolve({ noteId: NOTE_ID }) };
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

/** The self-call of a tool lands on the real route handlers. */
async function selfCall(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const request = new NextRequest(
    `http://lab.test${url.pathname}${url.search}`,
    init as never,
  );
  const id = /^\/api\/v1\/notes\/([^/]+)$/.exec(url.pathname)?.[1];
  const ctx = { params: Promise.resolve({ noteId: id ?? "" }) };
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/v1/notes")
    return method === "POST"
      ? createNoteRoute(request)
      : listNotesRoute(request);
  if (id && method === "GET") return getNoteRoute(request, ctx);
  if (id && method === "PATCH") return patchNoteRoute(request, ctx);
  if (id && method === "DELETE") return deleteNoteRoute(request, ctx);
  throw new Error(`unexpected self-call ${method} ${input}`);
}

const rpc = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

async function callTool(
  key: string,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await mcpRoute(
    req("/api/mcp", key, { method: "POST", body: rpc(name, args) }),
  );
  return (await res.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_PLATFORM_URL", "");
  vi.stubEnv("PLATFORM_API_URL", "");
  vi.stubEnv("PLATFORM_API_KEY", "");
  vi.stubEnv("MCP_SELF_BASE_URL", "");
  vi.stubEnv("PORT", "");
  vi.stubGlobal("fetch", vi.fn(selfCall));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  audit = [];
  restoreAudit = __setAuditWriterForTests(async (actor, line) => {
    audit.push({ actor, line });
    return true;
  });
  h.apiKey.findUnique.mockImplementation(
    async ({ where }: { where: { keyHash: string } }) =>
      keyRow(
        Object.keys(KEYS).find((k) => hashApiKey(k) === where.keyHash) ?? "",
      ),
  );
  h.apiKey.update.mockResolvedValue({});
  h.organisation.upsert.mockResolvedValue({});
  h.note.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => stored(data),
  );
  h.note.findFirst.mockResolvedValue(stored());
  h.note.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => stored(data),
  );
  h.note.delete.mockResolvedValue(stored());
  h.note.deleteMany.mockResolvedValue({ count: 2 });
  // expire-notes counts first: 2 expired of 40 organisation notes (5 %).
  h.note.count.mockImplementation(async ({ where }: { where: { AND: unknown[] } }) => (where.AND.length > 2 ? 2 : 40));
  h.jobRun.upsert.mockResolvedValue({});
  h.note.findMany.mockResolvedValue([]);
  h.session.current = {
    organisationId: ORG,
    token: "suite-session-token",
    access: apiKeyAccessContext({ organisationId: ORG, createdByUserId: USER }),
    isAdmin: false,
  };
});

afterEach(() => {
  restoreAudit();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  __resetRateLimitForTests();
});

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

describe("one function, three doors: createNote", () => {
  it("writes the same row and the same audit line from the screen, REST and MCP", async () => {
    await expect(
      createNoteAction(
        form({ title: "Plan", body: "", visibility: "private" }),
      ),
    ).rejects.toThrow("REDIRECT /notes");
    const rest = await createNoteRoute(
      req("/api/v1/notes", "user_rw", {
        method: "POST",
        body: { title: "Plan", visibility: "private" },
      }),
    );
    expect(rest.status).toBe(201);
    const tool = await callTool("user_rw", "examplelab_create_note", {
      title: "Plan",
      visibility: "private",
    });
    expect(tool.result.isError).toBeUndefined();

    const rows = h.note.create.mock.calls.map((c) => c[0].data);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(rows[0]);
    expect(rows[2]).toEqual(rows[0]);

    expect(audit.map((a) => a.line)).toEqual([
      {
        organisationId: ORG,
        action: "object.created",
        objectId: NOTE_ID,
        objectTitle: "Plan",
        details: { visibility: "private" },
      },
      {
        organisationId: ORG,
        action: "object.created",
        objectId: NOTE_ID,
        objectTitle: "Plan",
        details: { visibility: "private" },
      },
      {
        organisationId: ORG,
        action: "object.created",
        objectId: NOTE_ID,
        objectTitle: "Plan",
        details: { visibility: "private" },
      },
    ]);
    // Only the actor FORM differs: the screen has the person's token, a key names its creator.
    expect(audit.map((a) => a.actor)).toEqual([
      { token: "suite-session-token" },
      { actorUserId: USER },
      { actorUserId: USER },
    ]);
  });

  it("deleteNote: the same line from the screen and from REST; MCP needs the extra scope", async () => {
    await expect(deleteNoteAction(form({ noteId: NOTE_ID }))).rejects.toThrow(
      "REDIRECT /notes",
    );
    const rest = await deleteNoteRoute(
      req(`/api/v1/notes/${NOTE_ID}`, "user_delete", { method: "DELETE" }),
      params,
    );
    expect(rest.status).toBe(200);
    const tool = await callTool("user_delete", "examplelab_delete_note", {
      noteId: NOTE_ID,
    });
    expect(tool.result.isError).toBeUndefined();
    const lines = audit.map((a) => a.line);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toEqual({
        organisationId: ORG,
        action: "object.deleted",
        objectId: NOTE_ID,
        objectTitle: "Plan",
      });
    }
  });
});

describe("the container default (one rule for every door)", () => {
  it("a person who names nothing gets a private note", async () => {
    const res = await createNoteRoute(
      req("/api/v1/notes", "user_rw", { method: "POST", body: { title: "x" } }),
    );
    expect(res.status).toBe(201);
    expect(h.note.create.mock.calls[0][0].data).toMatchObject({
      visibility: "PRIVATE",
      ownerUserId: USER,
    });
  });

  it("a worker key that names nothing is refused: no silent widening", async () => {
    const res = await createNoteRoute(
      req("/api/v1/notes", "worker_rw", {
        method: "POST",
        body: { title: "x" },
      }),
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
    expect(h.note.create).not.toHaveBeenCalled();
  });

  it("a worker key that names 'organisation' creates it and audits as System", async () => {
    const res = await createNoteRoute(
      req("/api/v1/notes", "worker_rw", {
        method: "POST",
        body: { title: "x", visibility: "organisation" },
      }),
    );
    expect(res.status).toBe(201);
    expect(h.note.create.mock.calls[0][0].data).toMatchObject({
      visibility: "ORGANISATION",
      ownerUserId: "",
    });
    expect(audit[0].actor).toEqual({ system: true });
  });
});

describe("scopes", () => {
  it("a read-only key reads but cannot write; nothing is written, nothing audited", async () => {
    expect(
      (await listNotesRoute(req("/api/v1/notes", "user_read"))).status,
    ).toBe(200);
    const res = await createNoteRoute(
      req("/api/v1/notes", "user_read", {
        method: "POST",
        body: { title: "x" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("insufficient_scope");
    expect(h.note.create).not.toHaveBeenCalled();
    expect(audit).toEqual([]);
  });

  it("delete needs write AND notes:delete; a legacy full-access key has both", async () => {
    const plain = await deleteNoteRoute(
      req(`/api/v1/notes/${NOTE_ID}`, "user_rw", { method: "DELETE" }),
      params,
    );
    expect(plain.status).toBe(403);
    expect(await errorCode(plain)).toBe("insufficient_scope");
    const legacy = await deleteNoteRoute(
      req(`/api/v1/notes/${NOTE_ID}`, "user_legacy", { method: "DELETE" }),
      params,
    );
    expect(legacy.status).toBe(200);
  });

  it("the MCP tool gets the same refusal, mapped once", async () => {
    const tool = await callTool("user_read", "examplelab_update_note", {
      noteId: NOTE_ID,
      title: "y",
    });
    expect(tool.result.isError).toBe(true);
    expect(tool.result.content[0].text).toMatch(
      /^insufficient_scope \(HTTP 403\): /,
    );
  });

  it("describe shows each tool's scopes and whether this key covers them", async () => {
    const res = await describeRoute(req("/api/mcp/describe", "user_read"));
    const body = (await res.json()) as {
      tools: { name: string; scopes: string[]; available: boolean }[];
    };
    expect(
      body.tools.map((t) => [t.name, t.scopes.join("+"), t.available]),
    ).toEqual([
      ["examplelab_list_notes", "read", true],
      ["examplelab_get_note", "read", true],
      ["examplelab_create_note", "write", false],
      ["examplelab_update_note", "write", false],
      ["examplelab_delete_note", "write+notes:delete", false],
    ]);
  });
});

describe("service errors map the same way at every door", () => {
  it("not found: 404 over REST, the same code and text through MCP", async () => {
    h.note.findFirst.mockResolvedValue(null);
    const res = await getNoteRoute(
      req(`/api/v1/notes/${NOTE_ID}`, "user_rw"),
      params,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "Note not found." },
    });
    const tool = await callTool("user_rw", "examplelab_get_note", {
      noteId: NOTE_ID,
    });
    expect(tool.result.content[0].text).toBe(
      "not_found (HTTP 404): Note not found.",
    );
  });

  it("the screen gets the code in the address", async () => {
    h.note.findFirst.mockResolvedValue(null);
    await expect(deleteNoteAction(form({ noteId: NOTE_ID }))).rejects.toThrow(
      `REDIRECT /notes/${NOTE_ID}?error=not_found`,
    );
  });

  it("only the owner changes who sees a note", async () => {
    h.note.findFirst.mockResolvedValue(
      stored({ visibility: "ORGANISATION", ownerUserId: "someone-else" }),
    );
    const res = await patchNoteRoute(
      req(`/api/v1/notes/${NOTE_ID}`, "user_rw", {
        method: "PATCH",
        body: { visibility: "private" },
      }),
      params,
    );
    expect(res.status).toBe(403);
    expect(h.note.update).not.toHaveBeenCalled();
  });

  it("update audits content and container changes as separate lines", async () => {
    const res = await patchNoteRoute(
      req(`/api/v1/notes/${NOTE_ID}`, "user_rw", {
        method: "PATCH",
        body: { title: "New", visibility: "organisation" },
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(audit.map((a) => a.line.action)).toEqual([
      "object.updated",
      "object.visibility_changed",
    ]);
    expect(audit[1].line.details).toEqual({
      from: "private",
      to: "organisation",
    });
  });
});

describe("worker-triggered route POST /api/v1/worker/expire-notes", () => {
  const run = (key: string, body: Record<string, unknown> = { olderThanDays: 30, dryRun: false }) =>
    expireRoute(
      req("/api/v1/worker/expire-notes", key, {
        method: "POST",
        body,
      }),
    );

  it("refuses a USER key, even one with every scope", async () => {
    const res = await run("user_legacy");
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("worker_only");
  });

  it("refuses a worker key without notes:delete", async () => {
    const res = await run("worker_rw");
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("insufficient_scope");
  });

  it("runs with a worker key that has the scopes, on organisation rows only, audited as System", async () => {
    const res = await run("worker_job");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: 2, expired: 2, dryRun: false } });
    expect(h.jobRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: "expire-notes" }, update: expect.objectContaining({ lastStatus: "complete" }) }),
    );
    const where = h.note.deleteMany.mock.calls[0][0].where.AND;
    expect(where[1]).toEqual({ visibility: "ORGANISATION" });
    expect(audit).toEqual([
      {
        actor: { system: true },
        line: {
          organisationId: ORG,
          action: "examplelab.notes_expired",
          details: { deleted: 2, olderThanDays: 30 },
        },
      },
    ]);
  });

  it("the scheduled caller (ops/cron/expire-notes.sh) sends dryRun: false and really deletes", async () => {
    const script = readFileSync(path.resolve(__dirname, "..", "..", "ops", "cron", "expire-notes.sh"), "utf8");
    const body = JSON.parse(/^BODY='(.+)'$/m.exec(script)?.[1] ?? "null") as Record<string, unknown>;
    expect(body.dryRun).toBe(false);
    const res = await run("worker_job", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: 2, expired: 2, dryRun: false } });
    expect(h.note.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("is a dry run unless the body says dryRun: false", async () => {
    const res = await run("worker_job", { olderThanDays: 30 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: 0, expired: 2, dryRun: true } });
    expect(h.note.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses through the deletion guard when one run would delete more than 10 %, and the job is incomplete", async () => {
    h.note.count.mockImplementation(async ({ where }: { where: { AND: unknown[] } }) => (where.AND.length > 2 ? 5 : 10));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lines = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await run("worker_job");
    expect(res.status).toBe(409);
    expect(h.note.deleteMany).not.toHaveBeenCalled();
    expect(lines.mock.calls.map((c) => String(c[0]))).toContain(
      "job=expire-notes status=incomplete counts=none error=conflict",
    );
    expect(h.jobRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ lastStatus: "incomplete" }) }),
    );
    errors.mockRestore();
    lines.mockRestore();
  });
});

describe("rate limit at the door", () => {
  it("answers 429 with Retry-After once a key is over its limit", async () => {
    vi.stubEnv("API_RATE_LIMIT_PER_MINUTE", "2");
    expect((await listNotesRoute(req("/api/v1/notes", "user_rw"))).status).toBe(
      200,
    );
    expect((await listNotesRoute(req("/api/v1/notes", "user_rw"))).status).toBe(
      200,
    );
    const refused = await listNotesRoute(req("/api/v1/notes", "user_rw"));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await errorCode(refused)).toBe("rate_limited");
    // Another key has its own budget.
    expect(
      (await listNotesRoute(req("/api/v1/notes", "user_read"))).status,
    ).toBe(200);
  });

  it("the MCP door has its own limit and answers JSON-RPC -32029", async () => {
    vi.stubEnv("MCP_RATE_LIMIT_PER_MINUTE", "1");
    await callTool("user_rw", "examplelab_list_notes", {});
    const res = await mcpRoute(
      req("/api/mcp", "user_rw", {
        method: "POST",
        body: rpc("examplelab_list_notes", {}),
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
      -32029,
    );
  });
});

describe("GET /api/v1/openapi.json", () => {
  it("is public and describes every REST function from the manifest, with scopes", async () => {
    const res = openApiRoute();
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/api/v1/notes",
      "/api/v1/notes/{noteId}",
      "/api/v1/worker/expire-notes",
    ]);
    expect(Object.keys(doc.paths["/api/v1/notes/{noteId}"]).sort()).toEqual([
      "delete",
      "get",
      "patch",
    ]);
    expect(
      doc.paths["/api/v1/notes/{noteId}"].delete["x-required-scopes"],
    ).toEqual(["write", "notes:delete"]);
    expect(doc.paths["/api/v1/worker/expire-notes"].post["x-worker-only"]).toBe(
      true,
    );
    const body = doc.paths["/api/v1/notes"].post.requestBody as {
      content: {
        "application/json": {
          schema: { required: string[]; properties: Record<string, unknown> };
        };
      };
    };
    expect(body.content["application/json"].schema.required).toEqual(["title"]);
    expect(
      Object.keys(body.content["application/json"].schema.properties),
    ).toEqual(["title", "body", "visibility"]);
    const query = doc.paths["/api/v1/notes"].get.parameters as {
      name: string;
      in: string;
    }[];
    expect(query.map((p) => `${p.in}:${p.name}`)).toEqual([
      "query:search",
      "query:limit",
    ]);
  });
});
