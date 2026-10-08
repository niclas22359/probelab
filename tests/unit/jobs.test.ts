import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sendOpsAlert } from "@/server/jobs/alert";
import { checkDeletion, parseDryRun, parseMaxShare } from "@/server/jobs/deletion-guard";
import { findMissedJobs, SCHEDULED_JOBS } from "@/server/jobs/heartbeat";
import { completionLine, runJob, type JobDeps, type JobResult } from "@/server/jobs/run-job";

function fakeDeps(overrides: Partial<JobDeps> = {}) {
  const lines: string[] = [];
  const alerts: JobResult[] = [];
  const records: JobResult[] = [];
  const deps: JobDeps = {
    log: (line) => lines.push(line),
    alert: async (r) => void alerts.push(r),
    record: async (r) => void records.push(r),
    now: () => new Date("2026-10-07T02:00:00Z"),
    ...overrides,
  };
  return { deps, lines, alerts, records };
}

describe("runJob", () => {
  it("logs one complete line with counts and records the success", async () => {
    const { deps, lines, alerts, records } = fakeDeps();
    const result = await runJob("retention", async () => ({ counts: { redacted: 3 } }), deps);
    expect(result.status).toBe("complete");
    expect(lines).toEqual(["job=retention status=complete counts=redacted=3"]);
    expect(alerts).toHaveLength(0);
    expect(records).toHaveLength(1);
  });

  it("turns a throw into incomplete + alert, without the error message (may hold personal data)", async () => {
    const { deps, lines, alerts } = fakeDeps();
    const result = await runJob("retention", async () => {
      throw new TypeError("row of jane@example.com broke");
    }, deps);
    expect(result.status).toBe("incomplete");
    expect(lines[0]).toBe("job=retention status=incomplete counts=none error=TypeError");
    expect(lines[0]).not.toContain("jane");
    expect(alerts).toHaveLength(1);
  });

  it("an outcome with complete=false is incomplete and alerts", async () => {
    const { deps, alerts } = fakeDeps();
    const result = await runJob("x", async () => ({ counts: { a: 1 }, complete: false, reason: "notes_share_exceeded" }), deps);
    expect(result).toMatchObject({ status: "incomplete", reason: "notes_share_exceeded" });
    expect(alerts).toHaveLength(1);
  });

  it("a failing heartbeat record makes the run incomplete instead of hiding it", async () => {
    const { deps, lines } = fakeDeps({ record: async () => Promise.reject(new Error("db down")) });
    const result = await runJob("x", async () => ({ counts: {} }), deps);
    expect(result.status).toBe("incomplete");
    expect(lines[0]).toContain("status=incomplete");
  });

  it("never prints ids: non-word count keys are dropped", () => {
    expect(completionLine({ name: "j", status: "complete", counts: { "user 4f3a@x": 1, ok: 2 } })).toBe(
      "job=j status=complete counts=ok=2",
    );
  });
});

describe("deletion guard", () => {
  it.each(["true", "TRUE", "1", "yes", " Yes ", "", undefined, "ture", "maybe", "2"])("dry run for %j", (raw) => {
    expect(parseDryRun(raw)).toBe(true);
  });
  it.each(["false", "0", "no", "off"])("real run only for an explicit %j", (raw) => {
    expect(parseDryRun(raw)).toBe(false);
  });
  it("refuses empty input unless allowed", () => {
    expect(checkDeletion({ toDelete: 0, total: 0 })).toEqual({ ok: false, reason: "empty_input" });
    expect(checkDeletion({ toDelete: 0, total: 0, allowEmpty: true })).toEqual({ ok: true });
  });
  it("refuses more than 10 % by default, the share is configurable", () => {
    expect(checkDeletion({ toDelete: 10, total: 100 })).toEqual({ ok: true });
    expect(checkDeletion({ toDelete: 11, total: 100 })).toEqual({ ok: false, reason: "share_exceeded" });
    expect(checkDeletion({ toDelete: 255, total: 255 })).toEqual({ ok: false, reason: "share_exceeded" });
    expect(checkDeletion({ toDelete: 50, total: 100, maxShare: parseMaxShare("0.5") })).toEqual({ ok: true });
  });
  it("refuses nonsense counts and falls back to 10 % on an unusable share", () => {
    expect(checkDeletion({ toDelete: 5, total: 3 }).ok).toBe(false);
    expect(parseMaxShare("abc")).toBe(0.1);
    expect(parseMaxShare("0")).toBe(0.1);
  });
});

describe("heartbeat", () => {
  const now = new Date("2026-10-07T06:00:00Z");
  it("reports a job that never ran and one that missed its window", () => {
    const missed = findMissedJobs(
      [{ name: "a", windowHours: 26 }, { name: "b", windowHours: 26 }, { name: "c", windowHours: 26 }],
      [
        { name: "b", lastSuccessAt: new Date("2026-10-05T01:00:00Z") },
        { name: "c", lastSuccessAt: new Date("2026-10-07T01:00:00Z") },
      ],
      now,
    );
    expect(missed).toEqual([{ name: "a", hoursSince: null }, { name: "b", hoursSince: 53 }]);
  });

  it("watches every runnable job except itself", () => {
    const source = readFileSync(path.resolve(__dirname, "..", "..", "src", "server", "jobs", "jobs.ts"), "utf8");
    const block = /export const JOBS[^{]*\{([\s\S]*?)\n\};/.exec(source)?.[1] ?? "";
    const runnable = [...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).filter((n) => n !== "heartbeat");
    expect(runnable.length).toBeGreaterThan(0);
    expect(SCHEDULED_JOBS.map((j) => j.name).sort()).toEqual(runnable.sort());
  });
});

describe("ops alert", () => {
  it("sends through the mail door with an hourly idempotency key", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, messageId: "m", mode: "live" });
    const ok = await sendOpsAlert(
      { source: "job:retention", summary: "job=retention status=incomplete" },
      { send, config: { email: "alerts@beyondles.ai", organisationId: "org" }, now: new Date("2026-10-07T02:30:00Z") },
    );
    expect(ok).toBe(true);
    expect(send.mock.calls[0][0]).toMatchObject({
      organisationId: "org",
      action: "ops-alert",
      idempotencyKey: "alert:job:retention:2026-10-07T02",
    });
  });
  it("is loud, not silent, when unconfigured or when the door fails", async () => {
    const warn = vi.fn();
    expect(await sendOpsAlert({ source: "s", summary: "x" }, { config: null, warn })).toBe(false);
    const send = vi.fn().mockResolvedValue({ ok: false, status: 503, code: "DOOR_NOT_CONFIGURED", message: "" });
    expect(await sendOpsAlert({ source: "s", summary: "x" }, { send, config: { email: "a", organisationId: "o" }, warn })).toBe(false);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      "alert=failed source=s code=ALERT_NOT_CONFIGURED",
      "alert=failed source=s code=DOOR_NOT_CONFIGURED",
    ]);
  });
});
