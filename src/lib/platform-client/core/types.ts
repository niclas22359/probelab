/**
 * platform-client: every shared type, constant and error code. One file, final.
 *
 * Read `API.md` next to this folder for the behaviour of each module. This file is the only
 * one all three build groups import, and the only core file every other core file may import
 * without restriction. It imports nothing itself.
 *
 * Rules for this file:
 *  - No logic. Types, constant tables and one error class.
 *  - No `process.env`, no `server-only`, no framework, no Prisma.
 *  - No `import.meta`, no top-level `await` (the CommonJS consumer rejects both), and nothing
 *    newer than Node 20 provides at run time.
 *
 * Vocabulary is the platform's (`platform-api` `docs/API.md`, "Access model"). The names of
 * the types are the ones the Labs already use, so a product's thin file can re-export them
 * unchanged.
 */

/* ------------------------------------------------------------------------- vocabulary */

/** The two product roles. `null` (no role) means "no access to this product". */
export type ProductRole = "product_admin" | "user";

/** The role in the Suite organisation. Never a source of product access (round 3). */
export type OrgRole = "owner" | "admin" | "member";

/** What an individual grant hands out. A collection has no graded rights; a grant does. */
export type GrantLevel = "view" | "edit";

/** How an organisation hands out a product. */
export type AccessMode = "assigned" | "everyone";

/**
 * The container of an object, in the spelling of the Labs' Prisma enum (upper case).
 * This is the spelling the shared code RETURNS.
 */
export type Visibility = "PRIVATE" | "COLLECTION" | "ORGANISATION";

/**
 * The same three values in the platform's spelling (lower case). Used on the wire, by the
 * share dialog and by Beyondles HorAIzon's database.
 */
export type PlatformVisibility = "private" | "collection" | "organisation";

/** Either spelling. Every rule ACCEPTS both and compares them as the same value. */
export type AnyVisibility = Visibility | PlatformVisibility;

export const VISIBILITIES: readonly Visibility[] = ["PRIVATE", "COLLECTION", "ORGANISATION"];

export const PLATFORM_VISIBILITIES: readonly PlatformVisibility[] = [
  "private",
  "collection",
  "organisation",
];

/** The role names of the Labs' frozen member table (`enum MemberRole`). */
export type LegacyMemberRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" | "NONE";

/* ---------------------------------------------------------------------------- limits */

/** `/me` and the machine route are cached this long. The platform contract's own ceiling. */
export const ACCESS_CACHE_TTL_MS = 60_000;

/** Entries per cache. The oldest entry is dropped first. */
export const ACCESS_CACHE_MAX = 500;

/** Timeout of the context calls (`/me`, the machine route) and of the Suite gate. */
export const CONTEXT_TIMEOUT_MS = 5_000;

/** Timeout of grant, collection and audit calls. */
export const PROTOCOL_TIMEOUT_MS = 8_000;

/** `POST …/audit/batch` takes at most this many lines per call (round 5). */
export const AUDIT_BATCH_MAX = 200;

/** A title in the protocol is a reference, not a copy. The platform cuts at the same length. */
export const TITLE_MAX = 200;

/** The Suite's session cookie. */
export const AUTH_COOKIE_NAME = "platform-auth-token";

/* ------------------------------------------------------------------ the access context */

/** A collection the person is a member of. */
export interface AccessCollection {
  id: string;
  name: string;
  isOwner: boolean;
}

/** Individually granted object ids of one object type, split by level. An id is in one list only. */
export interface GrantedIds {
  view: string[];
  edit: string[];
}

/**
 * Where a context comes from.
 *  - `platform`:   a person, answered by `GET /api/access/me`.
 *  - `local`:      no platform door, and the host permits the local fallback (development, CI, E2E).
 *  - `api-key`:    an API key acting as the person who created it (machine route, or the local
 *                  key context while the door state is `local`).
 *  - `worker-key`: a key that acts for no person. Sees organisation-visible rows only.
 */
export type ContextSource = "platform" | "local" | "api-key" | "worker-key";

/**
 * Where `productRole` comes from. For tracing only, never a basis for a decision.
 *  - `platform`: the platform's answer, unchanged.
 *  - `legacy`:   the organisation is ungoverned and the product's old member table decided.
 *  - `everyone`: the organisation is ungoverned and the host admits everybody (`ungoverned: 'everyone'`).
 *  - `local`:    derived from the Suite role in the local fallback.
 *  - `worker`:   fixed by the worker context.
 */
export type ProductRoleSource = "platform" | "legacy" | "everyone" | "local" | "worker";

