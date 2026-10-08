import { NextResponse, type NextRequest } from "next/server";

/**
 * Upstream sign-in check. It only checks WHETHER a Suite cookie is present
 * and redirects to the Suite login otherwise. It verifies NO signature: the
 * middleware runs in the Edge runtime without Node `crypto`. The real
 * security boundary is `src/lib/auth.ts` + `src/lib/rbac.ts` on the Node
 * server, where every data query hangs on the verified `organisationId`.
 */

const PUBLIC_PATHS = [
  "/_next",
  "/favicon.ico",
  "/icon.png",
  "/apple-icon.png",
  "/api/health",
  /** Machine door: no cookie, security boundary is `x-api-key` in each route. */
  "/api/v1",
  /** Agent door (MCP): same reason. */
  "/api/mcp",
  /** Platform calls (export): `X-API-Key` = PLATFORM_EXPORT_KEY, checked in the route. */
  "/api/platform/",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) return NextResponse.next();

  if (request.cookies.get("platform-auth-token")?.value) return NextResponse.next();

  // No production fallback: without the variable there is no Suite to send
  // people to, and the stack refuses to start without it anyway.
  const platformUrl = process.env.NEXT_PUBLIC_PLATFORM_URL?.trim().replace(/\/+$/, "");
  if (!platformUrl) {
    return new NextResponse("NEXT_PUBLIC_PLATFORM_URL is not configured.", { status: 503 });
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || request.nextUrl.origin;
  const callbackUrl = encodeURIComponent(`${appUrl}${pathname}`);
  return NextResponse.redirect(`${platformUrl}/login?callbackUrl=${callbackUrl}`);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
