import { db } from "@/lib/db";
import { alertJobFailure, sendOpsAlert } from "@/server/jobs/alert";
import { findMissedJobs, SCHEDULED_JOBS } from "@/server/jobs/heartbeat";
import type { JobDeps, JobOutcome, JobResult } from "@/server/jobs/run-job";
import { redactedValues } from "@/server/retention/redaction";
import { runRetention, type RetentionStore } from "@/server/retention/retention-job";

/**
 * The runnable jobs of this Lab and their real (database, platform door)
 * dependencies. `scripts/run-job.ts <name>` runs one of them through the job
 * frame; the host's cron calls that script (docs/FRAME.md 7a).
 */

/** Prisma store for the retention job. One `case` per registry table. */
export const prismaRetentionStore: RetentionStore = {
  async countAll(table) {
    if (table === "notes") return db.note.count();
    throw new Error(`no retention store for table ${table}`);
  },
  async countExpired(table, cutoff) {
    if (table === "notes") return db.note.count({ where: { createdAt: { lt: cutoff }, redactedAt: null } });
    throw new Error(`no retention store for table ${table}`);
  },
  async redactExpired(entry, cutoff, at) {
    if (entry.table === "notes") {
      const result = await db.note.updateMany({
        where: { createdAt: { lt: cutoff }, redactedAt: null },
        data: { ...redactedValues(entry.personalColumns), redactedAt: at },
      });
      return result.count;
    }
    throw new Error(`no retention store for table ${entry.table}`);
  },
};

export async function heartbeatJob(now: Date): Promise<JobOutcome> {
  const states = await db.jobRun.findMany({ select: { name: true, lastSuccessAt: true } });
  const missed = findMissedJobs(SCHEDULED_JOBS, states, now);
  for (const job of missed) {
    await sendOpsAlert({
      source: `heartbeat:${job.name}`,
      summary: `job=${job.name} missed its window (last success: ${job.hoursSince === null ? "never" : `${job.hoursSince} h ago`})`,
    });
  }
  return {
    counts: { watched: SCHEDULED_JOBS.length, missed: missed.length },
    complete: missed.length === 0,
    reason: missed.length > 0 ? "missed_jobs" : undefined,
  };
}

export const JOBS: Record<string, (now: Date) => Promise<JobOutcome>> = {
  retention: (now) => runRetention(prismaRetentionStore, process.env, now),
  heartbeat: heartbeatJob,
};

export function realJobDeps(): JobDeps {
  return {
    log: (line) => console.log(line),
    alert: alertJobFailure,
    now: () => new Date(),
    async record(result: JobResult, at: Date) {
      const success = result.status === "complete" ? { lastSuccessAt: at } : {};
      await db.jobRun.upsert({
        where: { name: result.name },
        create: { name: result.name, lastRunAt: at, lastStatus: result.status, ...success },
        update: { lastRunAt: at, lastStatus: result.status, ...success },
      });
    },
  };
}