/**
 * Everything a product knows about one caller's access. `T` is the union of the product's
 * object types (`"lead" | "contact"`); `grantedIds` has one entry per type, always.
 *
 * Fields the platform returns today, all of them:
 * `userId`, `organisationId`, `email`, `orgRole`, `product.productRole`, `product.governed`,
 * `product.accessMode`, `product.personalAllowed`, `product.mayPublish`, `product.releaseStep`,
 * `collections`, `grantedObjects` + `grantedLevels` (merged into `grantedIds`),
 * `settings.membersMayShareOrg`, `settings.membersMayCreateCollections`.
 * `revokedAt` and `memberActive` exist on the machine route only and live on {@link MachineAnswer}.
 */
export interface AccessContext<T extends string = string> {
  /** Empty string for a worker key: there is no person. */
  userId: string;
  organisationId: string;
  /** Empty string when unknown (machine route, worker key). */
  email: string;
  /** `member` when the platform does not know it (machine route answers `null`). */
  orgRole: OrgRole;
  /** `null` = no access to the product. See `decide.hasProductAccess`. */
  productRole: ProductRole | null;
  /** `false` = the organisation has never decided anything about this product. */
  governed: boolean;
  accessMode: AccessMode;
  /**
   * "Darf veröffentlichen" (round 5). Normalised by the parser: `true` for a product admin,
   * `false` without a product role, otherwise the platform's switch (default `false`).
   */
  mayPublish: boolean;
  /** The product's own name for its release action, or `null` when it has none. */
  releaseStep: string | null;
  collections: AccessCollection[];
  grantedIds: Record<T, GrantedIds>;
  /** `false` = the organisation switched off "only me". */
  personalAllowed: boolean;
  /** `false` = only organisation admins may share with the whole organisation. */
  membersMayShareOrg: boolean;
  membersMayCreateCollections: boolean;
  source: ContextSource;
  productRoleSource: ProductRoleSource;
}

/**
 * The part of a context the container rules read. Structural on purpose: a product whose own
 * context type has more or differently named extra fields (Beyondles HorAIzon, a Lab that
 * keeps a marker of its own) can pass it without conversion, as long as these seven are there.
 */
export interface RuleContext {
  userId: string;
  /** Compared case-insensitively; anything but `owner` and `admin` is a member. */
  orgRole: string;
  productRole: ProductRole | null;
  collections: ReadonlyArray<{ readonly id: string }>;
  grantedIds: { readonly [objectType: string]: Readonly<GrantedIds> | undefined };
  personalAllowed: boolean;
  membersMayShareOrg: boolean;
}

/** The three container columns of a top-level object, plus its id. */
export interface ObjectContainer {
  id: string;
  /** `null` = a legacy row that belongs to nobody. An empty string is treated the same. */
  ownerUserId: string | null;
  visibility: AnyVisibility;
  collectionId: string | null;
}

/** A container a person chose or a default the rules computed. Upper-case spelling. */
export interface ContainerChoice {
  visibility: Visibility;
  collectionId: string | null;
}

/** The verified session of a person, as the host's own `auth` layer knows it. */
export interface SessionIdentity {
  userId: string;
  email: string;
  organisationId: string;
  /** The Suite role as the token carries it (`owner`, `admin`, `member`, any case). */
  role: string;
}

/* ------------------------------------------------------------------ host configuration */

/** Address and service key of platform-api. `baseUrl` has no trailing slash. */
export interface DoorConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * The state of the access door, one vocabulary for every product (policy P1).
 * `/api/health` reports it in the field `access`.
 *  - `ok`:           address and key are set. The platform decides.
 *  - `local`:        no door, and the host permits the local fallback.
 *  - `unconfigured`: attached to the Suite, but address or key is missing or a placeholder.
 *                    Nobody gets a context.
 *  - `off`:          not attached to the Suite, no door, local fallback not permitted.
 *                    Nobody gets a context.
 */
export type DoorState = "ok" | "off" | "unconfigured" | "local";

/**
 * What a host passes to `config.resolveDoor`. The host reads its own environment and spells
 * out `process.env.NAME` itself; the shared code never reads the environment.
 */
export interface DoorSettings {
  /** The host's `PLATFORM_API_URL`, raw. */
  platformApiUrl: string | null | undefined;
  /** The host's `PLATFORM_API_KEY`, raw. */
  platformApiKey: string | null | undefined;
  /**
   * Is this process attached to the Suite? Most Labs: "the Suite address is set".
   * A Lab whose Suite address has a default value (SummarizeLab) answers with
   * "sessions are NOT verified locally".
   */
  suiteAttached: boolean;
  /**
   * May the local fallback apply here? Computed by the host from the switches it already
   * has (`config.localFallbackAllowed` implements the default rule).
   */
  localAllowed: boolean;
  /**
   * The host's existing explicit production override (LeadLab `JWT_SECRET_ALLOW_IN_PRODUCTION`,
   * SignatureLab `ALLOW_LOCAL_ACCESS`, the other Labs `ALLOW_LOCAL_JWT`). In a production
   * process the local fallback applies only when this AND `localAllowed` are true.
   */
  productionLocalOverride?: boolean;
  /**
   * The host's `NODE_ENV`, raw. `production` counts as production in any case and with
   * surrounding white space (`config.isProductionEnv`): a stray blank from an env file must
   * not turn a server into a local process.
   */
  nodeEnv: string | undefined;
}

