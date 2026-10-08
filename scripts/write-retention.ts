/**
 * Writes docs/RETENTION.md from the retention registry
 * (src/server/retention/registry.ts). `tests/unit/retention.test.ts` fails
 * when the file and the registry disagree. Run: `npm run docs:retention`.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { NO_PERSONAL_DATA, privacyNoteLines, RETENTION_REGISTRY } from "@/server/retention/registry";

const lines = [
  "# Retention",
  "",
  "<!-- GENERATED from src/server/retention/registry.ts by `npm run docs:retention`. Do not edit by hand: tests/unit/retention.test.ts fails when a registry line is missing. -->",
  "",
  "Periods are the defaults; the setting named in the",
  "registry overrides them per environment. The periods are a customer",
  "decision: until the customer signs them off they stay in docs/OFFEN.md.",
  "",
  "## Privacy-note lines",
  "",
  ...privacyNoteLines(),
  "",
  "## Settings",
  "",
  ...RETENTION_REGISTRY.map((e) => `- \`${e.periodSetting}\` (days, default ${e.defaultDays}) for \`${e.table}\``),
  "",
  "## Tenant tables without personal data",
  "",
  ...Object.entries(NO_PERSONAL_DATA).map(([table, why]) => `- \`${table}\`: ${why}`),
  "",
];
writeFileSync(path.resolve(__dirname, "..", "docs", "RETENTION.md"), lines.join("\n"), "utf8");
console.log("job=docs-retention status=complete counts=tables=" + RETENTION_REGISTRY.length);
