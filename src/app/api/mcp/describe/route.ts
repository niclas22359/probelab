import { requireApiKey } from "@/lib/api-auth";
import { apiJson, withErrorEnvelope } from "@/lib/api-errors";
import { LAB_KEY, LAB_NAME, TOOL_PREFIX } from "@/lib/lab";
import { TOOLS_BY_NAME, TOOL_DEFINITIONS } from "@/lib/mcp/catalog";
import { hasScopes } from "@/lib/scopes";
import { MCP_SERVER_VERSION } from "@/lib/mcp/server";
import { describeToolDoor } from "@/lib/tool-door/describe";

/**
 * `GET /api/mcp/describe` — what this Lab's tool door offers, in one answer
 * (connection layer contract, stage 6, 2.4): every tool with its title in
 * German and English, what it does (`access`, `idempotent`, `capability`) and
 * whether the caller's credential covers it (`available`).
 *
 * Same credential and checks as `POST /api/mcp` (an `x-api-key` of this Lab,
 * release gate included, or an on-behalf token for this Lab). Errors come in
 * the Lab's own JSON envelope (`src/lib/api-errors.ts`). The middleware lets
 * it through as part of `/api/mcp`.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withErrorEnvelope(async () => {
    const key = await requireApiKey(request);
    return apiJson(
      describeToolDoor({
        product: LAB_KEY,
        name: LAB_NAME,
        version: MCP_SERVER_VERSION,
        toolPrefix: TOOL_PREFIX,
        appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null,
        tools: TOOL_DEFINITIONS,
        // Available = the caller's credential carries every scope the tool declares.
        isAvailable: (name) => hasScopes(key.scopes, TOOLS_BY_NAME.get(name)?.scopes ?? []),
      }),
    );
  });
}
