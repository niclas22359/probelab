import { cookies, headers } from "next/headers";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALES,
  isSupportedLocale,
  type Locale,
} from "./config";

/**
 * Resolves the language of a request, in this order:
 *   1. cookie `NEXT_LOCALE` (the person chose actively),
 *   2. `Accept-Language` of the browser,
 *   3. DEFAULT_LOCALE.
 */
export async function resolveLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isSupportedLocale(fromCookie)) return fromCookie;

  const headerStore = await headers();
  const acceptLanguage = headerStore.get("accept-language");
  if (acceptLanguage) {
    const match = parseAcceptLanguage(acceptLanguage);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/** `de-DE,de;q=0.9,en;q=0.8` -> "de". Pure function, unit-tested. */
export function parseAcceptLanguage(header: string): Locale | null {
  const candidates = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const quality = qParam ? Number(qParam.trim().slice(2)) : 1;
      return {
        base: tag.trim().toLowerCase().split("-")[0],
        quality: Number.isFinite(quality) ? quality : 0,
      };
    })
    .sort((a, b) => b.quality - a.quality);

  for (const candidate of candidates) {
    const hit = LOCALES.find((locale) => locale === candidate.base);
    if (hit) return hit;
  }
  return null;
}
