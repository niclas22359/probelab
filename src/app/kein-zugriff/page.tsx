import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireOrg } from "@/lib/rbac";
import { platformUrl } from "@/lib/platform/door";
import { hasProductAccess } from "@/lib/platform/access";

/**
 * Notice page for people without access. Lives OUTSIDE the `(app)` group:
 * its layout calls `requireAccess()` and would redirect here — a loop.
 *
 * Always shows the e-mail of the signed-in account, the reason and a way
 * back to the Suite. The reason is determined fresh from gate and platform
 * context, never from the address bar.
 *
 * Reasons: `blocked` (level 1: not released, or Suite unreachable),
 * `not-assigned` (level 2: the organisation has not given this person the
 * Lab, or the platform could not be asked), `not-configured` (the door state
 * is `unconfigured` or `off`: the platform door is missing in this
 * environment — an operator problem, not the person's).
 */
export default async function NoAccessPage() {
  const { session, access, gate, denied, doorState } = await requireOrg();
  const t = await getTranslations("noAccess");

  // Policy P1: with the door unconfigured or off nobody gets in; that is the
  // operator's problem, not the person's.
  const doorMissing = denied === "unavailable" && (doorState === "unconfigured" || doorState === "off");

  const reason = !gate.allowed
    ? gate.reason === "unreachable"
      ? "unreachable"
      : "blocked"
    : !access
      ? doorMissing
        ? "not-configured"
        : "not-assigned"
      : hasProductAccess(access)
        ? "allowed"
        : "not-assigned";

  const title =
    reason === "allowed"
      ? t("titleAllowed")
      : reason === "not-assigned"
        ? t("title")
        : reason === "not-configured"
          ? t("titleNotConfigured")
          : t("titleBlocked");
  const body =
    reason === "allowed"
      ? t("bodyAllowed")
      : reason === "not-assigned"
        ? t("body")
        : reason === "not-configured"
          ? t("bodyNotConfigured")
          : reason === "unreachable"
            ? t("bodyUnreachable")
            : t("bodyBlocked");

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-3 rounded-lg border bg-white p-6 text-sm">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-zinc-600">{body}</p>
        <p className="text-zinc-500">
          {t("signedInAs", { email: session.email, organisation: session.organisationSlug })}
        </p>
        {reason === "allowed" ? (
          <Link className="block underline" href="/">
            {t("toApp")}
          </Link>
        ) : null}
        <a className="block underline" href={platformUrl() ?? "https://beyondles.ai"}>
          {t("toSuite")}
        </a>
      </div>
    </main>
  );
}
