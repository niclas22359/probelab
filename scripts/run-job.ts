/**
 * Runs one scheduled job through the job frame (src/server/jobs/run-job.ts):
 *
 *   npm run job -- retention
 *   npm run job -- heartbeat
 *
 * On the server, from the host's cron, inside the toolchain container:
 *   docker compose ... run --rm --no-deps toolchain npm run job -- retention
 *
 * Prints exactly one completion line and exits 1 when the run is not
 * complete. `scripts/tsconfig.json` maps the `server-only` marker to a
 * stand-in so the server modules load outside Next.js.
 */
import "dotenv/config";

import { db } from "@/lib/db";
import { JOBS, realJobDeps } from "@/server/jobs/jobs";
import { runJobCli } from "@/server/jobs/run-job";

async function main(): Promise<void> {
  const name = process.argv[2] ?? "";
  const job = JOBS[name];
  if (!job) {
    console.error(`job=${name || "none"} status=incomplete counts=none error=unknown_job (known: ${Object.keys(JOBS).join(", ")})`);
    process.exitCode = 1;
    return;
  }
  const deps = realJobDeps();
  await runJobCli(name, () => job(deps.now()), deps);
}

main()
  .catch((error: unknown) => {
    console.error(`job=${process.argv[2] ?? "none"} status=incomplete counts=none error=crash`, error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
