/**
 * One stored date format (lab learnings, rule 12).
 *
 * WHY: a birth date once followed the browser's format, so day and month
 * could swap unnoticed (03/02 vs 02/03). What is STORED or SENT is always
 * ISO 8601: `YYYY-MM-DD` for a calendar date, full ISO with `Z` for a point
 * in time. The UI formats for display only (next-intl), never for storage.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date to store: `YYYY-MM-DD` in UTC. */
export function toStoredDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("invalid date");
  return date.toISOString().slice(0, 10);
}

/**
 * Parses ONLY `YYYY-MM-DD` and only real calendar dates. `03/02/1980`,
 * `1980-2-3` or `1980-02-30` are `null`: guessing the order is the bug.
 */
export function parseStoredDate(value: string): Date | null {
  const hit = ISO_DATE.exec(value.trim());
  if (!hit) return null;
  const [, y, m, d] = hit.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}
