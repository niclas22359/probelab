/**
 * The folder's own class-name joiner.
 *
 * `@/lib/utils` (clsx + tailwind-merge) is deliberately NOT used here: this
 * folder is copied verbatim into products that do not have that helper, and its
 * only allowed imports are React, next-intl, lucide-react and the product's own
 * `components/ui/*`. Five lines is a cheaper price than a copy that does not
 * compile on arrival.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
