import { NextResponse, type NextRequest } from "next/server";

import { LAB_KEY } from "@/lib/lab";
import { checkExportKey } from "@/lib/platform-export-auth";
import { reassignOwner } from "@/server/services/platform-reassign";

/**
 * `POST /api/platform/reassign-owner` — the platform's offboarding call
 * (the Lab standard, the same shape in every Lab).
 *
 * When a person leaves an organisation, the platform cleans up its own tables
 * and then asks EVERY product to hand over what the person owns
 * (`src/server/services/platform-reassign.ts`).
 *
 * Rules:
 *  - security boundary is `X-API-Key` against `PLATFORM_EXPORT_KEY`, constant
 *    time; unset key = `503 EXPORT_NOT_CONFIGURED`, wrong = `401 UNAUTHORIZED`;
 *  - body `{ organisationId, fromUserId, toUserId }`, all uuids, two different
 *    people, else `400 VALIDATION`;
 *  - an organisation this Lab never saw, and a second run, answer `200` with
 *    zeros (never `404`: the platform asks every product);
 *  - `Cache-Control: no-store` on every answer.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Well-formed uuid and no more, as the export route.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { success: false, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = checkExportKey(request);
  if (!auth.ok) return fail(auth.status, auth.code, auth.message);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VALIDATION", "A JSON body is required.");
  }
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const organisationId = text(input.organisationId);
  const fromUserId = text(input.fromUserId);
  const toUserId = text(input.toUserId);

  if (!UUID.test(organisationId) || !UUID.test(fromUserId) || !UUID.test(toUserId)) {
    return fail(400, "VALIDATION", "organisationId, fromUserId and toUserId must be uuids.");
  }
  if (fromUserId.toLowerCase() === toUserId.toLowerCase()) {
    return fail(400, "VALIDATION", "fromUserId and toUserId must be two different people.");
  }

  try {
    const result = await reassignOwner(organisationId, fromUserId, toUserId);
    return NextResponse.json(
      {
        success: true,
        data: {
          source: LAB_KEY,
          organisationId,
          reassigned: result.reassigned,
          revokedApiKeys: result.revokedApiKeys,
        },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[platform/reassign-owner] failed:", error);
    return fail(500, "INTERNAL", "The hand-over failed.");
  }
}
