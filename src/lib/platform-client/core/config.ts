/**
 * platform-client: is the access door configured, and what happens when it is not.
 *
 * This is policy P1 of the contract (CONTRACT 4.1). The dangerous state is the quiet one: a
 * server that is attached to the Suite but has no platform address or key. On 2 Sep 2026
 * LeadLab ran every deploy in that state, let every Suite member in, and nothing looked
 * broken. The rule here: such a process has the state `unconfigured`, and in that state
 * nobody gets a context. "We could not check" is never "may enter".
 *
 * The host reads its own environment and passes the values in; this file reads none. The two
 * conventional variable names appear below as TEXT in operator messages only.
 *
 * Replaces `readDoorConfig`, `isPlatformAccessConfigured`, `accessDoorState`,
 * `localFallbackAllowed` and `assertAccessDoorSane` of every Lab, and with them the four
 * different door-state vocabularies.
 */

import type { Door, DoorConfig, DoorNotice, DoorSettings, Logger } from "./types";

/**
 * Words that stand in an example file or a half-finished setup instead of a value. Compared
 * after trimming, ignoring case. The union of BookingLab's and ContentLab's sentinel set.
 *
 * Two of the ten words are put together from halves. A product's CI scans its sources, and so
 * its copy of this file, for exactly these two words as leftover markers (the placeholder
 * gate), and a product must not edit its copy to silence that.
 */
const SENTINELS: readonly string[] = [
  "empty",
  "changeme",
  "change-me",
  ["to", "do"].join(""),
  "your-key-here",
  "your_key_here",
  "yourkeyhere",
  "placeholder",
  "x".repeat(3),
  "none",
];

/**
 * Is the value really set, and not merely a placeholder?
 *
 * Not a value: nothing, blanks, `<anything in angle brackets>` (the form example files use,
 * SignatureLab's rule) and the sentinel words above. A placeholder that counted as a key would
 * make the door report `ok` while the platform refuses every request (closes the placeholder
 * half of B16).
 */
export function isRealValue(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return false;
  return !SENTINELS.includes(trimmed.toLowerCase());
}

/** `true` for an address `new URL()` accepts and whose scheme is http or https. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Address and service key of platform-api, or `null` when either is missing, a placeholder,
 * or the address is not an http(s) URL.
 *
 * Half configured is not configured: with an address and no key every request would be 401
 * and look like an outage instead of a forgotten setting.
 */
export function readDoorConfig(input: {
  platformApiUrl: string | null | undefined;
  platformApiKey: string | null | undefined;
}): DoorConfig | null {
  if (!isRealValue(input.platformApiUrl) || !isRealValue(input.platformApiKey)) return null;
  const url = input.platformApiUrl.trim();
  if (!isHttpUrl(url)) return null;
  return { baseUrl: url.replace(/\/+$/, ""), apiKey: input.platformApiKey.trim() };
}

/**
 * Is this a production process? `NODE_ENV` is `production`, ignoring case and surrounding
 * white space. The contract's wording is `NODE_ENV === "production"`; a value read from an env
 * file with a trailing blank (`production `) or another casing names the same intent, and
 * reading it as "not production" would hand a server the local door. Every production check of
 * this file goes through here, so the three of them can never disagree.
 */
export function isProductionEnv(nodeEnv: unknown): boolean {
  return typeof nodeEnv === "string" && nodeEnv.trim().toLowerCase() === "production";
}

/**
 * Is this process in the host's local mode: sessions verified locally, no Suite?
 *
 * A local signing secret is a tool for development, CI and the end-to-end run. In a production
 * process a stray secret alone never switches the Suite off; only the host's existing explicit
 * override does. This is LeadLab's `isLocalMode()`, and it closes the gate half of B16, where
 * SummarizeLab's rule was "the secret is set" with no production guard.
 */
export function localSessionMode(input: {
  nodeEnv: string | undefined;
  localSecretSet: boolean;
  productionOverride: boolean;
}): boolean {
  return (
    input.localSecretSet === true &&
    (!isProductionEnv(input.nodeEnv) || input.productionOverride === true)
  );
}

/**
 * May the local fallback apply? LeadLab's rule: sessions are verified locally (CI, the
 * end-to-end run), or there is no Suite at all and the process is not a production process
 * (local development).
 *
 * A convenience for hosts with this rule. `resolveDoor` is the guard: whatever a host passes
 * as `localAllowed`, a production process is local only with the explicit override as well.
 */
