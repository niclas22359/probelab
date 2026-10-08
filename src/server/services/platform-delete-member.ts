import "server-only";

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { LAB_KEY } from "@/lib/lab";
import type { DeletionItem } from "@/server/services/platform-delete";

/**
 * The person deletion: erase ONE Suite user from this Lab, inside one
 * organisation, and report line by line what happened. The counterpart of the
 * organisation door (`platform-delete.ts`); same key, same item shape.
 *
 * The rule (decided by the company owner, 2 Oct 2026):
 *  - what is PERSONAL to the person is erased;
 *  - what the person shared with the organisation stays and goes to the
 *    successor (`toUserId`, the organisation's owner);
 *  - afterwards no row with the person's user id remains, except anonymised
 *    evidence rows.
 *
 * PERSON_PLAN lists every (table, column) that can hold a Suite user id and
 * what happens to it. `tests/unit/platform-delete-member-coverage.test.ts`
 * parses the Prisma schema and fails when a column that looks like a user
 * reference is missing here, so a new column forces a decision.
 *
 *   delete_rows   the rows are removed
 *   reassign      the column is set to `toUserId` (the row means
 *                 responsibility and the organisation keeps it)
 *   anonymise     the column is set to NULL (or text blanked), the row stays
 *   not_personal  the column does not hold a Suite user; `reason` says why
 *
 * Every statement is scoped to the organisation AND the person; neither
 * filter can be undefined (the route validates both as uuids, and this
 * service refuses an empty value). The template's `Note` rows are owned by
 * the person with a visibility: PRIVATE ones were visible to nobody else and
 * are deleted, COLLECTION and ORGANISATION ones were shared and are
 * reassigned. This is also what `POST /api/platform/reassign-owner` would do
 * for the shared rows; the template has no such route yet (`docs/OFFEN.md`).
 *
 * People who are not Suite users (guests, signers, visitors) are data
 * subjects of the customer and out of scope of this door.
 */
export type PersonTreatment =
  "delete_rows" | "reassign" | "anonymise" | "not_personal";

export interface PersonPlanEntry {
  /** Unique id of the statement; the executor map is keyed by it. */
  id: string;
  table: string;
  column: string;
  treatment: PersonTreatment;
  /** Which rows the statement touches, shown in the answer's `detail`. */
  scope: string;
  /** Mandatory for `not_personal`: why the column holds no Suite user. */
  reason?: string;
}

export const PERSON_PLAN: readonly PersonPlanEntry[] = [
  {
    id: "notes_private",
    table: "notes",
    column: "ownerUserId",
    treatment: "delete_rows",
    scope: "visibility PRIVATE (visible to nobody else)",
  },
  {
    id: "notes_shared",
    table: "notes",
    column: "ownerUserId",
    treatment: "reassign",
    scope: "visibility COLLECTION or ORGANISATION, owner set to the successor",
  },
  {
    id: "api_keys_user",
    table: "api_keys",
    column: "createdByUserId",
    treatment: "delete_rows",
    scope: "kind USER (acts as that person)",
  },
  {
    id: "api_keys_worker",
    table: "api_keys",
    column: "createdByUserId",
    treatment: "anonymise",
    scope: "kind WORKER (belongs to the organisation), creator set to NULL",
  },
];

export interface PersonScope {
  organisationId: string;
  userId: string;
  toUserId: string;
}

type PersonExecutor = (
  tx: Prisma.TransactionClient,
  scope: PersonScope,
) => Promise<number>;

/** Match a user id without regard to case, like the platform does. */
const ci = (userId: string) => ({
  equals: userId,
  mode: "insensitive" as const,
});

/**
 * One executor per plan entry that changes rows. Every `where` carries the
 * organisation AND the person.
 */
export const PERSON_EXECUTORS: Record<string, PersonExecutor> = {
  notes_private: async (tx, { organisationId, userId }) =>
    (
      await tx.note.deleteMany({
        where: {
          organisationId,
          ownerUserId: ci(userId),
          visibility: "PRIVATE",
        },
      })
    ).count,
  notes_shared: async (tx, { organisationId, userId, toUserId }) =>
    (
      await tx.note.updateMany({
        where: {
          organisationId,
          ownerUserId: ci(userId),
          visibility: { not: "PRIVATE" },
        },
        data: { ownerUserId: toUserId },
      })
    ).count,
  api_keys_user: async (tx, { organisationId, userId }) =>
    (
      await tx.apiKey.deleteMany({
        where: { organisationId, createdByUserId: ci(userId), kind: "USER" },
      })
    ).count,
  api_keys_worker: async (tx, { organisationId, userId }) =>
    (
      await tx.apiKey.updateMany({
        where: { organisationId, createdByUserId: ci(userId), kind: "WORKER" },
        data: { createdByUserId: null },
      })
    ).count,
};

