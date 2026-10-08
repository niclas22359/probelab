import { createAccessClient, parseAccessContext } from "@/lib/platform-client/core/context";
import {
  emptyGrants as sharedEmptyGrants,
  localAccessContext as sharedLocalAccessContext,
  localKeyAccessContext,
  workerAccessContext as sharedWorkerAccessContext,
} from "@/lib/platform-client/core/contexts";
import {
  hasProductAccess as sharedHasProductAccess,
  isProductAdmin as sharedIsProductAdmin,
  machineVerdict,
  resolveKeyAccess,
} from "@/lib/platform-client/core/decide";
import type {
  AccessContext as SharedAccessContext,
  GrantedIds,
  MachineDenyCode,
  MachineKey,
  ProductConfig,
  SessionIdentity,
  UngovernedPolicy,
} from "@/lib/platform-client/core/types";
import { LAB_KEY } from "@/lib/lab";
import { door, localAllowed, readDoorConfig } from "@/lib/platform/door";
import type { OnBehalfAgent } from "@/lib/platform/on-behalf";

/**
 * Access model, LEVELS 2 + 3 — both come from the PLATFORM, never from a
 * table of the Lab.
 *
 * One request per page view:
 *   `GET <PLATFORM_API_URL>/api/access/me?product=<LAB_KEY>`
 *   with `X-API-Key: <PLATFORM_API_KEY>` (WHICH product asks) and
 *   `Authorization: Bearer <Suite cookie>` (WHICH person asks).
 *
 * The answer says three things:
 *  1. may the person use this Lab at all (`productRole`, `governed`)?
 *  2. which collections is she in, which objects were granted to her
 *     individually (`collections`, `grantedLevels`)?
 *  3. what may she offer when sharing (`personalAllowed`, `membersMayShareOrg`)?
 *
 * FAIL CLOSED. This is the PERMISSION. If the platform is unreachable or
 * answers something unreadable: NO access, and that is NOT cached. 60 s cache
 * per token for clear answers (the contract's limit).
 *
 * The client, the parser, the caches and the key verdict are the shared code
 * of beyondles-ai/beyondles-shared (`src/lib/platform-client`, never edited
 * here). This file configures it for this Lab and keeps the names its callers
 * use.
 *
 * No `server-only` on purpose: rbac.ts, the actions and their unit tests load
 * this unmocked.
 */

/* ---------------------------------------------------------------- Types */

