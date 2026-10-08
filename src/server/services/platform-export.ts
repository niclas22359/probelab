import "server-only";

import { db } from "@/lib/db";
import { LAB_KEY } from "@/lib/lab";

/**
 * The tenant export: ALL rows this Lab stores for one organisation, every
 * table, nothing filtered, nothing paginated. An organisation this Lab never
 * saw yields `entities: {}` — not an error.
 *
 * TENANT_TABLES is the list the coverage test checks against the Prisma
 * schema: every model with an `organisationId` column must be here. A new
 * migration that adds a tenant table fails that test until the export
 * learns about it.
 */
export const TENANT_TABLES = ["organisations", "notes", "api_keys"] as const;

export interface TenantExport {
  source: string;
  organisationId: string;
  exportedAt: string;
  entities: Record<string, unknown[]>;
}

export async function exportOrganisation(organisationId: string): Promise<TenantExport> {
  // The platform compares ids case-insensitively; the stored id is the
  // token's spelling. Look up without case, echo the REQUESTED value.
  const organisation = await db.organisation.findFirst({
    where: { id: { equals: organisationId, mode: "insensitive" } },
  });
  if (!organisation) {
    return { source: LAB_KEY, organisationId, exportedAt: new Date().toISOString(), entities: {} };
  }
  const storedId = organisation.id;

  const [notes, apiKeys] = await Promise.all([
    db.note.findMany({ where: { organisationId: storedId }, orderBy: { createdAt: "asc" } }),
    // Keys are exported WITHOUT the hash: it is not the customer's data, it
    // is our lock.
    db.apiKey.findMany({
      where: { organisationId: storedId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, kind: true, createdByUserId: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    }),
  ]);

  const entities: Record<(typeof TENANT_TABLES)[number], unknown[]> = {
    organisations: [organisation],
    notes,
    api_keys: apiKeys,
  };

  return { source: LAB_KEY, organisationId, exportedAt: new Date().toISOString(), entities };
}
