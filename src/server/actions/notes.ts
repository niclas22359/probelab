"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { uiActor, type Actor } from "@/lib/actor";
import { requireAccessOrNull } from "@/lib/rbac";
import { actionErrorCode } from "@/lib/service-errors";
import { noteInputSchema, noteUpdateSchema } from "@/server/schemas/notes";
import { createNote, deleteNote, updateNote } from "@/server/services/notes";

/**
 * Server actions behind the notes screen — thin adapters, like the routes:
 * check access ITSELF (a layout is not a security boundary), parse with the
 * same schema, build the actor, call the same service, map the error with the
 * one mapping (`actionErrorCode`). Audit and container choice happen in the
 * service, never here.
 */

async function actor(): Promise<Actor> {
  const ctx = await requireAccessOrNull();
  if (!ctx) redirect("/kein-zugriff");
  return uiActor(ctx);
}

/** Runs the service call; returns the error code or `null`. Redirects stay outside the try. */
async function attempt(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (error) {
    return actionErrorCode(error);
  }
}

function visibilityOf(formData: FormData): string | undefined {
  const value = formData.get("visibility");
  return typeof value === "string" && value ? value : undefined;
}

export async function createNoteAction(formData: FormData): Promise<void> {
  const who = await actor();
  const parsed = noteInputSchema.safeParse({
    title: formData.get("title"),
    body: formData.get("body") ?? "",
    visibility: visibilityOf(formData),
  });
  if (!parsed.success) redirect("/notes?error=invalid_request");

  const error = await attempt(() => createNote(who, parsed.data));
  revalidatePath("/notes");
  redirect(error ? `/notes?error=${error}` : "/notes");
}

export async function updateNoteAction(formData: FormData): Promise<void> {
  const who = await actor();
  const noteId = String(formData.get("noteId") ?? "");
  const back = `/notes/${encodeURIComponent(noteId)}`;
  const parsed = noteUpdateSchema.safeParse({
    title: formData.get("title") ?? undefined,
    body: formData.get("body") ?? undefined,
    visibility: visibilityOf(formData),
  });
  if (!parsed.success) redirect(`${back}?error=invalid_request`);

  const error = await attempt(() => updateNote(who, noteId, parsed.data));
  revalidatePath("/notes");
  revalidatePath(back);
  redirect(error ? `${back}?error=${error}` : back);
}

export async function deleteNoteAction(formData: FormData): Promise<void> {
  const who = await actor();
  const noteId = String(formData.get("noteId") ?? "");
  const error = await attempt(() => deleteNote(who, noteId));
  revalidatePath("/notes");
  redirect(error ? `/notes/${encodeURIComponent(noteId)}?error=${error}` : "/notes");
}
