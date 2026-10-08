"use client";

import { Loader2 } from "lucide-react";

import type { ShareButtonProps } from "@/components/share/types";

/**
 * Adapter for the share blocks (contract: share-ui/HOST-CONTRACT.md in
 * beyondles-ai/beyondles-shared). Same look as the template's own buttons
 * (`rounded bg-zinc-900 text-white`). `isLoading` shows a spinner and makes
 * the button unclickable.
 */
const VARIANTS = {
  primary: "bg-zinc-900 text-white hover:bg-zinc-700",
  secondary: "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100",
  danger: "bg-red-600 text-white hover:bg-red-700",
} as const;

export function Button({
  type = "button",
  variant = "primary",
  size,
  isLoading = false,
  disabled = false,
  className,
  onClick,
  children,
}: ShareButtonProps) {
  const scale = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm";
  return (
    <button
      type={type}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      onClick={onClick}
      className={[
        "inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors",
        "focus-visible:ring-2 focus-visible:ring-zinc-900/40 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        scale,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
}
