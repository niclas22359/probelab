import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { checkExportKey } from "@/lib/platform-export-auth";
import { exportOrganisation } from "@/server/services/platform-export";

/**
 * `GET /api/platform/export?organisationId=<uuid>` — the tenant export for
 * the Beyondles platform (one zip per customer, fanned out to every Lab).
 *
 * Rules (SIDE-PROJECTS.md, "Every Lab implements the export endpoint"):
 *  - security boundary is `X-API-Key` against `PLATFORM_EXPORT_KEY`, constant
 *    time; unset key = `503 EXPORT_NOT_CONFIGURED`, never open;
 *  - `organisationId` validated as a well-formed uuid and no more;
 *  - the requested `organisationId` is echoed back unchanged;
 *  - an organisation this Lab never saw is NOT an error: `200` + `entities: {}`;
 *  - `Cache-Control: no-store` on EVERY answer, errors included;
 *  - answer within 120 s.
 */
export const dynamic = "force-dynamic";

// Well-formed uuid and NO MORE: zod's `.uuid()` also pins version and variant
// digits, which the contract says not to do (sign-in accepts any 8-4-4-4-12).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const querySchema = z.object({ organisationId: z.string().regex(UUID) });

function fail(status: number, code: string, message: string) {
  return NextResponse.json(
    { success: false, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = checkExportKey(request);
  if (!auth.ok) return fail(auth.status, auth.code, auth.message);

  const parsed = querySchema.safeParse({
    organisationId: request.nextUrl.searchParams.get("organisationId") ?? "",
  });
  if (!parsed.success) return fail(400, "VALIDATION", "organisationId (uuid) missing or invalid.");

  try {
    const data = await exportOrganisation(parsed.data.organisationId);
    return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[platform/export] export failed:", error);
    return fail(500, "INTERNAL", "Export failed.");
  }
}
