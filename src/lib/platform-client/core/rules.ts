/**
 * The container rule as pure functions: who sees an object, who may change it, who may share
 * it, and which container a person may choose. No database, no network, no host.
 *
 * The rule is the platform's ("How a product applies the container", `platform-api`
 * `docs/API.md`), read the way CONTRACT section 4.1, policy P4 fixes it:
 *
 *   visible  = owner
 *           OR visibility = organisation AND the person has product access
 *           OR visibility = collection   AND the person is in that collection
 *           OR an individual grant on the object
 *   editable = visible AND (owner
 *                           OR organisation AND product access
 *                           OR collection   AND in that collection
 *                           OR an individual grant of level `edit`)
 *   owner only: delete, change visibility, change collection, hand over
 *
 * Three things this file deliberately does NOT contain, because they are guessed often:
 *  - Organisation admins and product admins see nothing extra. There is no branch for them.
 *  - A collection has no graded rights: whoever is in it may edit.
 *  - A `view` grant is read-only, literally. Every branch of `canEdit` carries its own
 *    condition; "visible somehow, therefore editable" is finding B1.
 *
 * This file imports `types.ts` only, so a product without the rest of the package (the API of
 * Beyondles HorAIzon) can copy it together with `types.ts` and nothing else.
 */
import type {
  AnyVisibility,
  ContainerChoice,
  ContainerChoiceResult,
  GrantLevel,
  ObjectContainer,
  PlatformVisibility,
  RuleContext,
  Visibility,
  VisibilityClause,
  VisibilityFields,
} from "./types";

/* --------------------------------------------------------------------------- spellings */

/**
 * Reads a visibility in either spelling and returns the upper-case one, or `null`.
 *
 * Exactly six strings are a visibility. Another casing, another type or a missing value is
 * `null`, and every rule below treats `null` as "neither organisation nor collection": only
 * the owner and holders of a grant get to such a row (fail closed).
 */
export function normaliseVisibility(value: unknown): Visibility | null {
  if (value === "PRIVATE" || value === "private") return "PRIVATE";
  if (value === "COLLECTION" || value === "collection") return "COLLECTION";
  if (value === "ORGANISATION" || value === "organisation") return "ORGANISATION";
  return null;
}

/** Either spelling to the platform's lower-case spelling. Everything unknown is `private`. */
export function toPlatformVisibility(value: AnyVisibility): PlatformVisibility {
  const visibility = normaliseVisibility(value);
  if (visibility === "COLLECTION") return "collection";
  if (visibility === "ORGANISATION") return "organisation";
  return "private";
}

/**
 * The platform's spelling to the upper-case one, or `null`. This reads what came over the
 * wire and refuses everything else, including the upper-case spelling: that one is no wire
 * value, and accepting it would hide a caller that sends the wrong thing.
 */
export function fromPlatformVisibility(value: unknown): Visibility | null {
  if (value === "private") return "PRIVATE";
  if (value === "collection") return "COLLECTION";
  if (value === "organisation") return "ORGANISATION";
  return null;
}

/* ----------------------------------------------------------------------- private helpers */

/**
 * The same rule as `decide.isOrgAdmin`, kept here so that this file can be copied without
 * `decide.ts`: the organisation role, trimmed and lower-cased, is `owner` or `admin`.
 */
function isOrganisationAdmin(ctx: { orgRole: string }): boolean {
  const role = typeof ctx.orgRole === "string" ? ctx.orgRole.trim().toLowerCase() : "";
  return role === "owner" || role === "admin";
}

/** "Product access" throughout this file: the person has a product role. One condition. */
function hasRole(ctx: { productRole: RuleContext["productRole"] }): boolean {
  return ctx.productRole !== null && ctx.productRole !== undefined;
}

/** "In the collection": the object names a collection and the person is a member of it. */
function inCollectionOf(ctx: RuleContext, o: { collectionId: string | null }): boolean {
  const collectionId = o.collectionId;
  if (typeof collectionId !== "string" || collectionId === "") return false;
  return ctx.collections.some((collection) => collection.id === collectionId);
}

