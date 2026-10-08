import { describe, expect, it, vi } from "vitest";

import { buildEdges, checkEdges } from "@/server/jobs/contract-edges";
import { fillTemplate, judgeRequest, parseVerdict, pickScenarios, runScenario, score } from "@/server/jobs/simulation";

const env = {
  PLATFORM_API_URL: "https://door.test/",
  PLATFORM_API_KEY: "k",
  NEXT_PUBLIC_PLATFORM_URL: "https://suite.test",
  PLATFORM_EXPORT_KEY: "e",
  CONTRACT_LAB_URL: "https://lab.test",
  CONTRACT_ORGANISATION_ID: "00000000-0000-4000-8000-000000000000",
};

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("contract edges (fake fetch, no network)", () => {
  it("all edges ok when every answer matches the contract", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/api/llm/complete")) return reply(200, { success: true, data: { text: "OK" } });
      if (u.includes("/api/llm/route?")) return reply(200, { success: true, data: { model: "gpt-image-2" } });
      if (u.endsWith("/api/auth/me")) return reply(401, { error: "Not authenticated" });
      return reply(200, { success: true });
    }) as unknown as typeof fetch;
    const results = await checkEdges(buildEdges(), env, fetchImpl);
    expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("the door call stays on the contract: useCase + level, no model, no provider key", async () => {
    const llm = buildEdges().find((e) => e.name === "door-llm-complete")!;
    const { url, init } = llm.request(env);
    expect(url).toBe("https://door.test/api/llm/complete");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ useCase: "verification", level: "economy" });
    expect(body.model).toBeUndefined();
  });

  it("a 502 from the door fails, a missing setting is 'missing' (never skipped)", async () => {
    const fetchImpl = vi.fn(async () => reply(502, {})) as unknown as typeof fetch;
    const results = await checkEdges(buildEdges(), { ...env, PLATFORM_EXPORT_KEY: "" }, fetchImpl);
    expect(results.find((r) => r.name === "door-llm-complete")).toMatchObject({ status: "failed", http: 502 });
    expect(results.find((r) => r.name === "lab-export-key")).toMatchObject({ status: "missing" });
  });

  it("the Suite edge needs no stored session: a signed-in 200 is not the contract, a JSON 401 is", async () => {
    const suite = buildEdges().find((e) => e.name === "suite-auth-me")!;
    expect(suite.needs).toEqual(["NEXT_PUBLIC_PLATFORM_URL"]);
    expect(suite.accept(401, { error: "Not authenticated" })).toBe(true);
    expect(suite.accept(401, { unparsable: "SyntaxError" })).toBe(false);
    expect(suite.accept(502, {})).toBe(false);
  });

  it("a network error is a failure", async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const results = await checkEdges(buildEdges().slice(0, 1), env, fetchImpl);
    expect(results[0]).toMatchObject({ status: "failed", http: 0 });
    errors.mockRestore();
  });
});

describe("simulation harness (pure parts)", () => {
  const scenario = {
    id: "s",
    goal: "g",
    steps: [
      { method: "POST" as const, path: "/api/v1/notes", body: {} },
      { method: "DELETE" as const, path: "/api/v1/notes/{{prev.id}}" },
      { method: "GET" as const, path: "/api/v1/notes/{{prev.id}}" },
    ],
  };

  it("fills {{prev.id}} from the most recent step that returned data", async () => {
    const paths: string[] = [];
    await runScenario(scenario, async (step) => {
      paths.push(step.path);
      return step.method === "POST" ? { status: 201, body: { data: { id: "a b" } } } : { status: 204, body: null };
    });
    expect(paths).toEqual(["/api/v1/notes", "/api/v1/notes/a%20b", "/api/v1/notes/a%20b"]);
    expect(fillTemplate("/x/{{prev.id}}", null)).toBe("/x/");
  });

  it("runs N flows, default cycling through the scenarios", () => {
    expect(pickScenarios([scenario], 20)).toHaveLength(20);
    expect(pickScenarios([], 20)).toEqual([]);
  });

  it("judges through the door with useCase verification", () => {
    expect(judgeRequest(scenario, [], "org")).toMatchObject({ useCase: "verification", organisationId: "org" });
  });

  it("anything but a clear pass is a failure; the score counts", () => {
    const verdicts = [
      parseVerdict("1", '{"pass": true, "reason": "ok"}'),
      parseVerdict("2", 'Sure! {"pass": "yes"}'),
      parseVerdict("3", "HTTP 502"),
    ];
    expect(verdicts.map((v) => v.pass)).toEqual([true, false, false]);
    expect(score(verdicts)).toEqual({ passed: 1, total: 3, percent: 33 });
  });
});
