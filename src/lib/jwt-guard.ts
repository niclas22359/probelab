/**
 * The one place that decides whether this Lab verifies session tokens ITSELF.
 *
 * `JWT_SECRET` is a development and CI tool: without a running Suite the Lab
 * verifies the cookie locally. On staging and production the secret must NOT
 * exist — if it did and were used, a compromise of this Lab could forge
 * sessions for the whole platform.
 *
 * Rule (SIDE-PROJECTS.md, "Platform door"): the secret counts ONLY together
 * with `ALLOW_LOCAL_JWT=true`, and both belong to local development and CI
 * alone. A production process that finds `JWT_SECRET` without the switch
 * REFUSES TO START (`assertProductionEnvSane`, called from
 * `src/instrumentation.ts`). Refusing beats warning: a warning in a container
 * log at 03:00 is a warning nobody reads.
 */

type Env = Record<string, string | undefined>;

/** The secret to verify with, or `null` = ask the Suite (introspection). */
export function localJwtSecret(env: Env = process.env): string | null {
  const secret = env.JWT_SECRET?.trim() ?? "";
  if (secret.length === 0) return null;
  if (env.ALLOW_LOCAL_JWT !== "true") return null;
  return secret;
}

/** Local mode = local signature check, no Suite. */
export function isLocalMode(env: Env = process.env): boolean {
  return localJwtSecret(env) !== null;
}

/**
 * Throws when a production process carries `JWT_SECRET` without the explicit
 * switch. Called once at boot. `ALLOW_LOCAL_JWT=true` in production is the
 * E2E exception (production bundle without a Suite) and is itself reported.
 */
export function assertProductionEnvSane(env: Env = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const secret = env.JWT_SECRET?.trim() ?? "";
  if (secret.length === 0) return;
  if (env.ALLOW_LOCAL_JWT === "true") {
    console.error(
      "[jwt-guard] ALLOW_LOCAL_JWT=true in a production process: sessions are " +
        "verified LOCALLY, not by the Suite. Only an E2E run may do this.",
    );
    return;
  }
  throw new Error(
    "[jwt-guard] JWT_SECRET is set in a production process. A Lab must never " +
      "hold the platform's signing secret. Remove JWT_SECRET from the " +
      "environment (server .env, compose) and restart.",
  );
}