/**
 * The grant lists of one object type, or `null` when the context has no entry for it.
 *
 * `grantedIds` is looked up by OWN key only. A plain property read would find what every
 * object inherits (`constructor`, `toString`) for a type of that name and then fail on a
 * missing list instead of answering "no grant".
 */
function grantsOf(ctx: RuleContext, type: string): { view: string[]; edit: string[] } | null {
  const all = ctx.grantedIds;
  if (all === null || typeof all !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(all, type)) return null;
  const entry = all[type];
  if (entry === null || typeof entry !== "object") return null;
  return {
    view: Array.isArray(entry.view) ? entry.view : [],
    edit: Array.isArray(entry.edit) ? entry.edit : [],
  };
}

/* ------------------------------------------------------------------------------- rules */

/**
 * Does the object belong to this person? A row without an owner belongs to nobody, and that
 * includes a context whose own `userId` is empty (a worker key): `"" === ""` must not turn
 * every ownerless row into the worker's property.
 */
export function isOwner(ctx: { userId: string }, o: { ownerUserId: string | null }): boolean {
  return typeof o.ownerUserId === "string" && o.ownerUserId !== "" && o.ownerUserId === ctx.userId;
}

/**
 * The right an individual grant hands out, or `null`. `edit` wins when both lists carry the
 * id. A type the context has no entry for gives `null`.
 */
export function grantLevel(ctx: RuleContext, type: string, o: { id: string }): GrantLevel | null {
  const grants = grantsOf(ctx, type);
  if (!grants) return null;
  if (grants.edit.includes(o.id)) return "edit";
  if (grants.view.includes(o.id)) return "view";
  return null;
}

/**
 * SEE. Policy P4, four branches, the first matching one decides.
 *
 * The organisation branch is an early return on purpose: a person whose product access was
 * withdrawn does not get an organisation-wide row back through a grant (LeadLab
 * `access-rules.test.ts:289`). Do not "repair" it into a fall-through.
 */
export function canSee(ctx: RuleContext, type: string, o: ObjectContainer): boolean {
  if (isOwner(ctx, o)) return true;
  const visibility = normaliseVisibility(o.visibility);
  if (visibility === "ORGANISATION") return hasRole(ctx);
  if (visibility === "COLLECTION" && inCollectionOf(ctx, o)) return true;
  return grantLevel(ctx, type, o) !== null;
}

/**
 * EDIT. Policy P4. `canSee` comes first: nobody edits what they cannot see.
 *
 * EVERY BRANCH CARRIES ITS OWN CONDITION. The short form of the platform contract
 * (`editable = owner OR visibility IN (collection, organisation) OR grant = edit`) means the
 * things a person can see THROUGH THAT VERY BRANCH. A rule that only reads the value of
 * `visibility` after any `canSee` builds finding B1: Anna puts her lead into the collection
 * Marketing and additionally shares it with Ben, who is not in Marketing, as "view". Ben sees
 * it through the GRANT. Reading `visibility === COLLECTION` afterwards would turn his
 * read-only into edit. The same holds for an organisation-wide row in the hands of somebody
 * who lost product access and only holds a grant.
 */
export function canEdit(ctx: RuleContext, type: string, o: ObjectContainer): boolean {
  if (!canSee(ctx, type, o)) return false;
  const visibility = normaliseVisibility(o.visibility);
  // Platform contract round 2 section 7 (closes B9): once the organisation switched "only me"
  // off, an existing private object stays readable but must be moved before it is edited.
  // The sentence is about the OBJECT, so it binds the owner and a holder of an `edit` grant
  // alike. Moving stays possible: `canManage` and `mayChooseVisibility` do not ask this rule.
  if ((visibility === "PRIVATE" || visibility === null) && ctx.personalAllowed === false) {
    return false;
  }
  if (isOwner(ctx, o)) return true;
  if (visibility === "ORGANISATION" && hasRole(ctx)) return true;
  // A collection has no graded rights: whoever is in THIS collection may edit.
  if (visibility === "COLLECTION" && inCollectionOf(ctx, o)) return true;
  // A `view` grant never yields edit (closes B1).
  return grantLevel(ctx, type, o) === "edit";
}

/**
 * Delete, change visibility, change collection, hand over: the owner only. A function of its
 * own instead of `isOwner` at the call sites, so that the intent is readable there.
 */