const ACTION: Record<PersonTreatment, string> = {
  delete_rows: "delete_rows",
  reassign: "reassign_rows",
  anonymise: "anonymise_rows",
  not_personal: "retain_rows",
};

export interface PersonDeletion {
  source: string;
  organisationId: string;
  userId: string;
  runId: string;
  /** `true` only when no item failed. */
  ok: boolean;
  items: DeletionItem[];
  failures: string[];
}

const UNKNOWN = "organisation or user unknown to this Lab";

/**
 * Data outside the database that belongs only to this person (avatar,
 * uploads). Runs BEFORE the transaction: a failure here returns one failed
 * item and leaves the database untouched. The template has none.
 */
async function erasePersonalFiles(scope: PersonScope): Promise<DeletionItem[]> {
  void scope;
  return [];
}

function planItems(outcome: "skipped", detail: string): DeletionItem[] {
  return PERSON_PLAN.filter((e) => e.treatment !== "not_personal").map(
    (entry) => ({
      store: "postgres",
      target: `${entry.table}.${entry.column}`,
      action: ACTION[entry.treatment],
      itemCount: 0,
      outcome,
      detail,
    }),
  );
}

export async function deletePerson(
  organisationId: string,
  userId: string,
  toUserId: string,
  runId: string,
): Promise<PersonDeletion> {
  const result = (items: DeletionItem[]): PersonDeletion => {
    const failures = items
      .filter((item) => item.outcome === "failed")
      .map(
        (item) =>
          `${item.store} ${item.target} ${item.action} failed${item.detail ? `: ${item.detail}` : ""}`,
      );
    return {
      source: LAB_KEY,
      organisationId,
      userId,
      runId,
      ok: failures.length === 0,
      items,
      failures,
    };
  };

  if (
    !organisationId ||
    !userId ||
    !toUserId ||
    userId.toLowerCase() === toUserId.toLowerCase()
  ) {
    throw new Error(
      "organisationId, userId and toUserId are required and userId must differ from toUserId",
    );
  }

  // The platform compares ids case-insensitively; the stored id is the
  // token's spelling. Look up without case, echo the REQUESTED values.
  const organisation = await db.organisation.findFirst({
    where: { id: { equals: organisationId, mode: "insensitive" } },
    select: { id: true },
  });
  if (!organisation) return result(planItems("skipped", UNKNOWN));
  const scope: PersonScope = {
    organisationId: organisation.id,
    userId,
    toUserId,
  };

  const files = await erasePersonalFiles(scope);
  if (files.some((item) => item.outcome === "failed")) return result(files);

  let items: DeletionItem[];
  try {
    items = await db.$transaction(
      async (tx) => {
        const lines: DeletionItem[] = [];
        for (const entry of PERSON_PLAN) {
          if (entry.treatment === "not_personal") continue;
          const count = await PERSON_EXECUTORS[entry.id](tx, scope);
          lines.push({
            store: "postgres",
            target: `${entry.table}.${entry.column}`,
            action: ACTION[entry.treatment],
            itemCount: count,
            outcome: "success",
            detail: entry.scope,
          });
        }
        return lines;
      },
      // Prisma's default is 5 s; the platform allows 120 s.
      { maxWait: 10_000, timeout: 100_000 },
    );
  } catch (error) {
    console.error("[platform/delete-member] transaction failed:", error);
    return result([
      {
        store: "postgres",
        target: "all person columns",
        action: "delete_rows",
        itemCount: null,
        outcome: "failed",
        detail: "transaction rolled back, nothing was erased",
      },
    ]);
  }

  // Nothing touched anywhere: this Lab never saw the person (or an earlier
  // run already erased them). Idempotent answer: everything skipped.
  if (items.every((item) => item.itemCount === 0)) {
    return result(planItems("skipped", UNKNOWN));
  }

  items.push(...files);
  const summary = items
    .map((item) => `${item.target}=${item.itemCount ?? "?"}`)
    .join(" ");
  console.info(
    `[platform/delete-member] organisation ${scope.organisationId} run ${runId}: ${summary}`,
  );
  return result(items);
}
