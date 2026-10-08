import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createOnBehalfClient, type OnBehalfTokenRequest } from "@/lib/platform/on-behalf";

/**
 * Lab-to-Lab calls (connection layer contract, stage 6, D6.13 and 2.7).
 *
 * A Lab that wants to use another Lab's tool asks the platform, with its OWN
 * service key, for an on-behalf token with `audience = <target Lab>`, and
 * calls the target's tool door with it. No Lab-to-Lab key, no shared secret.
 * The platform refuses a token for a Lab that is not released for the
 * organisation (`AUDIENCE_NOT_RELEASED`), and the target applies its own
 * rules for the person or agent named in the token.
 *
 * The target's address comes from the platform registry
 * (`GET /api/registry/products`, cached 5 minutes). A `401` from the target
 * drops the cached token and tries once more with a fresh one.
 *
 * Template only (the ports of stage 6 do not copy it); used from stage 7 on.
 * Node runtime only.
 */

export const REGISTRY_CACHE_MS = 5 * 60_000;

const CALL_TIMEOUT_MS = 30_000;
const REGISTRY_TIMEOUT_MS = 5_000;

/** Why a tool call did not reach a result. A tool's own error comes back as a result with `isError`. */
export class LabToolCallError extends Error {
  /** `TARGET_UNKNOWN`, `NO_TOOL_DOOR`, `REGISTRY_UNAVAILABLE`, `NETWORK`, `HTTP_<status>`, `RPC_<code>`, `BAD_RESPONSE`. */
  readonly code: string;
  /** HTTP status of the target or the registry; 0 when nobody answered. */
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "LabToolCallError";
    this.code = code;
    this.status = status;
  }
}

export interface LabToolCallRequest {
  /** Product key of the target Lab. */
  audience: string;
  organisationId: string;
  userId?: string | null;
  agent?: OnBehalfTokenRequest["agent"];
  /** The target's tool name, with its prefix. */
  tool: string;
  arguments?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON-RPC answer from a JSON body, or from the first `data:` line of an event stream. */
function parseRpcBody(contentType: string, body: string): unknown {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        try {
          return JSON.parse(line.slice(5).trim()) as unknown;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export function createLabToolClient(config: { platformApiUrl: string; apiKey: string; fetchImpl?: typeof fetch }): {
  callTool(request: LabToolCallRequest): Promise<CallToolResult>;
} {
  const base = config.platformApiUrl.trim().replace(/\/+$/, "");
  const doFetch: typeof fetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const tokens = createOnBehalfClient({ platformApiUrl: base, apiKey: config.apiKey, fetchImpl: doFetch });

  let registry: { doors: Map<string, string | null>; loadedAt: number } | null = null;

  async function loadRegistry(): Promise<Map<string, string | null>> {
    if (registry && Date.now() - registry.loadedAt < REGISTRY_CACHE_MS) return registry.doors;
    let response: Response;
    try {
      response = await doFetch(`${base}/api/registry/products`, {
        method: "GET",
        headers: { "X-API-Key": config.apiKey, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
    } catch {
      throw new LabToolCallError("REGISTRY_UNAVAILABLE", 0, "The platform registry did not answer.");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const products =
      response.ok && isRecord(body) && body.success === true && isRecord(body.data) && Array.isArray(body.data.products)
        ? body.data.products
        : null;
    if (!products) {
      throw new LabToolCallError("REGISTRY_UNAVAILABLE", response.status, "The platform registry answered with something this build cannot read.");
    }
    const doors = new Map<string, string | null>();
    for (const product of products) {
      if (!isRecord(product) || typeof product.key !== "string") continue;
      doors.set(product.key, typeof product.toolDoorUrl === "string" && product.toolDoorUrl ? product.toolDoorUrl : null);
    }
    registry = { doors, loadedAt: Date.now() };
    return doors;
  }

  async function post(url: string, token: string, payload: unknown): Promise<Response> {
    try {
      return await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      throw new LabToolCallError("NETWORK", 0, `The tool door at ${url} did not answer.`);
    }
  }

  return {
    async callTool(request: LabToolCallRequest): Promise<CallToolResult> {
      const doors = await loadRegistry();
      if (!doors.has(request.audience)) {
        throw new LabToolCallError("TARGET_UNKNOWN", 0, `The platform registry has no product "${request.audience}".`);
      }
      const url = doors.get(request.audience);
      if (!url) {
        throw new LabToolCallError("NO_TOOL_DOOR", 0, `The product "${request.audience}" has no tool door.`);
      }

      const tokenRequest: OnBehalfTokenRequest = {
        audience: request.audience,
        organisationId: request.organisationId,
        userId: request.userId ?? null,
        agent: request.agent ?? null,
      };
      const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: request.tool, arguments: request.arguments ?? {} },
      };

      let response = await post(url, await tokens.getToken(tokenRequest), payload);
      if (response.status === 401) {
        tokens.forget(tokenRequest);
        response = await post(url, await tokens.getToken(tokenRequest), payload);
      }

      const answer = parseRpcBody(response.headers.get("content-type") ?? "", await response.text());
      if (isRecord(answer) && isRecord(answer.error)) {
        const code = typeof answer.error.code === "number" ? answer.error.code : 0;
        const message = typeof answer.error.message === "string" ? answer.error.message : "The tool door refused the call.";
        throw new LabToolCallError(`RPC_${code}`, response.status, message);
      }
      if (!response.ok) {
        throw new LabToolCallError(`HTTP_${response.status}`, response.status, `The tool door answered HTTP ${response.status}.`);
      }
      if (!isRecord(answer) || !isRecord(answer.result) || !Array.isArray(answer.result.content)) {
        throw new LabToolCallError("BAD_RESPONSE", response.status, "The tool door answered with something this build cannot read.");
      }
      return answer.result as CallToolResult;
    },
  };
}
