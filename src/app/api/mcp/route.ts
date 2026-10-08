import { NextResponse, type NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { requireApiKey, type ApiKeyContext } from "@/lib/api-auth";
import { ApiError } from "@/lib/api-errors";
import { createMcpServer, resolveSelfBaseUrl, type McpCredential } from "@/lib/mcp/server";
import { onBehalfBearer } from "@/lib/tool-door/obo-door";

/**
 * `POST /api/mcp` — the Lab as a tool for agents, over HTTP.
 *
 * Streamable HTTP, stateless (`sessionIdGenerator: undefined`), JSON answers
 * (`enableJsonResponse: true`). The credential is checked BEFORE anything
 * else; the route is on the middleware's public list because an agent has no
 * Suite cookie. Its security boundary is `requireApiKey`, the same as
 * `/api/v1`: an `x-api-key` of this Lab, or an on-behalf token the platform
 * signed for this Lab (connection layer contract, stage 6).
 *
 * Nothing else happens here: no Prisma, no service. The tools call the own
 * `/api/v1` with exactly the credential this request carried
 * (`src/lib/mcp/server.ts`).
 */
export const dynamic = "force-dynamic";

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers: { ...headers, "Cache-Control": "no-store" } },
  );
}

/** HTTP status of a refusal → JSON-RPC error code (contract stage 6, 2.4). */
function rpcCodeFor(status: number): number {
  if (status === 400) return -32600;
  if (status === 401) return -32001;
  if (status === 403) return -32002;
  if (status === 429) return -32029;
  if (status === 503) return -32003;
  return -32603;
}

const ACCEPT = "application/json, text/event-stream";

/**
 * Streamable HTTP demands that the client accepts BOTH answer forms; the SDK
 * answers 406 otherwise. `curl` sends an Accept that names neither, so a
 * hand check would fail for the wrong reason. Missing forms are ADDED.
 */
async function withAcceptHeader(request: NextRequest): Promise<Request> {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json") && accept.includes("text/event-stream")) return request;
  const headers = new Headers(request.headers);
  headers.set("accept", ACCEPT);
  return new Request(request.url, { method: "POST", headers, body: await request.text() });
}

/** Exactly the credential that was accepted, for the self-call. Never both. */
function receivedCredential(request: Request, key: ApiKeyContext): McpCredential {
  if (key.via === "on-behalf") {
    const bearer = onBehalfBearer(request);
    const token = bearer && "token" in bearer ? bearer.token : "";
    return { header: "authorization", value: `Bearer ${token}` };
  }
  return { header: "x-api-key", value: request.headers.get("x-api-key")?.trim() ?? "" };
}

export async function POST(request: NextRequest): Promise<Response> {
  let key: ApiKeyContext;
  try {
    key = await requireApiKey(request);
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonRpcError(error.status, rpcCodeFor(error.status), error.message, error.headers);
    }
    console.error("[mcp] credential check failed:", error);
    return jsonRpcError(500, -32603, "Internal error in the MCP endpoint.");
  }

  const server = createMcpServer({
    baseUrl: resolveSelfBaseUrl(),
    credential: receivedCredential(request, key),
    caller: {
      via: key.via,
      callingProduct: key.onBehalf?.callingProduct ?? null,
      organisationId: key.organisationId,
      userId: key.onBehalf?.userId ?? key.createdByUserId,
      agentLevel: key.onBehalf?.agent?.level ?? null,
      tokenId: key.onBehalf?.tokenId ?? null,
    },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(await withAcceptHeader(request));
  } catch (error) {
    console.error("[mcp] request failed:", error);
    return jsonRpcError(500, -32603, "Internal error in the MCP endpoint.");
  } finally {
    await server.close().catch((error: unknown) => console.error("[mcp] server close failed:", error));
    await transport.close().catch((error: unknown) => console.error("[mcp] transport close failed:", error));
  }
}

/** GET/DELETE belong to the session mechanics of Streamable HTTP; stateless has none. */
export function GET(): NextResponse {
  return jsonRpcError(405, -32601, "This MCP endpoint is stateless — use POST.");
}

export function DELETE(): NextResponse {
  return jsonRpcError(405, -32601, "This MCP endpoint is stateless — nothing to end.");
}
