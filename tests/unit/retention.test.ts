import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { TENANT_TABLES } from "@/server/services/platform-export";
import { assertNotRedacted, REDACTED_TEXT, redactedValues } from "@/server/retention/redaction";
import { NO_PERSONAL_DATA, privacyNoteLines, RETENTION_REGISTRY, type RetentionEntry } from "@/server/retention/registry";
import { runRetention, type RetentionStore } from "@/server/retention/retention-job";

const root = path.resolve(__dirname, "..", "..");
const now = new Date("2026-10-07T02:00:00Z");

/** In-memory table that behaves like the database trigger of migration 0003. */
function memoryStore(rows: { createdAt: Date; title: string; body: string; redactedAt: Date | null }[]) {
  const store: RetentionStore = {
    countAll: async () => rows.length,
    countExpired: async (_t, cutoff) => rows.filter((r) => r.createdAt < cutoff && !r.redactedAt).length,
    redactExpired: async (entry, cutoff, at) => {
      let n = 0;
      for (const r of rows.filter((x) => x.createdAt < cutoff && !x.redactedAt)) {
        Object.assign(r, redactedValues(entry.personalColumns), { redactedAt: at });
        n += 1;
      }
      return n;
    },
  };
  return { store, rows };
}

const old = (i: number) => ({ createdAt: new Date("2024-01-01"), title: `Passport ${i}`, body: "born 1980-02-03", redactedAt: null });
const fresh = () => ({ createdAt: new Date("2026-10-01"), title: "t", body: "b", redactedAt: null });

describe("retention job", () => {
  it("is a dry run by default: counts, changes nothing", async () => {
    const { store, rows } = memoryStore([old(1), ...Array.from({ length: 19 }, fresh)]);
    const outcome = await runRetention(store, {}, now);
    expect(outcome).toEqual({ counts: { dry_run: 1, notes_total: 20, notes_expired: 1 } });
    expect(rows[0].title).toBe("Passport 1");
  });

  it("redacts in a real run, and RETENTION_DRY_RUN=true is NOT a real run", async () => {
    const dry = memoryStore([old(1), ...Array.from({ length: 19 }, fresh)]);
    await runRetention(dry.store, { RETENTION_DRY_RUN: "true" }, now);
    expect(dry.rows[0].title).toBe("Passport 1");

    const real = memoryStore([old(1), ...Array.from({ length: 19 }, fresh)]);
    const outcome = await runRetention(real.store, { RETENTION_DRY_RUN: "false" }, now);
    expect(outcome.counts.notes_redacted).toBe(1);
    expect(real.rows[0]).toMatchObject({ title: REDACTED_TEXT, body: "", redactedAt: now });
  });

  it("stops as incomplete when one night would touch more than 10 %", async () => {
    const { store, rows } = memoryStore([old(1), old(2), ...Array.from({ length: 8 }, fresh)]);
    const outcome = await runRetention(store, { RETENTION_DRY_RUN: "no" }, now);
    expect(outcome).toMatchObject({ complete: false, reason: "notes_share_exceeded" });
    expect(rows[0].title).toBe("Passport 1");
  });

  it("an empty table is fine for retention", async () => {
    const { store } = memoryStore([]);
    expect((await runRetention(store, { RETENTION_DRY_RUN: "0" }, now)).complete).toBeUndefined();
  });

  it("a retry with the old values cannot restore a redacted row", async () => {
    const { store, rows } = memoryStore([old(1), ...Array.from({ length: 19 }, fresh)]);
    const staleCopy = { ...rows[0] };
    await runRetention(store, { RETENTION_DRY_RUN: "false" }, now);
    // The retried write (stale form, replayed request) goes through the service guard first.
    expect(() => assertNotRedacted(rows[0])).toThrow(/retention/);
    // A second retention run does not touch it again either.
    expect((await runRetention(store, { RETENTION_DRY_RUN: "false" }, now)).counts.notes_expired).toBe(0);
    expect(rows[0].title).not.toBe(staleCopy.title);
  });

  it("the database trigger in migration 0003 refuses the write-back", () => {
    const sql = readFileSync(path.join(root, "prisma", "migrations", "0003_retention_and_job_runs", "migration.sql"), "utf8");
    expect(sql).toMatch(/BEFORE UPDATE ON "notes"/);
    for (const column of RETENTION_REGISTRY.find((e) => e.table === "notes")!.personalColumns) {
      expect(sql).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
  });
});

describe("retention registry", () => {
  it("covers every tenant table: a period, or a reason why there is no personal data", () => {
    const listed = [...RETENTION_REGISTRY.map((e) => e.table), ...Object.keys(NO_PERSONAL_DATA)].sort();
    expect(listed).toEqual([...TENANT_TABLES].sort());
  });

  it("docs/RETENTION.md carries the generated privacy-note lines", () => {
    const doc = readFileSync(path.join(root, "docs", "RETENTION.md"), "utf8");
    for (const line of privacyNoteLines()) expect(doc).toContain(line);
  });

  it("the period follows the setting, never 0 or forever", () => {
    const entry: RetentionEntry = { table: "t", label: "T", personalColumns: ["a"], periodSetting: "P", defaultDays: 30 };
    expect(privacyNoteLines([entry], { P: "90" })[0]).toContain("kept 90 days");
    expect(privacyNoteLines([entry], { P: "0" })[0]).toContain("kept 30 days");
  });
});
