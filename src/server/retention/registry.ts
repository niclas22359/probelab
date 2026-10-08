/**
 * Retention registry (lab learnings, rule 5).
 *
 * WHY: passport names and birth dates were once kept forever, and the first
 * retention fix could write personal data back over a redacted row.
 *
 * EVERY table that holds personal data has ONE entry here: which columns are
 * personal, how long they are kept (a setting, with a default the customer
 * signed off), and what happens after that. From this list come
 *  - the nightly retention job (`retention-job.ts`),
 *  - the privacy-note lines (`privacyNoteLines`, written to docs/RETENTION.md
 *    and checked by `tests/unit/retention.test.ts`),
 *  - the coverage test: a schema table with an `organisationId` must be
 *    either listed here or in `NO_PERSONAL_DATA` with a reason.
 *
 * The period is a CUSTOMER decision (docs/OFFEN.md lists it until signed off).
 */

export interface RetentionEntry {
  /** Database table (`@@map` name). */
  table: string;
  /** Human name for the privacy note, in English (the note is translated with the rest of the legal text). */
  label: string;
  /** Columns holding personal data. Redaction blanks exactly these. */
  personalColumns: readonly string[];
  /** Setting that holds the period in days, e.g. `RETENTION_NOTES_DAYS`. */
  periodSetting: string;
  defaultDays: number;
}

export const RETENTION_REGISTRY: readonly RetentionEntry[] = [
  {
    table: "notes",
    label: "Notes",
    personalColumns: ["title", "body"],
    periodSetting: "RETENTION_NOTES_DAYS",
    defaultDays: 365,
  },
];

/** Tenant tables WITHOUT personal data in their own columns, each with the reason. */
export const NO_PERSONAL_DATA: Readonly<Record<string, string>> = {
  organisations: "Mirror of the Suite organisation: id, slug, name of a company.",
  api_keys: "Key hash, scopes and the Suite user id of the creator; deleted with the person (platform-delete-member).",
};

/** Period in days from the setting; empty or unusable = the default (never 0, never "forever"). */
export function periodDays(entry: RetentionEntry, env: Record<string, string | undefined>): number {
  const raw = env[entry.periodSetting]?.trim();
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) return entry.defaultDays;
  return n;
}

/** The lines for the privacy note, one per table, naming the period. */
export function privacyNoteLines(
  registry: readonly RetentionEntry[] = RETENTION_REGISTRY,
  env: Record<string, string | undefined> = {},
): string[] {
  return registry.map(
    (entry) =>
      `- ${entry.label} (${entry.personalColumns.join(", ")}): kept ${periodDays(entry, env)} days after creation, then the personal content is erased for good.`,
  );
}
