import { apiJson } from "@/lib/api-errors";
import { buildOpenApi } from "@/lib/openapi";

/**
 * `GET /api/v1/openapi.json` — the machine-readable description of `/api/v1`,
 * generated from the functions manifest and the same zod schemas the routes
 * parse with. PUBLIC like `/api/health`: it describes the Lab's surface, never
 * tenant data, and a program needs it before it has a key. Every operation
 * still needs its credential and scopes.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return apiJson(
    buildOpenApi({ appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null }),
  );
}