/** The top-level object types of this Lab that carry the container columns. */
export const OBJECT_TYPES = ["note"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export type {
  AccessCollection,
  GrantLevel,
  GrantedIds,
  OrgRole,
  ProductRole,
} from "@/lib/platform-client/core/types";

/**
 * The shared context for this Lab's object types. `source` says where it
 * comes from: `platform` = normal; `local` = no door (dev/CI);
 * `api-key`/`worker-key` = machine; `agent` = a collection agent behind an
 * on-behalf token (no person, one collection). `agent` is this Lab's own
 * addition to the shared sources, so the type is widened here and the shared
 * code stays untouched.
 */
export type AccessContext = Omit<SharedAccessContext<ObjectType>, "source"> & {
  source: SharedAccessContext<ObjectType>["source"] | "agent";
};

/** Which product asks the platform. `productKey` is the name of the service key. */
export const PRODUCT: ProductConfig<ObjectType> = { productKey: LAB_KEY, objectTypes: OBJECT_TYPES };

/**
 * While an organisation has not decided anything about this Lab in the Suite
 * (`governed: false`), the platform's answer stands: no product role, no
 * access. The template has no member table to fall back to (policy P2).
 */
export const UNGOVERNED: UngovernedPolicy = { mode: "refuse" };

/** One client per process: the caches live in it. The door is read per request. */
const client = createAccessClient<ObjectType>({
  product: PRODUCT,
  door: () => readDoorConfig(),
});

/** `/me` for the person decision in `rbac.ts`; handed over detached on purpose. */
export const accessClient = client;

export function emptyGrants(): Record<ObjectType, GrantedIds> {
  return sharedEmptyGrants(OBJECT_TYPES);
}

/** Tests only. */
export function __clearAccessCacheForTests(): void {
  client.clear();
}

/* ---------------------------------------------------- Local fallback rule */

/**
 * MAY THE LOCAL FALLBACK APPLY AT ALL? The local context makes every
 * signed-in Suite member a user and every owner a product admin. Right for
 * development, an open door in operation. The rule lives in `door.ts`.
 */
export function localFallbackAllowed(env?: Record<string, string | undefined>): boolean {
  return localAllowed(env);
}

/* ------------------------------------------------------------- Parsing */

/**
 * Reads the `data` of `/api/access/me` (or of the machine route). `null` for
 * an answer this build cannot read, including one without the product block.
 */
export function toContext(body: unknown): AccessContext | null {
  return parseAccessContext(body, { objectTypes: OBJECT_TYPES });
}

/* --------------------------------------------------------------- People */

/**
 * Levels 2 + 3 for ONE person. `null` always and only means NO ACCESS. Clear
 * answers are cached (a valid context, 401/403/404); network errors, 5xx and
 * unreadable answers are not, so a short outage locks nobody out longer than
 * necessary.
 */
export async function getAccessContext(token: string | null): Promise<AccessContext | null> {
  const result = await client.me(token);
  return result.status === "ok" ? result.context : null;
}

/**
 * The context WITHOUT a platform: local development, CI, E2E. Only reachable
 * while the door state is `local`. The Suite role maps to `product_admin` so a
 * developer reaches the settings; this is NO floor for operation.
 */
export function localAccessContext(session: SessionIdentity): AccessContext {
  return sharedLocalAccessContext(session, PRODUCT);
}

/* ------------------------------------------------------------- Machines */

/**
 * Why a key is refused (policy P3):
 *  - `KEY_OWNER_NO_ACCESS`   — the person behind the key has no product access
 *                              (any more), or a user key has no person;
 *  - `KEY_REVOKED`           — the key was minted at or before its creator's
 *                              token floor;
 *  - `PERSON_GONE`           — the Suite holds no active membership any more;
 *  - `KEY_CHECK_UNAVAILABLE` — the platform could not be asked: "unclear" means "no".
 */
export type MachineDenyReason = MachineDenyCode;

export type MachineAccess =
  | { ok: true; context: AccessContext }
  | { ok: false; reason: MachineDenyReason };

/**
 * A WORKER key: no person behind it. Sees only `visibility = ORGANISATION`,
 * creates nothing private, books door calls without a user, survives every
 * single person leaving.
 */
export function workerAccessContext(organisationId: string): AccessContext {
  return sharedWorkerAccessContext(organisationId, PRODUCT);
}

/** A USER key WITHOUT a platform door: development, CI, E2E only. */
export function apiKeyAccessContext(input: {
  organisationId: string;
  createdByUserId: string | null;
}): AccessContext {
  return localKeyAccessContext(
    { organisationId: input.organisationId, createdByUserId: input.createdByUserId ?? "" },
    PRODUCT,
  );
}

/**
 * AN API KEY ACTS AS THE PERSON WHO CREATED IT — the platform is asked about
 * that person (60 s cache per person, never per verdict):
 *   `GET /api/access/orgs/:org/users/:user/context?product=<LAB_KEY>`
 * with the service key and WITHOUT a user token. The verdict is computed per
 * call from that answer and the key's own mint time (policy P3).
 *
 * A user key without a creator is refused; only a WORKER key acts for nobody.
 */
export async function getApiKeyAccessContext(input: MachineKey): Promise<MachineAccess> {
  const verdict = await resolveKeyAccess({
    key: input,
    door: door(),
    userContext: client.userContext,
    product: PRODUCT,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.code };

  // The key belongs to ONE organisation (its row). A platform answer for
  // another organisation is never acted upon.
  if (verdict.context.organisationId.toLowerCase() !== input.organisationId.toLowerCase()) {
    console.error(
      "[platform-access] the platform answered the key check with a different organisation than the key's row.",
    );
    return { ok: false, reason: "KEY_CHECK_UNAVAILABLE" };
  }
  return { ok: true, context: { ...verdict.context, organisationId: input.organisationId } };
}

/* ------------------------------------------------------ On-behalf tokens */

/**
 * A COLLECTION AGENT behind an on-behalf token: no person, exactly one
 * collection. With `userId ""`, `personalAllowed false` and
 * `membersMayShareOrg false` the rules of `src/lib/access-rules.ts` give it
 * organisation rows plus the rows of its collection, editing what it sees and
 * creating in its collection only. Nothing private, no individual grants.
 */
export function agentAccessContext(organisationId: string, collectionId: string): AccessContext {
  return {
    ...sharedWorkerAccessContext(organisationId, PRODUCT),
    userId: "",
    email: "",
    orgRole: "member",
    productRole: "user",
    governed: false,
    accessMode: "assigned",
    collections: [{ id: collectionId, name: collectionId, isOwner: false }],
    grantedIds: emptyGrants(),
    personalAllowed: false,
    membersMayShareOrg: false,
    membersMayCreateCollections: false,
    source: "agent",
  };
}

/**
 * Steps 4 and 5 of the token path (connection layer contract, stage 6, 2.4):
 * WHOSE view a token gets, and the check of every person it names.
 *
 *  - organisation agent, or neither agent nor person: the WORKER view;
 *  - collection agent: `agentAccessContext` (its collection, no person);
 *  - private agent: the view of `agent.owner`;
 *  - no agent, `personUserId` (`claims.sub`) present: that person's view.
 *
 * Every named person is checked (`personUserId` whenever present, and the
 * owner of a private agent) through the shared client's person answer
 * (cached 60 s per person, never a verdict). The verdict is the shared one,
 * with the token's `issuedAt` as the mint time: the floor (`KEY_REVOKED`),
 * `memberActive === false` (`PERSON_GONE`), product access
 * (`KEY_OWNER_NO_ACCESS`, also for a person-level `403`/`404`). Platform
 * unreachable, `5xx`, a rejected service key or any other unusable answer:
 * `KEY_CHECK_UNAVAILABLE`.
 */
export async function getOnBehalfAccessContext(input: {
  organisationId: string;
  personUserId: string | null;
  issuedAt: Date;
  agent: OnBehalfAgent | null;
}): Promise<MachineAccess> {
  const named = new Set<string>();
  if (input.personUserId) named.add(input.personUserId.toLowerCase());
  const owner = input.agent?.level === "private" ? input.agent.owner?.toLowerCase() ?? null : null;
  if (input.agent?.level === "private" && !owner) return { ok: false, reason: "KEY_CHECK_UNAVAILABLE" };
  if (owner) named.add(owner);

  const contexts = new Map<string, AccessContext>();
  for (const userId of named) {
    const answer = await client.userContext(input.organisationId, userId);
    const verdict = machineVerdict(answer, { mintedAt: input.issuedAt });
    if (!verdict.ok) return { ok: false, reason: verdict.code };
    if (verdict.context.organisationId.toLowerCase() !== input.organisationId.toLowerCase()) {
      console.error(
        "[platform-access] the platform answered the person check with a different organisation than the token's.",
      );
      return { ok: false, reason: "KEY_CHECK_UNAVAILABLE" };
    }
    contexts.set(userId, { ...verdict.context, organisationId: input.organisationId, source: "api-key" });
  }

  const level = input.agent?.level ?? null;
  if (level === "organisation") return { ok: true, context: workerAccessContext(input.organisationId) };
  if (level === "collection") {
    const collectionId = input.agent?.col;
    if (!collectionId) return { ok: false, reason: "KEY_CHECK_UNAVAILABLE" };
    return { ok: true, context: agentAccessContext(input.organisationId, collectionId) };
  }
  const viewPerson = level === "private" ? owner : input.personUserId?.toLowerCase() ?? null;
  if (viewPerson) {
    const context = contexts.get(viewPerson);
    if (!context) return { ok: false, reason: "KEY_CHECK_UNAVAILABLE" };
    return { ok: true, context };
  }
  return { ok: true, context: workerAccessContext(input.organisationId) };
}

/* -------------------------------------------------------------- Helpers */

/**
 * May this context use the Lab? Only `productRole` counts — the platform has
 * already folded `accessMode = everyone` into it, and the local and worker
 * contexts carry a role of their own. No second way in here.
 */
export function hasProductAccess(ctx: AccessContext): boolean {
  if (ctx.source === "agent") return true;
  return sharedHasProductAccess(ctx);
}

export function isProductAdmin(ctx: AccessContext): boolean {
  return sharedIsProductAdmin(ctx);
}
