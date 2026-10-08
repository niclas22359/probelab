import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { TOOL_DEFINITIONS } from "@/lib/mcp/catalog";
import type { FoundRoute, FoundTool, ParitySources } from "@/server/parity";

/**
 * Reads what the code really contains, for `parityProblems`: service and
 * action exports (source text, no import, so no database is needed), the
 * `/api/v1` route files and their handlers, the pages, and the MCP catalogue.
 */

const root = path.resolve(__dirname, "..", "..");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function files(dir: string, name: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Strip comments so a commented-out export does not count. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function exportedFunctions(source: string): string[] {
  return [
    ...source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm),
  ].map((m) => m[1] as string);
}

/** Each exported HTTP handler with the function id it passes to `openMachineDoor`. */
export function routeHandlers(source: string, routePath: string): FoundRoute[] {
  const heads = [
    ...source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Z]+)\b/gm),
  ].filter((m) => METHODS.includes(m[1] as string));
  return heads.map((head, i) => {
    const end = heads[i + 1]?.index ?? source.length;
    const body = source.slice(head.index ?? 0, end);
    const opens =
      /openMachineDoor\(\s*request\s*,\s*"([A-Za-z0-9_]+)"\s*\)/.exec(
        body,
      )?.[1] ?? null;
    return { method: head[1] as string, path: routePath, opens };
  });
}

function v1Path(file: string): string {
  const rel = path
    .relative(path.join(root, "src", "app"), path.dirname(file))
    .split(path.sep)
    .join("/");
  return `/${rel}`.replace(/\[([^\]]+)\]/g, "{$1}");
}

function pagePath(file: string): string {
  const rel = path
    .relative(path.join(root, "src", "app"), path.dirname(file))
    .split(path.sep);
  const parts = rel.filter((p) => p && !/^\(.*\)$/.test(p));
  return `/${parts.join("/")}`;
}

const SAMPLE_ARGS = {
  noteId: "00000000-0000-4000-8000-000000000000",
  title: "t",
  body: "b",
  visibility: "private",
};

export function toolsFound(definitions = TOOL_DEFINITIONS): FoundTool[] {
  return definitions.map((tool) => {
    const call = tool.toCall(SAMPLE_ARGS);
    return {
      name: tool.name,
      scopes: tool.scopes,
      call: { method: call.method, path: call.path },
    };
  });
}

export function readParitySources(): ParitySources {
  const services: Record<string, string[]> = {};
  for (const file of files(
    path.join(root, "src", "server", "services"),
    /\.ts$/,
  )) {
    services[path.basename(file, ".ts")] = exportedFunctions(code(file));
  }
  const actions = files(
    path.join(root, "src", "server", "actions"),
    /\.ts$/,
  ).flatMap((f) => exportedFunctions(code(f)));
  const routes = files(
    path.join(root, "src", "app", "api", "v1"),
    /^route\.ts$/,
  ).flatMap((f) => routeHandlers(code(f), v1Path(f)));
  const pages = files(path.join(root, "src", "app"), /^page\.tsx$/).map(
    pagePath,
  );
  return { services, actions, pages, routes, tools: toolsFound() };
}
