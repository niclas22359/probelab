import { getTranslations } from "next-intl/server";

import { uiActor } from "@/lib/actor";
import { requireAccess } from "@/lib/rbac";
import { accessDoorState } from "@/lib/platform/door";
import { countVisibleNotes } from "@/server/services/notes";

/**
 * The entry page at "/". The Suite tile points here. There is no landing
 * page in between: a signed-in person lands in the app.
 */
export default async function DashboardPage() {
  const ctx = await requireAccess();
  const { session } = ctx;
  const t = await getTranslations("dashboard");
  const count = await countVisibleNotes(uiActor(ctx));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-zinc-600">{t("intro")}</p>
      <p className="text-sm text-zinc-500">
        {t("signedInAs", { email: session.email, organisation: session.organisationSlug })}
      </p>
      <p className="text-sm text-zinc-500">{t("doorState", { state: accessDoorState() })}</p>
      <p className="text-sm">{t("notesCount", { count })}</p>
    </div>
  );
}
