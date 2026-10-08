import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Doorkeeper for the tenant export (`GET /api/platform/export`).
 *
 * The caller is the Beyondles platform API, which collects all data of an
 * organisation from every product. It presents `X-API-Key`; our side of it
 * is `PLATFORM_EXPORT_KEY`. No database, no relation to the customer keys in
 * `api_keys`: a Lab key does not open this door, and this key opens no other.
 *
 * Constant-time comparison over SHA-256 digests of both sides: runtime then
 * depends neither on the content nor on the length of a guessed value
 * (`timingSafeEqual` on raw strings THROWS on unequal length, which would
 * turn a wrong key into a 500 and leak the key length).
 *
 * An UNSET key closes the route (`503 EXPORT_NOT_CONFIGURED`), never opens it.
 * Pure function without `server-only`, so it is testable without mocks.
 */

export type ExportAuthResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 503;
      code: "UNAUTHORIZED" | "EXPORT_NOT_CONFIGURED";
      message: string;
    };

export function exportKeyFromEnv(): string | null {
  const value = process.env.PLATFORM_EXPORT_KEY?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export function exportKeyEquals(expected: string, presented: string): boolean {
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function checkExportKey(request: Request): ExportAuthResult {
  const expected = exportKeyFromEnv();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      code: "EXPORT_NOT_CONFIGURED",
      message: "PLATFORM_EXPORT_KEY is not set on this server.",
    };
  }
  const presented = request.headers.get("x-api-key")?.trim() ?? "";
  if (presented.length === 0 || !exportKeyEquals(expected, presented)) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Header X-API-Key is missing or invalid.",
    };
  }
  return { ok: true };
}
