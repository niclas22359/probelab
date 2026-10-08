import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { checkDeleteKey } from "@/lib/platform-delete-auth";
import { deletePerson } from "@/server/services/platform-delete-member";

/**
 * `DELETE /api/platform/member?organisationId=&userId=&toUserId=&runId=` -
 * the person deletion for the Beyondles platform: one Suite user erased from
 * this Lab inside one organisation. Sits next to the organisation door
 * (`/api/platform/organisation`) and shares its key.
 *
 * Rules:
 *  - `X-API-Key` against `PLATFORM_DELETE_KEY`, constant time; unset key is
 *    `503 DELETE_NOT_CONFIGURED`; no fallback to any other key. The check
 *    runs before anything else;
 *  - all four ids are well-formed uuids, else `400 VALIDATION`; `toUserId`
 *    (the successor for shared rows) must differ from `userId`;
 *  - the answer is the organisation door's envelope plus `userId`;
 *  - a person or organisation this Lab never saw is NOT an error: `200`,
 *    `ok: true`, every item `skipped`. That is also what a repeated run
 *    answers;
 *  - `Cache-Control: no-store` on EVERY answer, errors included.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const querySchema = z
  .object({
    organisationId: z.string().regex(UUID),
    userId: z.string().regex(UUID),
    toUserId: z.string().regex(UUID),
    runId: z.string().regex(UUID),
  })
  .refine((q) => q.userId.toLowerCase() !== q.toUserId.toLowerCase());

function fail(status: number, code: string, message: string) {
  return NextResponse.json(
    { success: false, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const auth = checkDeleteKey(request);
  if (!auth.ok) return fail(auth.status, auth.code, auth.message);

  const params = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    organisationId: params.get("organisationId") ?? "",
    userId: params.get("userId") ?? "",
    toUserId: params.get("toUserId") ?? "",
    runId: params.get("runId") ?? "",
  });
  if (!parsed.success) {
    return fail(
      400,
      "VALIDATION",
      "organisationId, userId, toUserId and runId must be uuids, and toUserId must differ from userId.",
    );
  }

  try {
    const { organisationId, userId, toUserId, runId } = parsed.data;
    const data = await deletePerson(organisationId, userId, toUserId, runId);
    return NextResponse.json(
      { success: true, data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[platform/delete-member] deletion failed:", error);
    return fail(500, "INTERNAL", "Deletion failed.");
  }
}
