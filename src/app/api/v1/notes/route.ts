import { apiJson, readJson, withErrorEnvelope, zodToApiError } from "@/lib/api-errors";
import { openMachineDoor } from "@/server/machine-door";
import { listNotesQuerySchema, noteInputSchema } from "@/server/schemas/notes";
import { createNote, listNotes } from "@/server/services/notes";

/**
 * HTTP door for notes — a thin adapter: parse, open the door for the
 * function (credential, rate limit, scopes, actor), call the service, answer.
 *   GET  /api/v1/notes?search=&limit=   listNotes   (scope read)
 *   POST /api/v1/notes                  createNote  (scope write)
 * Errors: `withErrorEnvelope` maps service errors (src/lib/service-errors.ts).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withErrorEnvelope(async () => {
    const actor = await openMachineDoor(request, "listNotes");
    const url = new URL(request.url);
    const parsed = listNotesQuerySchema.safeParse({
      search: url.searchParams.get("search") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) throw zodToApiError(parsed.error);
    return apiJson({ data: await listNotes(actor, parsed.data) });
  });
}

export async function POST(request: Request): Promise<Response> {
  return withErrorEnvelope(async () => {
    const actor = await openMachineDoor(request, "createNote");
    const parsed = noteInputSchema.safeParse(await readJson(request));
    if (!parsed.success) throw zodToApiError(parsed.error);
    return apiJson({ data: await createNote(actor, parsed.data) }, 201);
  });
}
