"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { LAB_NAME } from "@/lib/lab";

const ITEMS = [
  { href: "/", key: "dashboard" },
  { href: "/notes", key: "notes" },
  { href: "/settings", key: "settings", manageOnly: true },
] as const;

export function AppNav({
  organisationName,
  canManageSettings = false,
  suiteUrl,
}: {
  organisationName: string;
  canManageSettings?: boolean;
  /** Ready target of the way back (`<Suite>/toolbox`), read server-side. */
  suiteUrl: string;
}) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <nav className="flex h-full w-full flex-col gap-1 border-r bg-white p-3">
      <div className="mb-4 px-2 pt-1">
        <p className="text-lg font-semibold tracking-tight">{LAB_NAME}</p>
        <p className="truncate text-xs text-zinc-500" title={organisationName}>
          {organisationName}
        </p>
      </div>

      {/* Back to the Suite: its own block ABOVE the menu, always visible.
          A plain <a>, because the target is another application. */}
      <div className="mb-3 border-b pb-3">
        <a
          href={suiteUrl}
          className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm font-medium hover:bg-zinc-100"
        >
          <span aria-hidden>←</span>
          {t("backToSuite")}
        </a>
      </div>

      {ITEMS.map((item) => {
        if ("manageOnly" in item && item.manageOnly && !canManageSettings) return null;
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              "rounded-md px-2.5 py-2 text-sm " +
              (active ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100")
            }
          >
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );
}
