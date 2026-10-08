/**
 * One real, cheap call per platform edge against STAGING
 * (src/server/jobs/contract-edges.ts). Runs daily from
 * .github/workflows/contract-check.yml and by hand:
 *
 *   npm run contract:check
 *
 * Through the job frame: one completion line, exit 1 and an ops alert when
 * any edge failed or its settings are missing. Settings (staging values):
 * PLATFORM_API_URL, PLATFORM_API_KEY, NEXT_PUBLIC_PLATFORM_URL,
 * PLATFORM_EXPORT_KEY, CONTRACT_LAB_URL, CONTRACT_ORGANISATION_ID,
 * OPS_ALERT_EMAIL, OPS_ALERT_ORGANISATION_ID.
 */
import "dotenv/config";

import { sendOpsAlert } from "@/server/jobs/alert";
import { buildEdges, checkEdges } from "@/server/jobs/contract-edges";
import { runJobCli } from "@/server/jobs/run-job";

async function main(): Promise<void> {
  await runJobCli(
    "contract-check",
    async () => {
      const results = await checkEdges(buildEdges(), process.env);
      for (const r of results) console.log(`edge=${r.name} status=${r.status}${r.http !== undefined ? ` http=${r.http}` : ""}`);
      const bad = results.filter((r) => r.status !== "ok");
      return {
        counts: {
          edges: results.length,
          ok: results.length - bad.length,
          failed: bad.filter((r) => r.status === "failed").length,
          missing: bad.filter((r) => r.status === "missing").length,
        },
        complete: bad.length === 0,
        reason: bad.length > 0 ? "edges_failed" : undefined,
      };
    },
    {
      log: (line) => console.log(line),
      alert: async (result) => {
        await sendOpsAlert({ source: "contract-check", summary: `${result.name}: ${JSON.stringify(result.counts)}` });
      },
      // The contract check has no database: its heartbeat is the scheduled
      // workflow itself, whose failure GitHub reports.
      record: async () => undefined,
      now: () => new Date(),
    },
  );
}

main().catch((error: unknown) => {
  console.error("job=contract-check status=incomplete counts=none error=crash", error);
  process.exitCode = 1;
});