export function canManage(ctx: { userId: string }, o: { ownerUserId: string | null }): boolean {
  return isOwner(ctx, o);
}

/**
 * May the person CHOOSE this container?
 *
 * The selection in the user interface is a courtesy. The platform holds no object it could
 * check, so the product has to check when it writes: `personalAllowed: false` forbids new
 * "only me" objects, `membersMayShareOrg: false` keeps "the whole organisation" for the
 * organisation's admins. Which collection is `checkContainerChoice`'s question.
 */
export function mayChooseVisibility(ctx: RuleContext, next: AnyVisibility): boolean {
  const visibility = normaliseVisibility(next);
  if (visibility === "PRIVATE") return ctx.personalAllowed;
  if (visibility === "ORGANISATION") return ctx.membersMayShareOrg || isOrganisationAdmin(ctx);
  if (visibility === "COLLECTION") return true;
  return false;
}

/**
 * The container a NEW object gets when the person chooses nothing: "only me"; when the
 * organisation switched that off, the first collection as the next narrowest choice; and the
 * whole organisation only when there is no collection (LeadLab `access-rules.ts:170`).
 *
 * `allowCollection: false` is for a caller that cannot name a collection (SummarizeLab's key
 * path, which creates a meeting without a collection id): "only me", else the organisation.
 *
 * UNCHECKED, on purpose: this is the value a picker starts with. The fallback "the whole
 * organisation" may be one the person may not choose (`membersMayShareOrg: false` and no
 * collection), and then no container at all is open to them. A path that CREATES an object
 * uses {@link defaultContainerChoice}, which runs the same check as a chosen container.
 */
export function defaultVisibility(
  ctx: RuleContext,
  options?: { allowCollection?: boolean },
): ContainerChoice {
  if (ctx.personalAllowed) return { visibility: "PRIVATE", collectionId: null };
  const collection = options?.allowCollection === false ? undefined : ctx.collections[0];
  if (collection) return { visibility: "COLLECTION", collectionId: collection.id };
  return { visibility: "ORGANISATION", collectionId: null };
}

/**
 * {@link defaultVisibility}, checked with {@link checkContainerChoice}: the container a create
 * path may write when the person chose nothing, or the refusal it answers with. Never a
 * container the person could not have chosen themselves (`VISIBILITY_NOT_ALLOWED`, 403, for a
 * member whose organisation switched off "only me" and sharing with everyone while they are
 * in no collection; the product tells them to pick or create a collection).
 */
export function defaultContainerChoice(
  ctx: RuleContext,
  options?: { allowCollection?: boolean },
): ContainerChoiceResult {
  return checkContainerChoice(ctx, defaultVisibility(ctx, options));
}

/**
 * Checks a container a person wants to put an object into. `choice.visibility` is read in
 * either spelling. The first failing check decides:
 *
 *  1. not one of the three visibilities                       -> VALIDATION, 400
 *  2. a `collectionId` that is neither absent, `null` nor text -> VALIDATION, 400
 *  3. the visibility is not allowed for this person            -> VISIBILITY_NOT_ALLOWED, 403
 *  4. `collection` without a collection id                     -> COLLECTION_REQUIRED, 400
 *  5. `collection` the person is not a member of               -> COLLECTION_NOT_ALLOWED, 403
 *
 * Rule 5 exists because a collection the person is not in would be giving the object away to
 * a group they do not know, and they would no longer see their own object afterwards.
 *
 * A collection id sent next to `private` or `organisation` is dropped, not an error: the
 * share dialog remembers the last collection while the person switches back and forth.
 */
