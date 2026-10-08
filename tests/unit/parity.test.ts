import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renderExclusions } from "@/server/exclusions";
import {
  FRAME_SERVICES,
  FUNCTIONS,
  INFRASTRUCTURE_ROUTES,
  SCREEN_HELPERS,
  type FunctionEntry,
} from "@/server/functions.manifest";
import {
  parityProblems,
  type ParityManifest,
  type ParitySources,
} from "@/server/parity";
import { noteEnvelope } from "@/server/schemas/notes";

import {
  exportedFunctions,
  readParitySources,
  routeHandlers,
} from "../support/parity-sources";

/**
 * THE PARITY CHECK. Fails the build when the functions manifest and the code
 * drift apart (docs/FRAME.md 5). The fixtures below prove each of the four
 * failure kinds is caught.
 */

const real: ParityManifest = {
  functions: FUNCTIONS,
  frameServices: FRAME_SERVICES,
  screenHelpers: SCREEN_HELPERS,
  infrastructureRoutes: INFRASTRUCTURE_ROUTES,
};

describe("the template", () => {
  it("has parity between services, actions, routes and tools", () => {
    expect(parityProblems(real, readParitySources())).toEqual([]);
  });

  it("docs/EXCLUSIONS.md is the rendering of the manifest (run `npm run docs:exclusions`)", () => {
    const file = readFileSync(
      path.resolve(__dirname, "..", "..", "docs", "EXCLUSIONS.md"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(file).toBe(renderExclusions());
  });

  it("reads every /api/v1 handler with the function it opens", () => {
    const routes = readParitySources()
      .routes.map((r) => `${r.method} ${r.path} ${r.opens}`)
      .sort();
    expect(routes).toEqual([
      "DELETE /api/v1/notes/{noteId} deleteNote",
      "GET /api/v1/notes listNotes",
      "GET /api/v1/notes/{noteId} getNote",
      "GET /api/v1/openapi.json null",
      "PATCH /api/v1/notes/{noteId} updateNote",
      "POST /api/v1/notes createNote",
      "POST /api/v1/worker/expire-notes expireNotes",
    ]);
  });
});

/* -------------------------------------------------------------- fixtures */

const entry = (over: Partial<FunctionEntry> = {}): FunctionEntry => ({
  service: "things",
  scopes: ["read"],
  screen: { action: "listThingsAction" },
  rest: {
    method: "GET",
    path: "/api/v1/things",
    summary: "List",
    response: noteEnvelope,
  },
  mcp: { tool: "demo_list_things" },
  ...over,
});

const manifest = (
  functions: Record<string, FunctionEntry>,
): ParityManifest => ({
  functions,
  frameServices: {},
  screenHelpers: {},
  infrastructureRoutes: [],
});

const sources = (over: Partial<ParitySources> = {}): ParitySources => ({
  services: { things: ["listThings"] },
  actions: ["listThingsAction"],
  pages: ["/things"],
  routes: [{ method: "GET", path: "/api/v1/things", opens: "listThings" }],
  tools: [
    {
      name: "demo_list_things",
      scopes: ["read"],
      call: { method: "GET", path: "/api/v1/things?limit=5" },
    },
  ],
  ...over,
});

describe("parityProblems on fixtures", () => {
  it("a consistent fixture has no problem", () => {
    expect(
      parityProblems(manifest({ listThings: entry() }), sources()),
    ).toEqual([]);
  });

  it("(i) a service export missing from the manifest", () => {
    const problems = parityProblems(
      manifest({ listThings: entry() }),
      sources({ services: { things: ["listThings", "purgeThings"] } }),
    );
    expect(problems).toEqual([
      "(i) service things.purgeThings is not in the functions manifest",
    ]);
  });

  it("(ii) an entry pointing at a route, tool, action or page that does not exist", () => {
    const problems = parityProblems(
      manifest({ listThings: entry({ screen: { page: "/gone" } }) }),
      sources({ routes: [], tools: [], actions: [] }),
    );
    expect(problems).toEqual([
      "(ii) listThings: page /gone does not exist",
      "(ii) listThings: route GET /api/v1/things does not exist",
      "(ii) listThings: tool demo_list_things does not exist",
    ]);
    expect(
      parityProblems(
        manifest({ listThings: entry() }),
        sources({ actions: [] }),
      ),
    ).toEqual(["(ii) listThings: action listThingsAction does not exist"]);
  });

  it("(iii) a route, tool or action that the manifest does not know", () => {
    const problems = parityProblems(
      manifest({ listThings: entry() }),
      sources({
        routes: [
          { method: "GET", path: "/api/v1/things", opens: "listThings" },
          { method: "POST", path: "/api/v1/things", opens: "createThing" },
        ],
        tools: [
          {
            name: "demo_list_things",
            scopes: ["read"],
            call: { method: "GET", path: "/api/v1/things" },
          },
          { name: "demo_secret", scopes: ["read"], call: null },
        ],
        actions: ["listThingsAction", "sneakyAction"],
      }),
    );
    expect(problems).toEqual([
      "(iii) route POST /api/v1/things is not in the functions manifest",
      "(iii) tool demo_secret is not in the functions manifest",
      "(iii) action sneakyAction is not in the functions manifest",
    ]);
  });

  it("(iv) a door missing without an excluded reason", () => {
    const missing = { ...entry() } as Partial<FunctionEntry>;
    delete missing.mcp;
    const problems = parityProblems(
      manifest({ listThings: missing as FunctionEntry }),
      sources({ tools: [] }),
    );
    expect(problems).toEqual([
      "(iv) listThings: no mcp door and no excluded reason",
    ]);
    const blank = parityProblems(
      manifest({ listThings: entry({ mcp: { excluded: "  " } }) }),
      sources({ tools: [] }),
    );
    expect(blank).toEqual([
      "(iv) listThings: mcp is excluded without a reason",
    ]);
  });

  it("a tool whose scopes or call differ from the manifest, and a route that opens the wrong function", () => {
    const problems = parityProblems(
      manifest({ listThings: entry() }),
      sources({
        routes: [
          { method: "GET", path: "/api/v1/things", opens: "deleteThings" },
        ],
        tools: [
          {
            name: "demo_list_things",
            scopes: ["write"],
            call: { method: "GET", path: "/api/v1/other" },
          },
        ],
      }),
    );
    expect(problems).toEqual([
      '(ii) listThings: route GET /api/v1/things opens the door for "deleteThings", not "listThings"',
      "listThings: tool demo_list_things declares scopes [write], the manifest [read]",
      "listThings: tool demo_list_things calls GET /api/v1/other, not GET /api/v1/things",
    ]);
  });

  it("worker routes live under /api/v1/worker/ and have no tool", () => {
    const problems = parityProblems(
      manifest({ listThings: entry({ trigger: "worker" }) }),
      sources(),
    );
    expect(problems).toEqual([
      "listThings: a worker route lives under /api/v1/worker/",
      "listThings: a worker-triggered function is REST only; exclude its MCP door",
    ]);
  });
});

describe("the source readers", () => {
  it("find exported functions and ignore everything else", () => {
    expect(
      exportedFunctions(
        "export async function a() {}\nexport function b() {}\nexport const c = 1;\nfunction d() {}",
      ),
    ).toEqual(["a", "b"]);
  });

  it("pair each handler with the function it opens", () => {
    const src =
      'export async function GET(request: Request) {\n  await openMachineDoor(request, "listThings");\n}\n' +
      "export async function POST(request: Request) {\n  await requireApiKey(request);\n}\n";
    expect(routeHandlers(src, "/api/v1/things")).toEqual([
      { method: "GET", path: "/api/v1/things", opens: "listThings" },
      { method: "POST", path: "/api/v1/things", opens: null },
    ]);
  });
});
