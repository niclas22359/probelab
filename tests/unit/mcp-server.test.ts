import { afterEach, describe, expect, it, vi } from "vitest";

import { TOOL_DEFINITIONS, TOOL_NAMES, type ToolDefinition } from "@/lib/mcp/catalog";
import { callTool, listTools, resolveSelfBaseUrl, type McpServerContext } from "@/lib/mcp/server";
import { LAB_KEY } from "@/lib/lab";

const ORG = "11111111-1111-4111-8111-111111111111";

/** A key caller's context; the credential is passed on unchanged. */
function keyContext(baseUrl: string, apiKey: string, fetchImpl?: typeof fetch): McpServerContext {
  return {
    baseUrl,
    credential: { header: "x-api-key", value: apiKey },
    caller: { via: "api-key", callingProduct: null, organisationId: ORG, userId: null, agentLevel: null, tokenId: null },
    fetchImpl,
  };
}

describe("MCP catalogue", () => {
  it("every tool carries the Lab prefix, a description and an object schema", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name.startsWith(`${LAB_KEY}_`)).toBe(true);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
    }
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it("maps arguments to the v1 door", () => {
    const list = TOOL_DEFINITIONS.find((t) => t.name === `${LAB_KEY}_list_notes`)!;
    expect(list.toCall({ search: "x y", limit: 5 })).toEqual({ method: "GET", path: "/api/v1/notes?search=x+y&limit=5" });
    const create = TOOL_DEFINITIONS.find((t) => t.name === `${LAB_KEY}_create_note`)!;
    // `visibility` is optional since stage 6: a collection agent must name none (contract 2.7).
    expect(create.inputSchema.required).toEqual(["title"]);
    expect(create.inputSchema.properties).toHaveProperty("visibility");
    expect(create.toCall({ title: "T", visibility: "organisation" })).toEqual({
      method: "POST",
      path: "/api/v1/notes",
      body: { title: "T", body: "", visibility: "organisation" },
    });
    expect(create.toCall({ title: "T" })).toEqual({
      method: "POST",
      path: "/api/v1/notes",
      body: { title: "T", body: "" },
    });
  });
});

describe("callTool", () => {
  it("calls the own v1 door with the same key and returns JSON as text", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await callTool(keyContext("http://127.0.0.1:3000", "k1", fetchImpl), `${LAB_KEY}_list_notes`, {});
    expect(seen[0].url).toBe("http://127.0.0.1:3000/api/v1/notes");
    expect(seen[0].headers["x-api-key"]).toBe("k1");
    expect(result.isError).toBeUndefined();
  });

  it("turns an HTTP error into a tool error, not an exception", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const result = await callTool(keyContext("http://x", "k", fetchImpl), `${LAB_KEY}_get_note`, { noteId: "1" });
    expect(result.isError).toBe(true);
  });

  it("rejects unknown tools", async () => {
    const result = await callTool(keyContext("http://x", "k"), "nothing", {});
    expect(result.isError).toBe(true);
  });

  it("forwards exactly the received credential: the key, or the token, never both", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await callTool(keyContext("http://127.0.0.1:3000", "examplelab_key", fetchImpl), `${LAB_KEY}_list_notes`, {});
    await callTool(
      {
        baseUrl: "http://127.0.0.1:3000",
        credential: { header: "authorization", value: "Bearer the.on-behalf.token" },
        caller: {
          via: "on-behalf",
          callingProduct: "bookinglab",
          organisationId: ORG,
          userId: null,
          agentLevel: "organisation",
          tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        },
        fetchImpl,
      },
      `${LAB_KEY}_create_note`,
      { title: "T" },
    );
    expect(seen[0]).toEqual({ "x-api-key": "examplelab_key" });
    expect(seen[1]).toEqual({ authorization: "Bearer the.on-behalf.token", "Content-Type": "application/json" });
  });

  it("writes one log line per call, with the outcome and without arguments", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await callTool(keyContext("http://x", "k", fetchImpl), `${LAB_KEY}_get_note`, { noteId: "secret-argument" });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toBe(
      `[tool-door] via=api-key cp=- org=${ORG} sub=- agent=- tool=${LAB_KEY}_get_note outcome=error jti=-`,
    );
    expect(line).not.toContain("secret-argument");
    log.mockRestore();
  });
});

describe("listTools (tools/list)", () => {
  it("every tool carries title and annotations from its marker", () => {
    const tools = listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.annotations).toMatchObject({ title: tool.title, openWorldHint: false });
    }
    expect(tools.find((t) => t.name === `${LAB_KEY}_create_note`)?.annotations).toEqual({
      title: "Create a note",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("carries _meta only on a tool with a capability", () => {
    const sender: ToolDefinition = {
      name: `${LAB_KEY}_send_note`,
      description: "Test entry: sends a note by mail to a person outside the organisation.",
      inputSchema: { type: "object", properties: {} },
      scopes: ["write"],
      access: "destructive",
      idempotent: false,
      title: { de: "Notiz senden", en: "Send a note" },
      capability: "mail.send",
      toCall: () => ({ method: "POST", path: "/api/v1/notes/send" }),
    };
    const tools = listTools([...TOOL_DEFINITIONS, sender]);
    expect(tools.filter((t) => "_meta" in t).map((t) => [t.name, t._meta])).toEqual([
      [`${LAB_KEY}_send_note`, { "ai.beyondles/capability": "mail.send" }],
    ]);
    expect(tools.find((t) => t.name === `${LAB_KEY}_send_note`)?.annotations?.destructiveHint).toBe(true);
  });
});

describe("resolveSelfBaseUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never takes the address from the request: override, then PORT, then dev", () => {
    vi.stubEnv("MCP_SELF_BASE_URL", "http://proxy:9/");
    expect(resolveSelfBaseUrl()).toBe("http://proxy:9");
    vi.stubEnv("MCP_SELF_BASE_URL", "");
    vi.stubEnv("PORT", "3000");
    expect(resolveSelfBaseUrl()).toBe("http://127.0.0.1:3000");
    vi.stubEnv("PORT", "");
    expect(resolveSelfBaseUrl()).toBe("http://127.0.0.1:3390");
  });
});
