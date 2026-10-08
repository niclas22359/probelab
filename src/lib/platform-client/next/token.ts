/**
 * platform-client, Next adapter: the Suite token of the current request.
 *
 * The Suite sets one session cookie on its parent domain; every Lab reads it with the
 * framework's cookie store. Replaces `getAuthToken` in every Lab's `auth.ts`.
 */

import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import { AUTH_COOKIE_NAME } from "../core/types";

/**
 * The value of the Suite cookie, trimmed, or `null` when it is missing or empty.
 *
 * Outside a request (a script, a build step) the cookie store is not available and throws.
 * That is "no token", not an error: the caller treats a missing token as not signed in.
 *
 * One kind of error is NOT "no token": the control-flow errors Next throws on purpose, for
 * example when `cookies()` is called while a page is prerendered. The framework needs to
 * receive those to know that the page depends on the request; swallowing one could turn a
 * page behind the sign-in into a prerendered redirect. `unstable_rethrow` hands them on and
 * returns for every other error.
 */
export async function readPlatformToken(cookieName: string = AUTH_COOKIE_NAME): Promise<string | null> {
  try {
    const store = await cookies();
    const value = store.get(cookieName)?.value;
    if (typeof value !== "string") return null;
    const token = value.trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}
