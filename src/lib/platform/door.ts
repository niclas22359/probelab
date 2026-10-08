import {
  localFallbackAllowed,
  localSessionMode,
  readDoorConfig as readSharedDoorConfig,
  resolveDoor,
} from "@/lib/platform-client/core/config";
import type { Door, DoorConfig, DoorState } from "@/lib/platform-client/core/types";
import { localJwtSecret } from "@/lib/jwt-guard";

/**
 * Addresses and keys of the two doors — read in one place.
 *
 *  - `NEXT_PUBLIC_PLATFORM_URL` points to the SUITE (beyondles.ai or
 *    suite-staging.beyondles.ai): sign-in and level 1 (release switch).
 *  - `PLATFORM_API_URL` + `PLATFORM_API_KEY` point to the PLATFORM API
 *    (api.beyondles.ai): levels 2 + 3, AI, mail, protocol, export.
 *
 * The three variables are written out as `process.env.NAME` on purpose:
 * `tests/unit/deployment-env.test.ts` scans `src/` for exactly that form and
 * compares it with the `environment:` block of docker-compose.yml. A variable
 * read through an indirection is invisible to that guard, and that is how the
 * door once went missing on every deploy.
 *
 * What the values MEAN is decided by the shared code
 * (`src/lib/platform-client/core/config.ts`, policy P1 of the access
 * contract): one door vocabulary for every product, placeholders from an
 * example file count as missing, and a production process never falls back
 * to the local context unless the explicit override is set. This file only
 * reads the environment and hands the values over; the shared code reads no
 * environment itself.
 *
 * A function, not a constant: tests stub `process.env` after the module
 * loaded. Deliberately without `server-only` so pure unit tests can load it.
 */

export type { DoorConfig, DoorState };

type Env = Record<string, string | undefined>;

function currentEnv(): Env {
  return {
    // The local switches (`JWT_SECRET`, `ALLOW_LOCAL_JWT`) are read by
    // `jwt-guard.ts`, their one home; they come along with the rest.
    ...process.env,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_PLATFORM_URL: process.env.NEXT_PUBLIC_PLATFORM_URL,
    PLATFORM_API_URL: process.env.PLATFORM_API_URL,
    PLATFORM_API_KEY: process.env.PLATFORM_API_KEY,
  };
}

/**
 * Suite address, or `null` when there is no Suite here. NO production
 * fallback on purpose: a staging box without the line must not silently sign
 * people in against production. The Compose file refuses to start without it.
 */
export function platformUrl(env: Env = currentEnv()): string | null {
  const raw = env.NEXT_PUBLIC_PLATFORM_URL?.trim().replace(/\/+$/, "");
  return raw ? raw : null;
}

/**
 * Address and key of the platform API, or `null` when either is missing, is a
 * placeholder, or the address is no http(s) URL. Half configured is not
 * configured: an address without a key answers 401 to everything and would
 * look like an outage instead of a missing line.
 */
export function readDoorConfig(env: Env = currentEnv()): DoorConfig | null {
  return readSharedDoorConfig({ platformApiUrl: env.PLATFORM_API_URL, platformApiKey: env.PLATFORM_API_KEY });
}

/**
 * Are sessions verified LOCALLY in this process (CI, E2E, development)? The
 * switches are the template's own: `JWT_SECRET` counts only together with
 * `ALLOW_LOCAL_JWT=true` (`jwt-guard.ts`), and `ALLOW_LOCAL_JWT=true` is also
 * the existing explicit override for a production bundle without a Suite
 * (the E2E run). No new switch.
 */
export function localJwtActive(env: Env = currentEnv()): boolean {
  return localSessionMode({
    nodeEnv: env.NODE_ENV,
    localSecretSet: localJwtSecret(env) !== null,
    productionOverride: env.ALLOW_LOCAL_JWT === "true",
  });
}

/**
 * MAY THE LOCAL FALLBACK APPLY AT ALL? Only where it belongs:
 *  - sessions are verified LOCALLY (`localJwtActive`) — CI and E2E;
 *  - or no Suite at all AND not a production process — local development.
 * On staging and production neither is true. If the door is missing there,
 * the Lab is closed for EVERYONE: "we could not check" never means "come in".
 */
export function localAllowed(env: Env = currentEnv()): boolean {
  return localFallbackAllowed({
    nodeEnv: env.NODE_ENV,
    suiteAttached: platformUrl(env) !== null,
    localJwtActive: localJwtActive(env),
  });
}

/**
 * The resolved door (policy P1), computed on every call:
 *  - `ok`           — address and key of the platform are set. It decides.
 *  - `local`        — no door, and the local fallback is permitted (above).
 *  - `unconfigured` — Suite yes, platform door no. Nobody gets in, every
 *                     user key is refused with 503; worker keys keep working.
 *  - `off`          — no Suite, no door, no local fallback (a production
 *                     process without any configuration). Nobody gets in.
 */
export function door(env: Env = currentEnv()): Door {
  return resolveDoor({
    platformApiUrl: env.PLATFORM_API_URL,
    platformApiKey: env.PLATFORM_API_KEY,
    suiteAttached: platformUrl(env) !== null,
    localAllowed: localAllowed(env),
    productionLocalOverride: env.ALLOW_LOCAL_JWT === "true",
    nodeEnv: env.NODE_ENV,
  });
}

/** The state of the door in one word, for `/api/health`, the boot check and the pages. */
export function accessDoorState(env: Env = currentEnv()): DoorState {
  return door(env).state;
}
