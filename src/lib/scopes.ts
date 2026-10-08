/**
 * Scopes on machine credentials (`/api/v1`, `/api/mcp`).
 *
 * A small generic model: `read`, `write`, plus the Lab's own extra scopes for
 * operations that cannot be taken back or that reach outside the organisation
 * (`LAB_SCOPES`). A route or tool needs ALL scopes it names; no scope implies
 * another (`write` does not imply `read`, nor any extra scope).
 *
 *  - A new key gets `read` only unless its creator ticks more.
 *  - Keys that existed before scopes carry the legacy marker `*` (full
 *    access, also to scopes added later). Their owners narrow them by
 *    creating a new key and revoking the old one.
 *  - On-behalf tokens carry no scopes; `onBehalfScopes` is the ONE mapping.
 *  - People in the screen are not scoped: their permission is the container
 *    rule in the service, which applies to every door alike.
 *
 * Pure, no imports: loaded by the key form, `api-auth`, the manifest and tests.
 */

export const BASE_SCOPES = ["read", "write"] as const;

/**
 * The Lab's extra scopes, each with a label for the key form. Name them
 * `<object>:<verb>`. Add one for every operation that deletes data, reaches
 * a person outside the organisation, or spends money or credits.
 */
export const LAB_SCOPES = {
  "notes:delete": {
    de: "Notizen endgültig löschen",
    en: "Delete notes permanently",
  },
} as const;

export type Scope = (typeof BASE_SCOPES)[number] | keyof typeof LAB_SCOPES;

export const ALL_SCOPES: readonly Scope[] = [
  ...BASE_SCOPES,
  ...(Object.keys(LAB_SCOPES) as (keyof typeof LAB_SCOPES)[]),
];

/** Stored on keys created before scopes existed: everything, also future scopes. */
export const FULL_ACCESS = "*";

export const DEFAULT_KEY_SCOPES: readonly Scope[] = ["read"];

/** What a credential carries: scope names, or `*`. */
export type GrantedScopes = readonly string[];

export function missingScopes(
  granted: GrantedScopes,
  needed: readonly Scope[],
): Scope[] {
  if (granted.includes(FULL_ACCESS)) return [];
  return needed.filter((scope) => !granted.includes(scope));
}

export function hasScopes(
  granted: GrantedScopes,
  needed: readonly Scope[],
): boolean {
  return missingScopes(granted, needed).length === 0;
}

function isScope(value: unknown): value is Scope {
  return (
    typeof value === "string" &&
    (ALL_SCOPES as readonly string[]).includes(value)
  );
}

/** What the key form may store: known scopes in vocabulary order; nothing usable = read only. */
export function normaliseKeyScopes(values: readonly unknown[]): Scope[] {
  const chosen = new Set(values.filter(isScope));
  const out = ALL_SCOPES.filter((scope) => chosen.has(scope));
  return out.length > 0 ? out : [...DEFAULT_KEY_SCOPES];
}

/**
 * THE mapping from an on-behalf token to scopes. A token that names a person
 * (or a private agent's owner) acts with that person's rights, checked at the
 * platform per request, and the calling product's own agent safety asks a
 * human before a `destructive` tool: read, write and the Lab's extra scopes.
 * A token without a person (organisation or collection agent) gets read and
 * write only: nothing irreversible without somebody behind it.
 */
export function onBehalfScopes(input: {
  personUserId: string | null;
}): Scope[] {
  return input.personUserId ? [...ALL_SCOPES] : [...BASE_SCOPES];
}
