import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { checkDeleteKey } from "@/lib/platform-delete-auth";
import { deleteOrganisation } from "@/server/services/platform-delete";

/**
 * `DELETE /api/platform/organisation?organisationId=<uuid>&runId=<uuid>` —
 * the tenant deletion for the Beyondles platform (one erasure per customer,
 * fanned out to every Lab). The counterpart of `GET /api/platform/export`.
 *
 * Rules (SIDE-PROJECTS.md, "Every Lab implements the deletion endpoint"):
 *  - security boundary is `X-API-Key` against `PLATFORM_DELETE_KEY`, constant
 *    time; unset key = `503 DELETE_NOT_CONFIGURED`, never open, and never a
 *    fallback to the export key;
 *  - `organisationId` and `runId` validated as well-formed uuids and no more;
 *  - both are echoed back unchanged; `runId` ties this Lab's lines to the
 *    platform's deletion log;
 *  - the answer lists one item per tenant table and per external store, each
 *    with a count and an outcome; `ok` is `true` only when no item failed;
 *  - an organisation this Lab never saw is NOT an error: `200`, `ok: true`,
 *    every item `skipped`. That is also what a repeated run answers;
 *  - `Cache-Control: no-store` on EVERY answer, errors included;
 *  - answer within 120 s.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const querySchema = z.object({ organisationId: z.string().regex(UUID), runId: z.string().regex(UUID) });

function fail(status: number, code: string, message: string) {
  return NextResponse.json(
    { success: false, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const auth = checkDeleteKey(request);
  if (!auth.ok) return fail(auth.status, auth.code, auth.message);

  const parsed = querySchema.safeParse({
    organisationId: request.nextUrl.searchParams.get("organisationId") ?? "",
    runId: request.nextUrl.searchParams.get("runId") ?? "",
  });
  if (!parsed.success) return fail(400, "VALIDATION", "organisationId and runId (uuid) missing or invalid.");

  try {
    const data = await deleteOrganisation(parsed.data.organisationId, parsed.data.runId);
    return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[platform/delete] deletion failed:", error);
    return fail(500, "INTERNAL", "Deletion failed.");
  }
}
