import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { NoteError } from "@/components/notes/note-error";
import { uiActor } from "@/lib/actor";
import { canEdit } from "@/lib/access-rules";
import { requireAccess } from "@/lib/rbac";
import { ServiceError } from "@/lib/service-errors";
import { deleteNoteAction, updateNoteAction } from "@/server/actions/notes";
import { getNote } from "@/server/services/notes";

/**
 * One note: read (`getNote`), change (`updateNote`), delete (`deleteNote`) —
 * the same functions as `GET/PATCH/DELETE /api/v1/notes/:id` and the tools
 * `get_note`, `update_note`, `delete_note`.
 */
export default async function NotePage({
  params,
  searchParams,
}: {
  params: Promise<{ noteId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const ctx = await requireAccess();
  const t = await getTranslations("notes");
  const { noteId } = await params;
  const { error } = await searchParams;

  let note: Awaited<ReturnType<typeof getNote>>;
  try {
    note = await getNote(uiActor(ctx), noteId);
  } catch (e) {
    if (e instanceof ServiceError && e.code === "not_found") notFound();
    throw e;
  }
  const editable = canEdit(ctx.access, "note", note);

  return (
    <div className="space-y-6">
      <Link href="/notes" className="text-sm underline">
        {t("back")}
      </Link>
      <NoteError code={error} />

      {editable ? (
        <>
          <form
            action={updateNoteAction}
            className="space-y-3 rounded-lg border bg-white p-4"
          >
            <input type="hidden" name="noteId" value={note.id} />
            <label className="block text-sm">
              <span className="mb-1 block font-medium">{t("newTitle")}</span>
              <input
                name="title"
                required
                maxLength={200}
                defaultValue={note.title}
                className="w-full rounded border px-2 py-1"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">{t("newBody")}</span>
              <textarea
                name="body"
                maxLength={20000}
                rows={6}
                defaultValue={note.body}
                className="w-full rounded border px-2 py-1"
              />
            </label>
            <button
              type="submit"
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white"
            >
              {t("save")}
            </button>
          </form>
          <form action={deleteNoteAction}>
            <input type="hidden" name="noteId" value={note.id} />
            <button
              type="submit"
              className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
            >
              {t("delete")}
            </button>
          </form>
        </>
      ) : (
        <div className="rounded-lg border bg-white p-4">
          <h1 className="text-xl font-semibold">{note.title}</h1>
          <p className="whitespace-pre-wrap text-sm text-zinc-700">
            {note.body}
          </p>
          <p className="mt-2 text-xs text-zinc-500">{t("readOnly")}</p>
        </div>
      )}
    </div>
  );
}