/** The resolved door. `config` is set exactly when `state` is `ok`. */
export interface Door {
  state: DoorState;
  config: DoorConfig | null;
  /** `config.isProductionEnv(nodeEnv)`. */
  production: boolean;
}

/** What an operator should read at boot about the door, or nothing (`config.doorNotice`). */
export interface DoorNotice {
  level: "error" | "warn";
  message: string;
}

/** Which product is asking. `productKey` must equal the name of the service key. */
export interface ProductConfig<T extends string = string> {
  productKey: string;
  /** Every object type the product registers grants for. Drives `grantedIds`. */
  objectTypes: readonly T[];
}

/** A log sink. The default everywhere is `console`. */
export interface Logger {
  warn(message: string, ...detail: unknown[]): void;
  error(message: string, ...detail: unknown[]): void;
}

/* ----------------------------------------------------------------------------- transport */

/** The part of a `fetch` response the shared code reads. A global `Response` fits. */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The part of `RequestInit` the shared code sets. */
export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  cache?: "no-store";
  signal?: AbortSignal;
}

/**
 * An injectable `fetch`. The global `fetch` fits. When a module gets none, it reads
 * `globalThis.fetch` AT CALL TIME (never at import or creation time), so a product test that
 * stubs the global keeps working.
 */
export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;

/** One call to platform-api. */
export interface PlatformRequest {
  door: DoorConfig;
  method: "GET" | "PUT" | "POST" | "DELETE";
  /** Starts with `/api/`. Path segments are already encoded by the caller. */
  path: string;
  /** The Suite token of the acting person. `null` or absent: the service key alone. */
  token?: string | null;
  body?: Record<string, unknown>;
  timeoutMs: number;
  fetch?: FetchLike;
}

/**
 * The raw outcome of one call, for callers that decide by status (`context`).
 *  - `network`:  the request did not complete (refused, DNS, timeout, abort).
 *  - `response`: an HTTP answer. `data` is the envelope's `data` object when the status is 2xx,
 *                the body is JSON, `success === true` and `data` is a JSON object; else `null`.
 */
export type PlatformReply =
  | { kind: "network"; message: string }
  | {
      kind: "response";
      status: number;
      data: Record<string, unknown> | null;
      errorCode: string | null;
      errorMessage: string | null;
    };

/**
 * Error codes the shared code raises itself. A platform refusal carries the platform's own
 * `error.code` instead (`PRODUCT_MISMATCH`, `ORG_MISMATCH`, `VALIDATION`, ...), and an answer
 * without a readable error body carries `HTTP_<status>`.
 */
export type TransportErrorCode = "DOOR_NOT_CONFIGURED" | "NETWORK";

/**
 * The one error the throwing calls raise (`http.platformRequest`, the grant and collection
 * calls of `protocol`). Constructor order `(code, message, status)` is the Labs'
 * `PlatformProtocolError`, so a thin file can re-export it under that name.
 */
