import { getRequestConfig } from "next-intl/server";

import { DEFAULT_TIME_ZONE, isSupportedLocale } from "./config";
import { resolveLocale } from "./locale";

/**
 * Request configuration for next-intl (wired in by next.config.ts). For every
 * request the language is resolved and the matching message tree loaded.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = isSupportedLocale(requested)
    ? requested
    : await resolveLocale();

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    timeZone: DEFAULT_TIME_ZONE,
  };
});
