import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";

import { LAB_NAME } from "@/lib/lab";

import "./globals.css";

export const metadata: Metadata = {
  title: LAB_NAME,
  description: `${LAB_NAME} — a Beyondles Lab.`,
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  return (
    <html lang={locale} className="h-full antialiased" suppressHydrationWarning>
      <body className="flex min-h-full flex-col bg-zinc-50 font-sans text-zinc-900">
        {/* Without props the provider takes locale, messages and time zone
            from src/i18n/request.ts, so `useTranslations` works in every
            client component. */}
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
