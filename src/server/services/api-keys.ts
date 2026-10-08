import "server-only";

import { db } from "@/lib/db";
import { createApiKeySecret } from "@/lib/api-keys";
import { normaliseKeyScopes, type Scope } from "@/lib/scopes";

/** API keys of one organisation. The plaintext is returned exactly once. */

export async function listApiKeys(organisationId: string) {
  return db.apiKey.findMany({
    where: { organisationId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      kind: true,
      scopes: true,
      createdByUserId: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
}

export async function createApiKey(input: {
  organisationId: string;
  name: string;
  kind: "user" | "worker";
  createdByUserId: string;
  /** Normalised here: unknown values dropped, nothing usable = read only. */
  scopes: readonly Scope[];
}): Promise<{ id: string; plaintext: string }> {
  const { plaintext, hash } = createApiKeySecret();
  const row = await db.apiKey.create({
    data: {
      organisationId: input.organisationId,
      name: input.name,
      keyHash: hash,
      kind: input.kind === "worker" ? "WORKER" : "USER",
      scopes: normaliseKeyScopes(input.scopes),
      // A worker key has no person behind it — on purpose.
      createdByUserId: input.kind === "worker" ? null : input.createdByUserId,
    },
    select: { id: true },
  });
  return { id: row.id, plaintext };
}

export async function revokeApiKey(organisationId: string, keyId: string): Promise<void> {
  // `organisationId` in the where clause: a key of another organisation is
  // simply not found.
  await db.apiKey.updateMany({
    where: { id: keyId, organisationId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
