import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  PERSON_EXECUTORS,
  PERSON_PLAN,
} from "@/server/services/platform-delete-member";

/**
 * Every scalar column that can hold a Suite user (id, email) must have a
 * decision in `PERSON_PLAN`. A migration that adds such a column fails here
 * until somebody decides what deleting a person means for it.
 *
 * The pattern lives HERE and only here. Add columns the pattern cannot see
 * (a user id under an odd name) to `EXTRA_PERSON_COLUMNS`, with the reason.
 */
const PERSON_COLUMN =
  /(^|[a-z])(userId|UserId|ownerId|OwnerId|email|Email)$|ByUserId$|ById$/;
const EXTRA_PERSON_COLUMNS: readonly string[] = [];

interface Column {
  table: string;
  column: string;
}

function schemaColumns(): { all: Column[]; personal: Column[] } {
  const schema = readFileSync(
    path.resolve(__dirname, "..", "..", "prisma", "schema.prisma"),
    "utf8",
  );
  const blocks = [...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)];
  const modelNames = new Set(blocks.map((b) => b[1]));
  const all: Column[] = [];
  for (const [, model, body] of blocks) {
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? model;
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const match = /^(\w+)\s+(\w+)(\[\]|\?)?/.exec(line);
      if (!match) continue;
      const [, column, type] = match;
      if (modelNames.has(type)) continue; // relation field, not a column
      all.push({ table, column });
    }
  }
  const personal = all.filter(
    (c) =>
      PERSON_COLUMN.test(c.column) ||
      EXTRA_PERSON_COLUMNS.includes(`${c.table}.${c.column}`),
  );
  return { all, personal };
}

describe("person deletion coverage", () => {
  const { all, personal } = schemaColumns();
  const planned = new Set(PERSON_PLAN.map((e) => `${e.table}.${e.column}`));

  it("finds the user columns the template is known to have", () => {
    // Guards the regex itself: if it stopped matching, the next test would
    // pass for the wrong reason.
    const found = personal.map((c) => `${c.table}.${c.column}`);
    expect(found).toContain("notes.ownerUserId");
    expect(found).toContain("api_keys.createdByUserId");
  });

  it("has a decision for every column that can hold a Suite user", () => {
    const missing = personal
      .map((c) => `${c.table}.${c.column}`)
      .filter((key) => !planned.has(key));
    expect(
      missing,
      `columns without a PERSON_PLAN entry: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("only plans columns that exist in the schema", () => {
    const known = new Set(all.map((c) => `${c.table}.${c.column}`));
    for (const key of planned)
      expect(known.has(key), `${key} is not in the schema`).toBe(true);
  });

  it("has an executor for every entry that changes rows, and none for the rest", () => {
    for (const entry of PERSON_PLAN) {
      const has = entry.id in PERSON_EXECUTORS;
      expect(has, entry.id).toBe(entry.treatment !== "not_personal");
    }
    expect(Object.keys(PERSON_EXECUTORS).sort()).toEqual(
      PERSON_PLAN.filter((e) => e.treatment !== "not_personal")
        .map((e) => e.id)
        .sort(),
    );
  });

  it("uses unique statement ids", () => {
    expect(new Set(PERSON_PLAN.map((e) => e.id)).size).toBe(PERSON_PLAN.length);
  });

  it("gives a written reason for every not_personal entry", () => {
    for (const entry of PERSON_PLAN.filter(
      (e) => e.treatment === "not_personal",
    )) {
      expect(
        entry.reason?.trim().length ?? 0,
        `${entry.id} needs a reason`,
      ).toBeGreaterThan(10);
    }
  });
});