export function localFallbackAllowed(input: {
  nodeEnv: string | undefined;
  suiteAttached: boolean;
  localJwtActive: boolean;
}): boolean {
  return (
    input.localJwtActive === true ||
    (input.suiteAttached !== true && !isProductionEnv(input.nodeEnv))
  );
}

/**
 * The state of the access door (policy P1). First matching row wins:
 *
 *  1. address and key are real              -> `ok`
 *  2. the host permits the local fallback,
 *     and the process is not production
 *     or carries the explicit override      -> `local`
 *  3. attached to the Suite                 -> `unconfigured`
 *  4. otherwise                             -> `off`
 *
 * In `unconfigured` and `off` nobody gets a context: people are refused with the reason
 * `unavailable`, user keys with 503 (`decide.ts`). That closes B2, B3, B5 and B6 at the
 * source. Row 2 is a second lock: a host that computes `localAllowed` too generously still
 * gets no local door in a production process without its override (B3, B16).
 */
export function resolveDoor(settings: DoorSettings): Door {
  const production = isProductionEnv(settings.nodeEnv);
  const config = readDoorConfig(settings);

  if (config !== null) return { state: "ok", config, production };

  const localPermitted =
    settings.localAllowed === true && (!production || settings.productionLocalOverride === true);
  if (localPermitted) return { state: "local", config: null, production };

  if (settings.suiteAttached === true) return { state: "unconfigured", config: null, production };
  return { state: "off", config: null, production };
}

/**
 * What an operator should read at boot about the door, or `null` when there is nothing to
 * say. Pure: it logs nothing.
 *
 * No hard stop on purpose. A process that dies at start takes `/api/health` with it, and with
 * it the answer to WHY. An unmistakable line at boot plus the `access` field of health is the
 * better signal.
 */
export function doorNotice(door: Door, productName: string): DoorNotice | null {
  if (door.state === "unconfigured") {
    return {
      level: "error",
      message:
        `WARNING: ${productName} is attached to the Suite, but the platform door is not ` +
        "configured (PLATFORM_API_URL / PLATFORM_API_KEY are missing or still a placeholder). " +
        `${productName} cannot ask the platform who has product access, so it lets NOBODY in ` +
        "and refuses every API key: people see the no-access page, keys get 503. " +
        "Set PLATFORM_API_URL and PLATFORM_API_KEY (the key's name must equal the product " +
        "key) in the environment of the service, make sure both reach the running process, " +
        'and restart. /api/health reports access: "unconfigured" until then.',
    };
  }

  if (door.state === "off" && door.production) {
    return {
      level: "error",
      message:
        `WARNING: ${productName} runs as a production process without a Suite and without a ` +
        "platform door (PLATFORM_API_URL / PLATFORM_API_KEY), and the local fallback is not " +
        `permitted here. ${productName} lets NOBODY in and refuses every API key with 503. ` +
        'Configure the Suite address and the platform door, then restart. /api/health reports access: "off" until then.',
    };
  }

  if (door.state === "local" && door.production) {
    return {
      level: "warn",
      message:
        `${productName} runs with the LOCAL access fallback in a production process, by ` +
        "explicit override. There are no product roles, collections or grants from the " +
        "platform: every signed-in member counts as a user, every owner or admin as a product " +
        "admin. This is meant for an end-to-end run and has no place on a server. " +
        '/api/health reports access: "local".',
    };
  }

  return null;
}

/**
 * Which door states were already reported in this process. The one piece of module-level
 * state in the package (API.md section 0.4): the line is for the operator at boot, and a
 * second copy per request would flood the log.
 */
const reportedStates = new Set<string>();

/**
 * Logs {@link doorNotice} through `log.error` or `log.warn`, at most once per process and
 * door state. A state that has nothing to say does not use up its line.
 */
export function reportDoorOnce(door: Door, productName: string, log: Logger = console): void {
  if (reportedStates.has(door.state)) return;
  const notice = doorNotice(door, productName);
  if (notice === null) return;
  reportedStates.add(door.state);

  const line = `[platform-access] ${notice.message}`;
  if (notice.level === "error") log.error(line);
  else log.warn(line);
}

/** Forgets what was reported. For tests only. */
export function resetDoorReport(): void {
  reportedStates.clear();
}
