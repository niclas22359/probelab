import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { LAB_KEY, LAB_NAME } from "@/lib/lab";
import {
  TOOLS_BY_NAME,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  type ToolArguments,
  type ToolDefinition,
} from "@/lib/mcp/catalog";
import { logToolCall } from "@/lib/tool-door/call-log";
import { toolAnnotations, toolMeta } from "@/lib/tool-door/markers";
import { toolErrorFromHttp } from "@/lib/service-errors";

/**
 * The Lab's MCP server — built per request, stateless.
 *
 * One server per request: the credential of the request decides organisation
 * and view; a server living across requests would have to forget the previous
 * caller, which is exactly the kind of bug nobody notices until one
 * organisation sees another's rows.
 *
 * No database access: `tools/call` calls the own HTTP door `/api/v1` with
 * EXACTLY the credential the request carried — `x-api-key: <key>` or
 * `Authorization: Bearer <on-behalf token>`, never both. The MCP path cannot
 * bypass the access model because it takes the same path as every foreign
 * caller.
 */

export const MCP_SERVER_VERSION = "1.0.0";

const V1_TIMEOUT_MS = 15_000;

/** The credential of the incoming request, passed on unchanged. */
export type McpCredential =
  | { header: "x-api-key"; value: string }
  /** `value` is the whole header value, `Bearer <on-behalf token>`. */
  | { header: "authorization"; value: string };

export interface McpServerContext {
  /** Base URL of the own app, without trailing slash. */
  baseUrl: string;
  credential: McpCredential;
  /** Who calls, for the one log line per `tools/call`. */
  caller: {
    via: "api-key" | "on-behalf";
    callingProduct: string | null;
    organisationId: string;
    userId: string | null;
    agentLevel: string | null;
    tokenId: string | null;
  };
  fetchImpl?: typeof fetch;
}

/**
 * Where the own base URL comes from — and why NOTHING of it comes from the
 * request. The Host header belongs to the CALLER; using it as the target of
 * the self-call would let a stranger decide where this server sends the
 * credential. Seven Labs share loopback ports on the Playground.
 *
 * 1. `MCP_SELF_BASE_URL` if set (proxy, other network namespace).
 * 2. `http://127.0.0.1:${PORT}` — the runtime container sets PORT=3000.
 * 3. `http://127.0.0.1:3390` — `next dev` without PORT.
 */
export function resolveSelfBaseUrl(): string {
  const override = process.env.MCP_SELF_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  const port = process.env.PORT?.trim();
  if (port) return `http://127.0.0.1:${port}`;
  return "http://127.0.0.1:3390";
}

function asText(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** An error of the v1 door becomes a RESULT, not an abort: a model can act on it. */
function asError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function shorten(text: string, limit = 500): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * The `tools/list` entries: name, description, schema, plus `title` and the
 * MCP `annotations` from the tool's marker, and `_meta` with the capability
 * tag only on a tool that has one. Exported for the unit test.
 */
export function listTools(definitions: readonly ToolDefinition[] = TOOL_DEFINITIONS): Tool[] {
  return definitions.map((t) => {
    const meta = toolMeta(t);
    return {
      name: t.name,
      title: t.title.en,
      description: t.description,
      // Literal JSON Schema from the catalogue; the SDK types properties as objects.
      inputSchema: t.inputSchema as Tool["inputSchema"],
      annotations: toolAnnotations(t),
      ...(meta ? { _meta: meta } : {}),
    };
  });
}

async function runTool(context: McpServerContext, name: string, args: ToolArguments): Promise<CallToolResult> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return asError(`Unknown tool: ${name}. Available: ${TOOL_NAMES.join(", ")}.`);

  const call = tool.toCall(args);
  const fetchImpl = context.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(`${context.baseUrl}${call.path}`, {
      method: call.method,
      headers: {
        [context.credential.header]: context.credential.value,
        ...(call.body ? { "Content-Type": "application/json" } : {}),
      },
      body: call.body ? JSON.stringify(call.body) : undefined,
      signal: AbortSignal.timeout(V1_TIMEOUT_MS),
      // A redirect would never be right here (login page or foreign host).
      redirect: "manual",
    });
    const body = await res.text();
    // The one error mapping (src/lib/service-errors.ts): `<code> (HTTP <status>): <message>`.
    if (!res.ok) return toolErrorFromHttp(res.status, body);
    try {
      return asText(JSON.parse(body) as unknown);
    } catch {
      return asError(`Error in ${name}: the HTTP door did not return JSON: ${shorten(body)}`);
    }
  } catch (error) {
    console.error(`[mcp] tool ${name} failed:`, error);
    return asError(
      `Error in ${name}: ${LAB_NAME} was not reachable (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/** Exported so the unit test can call it without HTTP server or MCP client. Writes the one log line per call. */
export async function callTool(
  context: McpServerContext,
  name: string,
  args: ToolArguments,
): Promise<CallToolResult> {
  const result = await runTool(context, name, args);
  logToolCall({
    via: context.caller.via,
    callingProduct: context.caller.callingProduct,
    organisationId: context.caller.organisationId,
    userId: context.caller.userId,
    agentLevel: context.caller.agentLevel,
    tool: name,
    outcome: result.isError ? "error" : "ok",
    tokenId: context.caller.tokenId,
  });
  return result;
}

export function createMcpServer(context: McpServerContext): Server {
  const server = new Server(
    { name: LAB_KEY, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        `${LAB_NAME} for one organisation. Every tool acts only on the organisation ` +
        "the credential belongs to, and only on the rows the person or agent behind it may see.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> =>
      callTool(context, request.params.name, (request.params.arguments ?? {}) as ToolArguments),
  );

  return server;
}
