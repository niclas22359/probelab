import { getTranslations } from "next-intl/server";

const KNOWN = new Set([
  "not_found",
  "forbidden",
  "invalid_request",
  "conflict",
  "container_required",
]);

/** The screen's text for an error code from the one mapping (`actionErrorCode`). */
export async function NoteError({ code }: { code?: string }) {
  if (!code) return null;
  const t = await getTranslations("notes.errors");
  const key = KNOWN.has(code) ? code : "internal_error";
  return (
    <p
      role="alert"
      className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800"
    >
      {t(key)}
    </p>
  );
}
