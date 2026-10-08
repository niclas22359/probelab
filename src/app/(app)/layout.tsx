import { requireAccess } from "@/lib/rbac";
import { db } from "@/lib/db";
import { platformUrl } from "@/lib/platform/door";
import { suiteToolboxUrl } from "@/lib/suite-url";
import { AppNav } from "@/components/layout/app-nav";

/**
 * Frame of the signed-in area. `requireAccess()` runs here ONCE for all sub
 * pages: Suite session, level 1 (gate), level 2 (product access), and the
 * organisation mirror on the first visit. Every action still checks again —
 * a layout is not a security boundary, server actions run without it.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, organisationId, isAdmin } = await requireAccess();

  const organisation = await db.organisation.findUnique({
    where: { id: organisationId },
    select: { name: true },
  });

  // Read server-side: NEXT_PUBLIC_* is baked into the browser bundle at build
  // time, and the Docker build has no per-environment value. Server-side the
  // running environment's Suite always wins.
  const suiteUrl = suiteToolboxUrl(platformUrl());

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="md:w-60 md:shrink-0">
        <AppNav
          organisationName={organisation?.name ?? session.organisationSlug}
          canManageSettings={isAdmin}
          suiteUrl={suiteUrl}
        />
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
