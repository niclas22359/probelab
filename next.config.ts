import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

/**
 * next-intl wires `src/i18n/request.ts` in so that `getTranslations` (server)
 * and `useTranslations` (client) get the right language per request. There is
 * deliberately no locale prefix in the URL: the middleware is the auth layer
 * and must not also rewrite routes. The language hangs on the person (cookie).
 */
const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  /**
   * Standalone bundle: `.next/standalone` holds a minimal Node server plus the
   * node_modules that file tracing found. That is what `docker/Dockerfile`
   * copies into the runtime image.
   */
  output: "standalone",
};

export default withNextIntl(nextConfig);
