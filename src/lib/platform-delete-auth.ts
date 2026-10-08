import { exportKeyEquals } from "@/lib/platform-export-auth";

/**
 * Doorkeeper for the tenant deletion (`DELETE /api/platform/organisation`).
 *
 * The caller is the Beyondles platform API, which erases one organisation in
 * every product. It presents `X-API-Key`; our side of it is
 * `PLATFORM_DELETE_KEY`.
 *
 * This is deliberately NOT the export key. The export key reads, this key
 * destroys, and a leaked read key must never be able to erase a customer.
 * There is no fallback to `PLATFORM_EXPORT_KEY`: an UNSET delete key closes
 * the route (`503 DELETE_NOT_CONFIGURED`), so deletion stays off on a server
 * until somebody switches it on on purpose.
 *
 * Same constant-time comparison as the export key. Pure function without
 * `server-only`, so it is testable without mocks.
 */

export type DeleteAuthResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 503;
      code: "UNAUTHORIZED" | "DELETE_NOT_CONFIGURED";
      message: string;
    };

export function deleteKeyFromEnv(): string | null {
  const value = process.env.PLATFORM_DELETE_KEY?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export function checkDeleteKey(request: Request): DeleteAuthResult {
  const expected = deleteKeyFromEnv();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      code: "DELETE_NOT_CONFIGURED",
      message: "PLATFORM_DELETE_KEY is not set on this server.",
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