export function checkContainerChoice(
  ctx: RuleContext,
  choice: { visibility: unknown; collectionId?: unknown },
): ContainerChoiceResult {
  if (choice === null || typeof choice !== "object") {
    return { ok: false, code: "VALIDATION", status: 400 };
  }
  const visibility = normaliseVisibility(choice.visibility);
  if (visibility === null) return { ok: false, code: "VALIDATION", status: 400 };

  const rawCollectionId = choice.collectionId;
  if (
    rawCollectionId !== undefined &&
    rawCollectionId !== null &&
    typeof rawCollectionId !== "string"
  ) {
    return { ok: false, code: "VALIDATION", status: 400 };
  }

  if (!mayChooseVisibility(ctx, visibility)) {
    return { ok: false, code: "VISIBILITY_NOT_ALLOWED", status: 403 };
  }

  if (visibility !== "COLLECTION") {
    return { ok: true, value: { visibility, collectionId: null } };
  }

  const collectionId = typeof rawCollectionId === "string" ? rawCollectionId.trim() : "";
  if (collectionId === "") return { ok: false, code: "COLLECTION_REQUIRED", status: 400 };
  if (!inCollectionOf(ctx, { collectionId })) {
    return { ok: false, code: "COLLECTION_NOT_ALLOWED", status: 403 };
  }
  return { ok: true, value: { visibility: "COLLECTION", collectionId } };
}

/* ---------------------------------------------------------------- the rule as a query */

const DEFAULT_FIELDS: VisibilityFields = {
  id: "id",
  ownerUserId: "ownerUserId",
  visibility: "visibility",
  collectionId: "collectionId",
  spelling: "upper",
};

/** The defaults with the host's names on top. A field given as `undefined` keeps its default. */
function resolveFields(fields: Partial<VisibilityFields> | undefined): VisibilityFields {
  return {
    id: fields?.id ?? DEFAULT_FIELDS.id,
    ownerUserId: fields?.ownerUserId ?? DEFAULT_FIELDS.ownerUserId,
    visibility: fields?.visibility ?? DEFAULT_FIELDS.visibility,
    collectionId: fields?.collectionId ?? DEFAULT_FIELDS.collectionId,
    spelling: fields?.spelling ?? DEFAULT_FIELDS.spelling,
  };
}

