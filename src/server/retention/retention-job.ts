import { checkDeletion, parseDryRun, parseMaxShare } from "@/server/jobs/deletion-guard";
import type { JobOutcome } from "@/server/jobs/run-job";
import { periodDays, RETENTION_REGISTRY, type RetentionEntry } from "@/server/retention/registry";

/**
 * The nightly retention job. For every registry entry:
 *   1. count the table and the rows past their period (not yet redacted),
 *   2. ask the deletion guard (empty table is fine here; more than
 *      `RETENTION_MAX_SHARE` of the table in one night is NOT — then the job
 *      stops as `incomplete` and alerts, and a human decides),
 *   3. in a dry run (the default!) only count, otherwise redact.
 *
 * Settings: `RETENTION_DRY_RUN` (anything but an explicit false/0/no is a
 * dry run), `RETENTION_MAX_SHARE` (default 0.1), one `RETENTION_*_DAYS` per
 * entry. A first run over years of old data WILL hit the share guard: run it
 * once with a higher `RETENTION_MAX_SHARE` on purpose, written down in the
 * handover, then go back to the default.
 */

export interface RetentionStore {
  countAll(table: string): Promise<number>;
  countExpired(table: string, cutoff: Date): Promise<number>;
  /** Redacts the expired rows in ONE statement and returns how many it changed. */
  redactExpired(entry: RetentionEntry, cutoff: Date, at: Date): Promise<number>;
}

export async function runRetention(
  store: RetentionStore,
  env: Record<string, string | undefined>,
  now: Date,
  registry: readonly RetentionEntry[] = RETENTION_REGISTRY,
): Promise<JobOutcome> {
  const dryRun = parseDryRun(env.RETENTION_DRY_RUN);
  const maxShare = parseMaxShare(env.RETENTION_MAX_SHARE);
  const counts: Record<string, number> = { dry_run: dryRun ? 1 : 0 };

  for (const entry of registry) {
    const cutoff = new Date(now.getTime() - periodDays(entry, env) * 86_400_000);
    const total = await store.countAll(entry.table);
    const expired = await store.countExpired(entry.table, cutoff);
    counts[`${entry.table}_total`] = total;
    counts[`${entry.table}_expired`] = expired;

    const verdict = checkDeletion({ toDelete: expired, total, maxShare, allowEmpty: true });
    if (!verdict.ok) return { counts, complete: false, reason: `${entry.table}_${verdict.reason}` };
    if (dryRun || expired === 0) continue;

    counts[`${entry.table}_redacted`] = await store.redactExpired(entry, cutoff, now);
  }
  return { counts };
}
