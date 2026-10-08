import "server-only";

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { LAB_KEY } from "@/lib/lab";

/**
 * The tenant deletion: erase EVERYTHING this Lab stores for one organisation
 * and report, line by line, what happened to it. The counterpart of the
 * tenant export; the platform calls both for every registered product.
 *
 * DELETION_PLAN is the single place that says what happens to each table.
 * The coverage test checks it against the Prisma schema: EVERY model must be
 * either in the plan or in GLOBAL_TABLES. A new migration that adds a table
 * fails that test until somebody DECIDES here what deleting an organisation
 * means for it. That includes child tables without an `organisationId`
 * column of their own: they are in the plan and deleted through their parent.
 *
 *   delete     the rows are removed
 *   anonymise  the rows stay, every personal value in them is overwritten
 *   retain     the rows stay as they are; `reason` is mandatory and names the
 *              duty that forces it (for example a statutory retention period)
 *
 * Order matters: children before parents, `organisations` last. Every table
 * is deleted explicitly and counted, even where the database would cascade,
 * because the count is the evidence in the platform's deletion log.
 *
 * Data OUTSIDE the database (files on disk, objects in a store, tokens at a
 * provider) is not covered by the transaction. A Lab that has such data
 * removes it in `eraseExternalStores` AFTER the commit and reports one item
 * per store. The template has none.
 */
export type Treatment = "delete" | "anonymise" | "retain";

export interface PlanEntry {
  table: string;
  treatment: Treatment;
  /** Mandatory for `retain` and `anonymise`: why the rows are not removed. */
  reason?: string;
}

export const DELETION_PLAN = [
  { table: "notes", treatment: "delete" },
  { table: "api_keys", treatment: "delete" },
  { table: "organisations", treatment: "delete" },
] as const satisfies readonly PlanEntry[];

/**
 * Tables that hold nothing of any organisation (rate buckets, heartbeats,
 * catalogues). Each needs a reason, so "it is global" is a decision somebody
 * wrote down and not a table somebody forgot.
 */
export const GLOBAL_TABLES: readonly { table: string; reason: string }[] = [
  {
    table: "job_runs",
    reason: "Heartbeat state of the scheduled jobs: job name and timestamps, no organisation, no person.",
  },
];

type PlanTable = (typeof DELETION_PLAN)[number]["table"];

/**
 * One executor per plan entry, returning the number of rows it touched. The
 * `Record` type makes a plan entry without an executor a compile error.
 */
const EXECUTORS: Record<
  PlanTable,
  (tx: Prisma.TransactionClient, organisationId: string) => Promise<number>
> = {
  notes: async (tx, organisationId) =>
    (await tx.note.deleteMany({ where: { organisationId } })).count,
  api_keys: async (tx, organisationId) =>
    (await tx.apiKey.deleteMany({ where: { organisationId } })).count,
  organisations: async (tx, organisationId) =>
    (await tx.organisation.deleteMany({ where: { id: organisationId } })).count,
};

const ACTION: Record<Treatment, string> = {
  delete: "delete_rows",
  anonymise: "anonymise_rows",
  retain: "retain_rows",
};

export type DeletionOutcome = "success" | "skipped" | "failed";

/** One line of evidence. Same shape as the platform's deletion log. */
export interface DeletionItem {
  store: string;
  target: string;
  action: string;
  itemCount: number | null;
  outcome: DeletionOutcome;
  detail: string | null;
}

export interface TenantDeletion {
  source: string;
  organisationId: string;
  runId: string;
  /** `true` only when no item failed. */
  ok: boolean;
  items: DeletionItem[];
  failures: string[];
}

/** Data outside the database. Runs after the commit; never throws. */
async function eraseExternalStores(
  storedOrganisationId: string,
): Promise<DeletionItem[]> {
  void storedOrganisationId;
  return [];
}

export async function deleteOrganisation(
  organisationId: string,
  runId: string,
): Promise<TenantDeletion> {
  const result = (items: DeletionItem[]): TenantDeletion => {
    const failures = items
      .filter((item) => item.outcome === "failed")
      .map(
        (item) =>
          `${item.store} ${item.target} ${item.action} failed${item.detail ? `: ${item.detail}` : ""}`,
      );
    return {
      source: LAB_KEY,
      organisationId,
      runId,
      ok: failures.length === 0,
      items,
      failures,
    };
  };

  // The platform compares ids case-insensitively; the stored id is the
  // token's spelling. Look up without case, echo the REQUESTED value.
  const organisation = await db.organisation.findFirst({
    where: { id: { equals: organisationId, mode: "insensitive" } },
    select: { id: true },
  });
  if (!organisation) {
    // Not an error, and the answer a repeated run gets: nothing left to erase.
    return result(
      DELETION_PLAN.map((entry) => ({
        store: "postgres",
        target: entry.table,
        action: ACTION[entry.treatment],
        itemCount: 0,
        outcome: "skipped" as const,
        detail: "organisation unknown to this Lab",
      })),
    );
  }
  const storedId = organisation.id;

  let items: DeletionItem[];
  try {
    items = await db.$transaction(
      async (tx) => {
        const lines: DeletionItem[] = [];
        for (const entry of DELETION_PLAN) {
          const count = await EXECUTORS[entry.table](tx, storedId);
          lines.push({
            store: "postgres",
            target: entry.table,
            action: ACTION[entry.treatment],
            itemCount: count,
            outcome: "success",
            detail: (entry as PlanEntry).reason ?? null,
          });
        }
        return lines;
      },
      // Prisma's default is 5 s; a large organisation needs longer (the platform allows 120 s).
      { maxWait: 10_000, timeout: 100_000 },
    );
  } catch (error) {
    // The transaction rolled back: nothing was erased. Say so in one line
    // instead of pretending per table.
    console.error("[platform/delete] transaction failed:", error);
    return result([
      {
        store: "postgres",
        target: "all tenant tables",
        action: "delete_rows",
        itemCount: null,
        outcome: "failed",
        detail: "transaction rolled back, nothing was erased",
      },
    ]);
  }

  items.push(...(await eraseExternalStores(storedId)));

  const summary = items
    .map((item) => `${item.target}=${item.itemCount ?? "?"}`)
    .join(" ");
  console.info(
    `[platform/delete] organisation ${storedId} run ${runId}: ${summary}`,
  );
  return result(items);
}