export class PlatformError extends Error {
  /** A {@link TransportErrorCode}, the platform's `error.code`, or `HTTP_<status>`. */
  readonly code: string;
  /** The HTTP status, or `0` when there was no HTTP answer. */
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------------ context client */

/** Why a context call gave no usable answer. */
export type UnavailableReason =
  /** The door is not configured (`door()` returned `null`). Nothing was sent. */
  | "not-configured"
  /** The request did not complete. */
  | "network"
  /** An HTTP status that is neither a success nor a clear refusal (5xx, 429, 400, ...). */
  | "http"
  /** A 2xx answer this build cannot read. */
  | "unreadable"
  /**
   * `/me` only: the platform refused the product's own service key (401 `UNAUTHORIZED`).
   * Nothing a person can fix by signing in again.
   */
  | "service-key";

/**
 * The answer of `GET /api/access/me?product=`.
 *  - `ok`:              cached 60 s.
 *  - `unauthenticated`: no token was given (nothing sent, nothing cached), or the platform
 *                       refused the person's token with 401 (cached 60 s).
 *  - `denied`:          the platform answered 403 or 404 (cached 60 s).
 *  - `unavailable`:     never cached, with one exception: the reason `service-key` is a 401,
 *                       and CONTRACT 4.1 caches every `/me` 401 for 60 s.
 */
export type MeResult<T extends string = string> =
  | { status: "ok"; context: AccessContext<T> }
  | { status: "unauthenticated" }
  | { status: "denied"; httpStatus: 403 | 404 }
  | { status: "unavailable"; reason: UnavailableReason; httpStatus?: number };

/** Options of one `AccessClient.me` call. */
export interface MeOptions {
  /**
   * Skip the cache READ and ask the platform now; the answer is stored as usual. For the few
   * routes that must not act on an answer up to 60 s old: a route that mints a credential
   * (an API key) checks the person this way, so a key cannot be minted from a session whose
   * token the platform already refuses (HOST-CONTRACT section 4).
   */
  fresh?: boolean;
}

/**
 * The answer of the machine route `GET /api/access/orgs/:org/users/:user/context?product=`.
 * The cache stores THIS (the answer), never a verdict: the verdict depends on the credential
 * in hand and is computed per call by `decide.machineVerdict`.
 *  - `answer`:      cached 60 s per (organisation, person). `context.source` is `api-key`.
 *  - `no-access`:   the platform answered 403 or 404. Cached 60 s.
 *  - `unavailable`: 401, 5xx, any other status, network error, unreadable body. Never cached.
 */
export type MachineAnswer<T extends string = string> =
  | {
      status: "answer";
      context: AccessContext<T>;
      /** The person's token floor, or `null`. Credentials minted at or before it are dead. */
      revokedAt: Date | null;
      /** `false` = the Suite holds no active membership. `null` = not known (behave as before). */
      memberActive: boolean | null;
    }
  | { status: "no-access"; httpStatus: 403 | 404 }
  | { status: "unavailable"; reason: UnavailableReason; httpStatus?: number };

export interface AccessClientOptions<T extends string = string> {
  product: ProductConfig<T>;
  /** Called on every request, so a host can read its environment late. `null` = not configured. */
  door: () => DoorConfig | null;
  fetch?: FetchLike;
  /** Default {@link ACCESS_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Default {@link ACCESS_CACHE_MAX}. */
  max?: number;
  /** Default {@link CONTEXT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Default `Date.now`. */
  now?: () => number;
  log?: Logger;
}

/**
 * Both methods hand out a COPY of what they cached: a caller that changes the context it got
 * changes nothing for the next caller.
 */
export interface AccessClient<T extends string = string> {
  me(token: string | null | undefined, options?: MeOptions): Promise<MeResult<T>>;
  userContext(organisationId: string, userId: string): Promise<MachineAnswer<T>>;
  /** Drops both caches and the "warned once" memory. */
  clear(): void;
}

/** A small TTL cache: fixed lifetime, bounded size, oldest entry dropped first. */
export interface TtlCache<V> {
  /** `undefined` for a missing or expired entry. */
  get(key: string): V | undefined;
  /**
   * Stores `value`, stamped `storedAt` (default: now). The lifetime runs from the stamp. An
   * entry whose stamp is NEWER than the given one is kept: an answer to an older request
   * never overwrites the answer to a newer one.
   */
  set(key: string, value: V, storedAt?: number): void;
  clear(): void;
  readonly size: number;
}

export interface TtlCacheOptions {
  /** Default {@link ACCESS_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Default {@link ACCESS_CACHE_MAX}. */
  max?: number;
  /** Default `Date.now`. */
  now?: () => number;
}

/* ------------------------------------------------------------------------- machine path */

/** An API key of the product, as its own key table knows it. */
export interface MachineKey {
  keyId: string;
  organisationId: string;
  /**
   * The person the key acts as. `null` only for a key without a creator, which is refused
   * with `KEY_OWNER_NO_ACCESS` (CONTRACT P3). A product that answers that case with its own
   * code or text checks it before calling `resolveKeyAccess`.
   */
  createdByUserId: string | null;
  /**
   * When the key was issued. The comparison value for `revokedAt`. Anything that is not a
   * valid `Date` (`null` from a nullable column, a string from raw SQL) is "cannot be read",
   * and such a key is dead as soon as the person has a token floor.
   */
  mintedAt: Date;
  /** `worker` = acts for no person. */
  kind: "user" | "worker";
}

/** Why a machine caller is refused (policy P3). The wording is the platform contract's. */
export type MachineDenyCode =
  /** The person behind the key has no product access, or the key has no person. */
  | "KEY_OWNER_NO_ACCESS"
  /** The key was minted at or before the person's token floor. */
  | "KEY_REVOKED"
  /** The Suite no longer holds an active membership for the person. */
  | "PERSON_GONE"
  /** The platform could not be asked. "Could not check" is never "allowed". */
  | "KEY_CHECK_UNAVAILABLE";

/** The HTTP status each refusal maps to. */
export const MACHINE_DENY_STATUS: Readonly<Record<MachineDenyCode, 403 | 503>> = {
  KEY_OWNER_NO_ACCESS: 403,
  KEY_REVOKED: 403,
  PERSON_GONE: 403,
  KEY_CHECK_UNAVAILABLE: 503,
};

export type MachineVerdict<T extends string = string> =
  | { ok: true; context: AccessContext<T> }
  | { ok: false; code: MachineDenyCode; status: 403 | 503 };

/** The result of `decide.resolveKeyAccess` and `decide.resolveJobAccess`. */
export type KeyAccess<T extends string = string> =
  | { ok: true; context: AccessContext<T> }
  | { ok: false; code: MachineDenyCode; status: 403 | 503 };

export interface KeyAccessInput<T extends string = string> {
  key: MachineKey;
  door: Door;
  /** `AccessClient.userContext`. Called only when the door state is `ok` and the key has a person. */
  userContext: (organisationId: string, userId: string) => Promise<MachineAnswer<T>>;
  product: ProductConfig<T>;
}

/** A named person without a key: a scheduled job that acts for whoever ordered it. */
export interface JobAccessInput<T extends string = string> {
  organisationId: string;
  /** The person who ordered the work, recorded in a real session when the job was created. */
  userId: string | null | undefined;
  door: Door;
  userContext: (organisationId: string, userId: string) => Promise<MachineAnswer<T>>;
  product: ProductConfig<T>;
}

/* ---------------------------------------------------------------------- ungoverned (P2) */

/** Reads the product's frozen member table. `null` = no row. May throw; a throw is "no access". */
export type LookupMemberRole = (organisationId: string, userId: string) => Promise<string | null>;

/**
 * A member table's role names and the product role each one means. `null` = no access.
 * Read by own keys only, exact and case-sensitive; a name that is not in it is no access.
 */
export type LegacyRoleMap = Readonly<Record<string, ProductRole | null>>;

/**
 * What decides while the platform reports `governed: false` (policy P2).
 *  - `legacy`:   the old member table decides. `ownerFloor: true` lets the owner of the Suite
 *                organisation in when there is NO row (LeadLab, BookingLab, SignatureLab);
 *                `false` lets nobody in without a row (AdvisorLab, SummarizeLab). `roleMap`
 *                is for a table whose role names are not the Labs' `MemberRole` enum
 *                (`OWNER`, `ADMIN`, `EDITOR`, `VIEWER`, `NONE`); without it that enum applies.
 *  - `everyone`: every member of the organisation counts as `user` (ContentLab and
 *                Beyondles HorAIzon today).
 *  - `refuse`:   nobody gets in until the organisation is governed (the Lab template).
 */
export type UngovernedPolicy =
  | {
      mode: "legacy";
      lookupMemberRole: LookupMemberRole;
      ownerFloor: boolean;
      roleMap?: LegacyRoleMap;
    }
  | { mode: "everyone" }
  | { mode: "refuse" };

/* ------------------------------------------------------------------------ person access */

/** The Suite gate's reason vocabulary, complete. */
export type GateReason =
  /** The Lab is enabled for everybody. */
  | "enabled"
  /** The person's e-mail address is on the exception list. */
  | "exception"
  /** The person's organisation is on the exception list. */
  | "organisation"
  /** The Suite says no (switch off, signed out, unknown Lab, suspended organisation). */
  | "blocked"
  /** The Suite did not give a readable answer. Counts as closed, is not cached. */
  | "unreachable"
  /** No Suite in this process (the host's local mode). Open, nothing was asked. */
  | "local";

/** Level 1: is the Lab enabled for this account in the Suite? */
export interface LabGate {
  allowed: boolean;
  reason: GateReason;
  lab: { key: string; name: string; enabled: boolean } | null;
}

/** An active member of the Suite organisation. */
export interface SuiteMember {
  userId: string;
  /** Lower case. */
  email: string;
  name: string;
  /** The Suite role (`owner`, `admin`, `member`). `member` when the Suite leaves it out. */
  role: string;
  joinedAt: string | null;
}

export type OrganisationMembers =
  | { mode: "local" }
  | { mode: "unreachable" }
  | {
      mode: "suite";
      organisation: { id: string; slug: string; name: string };
      members: SuiteMember[];
    };

export interface SuiteClientOptions {
  /** The Lab's key in the Suite (`labs.key`). */
  labKey: string;
  /** The Suite's base address, called on every request. No trailing slash needed. */
  suiteUrl: () => string;
  /** The host's local mode (sessions verified locally, no Suite). Called on every request. */
  local: () => boolean;
  fetch?: FetchLike;
  /** Default {@link CONTEXT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Default {@link ACCESS_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Default {@link ACCESS_CACHE_MAX}. */
  max?: number;
  now?: () => number;
  /** Default {@link AUTH_COOKIE_NAME}. */
  cookieName?: string;
}

export interface SuiteClient {
  gate(token: string | null | undefined): Promise<LabGate>;
  members(token: string | null | undefined): Promise<OrganisationMembers>;
  clear(): void;
}

/**
 * Why a person gets no access. The host maps each value to its own page text.
 *  - `unauthenticated`:   no token, or the platform refused the token (401).
 *  - `blocked`:           the Suite gate is closed or unreachable (`gate.reason` says which).
 *  - `unavailable`:       the door state is `off` or `unconfigured`, or the platform could not
 *                         be asked. Policy P1: this is the reason on the blocked page.
 *  - `no-product-access`: the platform answered, and the person has no product role.
 */
export type AccessDenyReason = "unauthenticated" | "blocked" | "unavailable" | "no-product-access";

export type PersonAccess<T extends string = string> =
  | { ok: true; access: AccessContext<T>; gate: LabGate; doorState: DoorState }
  | { ok: false; reason: AccessDenyReason; gate: LabGate | null; doorState: DoorState };

export interface PersonAccessInput<T extends string = string> {
  /** The Suite token of the person (cookie or bearer). */
  token: string | null | undefined;
  /** The session the host verified for that token. Used for the local context only. */
  session: SessionIdentity;
  door: Door;
  /** `AccessClient.me`. Called only when the door state is `ok`. */
  me: (token: string) => Promise<MeResult<T>>;
  /**
   * `SuiteClient.gate`. Always called when there is a token. The answer is a copy; the host
   * may change it.
   */
  gate: (token: string) => Promise<LabGate>;
  ungoverned: UngovernedPolicy;
  product: ProductConfig<T>;
  log?: Logger;
}

/* -------------------------------------------------------------------------------- rules */

/** The column names a `where` clause is built for, and the stored spelling of the enum. */
export interface VisibilityFields {
  /** Default `id`. */
  id: string;
  /** Default `ownerUserId`. */
  ownerUserId: string;
  /** Default `visibility`. */
  visibility: string;
  /** Default `collectionId`. */
  collectionId: string;
  /** How the column stores the value. Default `upper` (`ORGANISATION`); `lower` gives `organisation`. */
  spelling: "upper" | "lower";
}

/**
 * One branch of the visibility rule as a plain object, in the shape Prisma's `where` takes:
 * `{ ownerUserId: "u1" }`, `{ visibility: "ORGANISATION" }`,
 * `{ visibility: "COLLECTION", collectionId: { in: [...] } }`, `{ id: { in: [...] } }`.
 */
export type VisibilityClause = Record<string, string | { in: string[] }>;

export type ContainerChoiceErrorCode =
  /** Not one of the three visibilities, or a malformed `collectionId`. */
  | "VALIDATION"
  /** `personalAllowed` or `membersMayShareOrg` forbids the visibility for this person. */
  | "VISIBILITY_NOT_ALLOWED"
  /** `collection` without a collection id. */
  | "COLLECTION_REQUIRED"
  /** The person is not a member of that collection. */
  | "COLLECTION_NOT_ALLOWED";

export type ContainerChoiceResult =
  | { ok: true; value: ContainerChoice }
  | { ok: false; code: ContainerChoiceErrorCode; status: 400 | 403 };

/* -------------------------------------------------------------------------------- share */

export interface ShareGrant {
  userId: string;
  level: GrantLevel;
}

/** The body the share dialog sends (`share-ui` `buildSharePatch`). Every field is optional. */
export interface SharePatch {
  visibility?: PlatformVisibility;
  collectionId?: string | null;
  add?: ShareGrant[];
  remove?: string[];
  levels?: ShareGrant[];
}

/** The object a share save is about, as the host loaded it. */
export interface ShareObject {
  organisationId: string;
  /** The platform object type (`lead`, `booking_page`, ...). */
  type: string;
  id: string;
  /** The display name. Goes into every grant and every protocol line. */
  title: string;
  ownerUserId: string | null;
  visibility: AnyVisibility;
  collectionId: string | null;
}

export type SharePlanErrorCode =
  | "VALIDATION"
  /** Only the owner changes container and grants. */
  | "NOT_OWNER"
  | "VISIBILITY_NOT_ALLOWED"
  | "COLLECTION_REQUIRED"
  | "COLLECTION_NOT_ALLOWED";

/** What a share save has to do. Pure data; `share.executeSharePlan` runs it in the fixed order. */
export interface SharePlan {
  /** Grants to write, deduplicated by person. The owner and the acting person are left out. */
  grantsToPut: ShareGrant[];
  /** People whose grant is removed. */
  grantsToDelete: string[];
  /** The container to write, or `null` when it does not change. */
  container: ContainerChoice | null;
  /** `object.visibility_changed` and `object.moved_to_collection`, each only when the value changed. */
  auditLines: AuditLine[];
  /** `true` when the plan touches grants, which live in the platform only. */
  needsPlatform: boolean;
}

export type SharePlanResult =
  | { ok: true; plan: SharePlan }
  | { ok: false; code: SharePlanErrorCode; status: 400 | 403; message: string };

/** The three writes of a share save. The host supplies them; the shared code fixes the order. */
export interface ShareSteps {
  putGrant(grant: ShareGrant): Promise<void>;
  deleteGrant(userId: string): Promise<void>;
  writeContainer(container: ContainerChoice): Promise<void>;
  /** Must not throw. A throw is swallowed and counted as not written. */
  audit(line: AuditLine): Promise<unknown>;
}

export type ShareExecution =
  | { ok: true; auditWritten: number }
  /** A grant call failed. NOTHING of the container was written. */
  | { ok: false; stage: "grants"; error: unknown }
  /** The container write failed after the grants were applied. */
  | { ok: false; stage: "container"; error: unknown };

/* ----------------------------------------------------------------------------- protocol */

/** One individual grant on an object, as the platform lists it. */
export interface GrantRow {
  userId: string;
  level: GrantLevel;
  grantedBy: string | null;
  createdAt: string | null;
}

/** One protocol line. `action` matches `^[a-z_]+\.[a-z_]+$` and is at most 60 characters. */
export interface AuditLine {
  organisationId: string;
  action: string;
  /** Left out: the client's `defaultObjectType`, when it has one. */
  objectType?: string;
  objectId?: string;
  /** Trimmed and cut to {@link TITLE_MAX} before sending. */
  objectTitle?: string;
  targetUserId?: string | null;
  /** At most 4 kB of JSON. `seeded`, `background` and `system` are stripped by the platform. */
  details?: Record<string, unknown>;
}

/**
 * Who a protocol line names. Exactly one form per call, and one form per batch.
 *  - `token`:       the person at the keyboard (their Suite token).
 *  - `actorUserId`: a job acts for a person who ordered it (the platform adds `details.background`).
 *  - `system`:      nobody asked at a keyboard (the platform adds `details.system`).
 */
export type AuditActor = { token: string } | { actorUserId: string } | { system: true };

export type ObjectRemovalResult =
  | { ok: true; grantsRemoved: number | null }
  | { ok: false; reason: "no-session" | "door-not-configured" | "failed"; error?: unknown };

export interface AuditBudgetOptions {
  /** No further line is STARTED once this much time has passed. */
  budgetMs: number;
  /** How many lines run at the same time. At least 1. */
  parallel: number;
  now?: () => number;
}

export interface AuditBudgetResult {
  written: number;
  /** Refused by the platform, or never started. */
  skipped: number;
  /** `true` when the budget ran out before every line was started. */
  budgetExhausted: boolean;
}

export interface ProtocolClientOptions {
  /** The product key in the object routes (`…/objects/<productKey>/<type>/<id>`). */
  productKey: string;
  door: () => DoorConfig | null;
  fetch?: FetchLike;
  /** Default {@link PROTOCOL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Used for a line without `objectType`. No default: such a line is then sent without one. */
  defaultObjectType?: string;
  log?: Logger;
}

export interface ProtocolClient {
  /** Throws {@link PlatformError}. */
  listGrants(
    token: string,
    organisationId: string,
    objectType: string,
    objectId: string,
  ): Promise<GrantRow[]>;
  /** Throws {@link PlatformError}. Always sends the title. */
  putGrant(
    token: string,
    organisationId: string,
    objectType: string,
    objectId: string,
    userId: string,
    level: GrantLevel,
    title: string,
  ): Promise<void>;
  /** Throws {@link PlatformError}. */
  deleteGrant(
    token: string,
    organisationId: string,
    objectType: string,
    objectId: string,
    userId: string,
  ): Promise<void>;
  /** Throws {@link PlatformError}. Removes every grant of a deleted object. */
  deleteObjectGrants(
    token: string,
    organisationId: string,
    objectType: string,
    objectId: string,
    title?: string | null,
  ): Promise<void>;
  /** The same call for a deletion path that must not fail. Never throws. */
  removeObject(input: {
    token: string | null | undefined;
    organisationId: string;
    objectType: string;
    objectId: string;
    title?: string | null;
  }): Promise<ObjectRemovalResult>;
  /** Throws {@link PlatformError}. The collections the person may see. */
  listCollections(token: string, organisationId: string): Promise<{ id: string; name: string }[]>;
  /** Throws {@link PlatformError}. The user ids in a collection. */
  listCollectionMembers(
    token: string,
    organisationId: string,
    collectionId: string,
  ): Promise<string[]>;
  /** Never throws. `false` when nothing was written. `actor: null` writes nothing. */
  audit(actor: AuditActor | null, line: AuditLine): Promise<boolean>;
  /** Never throws. Returns the number of lines written. `actor: null` writes nothing. */
  auditBatch(actor: AuditActor | null, lines: readonly AuditLine[]): Promise<number>;
  /** Never throws. Single-line calls under a time budget (offboarding hand-overs). */
  auditWithBudget(
    actor: AuditActor | null,
    lines: readonly AuditLine[],
    options: AuditBudgetOptions,
  ): Promise<AuditBudgetResult>;
  /** Forgets which failures were already logged (the client has no other state). */
  clear(): void;
}

/* -------------------------------------------------------------------------- next adapter */

/** What `/api/health` adds for the access door. */
export interface HealthAccessField {
  access: DoorState;
}

/** What a Lab hands to `next/createNextAccess`. Framework-free types only. */
export interface NextAccessOptions<T extends string = string> {
  /** The host's own session reader (its `auth.ts`). `null` = not signed in. */
  session: () => Promise<SessionIdentity | null>;
  /** Default: the cookie {@link AUTH_COOKIE_NAME}, read with `next/readPlatformToken`. */
  token?: () => Promise<string | null>;
  /** Called once per request, so the host can read its environment late. */
  door: () => Door;
  client: Pick<AccessClient<T>, "me">;
  suite: Pick<SuiteClient, "gate">;
  ungoverned: UngovernedPolicy;
  product: ProductConfig<T>;
  log?: Logger;
}

/** The result of `loadAccess()`. Never a redirect. */
export interface LoadedAccess<T extends string = string> {
  /** `null` = not signed in; `outcome.reason` is then `unauthenticated`. */
  session: SessionIdentity | null;
  token: string | null;
  outcome: PersonAccess<T>;
}

/** The result of `requireAccessOrRedirect()`. Reached only when access is granted. */
export interface GrantedAccess<T extends string = string> {
  session: SessionIdentity;
  token: string;
  access: AccessContext<T>;
  gate: LabGate;
}

export interface RedirectOptions {
  /** Where a person without a session is sent (the Suite sign-in). */
  loginUrl: string;
  /** Default `/kein-zugriff`. */
  noAccessPath?: string;
  /** Default `grund`. */
  reasonParam?: string;
  /**
   * The query value per reason. Defaults: `blocked` → `gesperrt`,
   * `no-product-access` → `nicht-teil`, `unavailable` → `unavailable`.
   */
  reasonValues?: Partial<Record<Exclude<AccessDenyReason, "unauthenticated">, string>>;
}

export interface NextAccess<T extends string = string> {
  /** Session, gate and access for the current request, evaluated once per request. */
  loadAccess(): Promise<LoadedAccess<T>>;
  /**
   * The same evaluation with an uncached `/me` (`me(token, { fresh: true })`), evaluated on
   * every call. For a route that mints a credential (HOST-CONTRACT section 4). Never redirects.
   */
  loadFreshAccess(): Promise<LoadedAccess<T>>;
  /**
   * Returns the granted access, or redirects: to `loginUrl` when there is no session or no
   * token; to the no-access page otherwise. A token the platform refuses while the host's
   * session is valid goes to the no-access page with the reason `unavailable`, because the
   * Suite would send a signed-in person straight back.
   */
  requireAccessOrRedirect(options: RedirectOptions): Promise<GrantedAccess<T>>;
}

/* ------------------------------------------------------------------------------ testing */

/** One request the fake platform received. */
export interface FakeCall {
  url: string;
  /** Upper case. `GET` when the caller set none. */
  method: string;
  headers: Record<string, string>;
  /** The parsed JSON body, or `undefined` when the request had none. */
  body: unknown;
}

/**
 * What the fake answers.
 *  - an object: an HTTP answer. `status` defaults to 200. `data` is wrapped in the platform's
 *    success envelope, `error` in its failure envelope, `body` is sent as it is (for the Suite,
 *    which has no envelope). With `invalidJson: true` the answer has that status and a body
 *    that is not JSON (`json()` rejects): the error page of a gateway in front of the platform.
 *  - `network-error`: the returned promise rejects.
 *  - `invalid-json`:  status 200, and `json()` rejects. Short for `{ invalidJson: true }`.
 */
export type FakeReply =
  | {
      status?: number;
      data?: unknown;
      error?: { code: string; message?: string };
      body?: unknown;
      invalidJson?: boolean;
    }
  | "network-error"
  | "invalid-json";

/** A scriptable stand-in for platform-api and the Suite. No test framework inside. */
export interface FakePlatform {
  /** Pass this as the `fetch` option of a client, or stub the global with it. */
  fetch: FetchLike;
  /** Every request, in order. */
  calls: FakeCall[];
  /**
   * Registers a reply for every request whose `"<METHOD> <url>"` contains `match` (string) or
   * matches it (RegExp). The reply registered last wins. A function is called per request.
   */
  respond(match: string | RegExp, reply: FakeReply | ((call: FakeCall) => FakeReply)): void;
  /** Forgets replies and calls. */
  reset(): void;
}
