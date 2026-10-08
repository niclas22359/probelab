import {
  FRAME_SERVICES,
  FUNCTIONS,
  SCREEN_HELPERS,
  type FunctionEntry,
} from "@/server/functions.manifest";

/**
 * `docs/EXCLUSIONS.md`, rendered from the functions manifest. Written by
 * `npm run docs:exclusions`; `tests/unit/parity.test.ts` fails when the file
 * differs from this rendering, so the list cannot drift from the code.
 */

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderExclusions(
  functions: Readonly<Record<string, FunctionEntry>> = FUNCTIONS,
): string {
  const rows: string[] = [];
  for (const [id, entry] of Object.entries(functions)) {
    for (const door of ["screen", "rest", "mcp"] as const) {
      const value = entry[door] as unknown as Record<string, unknown>;
      if (typeof value.excluded === "string") {
        const label =
          door === "rest"
            ? "REST /api/v1"
            : door === "mcp"
              ? "MCP tool"
              : "screen";
        rows.push(`| \`${id}\` | ${label} | ${cell(value.excluded)} |`);
      }
    }
  }
  const workers = Object.entries(functions)
    .filter(([, e]) => e.trigger === "worker" && "path" in e.rest)
    .map(
      ([id, e]) =>
        `| \`${id}\` | \`${(e.rest as { method: string }).method} ${(e.rest as { path: string }).path}\` | ${e.scopes.join(", ")} |`,
    );

  return [
    "# Deliberate exclusions",
    "",
    "<!-- GENERATED from src/server/functions.manifest.ts by `npm run docs:exclusions`. Do not edit by hand: a unit test fails when this file differs. -->",
    "",
    "Every function of this Lab is reachable through the screen, REST `/api/v1` and the MCP tool door, except where listed here with the reason.",
    "",
    "## Doors deliberately left out",
    "",
    "| Function | Door | Why |",
    "|---|---|---|",
    ...rows,
    "",
    "## Worker-triggered routes (WORKER key only, REST only)",
    "",
    "| Function | Route | Scopes |",
    "|---|---|---|",
    ...(workers.length > 0 ? workers : ["| (none) | | |"]),
    "",
    "## Outside the rule",
    "",
    "| Name | Why |",
    "|---|---|",
    ...Object.entries({ ...FRAME_SERVICES, ...SCREEN_HELPERS }).map(
      ([name, why]) => `| \`${name}\` | ${cell(why)} |`,
    ),
    "",
  ].join("\n");
}
