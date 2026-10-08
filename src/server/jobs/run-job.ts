/**
 * The job frame (lab learnings, Masoud 30.09.2026, rule 2).
 *
 * WHY: a failed chat turn once wrote no log line and the staging AI door was
 * dead for 12 days; a rollout script said "success" after copying nothing.
 * Every job and script therefore runs through `runJob`, which guarantees:
 *
 *  - exactly ONE completion line per run:
 *      job=<name> status=complete|incomplete counts=<k>=<n>,... [error=<code>]
 *    COUNTS ONLY, never ids or names: logs must not carry personal data.
 *  - a failure is never swallowed: the run is `incomplete`, an ops alert goes
 *    out (`alert.ts`) and the process exit code becomes 1 (`runJobCli`).
 *  - the heartbeat state (`job_runs.lastSuccessAt`) is written, so a job that
 *    silently stops running is noticed by the heartbeat job.
 *
 * A job that knows it did only part of its work returns `{ complete: false }`
 * instead of throwing; that is `incomplete` as well, with its counts.
 */

export type JobCounts = Record<string, number>;

export interface JobOutcome {
  counts: JobCounts;
  /** `false` = the job ran but did not finish its work (e.g. a guard refused). */
  complete?: boolean;
  /** Short machine-readable reason when incomplete (no personal data). */
  reason?: string;
}

export type JobStatus = "complete" | "incomplete";

export interface JobResult {
  name: string;
  status: JobStatus;
  counts: JobCounts;
  reason?: string;
}

export interface JobDeps {
  log: (line: string) => void;
  /** Called once for every incomplete run. Must not throw (see alert.ts). */
  alert: (result: JobResult) => Promise<void>;
  /** Heartbeat state. Errors here make the run incomplete, they are not hidden. */
  record: (result: JobResult, at: Date) => Promise<void>;
  now: () => Date;
}

const SAFE = /^[a-z0-9_.-]+$/i;

/** One line, counts only. Keys that are not plain words are dropped, values must be finite numbers. */
export function completionLine(result: JobResult): string {
  const counts = Object.entries(result.counts)
    .filter(([key, value]) => SAFE.test(key) && Number.isFinite(value))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const reason = result.reason && SAFE.test(result.reason) ? ` error=${result.reason}` : result.reason ? " error=other" : "";
  return `job=${result.name} status=${result.status} counts=${counts || "none"}${reason}`;
}

/** Turns any thrown value into a short code; the message may hold personal data, so it is NOT logged here. */
export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && SAFE.test(error.code)) {
    return error.code;
  }
  if (error instanceof Error && SAFE.test(error.name)) return error.name;
  return "unknown";
}

export async function runJob(name: string, job: () => Promise<JobOutcome>, deps: JobDeps): Promise<JobResult> {
  if (!SAFE.test(name)) throw new Error(`invalid job name: ${name}`);
  let result: JobResult;
  try {
    const outcome = await job();
    result = {
      name,
      status: outcome.complete === false ? "incomplete" : "complete",
      counts: outcome.counts,
      ...(outcome.complete === false ? { reason: outcome.reason ?? "incomplete" } : {}),
    };
  } catch (error) {
    result = { name, status: "incomplete", counts: {}, reason: errorCode(error) };
  }

  try {
    await deps.record(result, deps.now());
  } catch (error) {
    result = { ...result, status: "incomplete", reason: result.reason ?? `record_failed_${errorCode(error)}` };
  }

  deps.log(completionLine(result));
  if (result.status === "incomplete") await deps.alert(result);
  return result;
}

/** For scripts: runs the job and sets exit code 1 when it was not complete. */
export async function runJobCli(name: string, job: () => Promise<JobOutcome>, deps: JobDeps): Promise<JobResult> {
  const result = await runJob(name, job, deps);
  if (result.status !== "complete") process.exitCode = 1;
  return result;
}
