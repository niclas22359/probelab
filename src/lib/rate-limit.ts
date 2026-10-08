/**
 * Rate limit for the machine doors `/api/v1` and `/api/mcp`.
 *
 * Counted per door and per credential: an API key counts as `key:<id>`, an
 * on-behalf token as `cp:<calling product>:<organisation>`. Fixed one-minute
 * windows. Over the limit: `429 rate_limited` with `Retry-After`
 * (`src/lib/api-auth.ts`).
 *
 * Defaults per minute (env-tunable, empty = default, `0` = off):
 *   API_RATE_LIMIT_PER_MINUTE        120  per key on /api/v1
 *   MCP_RATE_LIMIT_PER_MINUTE         60  per key on /api/mcp
 *   ON_BEHALF_RATE_LIMIT_PER_MINUTE  600  per calling product and organisation, per door
 * A tool call also passes `/api/v1` (the tool calls it with the same
 * credential), so the v1 limit should stay above the MCP limit.
 * The token path has a second, coarser limit in the shared tool door
 * (`OBO_REQUESTS_PER_MINUTE`, 1200); this one is the Lab's own.
 *
 * PER PROCESS. The default store lives in memory: two containers or a
 * restart each count from zero. That is acceptable for one container per
 * environment (the Playground setup). A Lab that runs several replicas
 * replaces the store once at start-up with `setRateLimitStore` (Redis,
 * Postgres); the interface is one synchronous-looking method so a shared
 * store can implement it with a local cache in front.
 */

export type RateDoor = "v1" | "mcp";
export type RateCredential = "key" | "on-behalf";

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  hit(
    bucket: string,
    limit: number,
    windowMs: number,
    now: number,
  ): RateDecision;
}

export const RATE_LIMIT_DEFAULTS = { v1: 120, mcp: 60, onBehalf: 600 } as const;

const WINDOW_MS = 60_000;

/** In-memory fixed window. `maxBuckets` bounds memory; expired buckets are swept when it is reached. */
export function createMemoryStore(maxBuckets = 10_000): RateLimitStore {
  const buckets = new Map<string, { windowStart: number; count: number }>();
  return {
    hit(bucket, limit, windowMs, now) {
      let entry = buckets.get(bucket);
      if (!entry || now - entry.windowStart >= windowMs) {
        if (!entry && buckets.size >= maxBuckets) {
          for (const [key, value] of buckets)
            if (now - value.windowStart >= windowMs) buckets.delete(key);
        }
        entry = { windowStart: now, count: 0 };
        buckets.set(bucket, entry);
      }
      entry.count += 1;
      if (entry.count > limit) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((entry.windowStart + windowMs - now) / 1000),
        );
        return { allowed: false, remaining: 0, retryAfterSeconds };
      }
      return {
        allowed: true,
        remaining: limit - entry.count,
        retryAfterSeconds: 0,
      };
    },
  };
}

let store: RateLimitStore = createMemoryStore();

/** Replace the store once at start-up (shared store for several replicas). */
export function setRateLimitStore(next: RateLimitStore): void {
  store = next;
}

export function __resetRateLimitForTests(): void {
  store = createMemoryStore();
}

type Env = Record<string, string | undefined>;

function readLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Named reads, so `tests/unit/deployment-env.test.ts` sees them and checks Compose. */
function currentEnv(): Env {
  return {
    API_RATE_LIMIT_PER_MINUTE: process.env.API_RATE_LIMIT_PER_MINUTE,
    MCP_RATE_LIMIT_PER_MINUTE: process.env.MCP_RATE_LIMIT_PER_MINUTE,
    ON_BEHALF_RATE_LIMIT_PER_MINUTE:
      process.env.ON_BEHALF_RATE_LIMIT_PER_MINUTE,
  };
}

export function rateLimitFor(
  door: RateDoor,
  credential: RateCredential,
  env: Env = currentEnv(),
): number {
  if (credential === "on-behalf") {
    return readLimit(
      env.ON_BEHALF_RATE_LIMIT_PER_MINUTE,
      RATE_LIMIT_DEFAULTS.onBehalf,
    );
  }
  return door === "mcp"
    ? readLimit(env.MCP_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_DEFAULTS.mcp)
    : readLimit(env.API_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_DEFAULTS.v1);
}

export function checkRateLimit(input: {
  door: RateDoor;
  credential: RateCredential;
  subject: string;
  now?: number;
}): RateDecision {
  const limit = rateLimitFor(input.door, input.credential);
  if (limit === 0)
    return {
      allowed: true,
      remaining: Number.POSITIVE_INFINITY,
      retryAfterSeconds: 0,
    };
  return store.hit(
    `${input.door}|${input.subject}`,
    limit,
    WINDOW_MS,
    input.now ?? Date.now(),
  );
}
