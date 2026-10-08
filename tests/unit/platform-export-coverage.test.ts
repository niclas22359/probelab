import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { TENANT_TABLES } from "@/server/services/platform-export";

/**
 * The part of the export test that catches the real bug: every tenant table
 * of the schema must be in the export. A migration that adds a table with
 * `organisationId` fails here until `exportOrganisation` learns about it.
 */
function tenantTablesFromSchema(): string[] {
  const schema = readFileSync(path.resolve(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
  const tables: string[] = [];
  for (const block of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, model, body] = block;
    const isTenant = model === "Organisation" || /^\s*organisationId\s+String/m.test(body);
    if (!isTenant) continue;
    const map = /@@map\("([^"]+)"\)/.exec(body);
    tables.push(map ? map[1] : model);
  }
  return tables.sort();
}

describe("tenant export coverage", () => {
  it("exports every tenant table of the schema", () => {
    expect([...TENANT_TABLES].sort()).toEqual(tenantTablesFromSchema());
  });
});
