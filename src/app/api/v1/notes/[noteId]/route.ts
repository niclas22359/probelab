import { apiJson, readJson, withErrorEnvelope, zodToApiError } from "@/lib/api-errors";
import { openMachineDoor } from "@/server/machine-door";
import { noteUpdateSchema } from "@/server/schemas/notes";
import { deleteNote, getNote, updateNote } from "@/server/services/notes";

/**
 * One note through the HTTP door — thin adapters like `../route.ts`.
 *   GET    /api/v1/notes/:noteId   getNote     (read)
 *   PATCH  /api/v1/notes/:noteId   updateNote  (write)
 *   DELETE /api/v1/notes/:noteId   deleteNote  (write + notes:delete)
 */
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ noteId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return withErrorEnvelope(async () => {
    const actor = await openMachineDoor(request, "getNote");
    const { noteId } = await context.params;
    return apiJson({ data: await getNote(actor, noteId) });
  });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withErrorEnvelope(async () => {
    const actor = await openMachineDoor(request, "updateNote");
    const { noteId } = await context.params;
    const parsed = noteUpdateSchema.safeParse(await readJson(request));
    if (!parsed.success) throw zodToApiError(parsed.error);
    return apiJson({ data: await updateNote(actor, noteId, parsed.data) });
  });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withErrorEnvelope(async () => {
    const actor = await openMachineDoor(request, "deleteNote");
    const { noteId } = await context.params;
    return apiJson({ data: await deleteNote(actor, noteId) });
  });
}
