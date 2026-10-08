/**
 * Deletion guards (lab learnings, rule 4).
 *
 * WHY: a wrong default folder once produced an EMPTY source list, and the
 * reconciliation would have deleted all 255 documents with exit 0. And
 * `RETENTION_DRY_RUN=true` was a REAL run, because only "1" was understood.
 *
 * Every job that deletes or redacts asks `checkDeletion` first and uses
 * `parseDryRun` for its dry-run switch. Both are strict in the safe
 * direction: when in doubt, nothing is deleted.
 */

const DRY_TRUE = new Set(["true", "1", "yes", "on", "y"]);
const DRY_FALSE = new Set(["false", "0", "no", "off", "n"]);

/**
 * Dry run unless the value EXPLICITLY says "real". Empty, missing, a typo or
 * anything unparsable is a dry run. A real run has to be asked for.
 */
export function parseDryRun(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  if (DRY_FALSE.has(value)) return false;
  if (DRY_TRUE.has(value)) return true;
  return true;
}

export const DEFAULT_MAX_SHARE = 0.1;

/** Share of the table one run may touch, from a setting like `RETENTION_MAX_SHARE=0.1`. Unparsable = the default. */
export function parseMaxShare(raw: string | undefined): number {
  const n = Number(raw?.trim());
  if (!raw?.trim() || !Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_MAX_SHARE;
  return n;
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; reason: "empty_input" | "share_exceeded" | "invalid_counts" };

export interface DeletionPlan {
  /** Rows the run would delete or redact. */
  toDelete: number;
  /** Rows the run is allowed to judge (the whole table, or the input list). */
  total: number;
  maxShare?: number;
  /**
   * `true` when an empty input is legitimate (a retention scan over a table
   * that is still empty). Never for a reconciliation against a source list:
   * an empty source is the classic wrong-folder failure.
   */
  allowEmpty?: boolean;
}

export function checkDeletion(plan: DeletionPlan): GuardVerdict {
  const { toDelete, total } = plan;
  if (!Number.isInteger(toDelete) || !Number.isInteger(total) || toDelete < 0 || total < 0 || toDelete > total) {
    return { ok: false, reason: "invalid_counts" };
  }
  if (total === 0) return plan.allowEmpty ? { ok: true } : { ok: false, reason: "empty_input" };
  if (toDelete === 0) return { ok: true };
  const maxShare = plan.maxShare ?? DEFAULT_MAX_SHARE;
  if (toDelete / total > maxShare) return { ok: false, reason: "share_exceeded" };
  return { ok: true };
}
