import { LAB_KEY } from "@/lib/lab";

/**
 * Contract test per platform edge (lab learnings, rule 15).
 *
 * WHY: the staging AI door answered 502 for 12 days while every Lab test
 * stayed green, because the tests use a FAKE door. Uploads landed in the
 * wrong Brain while the Lab said "accepted". Fakes prove our side; only a
 * real call proves the edge. `scripts/contract-check.ts` makes ONE cheap
 * real call per edge against staging, once a day (.github/workflows/
 * contract-check.yml), and alerts on failure.
 *
 * An edge whose settings are missing is reported as `missing`, which FAILS
 * the run: a check that silently skips is how the 12 days happened. A Lab
 * that does not use an edge removes it from `buildEdges`, in code, reviewed.
 */

export interface Edge {
  name: string;
  /** Names of the settings this edge needs; empty value = edge `missing`. */
  needs: string[];
  request: (env: Record<string, string>) => { url: string; init: RequestInit };
  /** Is this answer the contract? Gets status and parsed JSON (or null). */
  accept: (status: number, body: unknown) => boolean;
}

const json = (body: unknown): RequestInit["body"] => JSON.stringify(body);
const trim = (url: string) => url.replace(/\/+$/, "");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function buildEdges(): Edge[] {
  return [
    {
      name: "door-llm-complete",
      needs: ["PLATFORM_API_URL", "PLATFORM_API_KEY", "CONTRACT_ORGANISATION_ID"],
      request: (env) => ({
        url: `${trim(env.PLATFORM_API_URL)}/api/llm/complete`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": env.PLATFORM_API_KEY },
          // The door contract: { useCase, level }. Smallest possible call.
          body: json({
            organisationId: env.CONTRACT_ORGANISATION_ID,
            purpose: `${LAB_KEY}.contract-check`,
            useCase: "verification",
            level: "economy",
            messages: [{ role: "user", content: "Reply with the single word OK." }],
            maxTokens: 5,
          }),
        },
      }),
      accept: (status, body) =>
        status === 200 && isObject(body) && body.success === true && isObject(body.data) && typeof body.data.text === "string",
    },
    {
      // The media door's routing for this organisation: free (no generation),
      // but it proves key, organisation and media catalogue. A real image would
      // cost money every day. `/api/media` itself has no GET (404).
      name: "door-media-route",
      needs: ["PLATFORM_API_URL", "PLATFORM_API_KEY", "CONTRACT_ORGANISATION_ID"],
      request: (env) => ({
        url: `${trim(env.PLATFORM_API_URL)}/api/llm/route?organisationId=${encodeURIComponent(env.CONTRACT_ORGANISATION_ID)}&useCase=image&level=economy`,
        init: { method: "GET", headers: { "X-API-Key": env.PLATFORM_API_KEY } },
      }),
      accept: (status, body) =>
        status === 200 && isObject(body) && body.success === true && isObject(body.data) && typeof body.data.model === "string",
    },
    {
      // Without a session the Suite must answer 401 as JSON: that proves the
      // login edge is there and speaks the contract. A stored session token
      // would expire after 24 hours and turn this check red for good.
      name: "suite-auth-me",
      needs: ["NEXT_PUBLIC_PLATFORM_URL"],
      request: (env) => ({
        url: `${trim(env.NEXT_PUBLIC_PLATFORM_URL)}/api/auth/me`,
        init: { method: "GET" },
      }),
      accept: (status, body) => status === 401 && isObject(body) && !("unparsable" in body),
    },
    {
      // The platform reads OUR export with PLATFORM_EXPORT_KEY. Checked
      // against the Lab's own staging address with the staging key.
      name: "lab-export-key",
      needs: ["CONTRACT_LAB_URL", "PLATFORM_EXPORT_KEY", "CONTRACT_ORGANISATION_ID"],
      request: (env) => ({
        url: `${trim(env.CONTRACT_LAB_URL)}/api/platform/export?organisationId=${encodeURIComponent(env.CONTRACT_ORGANISATION_ID)}`,
        init: { method: "GET", headers: { "x-api-key": env.PLATFORM_EXPORT_KEY } },
      }),
      accept: (status) => status === 200,
    },
    // Brain: add an edge here when the Lab uses the Brain (BRAIN_API_URL +
    // its key), with one cheap read against the Lab's staging Brain.
  ];
}

export type EdgeResult = { name: string; status: "ok" | "failed" | "missing"; http?: number };

export async function checkEdges(
  edges: Edge[],
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<EdgeResult[]> {
  const results: EdgeResult[] = [];
  for (const edge of edges) {
    const values: Record<string, string> = {};
    const missing = edge.needs.filter((name) => !(values[name] = env[name]?.trim() ?? ""));
    if (missing.length > 0) {
      results.push({ name: edge.name, status: "missing" });
      continue;
    }
    const { url, init } = edge.request(values);
    try {
      const res = await fetchImpl(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(30_000) });
      const body: unknown = await res.json().catch((error: unknown) => ({ unparsable: String(error) }));
      results.push({ name: edge.name, status: edge.accept(res.status, body) ? "ok" : "failed", http: res.status });
    } catch (error) {
      results.push({ name: edge.name, status: "failed", http: 0 });
      console.error(`edge=${edge.name} network_error=${error instanceof Error ? error.name : "unknown"}`);
    }
  }
  return results;
}