/** The ids a context holds a grant on for one type: `view` first, then `edit`, each id once. */
function grantedObjectIds(ctx: RuleContext, type: string): string[] {
  const grants = grantsOf(ctx, type);
  if (!grants) return [];
  const ids: string[] = [];
  for (const id of [...grants.view, ...grants.edit]) {
    if (typeof id === "string" && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The branches of {@link canSee} as plain OR-clauses for a list query, in the shape Prisma's
 * `where` takes, for configurable column names.
 *
 * Why the rule exists a second time: a list must not load everything and filter afterwards,
 * and a single row must not be "checked" by a query that is easy to forget. The tests hold
 * both forms against each other row by row.
 *
 * Each clause appears only under its condition:
 *  1. own rows, when the context has a person. An empty `userId` adds NO owner clause, so a
 *     worker key never matches rows whose owner is `null` or `""`.
 *  2. organisation-wide rows, with product access.
 *  3. rows of the person's collections.
 *  4. rows with an individual grant.
 *
 * Clause 4 does not repeat the early return of `canSee`: for a person without product access
 * who holds a grant on an organisation-wide row the list is wider than the rule. That person
 * does not get past the entry check, and `canSee` on the loaded row stays the authority.
 *
 * The host always adds its organisation filter itself. This is never a replacement for it.
 */
export function visibilityClauses(
  ctx: RuleContext,
  type: string,
  fields?: Partial<VisibilityFields>,
): VisibilityClause[] {
  const names = resolveFields(fields);
  const lower = names.spelling === "lower";
  const clauses: VisibilityClause[] = [];

  if (typeof ctx.userId === "string" && ctx.userId !== "") {
    clauses.push({ [names.ownerUserId]: ctx.userId });
  }

  if (hasRole(ctx)) {
    clauses.push({ [names.visibility]: lower ? "organisation" : "ORGANISATION" });
  }

  // An empty id is no collection (the same reading as `inCollectionOf`), so it never reaches
  // the query, where it could match a broken row that `canSee` refuses.
  const collectionIds = ctx.collections
    .map((collection) => collection.id)
    .filter((id) => typeof id === "string" && id !== "");
  if (collectionIds.length > 0) {
    clauses.push({
      [names.visibility]: lower ? "collection" : "COLLECTION",
      [names.collectionId]: { in: collectionIds },
    });
  }

  const grantedIds = grantedObjectIds(ctx, type);
  if (grantedIds.length > 0) clauses.push({ [names.id]: { in: grantedIds } });

  return clauses;
}

/**
 * The branches of {@link canEdit} as plain OR-clauses, for a change to many rows at once (a
 * bulk retry, a bulk move). {@link visibilityClauses} must never be used for that: its grant
 * clause includes `view` grants, and a read-only person would get the change.
 *
 * Each clause appears only under its condition, and each matches exactly the rows `canEdit`
 * allows through that branch:
 *  1. own rows, when the context has a person. While the organisation has "only me" switched
 *     off, without the private ones (canEdit row 2).
 *  2. organisation-wide rows, with product access.
 *  3. rows of the person's collections.
 *  4. rows with an `edit` grant: without product access not the organisation-wide ones
 *     (`canSee` returns early there), and while "only me" is off not the private ones.
 *
 * `personalAllowedRule: false` leaves the "only me is off" restriction out of 1 and 4, for a
 * product that answers it per row instead ("move it first", AdvisorLab's 409). A row whose
 * stored visibility is none of the three values matches clause 4 only when no restriction
 * applies; that is narrower than `canEdit`, never wider. The host adds its organisation filter.
 */
export function editableClauses(
  ctx: RuleContext,
  type: string,
  fields?: Partial<VisibilityFields>,
  options?: { personalAllowedRule?: boolean },
): VisibilityClause[] {
  const names = resolveFields(fields);
  const spell = (visibility: Visibility): string =>
    names.spelling === "lower" ? visibility.toLowerCase() : visibility;
  const privateLocked = options?.personalAllowedRule !== false && ctx.personalAllowed === false;
  const role = hasRole(ctx);
  const clauses: VisibilityClause[] = [];

  if (typeof ctx.userId === "string" && ctx.userId !== "") {
    clauses.push(
      privateLocked
        ? {
            [names.ownerUserId]: ctx.userId,
            [names.visibility]: { in: [spell("COLLECTION"), spell("ORGANISATION")] },
          }
        : { [names.ownerUserId]: ctx.userId },
    );
  }

  if (role) clauses.push({ [names.visibility]: spell("ORGANISATION") });

  const collectionIds = ctx.collections
    .map((collection) => collection.id)
    .filter((id) => typeof id === "string" && id !== "");
  if (collectionIds.length > 0) {
    clauses.push({
      [names.visibility]: spell("COLLECTION"),
      [names.collectionId]: { in: collectionIds },
    });
  }

  const grants = grantsOf(ctx, type);
  const editIds: string[] = [];
  for (const id of grants ? grants.edit : []) {
    if (typeof id === "string" && !editIds.includes(id)) editIds.push(id);
  }
  if (editIds.length > 0) {
    const allowed: Visibility[] = [
      ...(privateLocked ? [] : (["PRIVATE"] as const)),
      "COLLECTION",
      ...(role ? (["ORGANISATION"] as const) : []),
    ];
    clauses.push(
      // All three allowed: no filter, so the clause reads exactly as the rule does.
      allowed.length === 3
        ? { [names.id]: { in: editIds } }
        : { [names.id]: { in: editIds }, [names.visibility]: { in: allowed.map(spell) } },
    );
  }

  return clauses;
}

/** {@link editableClauses} as one condition, with the same "matches nothing" form as {@link visibilityWhere}. */
export function editableWhere(
  ctx: RuleContext,
  type: string,
  fields?: Partial<VisibilityFields>,
  options?: { personalAllowedRule?: boolean },
): Record<string, unknown> {
  const clauses = editableClauses(ctx, type, fields, options);
  if (clauses.length === 0) return { [resolveFields(fields).id]: { in: [] } };
  return { OR: clauses };
}

/**
 * {@link visibilityClauses} as one condition: `{ OR: clauses }`, or, when there is no clause,
 * a condition that matches NOTHING (`{ id: { in: [] } }`). `{ OR: [] }` is not used for
 * "nothing": query builders disagree on whether that means no row or no restriction, and the
 * second reading would be every row.
 */
export function visibilityWhere(
  ctx: RuleContext,
  type: string,
  fields?: Partial<VisibilityFields>,
): Record<string, unknown> {
  const clauses = visibilityClauses(ctx, type, fields);
  if (clauses.length === 0) return { [resolveFields(fields).id]: { in: [] } };
  return { OR: clauses };
}
