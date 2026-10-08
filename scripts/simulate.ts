/**
 * Simulation harness (docs/SIMULATION.md). NOT in CI, it costs money.
 *
 *   npm run simulate              # 20 runs
 *   npm run simulate -- 48        # N runs
 *
 * Settings: SIM_LAB_URL (running Lab), SIM_API_KEY (a Lab API key with
 * read + write), SIM_ORGANISATION_ID, PLATFORM_API_URL + PLATFORM_API_KEY
 * (the door the judge runs through). Exit 1 when a setting is missing or
 * the score is below SIM_MIN_PERCENT (default 90).
 */
import "dotenv/config";

import { readFileSync } from "node:fs";
import path from "node:path";

import { runJobCli, type JobOutcome } from "@/server/jobs/run-job";
import {
  judgeRequest,
  parseVerdict,
  pickScenarios,
  runScenario,
  score,
  type Scenario,
  type Verdict,
} from "@/server/jobs/simulation";

const env = (name: string) => process.env[name]?.trim() ?? "";
const readBody = (res: Response): Promise<unknown> =>
  res.json().catch((error: unknown) => ({ unparsable: String(error) }));

async function simulate(): Promise<JobOutcome> {
  const needed = ["SIM_LAB_URL", "SIM_API_KEY", "SIM_ORGANISATION_ID", "PLATFORM_API_URL", "PLATFORM_API_KEY"];
  const missing = needed.filter((name) => !env(name));
  if (missing.length > 0) {
    console.error(`missing settings: ${missing.join(", ")}`);
    return { counts: { missing_settings: missing.length }, complete: false, reason: "missing_settings" };
  }
  const requested = Number(process.argv[2] ?? 20);
  const n = Number.isInteger(requested) && requested > 0 ? requested : 20;
  const file = JSON.parse(
    readFileSync(path.resolve(__dirname, "..", "tests", "simulation", "scenarios.json"), "utf8"),
  ) as { scenarios: Scenario[] };
  const lab = env("SIM_LAB_URL").replace(/\/+$/, "");
  const door = env("PLATFORM_API_URL").replace(/\/+$/, "");

  const verdicts: Verdict[] = [];
  for (const [i, scenario] of pickScenarios(file.scenarios, n).entries()) {
    const exchanges = await runScenario(scenario, async (step) => {
      const res = await fetch(`${lab}${step.path}`, {
        method: step.method,
        headers: { "Content-Type": "application/json", "x-api-key": env("SIM_API_KEY") },
        body: step.body === undefined ? undefined : JSON.stringify(step.body),
      });
      return { status: res.status, body: await readBody(res) };
    });
    const res = await fetch(`${door}/api/llm/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": env("PLATFORM_API_KEY") },
      body: JSON.stringify(judgeRequest(scenario, exchanges, env("SIM_ORGANISATION_ID"))),
    });
    const envelope = (await readBody(res)) as { data?: { text?: string } } | null;
    verdicts.push(parseVerdict(`${i + 1}:${scenario.id}`, res.ok ? (envelope?.data?.text ?? "") : `HTTP ${res.status}`));
  }

  const s = score(verdicts);
  console.log(`score ${s.passed}/${s.total} (${s.percent} %)`);
  for (const v of verdicts.filter((x) => !x.pass)) console.log(`FAILED ${v.id}: ${v.reason}`);
  const min = Number(env("SIM_MIN_PERCENT") || 90);
  const ok = s.percent >= min;
  return {
    counts: { runs: s.total, passed: s.passed, failed: s.total - s.passed, percent: s.percent },
    complete: ok,
    reason: ok ? undefined : "score_below_minimum",
  };
}

runJobCli("simulation", simulate, {
  log: (line) => console.log(line),
  // Run by a person before handover and read on screen: no ops alert.
  alert: async () => undefined,
  record: async () => undefined,
  now: () => new Date(),
}).catch((error: unknown) => {
  console.error("job=simulation status=incomplete counts=none error=crash", error);
  process.exitCode = 1;
});
