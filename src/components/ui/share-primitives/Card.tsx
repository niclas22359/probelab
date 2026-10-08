import type { ShareCardProps } from "@/components/share/types";

/**
 * Adapter for the share blocks (contract: share-ui/HOST-CONTRACT.md in
 * beyondles-shared). A bordered white panel like the template's note cards.
 * No `overflow-hidden`: the dialog scrolls inside it and must not be clipped.
 * With `padding="none"` the blocks bring their own padding through `className`.
 */
export function Card({
  variant,
  padding,
  className,
  children,
}: ShareCardProps) {
  return (
    <div
      className={[
        "rounded-lg border bg-white",
        variant === "elevated" ? "shadow-lg" : "",
        padding === "none" ? "" : "p-4",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
