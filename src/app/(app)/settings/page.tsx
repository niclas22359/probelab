import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { NEW_KEY_COOKIE } from "@/lib/api-keys";
import { ALL_SCOPES, DEFAULT_KEY_SCOPES, FULL_ACCESS, LAB_SCOPES } from "@/lib/scopes";
import { requireAccess } from "@/lib/rbac";
import { platformUrl } from "@/lib/platform/door";
import { listApiKeys } from "@/server/services/api-keys";
import { createApiKeyAction, dismissNewKeyAction, revokeApiKeyAction } from "@/server/actions/api-keys";

/**
 * Settings: API keys (machine door) and the Team notice. Who is in the
 * organisation and who may use this Lab is decided in the Suite, never here.
 * The freshly created key arrives in a one-time httpOnly flash cookie (60 s),
 * never in the address bar; it is never stored in plaintext.
 */
export default async function SettingsPage() {
  const { access, organisationId, isAdmin } = await requireAccess();
  if (!isAdmin) redirect("/");
  const t = await getTranslations("settings");
  const created = (await cookies()).get(NEW_KEY_COOKIE)?.value;
  const keys = await listApiKeys(organisationId);
  const suite = platformUrl() ?? "https://beyondles.ai";
  const locale = (await getLocale()) === "de" ? "de" : "en";
  const scopeLabel = (scope: string): string =>
    scope === FULL_ACCESS
      ? t("scopeFull")
      : scope in LAB_SCOPES
        ? LAB_SCOPES[scope as keyof typeof LAB_SCOPES][locale]
        : t(scope === "write" ? "scopeWrite" : "scopeRead");

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">{t("apiKeysTitle")}</h2>
        <p className="text-sm text-zinc-600">{t("apiKeysIntro")}</p>

        {created ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            <p>{t("keyCreated")}</p>
            <code className="mt-1 block break-all">{created}</code>
            <form action={dismissNewKeyAction} className="mt-2">
              <button type="submit" className="rounded border px-2 py-1 text-xs">
                {t("keyCopied")}
              </button>
            </form>
          </div>
        ) : null}

        <form action={createApiKeyAction} className="flex flex-wrap items-end gap-2 rounded-lg border bg-white p-3">
          <label className="text-sm">
            <span className="mb-1 block">{t("keyName")}</span>
            <input name="name" required maxLength={80} className="rounded border px-2 py-1" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block">{t("keyKind")}</span>
            <select name="kind" className="rounded border px-2 py-1">
              <option value="user">{t("keyKindUser")}</option>
              <option value="worker">{t("keyKindWorker")}</option>
            </select>
          </label>
          <fieldset className="text-sm">
            <legend className="mb-1">{t("keyScopes")}</legend>
            <div className="flex flex-wrap gap-3">
              {ALL_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    name="scopes"
                    value={scope}
                    defaultChecked={DEFAULT_KEY_SCOPES.includes(scope)}
                  />
                  {scopeLabel(scope)}
                </label>
              ))}
            </div>
          </fieldset>
          <button type="submit" className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white">
            {t("createKey")}
          </button>
        </form>

        {keys.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("noKeys")}</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-white">
            {keys.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-2 p-3 text-sm">
                <span>
                  <span className="font-medium">{key.name}</span>{" "}
                  <span className="text-zinc-500">
                    · {key.kind.toLowerCase()} · {key.scopes.map(scopeLabel).join(", ")}
                    {key.createdByUserId === access.userId ? " · you" : ""}
                    {key.revokedAt ? ` · ${t("revoked")}` : ""}
                  </span>
                </span>
                {key.revokedAt ? null : (
                  <form action={revokeApiKeyAction}>
                    <input type="hidden" name="keyId" value={key.id} />
                    <button type="submit" className="rounded border px-2 py-1 text-xs">
                      {t("revoke")}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">{t("teamTitle")}</h2>
        <p className="text-sm text-zinc-600">{t("teamBody")}</p>
        <a className="text-sm underline" href={`${suite}/settings/members`}>
          {t("teamLink")}
        </a>
      </section>
    </div>
  );
}
