"use client";

import { useId } from "react";

import type { ShareInputProps } from "@/components/share/types";

/**
 * Adapter for the share blocks (contract: share-ui/HOST-CONTRACT.md in
 * beyondles-shared). A text field like the template's own (`rounded border
 * px-2 py-1`), with the visible label tied to the field and the icon drawn
 * inside it.
 */
export function Input({
  label,
  icon,
  value,
  placeholder,
  disabled = false,
  autoComplete,
  onChange,
}: ShareInputProps) {
  const id = useId();
  return (
    <div className="space-y-1">
      {label ? (
        <label htmlFor={id} className="block text-xs font-medium">
          {label}
        </label>
      ) : null}
      <div className="relative">
        {icon ? (
          <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-zinc-500">
            {icon}
          </span>
        ) : null}
        <input
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete={autoComplete}
          onChange={onChange}
          className={[
            "w-full rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50",
            icon ? "pl-8" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        />
      </div>
    </div>
  );
}
