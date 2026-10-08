import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { VisibilityBadge, type Visibility } from "@/components/share";
import { NoteVisibilityField } from "@/components/notes/note-visibility-field";
import { NoteError } from "@/components/notes/note-error";
import { uiActor } from "@/lib/actor";
import { requireAccess } from "@/lib/rbac";
import { allowedVisibilities } from "@/lib/access-rules";
import { listNotes } from "@/server/services/notes";
import { createNoteAction } from "@/server/actions/notes";

/**
 * Worked example of a tenant object: list + create; each note links to its
 * page (read, change, delete). The page and the form call the SAME service
 * functions as `/api/v1/notes` and the MCP tools (functions manifest).
 */
export default async function NotesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireAccess();
  const { access } = ctx;
  const t = await getTranslations("notes");
  const format = await getFormatter();
  const notes = await listNotes(uiActor(ctx), { limit: 50 });
  const allowed = allowedVisibilities(access);
  const { error } = await searchParams;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-zinc-600">{t("intro")}</p>
      </div>

      <NoteError code={error} />

      <form action={createNoteAction} className="space-y-3 rounded-lg border bg-white p-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t("newTitle")}</span>
          <input name="title" required maxLength={200} className="w-full rounded border px-2 py-1" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t("newBody")}</span>
          <textarea name="body" maxLength={20000} rows={3} className="w-full rounded border px-2 py-1" />
        </label>
        <NoteVisibilityField
          personalAllowed={allowed.includes("PRIVATE")}
          organisationAllowed={allowed.includes("ORGANISATION")}
        />
        <button type="submit" className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white">
          {t("create")}
        </button>
      </form>

      {notes.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((note) => (
            <li key={note.id} className="rounded-lg border bg-white p-3">
              <Link href={`/notes/${note.id}`} className="font-medium underline-offset-2 hover:underline">
                {note.title}
              </Link>
              {note.body ? <p className="whitespace-pre-wrap text-sm text-zinc-700">{note.body}</p> : null}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <VisibilityBadge
                  visibility={note.visibility.toLowerCase() as Visibility}
                  collectionName={access.collections.find((c) => c.id === note.collectionId)?.name}
                />
                <span>
                  {t("created", { date: format.dateTime(note.createdAt, { dateStyle: "medium" }) })}
                  {note.ownerUserId === access.userId ? ` · ${t("ownerYou")}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
