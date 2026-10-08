/**
 * Heartbeat (lab learnings, rule 3): an alert when a job did NOT run.
 *
 * A job that crashes alerts through `runJob`. A job whose cron line was
 * deleted, whose container never started or whose host is off alerts
 * nowhere — it simply stops writing `job_runs.lastSuccessAt`. The heartbeat
 * job compares that timestamp with the window of every scheduled job and
 * reports the ones that missed it. Run the heartbeat itself from a
 * DIFFERENT scheduler than the jobs it watches where you can (the platform
 * or a second host), otherwise one dead cron hides both.
 */

export interface ScheduledJob {
  name: string;
  /** How old the last success may be before it counts as missed. */
  windowHours: number;
}

/**
 * Every scheduled job of this Lab. A new nightly job is added HERE, or the
 * heartbeat does not watch it. `tests/unit/jobs.test.ts` checks every runnable
 * job except the heartbeat itself is listed.
 */
export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  // Nightly, plus a few hours of slack for a slow run.
  { name: "retention", windowHours: 26 },
];

export interface JobState {
  name: string;
  lastSuccessAt: Date | null;
}

export interface MissedJob {
  name: string;
  /** Hours since the last success, `null` = never succeeded. */
  hoursSince: number | null;
}

export function findMissedJobs(jobs: readonly ScheduledJob[], states: readonly JobState[], now: Date): MissedJob[] {
  const byName = new Map(states.map((s) => [s.name, s.lastSuccessAt]));
  const missed: MissedJob[] = [];
  for (const job of jobs) {
    const last = byName.get(job.name) ?? null;
    if (!last) {
      missed.push({ name: job.name, hoursSince: null });
      continue;
    }
    const hours = (now.getTime() - last.getTime()) / 3_600_000;
    if (hours > job.windowHours) missed.push({ name: job.name, hoursSince: Math.floor(hours) });
  }
  return missed;
}
