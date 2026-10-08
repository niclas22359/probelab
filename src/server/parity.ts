import type { FunctionEntry } from "@/server/functions.manifest";

/**
 * The parity check between the functions manifest and the code. Pure: the
 * caller reads the folders (`tests/support/parity-sources.ts`) and passes
 * what it found; every problem comes back as one readable line. Empty array
 * = parity holds. `tests/unit/parity.test.ts` runs it on the real repo and
 * on fixtures for each kind of drift.
 */

export interface ParityManifest {
  functions: Readonly<Record<string, FunctionEntry>>;
  frameServices: Readonly<Record<string, string>>;
  screenHelpers: Readonly<Record<string, string>>;
  infrastructureRoutes: ReadonlyArray<{
    method: string;
    path: string;
    reason: string;
  }>;
}

export interface FoundRoute {
  method: string;
  /** OpenAPI form, `/api/v1/notes/{noteId}`. */
  path: string;
  /** The function id passed to `openMachineDoor` in this handler, or `null`. */
  opens: string | null;
}

export interface FoundTool {
  name: string;
  scopes: readonly string[];
  /** What the tool calls, from `toCall` with sample arguments; `null` for a tool that calls a service directly. */
  call: { method: string; path: string } | null;
}

export interface ParitySources {
  /** Service file (without `.ts`) -> exported function names. */
  services: Readonly<Record<string, readonly string[]>>;
  actions: readonly string[];
  /** App paths with a `page.tsx`: `/`, `/notes`, `/notes/[noteId]`. */
  pages: readonly string[];
  routes: readonly FoundRoute[];
  tools: readonly FoundTool[];
}

type Door = "screen" | "rest" | "mcp";

function excludedReason(door: unknown): string | null | undefined {
  if (!door || typeof door !== "object") return undefined;
  if ("excluded" in door) {
    const reason = (door as { excluded: unknown }).excluded;
    return typeof reason === "string" ? reason.trim() : "";
  }
  return null;
}

function matchesTemplate(template: string, path: string): boolean {
  const pattern = template
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\\?\{[^}]+\\?\}/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(path.split("?")[0] ?? "");
}

export function parityProblems(
  manifest: ParityManifest,
  found: ParitySources,
): string[] {
  const problems: string[] = [];
  const entries = Object.entries(manifest.functions);
  const routeKey = (method: string, path: string) =>
    `${method.toUpperCase()} ${path}`;
  const routes = new Map(
    found.routes.map((r) => [routeKey(r.method, r.path), r]),
  );
  const tools = new Map(found.tools.map((t) => [t.name, t]));
  const actions = new Set(found.actions);
  const pages = new Set(found.pages);

  // (i) every service export is in the manifest
  for (const [file, exports] of Object.entries(found.services)) {
    if (file in manifest.frameServices) continue;
    for (const name of exports) {
      const entry = manifest.functions[name];
      if (!entry)
        problems.push(
          `(i) service ${file}.${name} is not in the functions manifest`,
        );
      else if (entry.service !== file)
        problems.push(
          `(ii) ${name}: manifest says service "${entry.service}", found in "${file}"`,
        );
    }
  }

  const knownRoutes = new Set(
    manifest.infrastructureRoutes.map((r) => routeKey(r.method, r.path)),
  );
  const knownTools = new Set<string>();
  const knownActions = new Set(Object.keys(manifest.screenHelpers));

  for (const [id, entry] of entries) {
    // (ii) the service file exports this function
    const exported = found.services[entry.service];
    if (!exported?.includes(id))
      problems.push(
        `(ii) ${id}: service file "${entry.service}" does not export it`,
      );

    // (iv) every door is present or excluded with a reason
    for (const door of ["screen", "rest", "mcp"] as Door[]) {
      const value = (entry as unknown as Record<Door, unknown>)[door];
      const reason = excludedReason(value);
      if (reason === undefined)
        problems.push(`(iv) ${id}: no ${door} door and no excluded reason`);
      else if (reason === "")
        problems.push(`(iv) ${id}: ${door} is excluded without a reason`);
    }

    // (ii) the screen door exists
    const screen = entry.screen as unknown as
      Record<string, unknown> | undefined;
    if (screen && typeof screen.action === "string") {
      knownActions.add(screen.action);
      if (!actions.has(screen.action))
        problems.push(`(ii) ${id}: action ${screen.action} does not exist`);
    }
    if (screen && typeof screen.page === "string" && !pages.has(screen.page)) {
      problems.push(`(ii) ${id}: page ${screen.page} does not exist`);
    }

    // (ii) the REST door exists and opens the door for THIS function
    const rest = entry.rest as unknown as Record<string, unknown> | undefined;
    if (
      rest &&
      typeof rest.path === "string" &&
      typeof rest.method === "string"
    ) {
      const key = routeKey(rest.method, rest.path);
      knownRoutes.add(key);
      const route = routes.get(key);
      if (!route) problems.push(`(ii) ${id}: route ${key} does not exist`);
      else if (route.opens !== id) {
        problems.push(
          `(ii) ${id}: route ${key} opens the door for "${route.opens ?? "nothing"}", not "${id}"`,
        );
      }
      const underWorker = rest.path.startsWith("/api/v1/worker/");
      if (entry.trigger === "worker" && !underWorker)
        problems.push(`${id}: a worker route lives under /api/v1/worker/`);
      if (entry.trigger !== "worker" && underWorker)
        problems.push(
          `${id}: /api/v1/worker/ is for worker-triggered functions only`,
        );
    }
    if (entry.trigger === "worker" && excludedReason(entry.mcp) === null) {
      problems.push(
        `${id}: a worker-triggered function is REST only; exclude its MCP door`,
      );
    }

    // (ii) the tool exists, declares the same scopes and calls this route
    const mcp = entry.mcp as unknown as Record<string, unknown> | undefined;
    if (mcp && typeof mcp.tool === "string") {
      knownTools.add(mcp.tool);
      const tool = tools.get(mcp.tool);
      if (!tool) problems.push(`(ii) ${id}: tool ${mcp.tool} does not exist`);
      else {
        const want = [...entry.scopes].sort().join(",");
        const have = [...tool.scopes].sort().join(",");
        if (want !== have)
          problems.push(
            `${id}: tool ${tool.name} declares scopes [${have}], the manifest [${want}]`,
          );
        if (tool.call && rest && typeof rest.path === "string") {
          if (
            tool.call.method !== rest.method ||
            !matchesTemplate(rest.path, tool.call.path)
          ) {
            problems.push(
              `${id}: tool ${tool.name} calls ${tool.call.method} ${tool.call.path}, not ${String(rest.method)} ${rest.path}`,
            );
          }
        }
      }
    }
  }

  // (iii) nothing exists that the manifest does not know
  for (const route of found.routes) {
    if (!knownRoutes.has(routeKey(route.method, route.path))) {
      problems.push(
        `(iii) route ${routeKey(route.method, route.path)} is not in the functions manifest`,
      );
    }
  }
  for (const tool of found.tools) {
    if (!knownTools.has(tool.name))
      problems.push(`(iii) tool ${tool.name} is not in the functions manifest`);
  }
  for (const action of found.actions) {
    if (!knownActions.has(action))
      problems.push(`(iii) action ${action} is not in the functions manifest`);
  }
  return problems;
}
