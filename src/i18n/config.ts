/**
 * i18n base configuration — the ONLY place in the code that knows languages.
 *
 * Adding a language: create `messages/<code>.json`, translate it completely,
 * add the code to LOCALES. Nothing else changes. A partially translated
 * language does not belong in this list; `tests/unit/i18n.test.ts` checks
 * that all files carry the same keys.
 *
 * Deliberately no URL prefix (`/de/...`): a Lab is a signed-in workspace,
 * not a public website. The language hangs on the person (cookie).
 */
export const LOCALES = ["de", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "de";

/** Cookie name of the chosen language — next-intl convention. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Fixed time zone so server and browser render the same dates. */
export const DEFAULT_TIME_ZONE = "Europe/Berlin";

export function isSupportedLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}
