import { ServiceError } from "@/lib/service-errors";

/**
 * Redaction that cannot be written back.
 *
 * Two locks, because one was not enough once:
 *  1. The DATABASE refuses (trigger `notes_keep_redaction`, migration 0003):
 *     an UPDATE on a redacted row that changes a personal column or clears
 *     `redactedAt` fails, whatever code sent it.
 *  2. The SERVICE refuses earlier with a clear error (`assertNotRedacted`),
 *     so a stale form or a retried request gets "conflict", not a 500.
 *
 * A Lab that adds a table to the retention registry copies the trigger in
 * its migration and calls `assertNotRedacted` in its update path.
 */

export const REDACTED_TEXT = "[redacted]";

/** The values redaction writes: personal text columns blanked. */
export function redactedValues(personalColumns: readonly string[]): Record<string, string> {
  return Object.fromEntries(personalColumns.map((column, i) => [column, i === 0 ? REDACTED_TEXT : ""]));
}

export function assertNotRedacted(row: { redactedAt: Date | null }): void {
  if (row.redactedAt) {
    throw new ServiceError("conflict", "This entry was erased under the retention rules and cannot be changed.");
  }
}
