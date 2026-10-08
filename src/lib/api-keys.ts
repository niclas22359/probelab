import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { API_KEY_PREFIX } from "@/lib/lab";

/**
 * Creating and hashing API keys. Pure functions without a database.
 *
 * Only the SHA-256 hash is stored. The plaintext leaves the process exactly
 * once, in the display right after creation. SHA-256 instead of bcrypt: the
 * value is 32 bytes of randomness, there is nothing to guess, and a work
 * factor would cost on every API call.
 */

const KEY_BYTES = 32;

/**
 * Name of the one-time flash cookie that carries a freshly created key to the
 * settings page. httpOnly, 60 s, path-limited: it never appears in a URL,
 * in browser history, in proxy logs or in a screenshot of the address bar.
 */
export const NEW_KEY_COOKIE = "lab-new-api-key";

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function createApiKeySecret(): { plaintext: string; hash: string } {
  const plaintext = `${API_KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;
  return { plaintext, hash: hashApiKey(plaintext) };
}

/** Constant-time comparison of two hex hashes. */
export function hashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
