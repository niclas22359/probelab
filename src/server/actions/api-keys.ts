"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { NEW_KEY_COOKIE } from "@/lib/api-keys";
import { normaliseKeyScopes } from "@/lib/scopes";
import { requireAccessOrNull, requireFreshAccessOrNull } from "@/lib/rbac";
import { createApiKey, revokeApiKey } from "@/server/services/api-keys";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["user", "worker"]).default("user"),
});

/**
 * Only product admins manage keys. Creating one asks the platform NOW, not
 * from its 60 s cache: a key minted from a session whose token the platform
 * already refuses would be younger than the token floor and outlive it.
 */
export async function createApiKeyAction(formData: FormData): Promise<void> {
  const ctx = await requireFreshAccessOrNull();
  if (!ctx || !ctx.isAdmin) redirect("/kein-zugriff");

  const parsed = createSchema.safeParse({ name: formData.get("name"), kind: formData.get("kind") ?? "user" });
  // Scopes: the ticked boxes; none = read only (`normaliseKeyScopes`).
  const scopes = normaliseKeyScopes(formData.getAll("scopes"));
  if (!parsed.success) redirect("/settings?error=invalid");

  const { plaintext } = await createApiKey({
    organisationId: ctx.organisationId,
    name: parsed.data.name,
    kind: parsed.data.kind,
    createdByUserId: ctx.session.userId,
    scopes,
  });
  const jar = await cookies();
  jar.set(NEW_KEY_COOKIE, plaintext, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/settings",
    maxAge: 60,
  });
  revalidatePath("/settings");
  redirect("/settings");
}

/** Removes the flash cookie once the person has copied the key. */
export async function dismissNewKeyAction(): Promise<void> {
  const jar = await cookies();
  jar.delete({ name: NEW_KEY_COOKIE, path: "/settings" });
  redirect("/settings");
}

export async function revokeApiKeyAction(formData: FormData): Promise<void> {
  const ctx = await requireAccessOrNull();
  if (!ctx || !ctx.isAdmin) redirect("/kein-zugriff");

  const keyId = String(formData.get("keyId") ?? "");
  if (keyId) await revokeApiKey(ctx.organisationId, keyId);
  revalidatePath("/settings");
  redirect("/settings");
}
