/**
 * platform-client, Next adapter: session, gate and access for the current request.
 *
 * The decision is `core/decide.resolvePersonAccess` (token, gate, door, platform, ungoverned
 * window, in that order). This file only wires it into a request: it reads the session and
 * the token, evaluates ONCE per request however many layouts, pages and components ask, and
 * sends a person without access to the right page.
 *
 * Replaces the token reader, `gateOnce` / `accessOnce` / `tokenOnce` and the redirects of
 * `requireAccess` in every Lab's `rbac.ts` (advisorlab `checkAccess` / `requireAccess`).
 * `requireSession`, `ensureOrganisation`, `requireAccessOrFail` (built on `loadAccess`), the
 * `callbackUrl` handling and the blocked page with its texts stay in the product.
 *
 * Every `catch` in this file starts with `unstable_rethrow`. Next steers a request with errors
 * it throws on purpose (`redirect()`, `notFound()`, the signal of a dynamic API used while a
 * page is prerendered). They are not disturbances and must reach the framework: a redirect
 * inside the host's session reader read as "not signed in", or a swallowed prerender signal,
 * would send people to the wrong place. `unstable_rethrow` hands those on and returns for
 * every other error, which is then "could not check" as before.
 */

import { redirect, unstable_rethrow } from "next/navigation";
import { cache } from "react";

import { resolvePersonAccess } from "../core/decide";
import type {
  AccessDenyReason,
  Door,
  DoorState,
  GrantedAccess,
  LoadedAccess,
  NextAccess,
  NextAccessOptions,
  RedirectOptions,
  SessionIdentity,
} from "../core/types";
import { readPlatformToken } from "./token";

type PageReason = Exclude<AccessDenyReason, "unauthenticated">;

/** The query value per reason: the Labs' German words, plus `unavailable` (policy P1). */
const DEFAULT_REASON_VALUES: Record<PageReason, string> = {
  blocked: "gesperrt",
  "no-product-access": "nicht-teil",
  unavailable: "unavailable",
};

export function createNextAccess<T extends string>(options: NextAccessOptions<T>): NextAccess<T> {
  function denied(
    reason: AccessDenyReason,
    doorState: DoorState,
    session: SessionIdentity | null,
    token: string | null,
  ): LoadedAccess<T> {
    return { session, token, outcome: { ok: false, reason, gate: null, doorState } };
  }

  /** `fresh`: ask the platform past its 60 s cache (`me(token, { fresh: true })`). */
  async function evaluate(fresh: boolean): Promise<LoadedAccess<T>> {
    // The door is read once per evaluation, so every part of the answer speaks about the
    // same state. A host callback that throws is "could not check", and nobody gets in.
    let door: Door;
    try {
      door = options.door();
    } catch (error) {
      unstable_rethrow(error);
      (options.log ?? console).error("[platform-access] the door settings could not be read:", error);
      return denied("unavailable", "unconfigured", null, null);
    }

    let session: SessionIdentity | null;
    try {
      session = await options.session();
    } catch (error) {
      unstable_rethrow(error);
      // A session that cannot be verified is no session.
      (options.log ?? console).error("[platform-access] the session could not be read:", error);
      session = null;
    }
    if (!session) return denied("unauthenticated", door.state, null, null);

    let token: string | null;
    try {
      const raw = await (options.token ? options.token() : readPlatformToken());
      // A token that is blank after trimming is no token (API.md section 0, rule 11).
      token = typeof raw === "string" && raw.trim() !== "" ? raw : null;
    } catch (error) {
      unstable_rethrow(error);
      token = null;
    }

    try {
      const outcome = await resolvePersonAccess<T>({
        token,
        session,
        door,
        // Called as methods of their objects: a client may be a class instance.
        me: (value: string) =>
          fresh ? options.client.me(value, { fresh: true }) : options.client.me(value),
        gate: (value: string) => options.suite.gate(value),
        ungoverned: options.ungoverned,
        product: options.product,
        ...(options.log ? { log: options.log } : {}),
      });
      return { session, token, outcome };
    } catch (error) {
      unstable_rethrow(error);
      // `resolvePersonAccess` does not throw. Should it ever, that is "could not check".
      (options.log ?? console).error("[platform-access] the access decision failed:", error);
      return denied("unavailable", door.state, session, token);
    }
  }

  // React `cache`: one evaluation per server request, dropped when the request ends. It is
  // NOT a cache across requests; those live in the access client and the Suite client.
  const loadAccess = cache(() => evaluate(false));

  /**
   * Not memoised: a route that mints a credential asks once, past the platform cache, so a
   * key is never minted from a session whose token the platform already refuses.
   */
  function loadFreshAccess(): Promise<LoadedAccess<T>> {
    return evaluate(true);
  }

  async function requireAccessOrRedirect(redirectOptions: RedirectOptions): Promise<GrantedAccess<T>> {
    const { session, token, outcome } = await loadAccess();

    if (outcome.ok && session && token) {
      return { session, token, access: outcome.access, gate: outcome.gate };
    }

    // `redirect()` throws by design and is not caught here.
    // The sign-in is the answer only when there is no session or no token. When the host
    // verified the session and the PLATFORM refused the token (a JWT secret that differs
    // between Suite and platform, a token floor the Suite does not know), the Suite would
    // send the signed-in person straight back: the no-access page says "cannot be checked".
    if (outcome.ok || !session || !token) redirect(redirectOptions.loginUrl);
    const reason: PageReason = outcome.reason === "unauthenticated" ? "unavailable" : outcome.reason;

    const path = redirectOptions.noAccessPath ?? "/kein-zugriff";
    const param = redirectOptions.reasonParam ?? "grund";
    const value = redirectOptions.reasonValues?.[reason] ?? DEFAULT_REASON_VALUES[reason];
    redirect(`${path}?${param}=${encodeURIComponent(value)}`);
  }

  return { loadAccess, loadFreshAccess, requireAccessOrRedirect };
}
