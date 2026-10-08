/**
 * platform-client: the three access contexts that exist WITHOUT an answer of the platform.
 *
 *  - the local context of a person (no platform door: development, CI, the end-to-end run),
 *  - the worker context (a key that acts for no person),
 *  - the local context of a user key (the same situation as the first, for the machine door).
 *
 * None of them is a state for a server. WHETHER one of them may apply is decided elsewhere:
 * `config.resolveDoor` says if the local fallback is permitted at all, `decide` picks the
 * context. This file only says what each one contains. The values are LeadLab's.
 *
 * Replaces `localAccessContext`, `workerAccessContext`, `apiKeyAccessContext` and
 * `emptyGrants` / `emptyGrantedIds` in every Lab.
 */

import type {
  AccessContext,
  GrantedIds,
  OrgRole,
  ProductConfig,
  SessionIdentity,
} from "./types";

/** One `{ view: [], edit: [] }` per object type, with fresh arrays on every call. */
export function emptyGrants<T extends string>(objectTypes: readonly T[]): Record<T, GrantedIds> {
  const grants = {} as Record<T, GrantedIds>;
  for (const type of objectTypes) grants[type] = { view: [], edit: [] };
  return grants;
}

/** The Suite role as the session token carries it, in any case; anything else is a member. */
function orgRoleOf(role: unknown): OrgRole {
  const value = typeof role === "string" ? role.trim().toLowerCase() : "";
  return value === "owner" || value === "admin" ? value : "member";
}

/**
 * The context of a person WITHOUT the platform.
 *
 * `governed: false` is the truth: there is no organisation that decided anything, because
 * there is no platform. Nobody knows collections or grants, so there are none; visible is what
 * a person owns plus everything organisation-wide.
 *
 * The Suite role is mapped to `product_admin` so that the administrative areas can be reached
 * while developing. This is expressly NOT a floor for a server: as soon as the door is
 * configured the platform's product role decides alone, and a Suite role gives neither access
 * nor sight (platform contract, round 3).
 */
export function localAccessContext<T extends string>(
  session: SessionIdentity,
  product: ProductConfig<T>,
): AccessContext<T> {
  const orgRole = orgRoleOf(session.role);
  const productAdmin = orgRole !== "member";
  return {
    userId: session.userId,
    organisationId: session.organisationId,
    email: session.email,
    orgRole,
    productRole: productAdmin ? "product_admin" : "user",
    governed: false,
    accessMode: "assigned",
    mayPublish: productAdmin,
    releaseStep: null,
    collections: [],
    grantedIds: emptyGrants(product.objectTypes),
    personalAllowed: true,
    membersMayShareOrg: true,
    membersMayCreateCollections: true,
    source: "local",
    productRoleSource: "local",
  };
}

/**
 * The context of a WORKER key: there is no person behind it.
 *
 * It sees organisation-visible rows only. That follows from the values, not from a special
 * rule: it owns nothing (`userId` is empty, and an empty id never matches an owner), it is in
 * no collection and it holds no grant. `personalAllowed: false` keeps it from creating a
 * private object that nobody, not even the key itself, could ever see.
 *
 * It hangs on the organisation, not on a person, so a person leaving does not revoke it and
 * the platform is never asked about it (inventory B19, recorded decision).
 *
 * `governed: false` is LeadLab's value. With product access being "has a product role" the
 * field decides nothing here, and `decide.applyUngoverned` leaves the context alone because
 * its source is not `platform`.
 */
export function workerAccessContext<T extends string>(
  organisationId: string,
  product: ProductConfig<T>,
): AccessContext<T> {
  return {
    userId: "",
    organisationId,
    email: "",
    orgRole: "member",
    productRole: "user",
    governed: false,
    accessMode: "assigned",
    mayPublish: false,
    releaseStep: null,
    collections: [],
    grantedIds: emptyGrants(product.objectTypes),
    personalAllowed: false,
    membersMayShareOrg: true,
    membersMayCreateCollections: false,
    source: "worker-key",
    productRoleSource: "worker",
  };
}

/**
 * The context of a USER key WITHOUT the platform: it acts as its creator, as a plain user.
 * The same role for the machine door that {@link localAccessContext} has for people, and just
 * as little a state for a server.
 */
export function localKeyAccessContext<T extends string>(
  input: { organisationId: string; createdByUserId: string },
  product: ProductConfig<T>,
): AccessContext<T> {
  return {
    userId: input.createdByUserId,
    organisationId: input.organisationId,
    email: "",
    orgRole: "member",
    productRole: "user",
    governed: false,
    accessMode: "assigned",
    mayPublish: false,
    releaseStep: null,
    collections: [],
    grantedIds: emptyGrants(product.objectTypes),
    personalAllowed: true,
    membersMayShareOrg: true,
    membersMayCreateCollections: true,
    source: "api-key",
    productRoleSource: "local",
  };
}
