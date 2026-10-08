/**
 * The way back into the Suite. Every Lab is opened from the Suite's Toolbox;
 * without a way back it is a one-way street.
 *
 * The base is ALWAYS the Suite of the running environment, never hard-coded,
 * or a staging user lands in the production Suite and loses the session.
 */
export function suiteToolboxUrl(platformUrl: string | null | undefined): string {
  // An EMPTY value is not a set value: `??` does not catch `X=`.
  const base = (platformUrl ?? "").trim().replace(/\/+$/, "");
  return `${base || "https://beyondles.ai"}/toolbox`;
}
