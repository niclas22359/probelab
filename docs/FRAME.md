# The frame — what every Beyondles Lab guarantees

Checked on: 2026-10-07

This template is the executable form of the Lab frame. A Lab built from it
passes `/lab-pipeline check` for everything that lives in the repo. The
binding operating description is `beyondles-ci/docs/SIDE-PROJECTS.md`; where
this file and that one disagree, that one wins and this template is updated.

## 1. Identity

- One name, lower-case, ending in `lab` (`src/lib/lab.ts`, `LAB_KEY`). It is
  repo, folder, Compose project, database role, subdomain, Suite `labs.key`,
  platform product key and platform service-key name.
- `npm run rename -- <name> "<Display Name>"` replaces it everywhere.

## 2. Sign-in: the Suite is the only login

- No password form, no registration, no own session lifetime.
- The Lab reads the cookie `platform-auth-token` and asks
  `GET <NEXT_PUBLIC_PLATFORM_URL>/api/auth/me` (`src/lib/auth.ts`). Each
  environment asks ITS OWN Suite. Sign-in and the gate have no production
  fallback (the middleware answers 503 and Compose refuses to start without
  the variable); only the "back to Suite" links fall back to beyondles.ai.
- `organisationId` comes from the confirmed token, never from the answer body,
  never from a request. Empty or non-uuid = reject. A platform answer for a
  different organisation than the token is refused (`src/lib/rbac.ts`).
- `JWT_SECRET` only with `ALLOW_LOCAL_JWT=true` and only in development/CI.
  A production process with `JWT_SECRET` and without the switch refuses to
  start (`src/lib/jwt-guard.ts`, `src/instrumentation.ts`); with the switch
  (E2E only) it starts and logs loudly.

## 3. Access in three levels

1. **Release switch (Suite):** `GET <suite>/api/labs/<LAB_KEY>/access`,
   default OFF, exceptions per organisation. Suite row first, then roll out.
   (`src/lib/platform-access.ts`)
2. **Product access (platform):** `GET <PLATFORM_API_URL>/api/access/me?product=<LAB_KEY>`
   with the Lab's service key and the person's cookie. Fail closed.
   (`src/lib/platform/access.ts`)
3. **Container on the row:** `visibility`, `ownerUserId`, `collectionId` on
   every top-level object; `visibleWhere` / `canSee` / `canEdit` in
   `src/lib/access-rules.ts` are the only filter. The example object uses
   `visibleWhere` on every read; a Lab that adds updates uses `canEdit`
   before every write. The local fallback context applies only while the
   platform door is NOT configured; once it is, the platform's "no" is final.

The three files are thin layers over the shared access code in
`src/lib/platform-client/` (generated from `beyondles-ai/beyondles-shared`,
checked in CI, never edited here). `/api/health` reports the door in the one
vocabulary of every product: `ok`, `local`, `unconfigured`, `off`.

People without access land on `/kein-zugriff` with their e-mail, the reason
and a way back to the Suite. The Suite tile points at `/`, which IS the app.

## 4. The platform door

- No provider key, no mail key, no provider SDK. AI through
  `POST /api/llm/complete` (`src/lib/platform/llm.ts`), mail through
  `POST /api/mail/send` (`src/lib/platform/mail.ts`), both with
  `X-API-Key: PLATFORM_API_KEY`.
- Purposes are `<LAB_KEY>.<action>` (`purposeFor`), stable forever.
- Retry only on 429/503. Mail only with an `idempotencyKey`.
- Fixed variable names: `PLATFORM_API_URL`, `PLATFORM_API_KEY`,
  `PLATFORM_EXPORT_KEY`, `PLATFORM_DELETE_KEY`, `NEXT_PUBLIC_PLATFORM_URL`,
  `ON_BEHALF_ISSUER`. `PLATFORM_SSO_URL` is retired and refused by the frame check.

## 5. Headless: one function, three doors

**The rule (owner, 06.10.2026):** every function of a Lab exists ONCE in the
code and is reachable through the screen AND two machine doors: REST
`/api/v1` (API key, for programs) and the tool door `/api/mcp` (MCP, for
agents). Same function, same permission checks, same audit trail, whichever
door is used. Since 06.10.2026 the template makes this true by construction;
the parity test fails the build when it is not.

### 5.1 The shape of a function

- **One service function per operation** (`src/server/services/<object>.ts`).
  It takes an `Actor` (`src/lib/actor.ts`: who acts and through which door,
  `ui` | `api-key` | `on-behalf` | `worker`) and does everything that must be
  identical across doors: the permission check (container rules,
  `src/lib/access-rules.ts`), the container choice for new rows
  (`chooseContainer`), the write, and the audit line (`recordAudit`,
  `src/lib/audit.ts`). "No person behind it" (worker key, organisation or
  collection agent) is decided once, in `Actor.personUserId`.
- **Doors are thin adapters**: parse with the shared zod schema
  (`src/server/schemas/<object>.ts`), build the actor (`uiActor` in a server
  action or page, `openMachineDoor` in a route), call the service, map errors.
  A server action or route that writes an audit line or chooses a container
  itself is a review finding.
- **One error mapping** (`src/lib/service-errors.ts`): a service throws
  `ServiceError(code, message)`; `withErrorEnvelope` turns it into the HTTP
  envelope, `actionErrorCode` into `?error=<code>` for the screen, and a tool
  sees `<code> (HTTP <status>): <message>` (`toolErrorFromHttp` over HTTP,
  `toToolResult` when it calls a service directly). Not found and "not yours"
  answer the same.
- **Container default: private to the acting person.** A wider container is
  always an explicit choice. A credential without a person (worker key,
  organisation agent) has no private container and must name `organisation`;
  without it the answer is `400 invalid_request` (`container_required`), never
  a silent widening. A collection agent creates in its own collection only.
  One function, `chooseContainer`; there is no second default in any door.
- **Audit**: the line (action, object, title, details) is identical across
  doors. Only the actor form differs, as the platform requires: the screen
  sends the person's Suite token, a key or token with a person sends
  `actorUserId` (the key's creator or the token's person, never anyone taken
  from the data), and a credential without a person sends `system: true` (the
  Suite shows "System"). A protocol line never throws and never blocks the
  write. Action names: `object.created|updated|visibility_changed|deleted`,
  otherwise `<LAB_KEY>.<what>`.

### 5.2 The functions manifest and the parity check

`src/server/functions.manifest.ts` lists every service export with its
scopes, its screen door (`action`, `page`), its REST route, its MCP tool, or
`{ excluded: "<reason>" }` per door. `tests/unit/parity.test.ts` reads
`src/server/services`, `src/server/actions`, `src/app/api/v1` and the MCP
catalogue and fails when:

1. a service export is missing from the manifest;
2. an entry names an action, page, route or tool that does not exist (or a
   route opens the door for another function, or a tool declares other scopes
   or calls another route than its entry);
3. a route, tool or action exists that the manifest does not know;
4. an entry lacks a door without an `excluded` reason.

Whole service files outside the rule (the platform's export, deletion and
hand-over calls) are listed in `FRAME_SERVICES`, screen mechanics such as
"dismiss the new key" in `SCREEN_HELPERS`, `/api/v1/openapi.json` in
`INFRASTRUCTURE_ROUTES`, each with a reason.

**Deliberate exclusions** live in the manifest, nowhere else.
`docs/EXCLUSIONS.md` is generated from it (`npm run docs:exclusions`) and a
test fails when it is stale. `docs/OFFEN.md` no longer lists missing doors.

### 5.3 The machine doors

- `POST /api/mcp` serves the tool catalogue (`src/lib/mcp/catalog.ts`) over
  Streamable HTTP; `mcp/server.mjs` is the stdio bridge for Claude Desktop/Code.
- **`openMachineDoor(request, "<functionId>")`** (`src/server/machine-door.ts`)
  is the first line of every `/api/v1` handler: credential (`requireApiKey`),
  release gate, rate limit, the function's scopes from the manifest, the
  worker-only rule, and the `Actor`.
- **Two credentials, one entry** (`requireApiKey`, `src/lib/api-auth.ts`):
  - `x-api-key`: a key of this Lab. USER keys act as their creator (asked at
    the platform per request), WORKER keys see organisation rows only.
  - `Authorization: Bearer <on-behalf token>`: another Beyondles product
    (Beyondles HorAIzon, another Lab) calling for an organisation, a person
    or an agent. The platform signed it for audience = `LAB_KEY`; the Lab
    verifies it with the platform's public keys (`src/lib/platform/on-behalf.ts`,
    a verbatim copy, checked by the frame check). The view follows the agent:
    organisation agent = worker view, collection agent = its collection only
    (`source: "agent"`), private agent = its owner, no agent = the person
    (`sub`), neither = worker view. Every named person is checked at the
    platform (floor, membership, product access).
  - Both together: `400 ambiguous_credential`. Without `ON_BEHALF_ISSUER` a
    token answers `503`; keys keep working.
  - A route reserved for WORKER keys also requires `via === "api-key"`: an
    organisation agent gets the worker view but never a worker-only route.
- **Release gate (level 1 for machines).** A key works only for organisations
  the Lab is released for in the Suite (`src/lib/tool-door/release-gate.ts`,
  `GET /api/registry/released` at the platform, 60 s cache, 15 minutes of
  grace during an outage, not applied by a platform without the route).
  Tokens are not gated here: the platform issues none for an unreleased Lab.
- **Markers.** Every tool says what it does: `access` (`read`, `write`,
  `destructive` = deletes, reaches somebody outside, spends money or credits),
  `idempotent`, `title` in German and English, and a `capability`
  (`mail.send`, `post.publish`, `calendar.write`) when its effect leaves the
  organisation through a connected account. `tools/list` carries them as
  MCP `annotations` and `_meta["ai.beyondles/capability"]`.
- **Prefix rule.** `TOOL_PREFIX` is declared once in `src/lib/lab.ts`; every
  tool name starts with it, is at most 48 characters and unique.
  `tests/unit/tool-catalog.test.ts` runs `catalogProblems` on the catalogue.
- **Describe route.** `GET /api/mcp/describe` (same credentials and checks as
  `/api/mcp`) lists every tool with markers, titles, `scopes` and
  `available` (the caller's credential carries the tool's scopes).
- One log line per `tools/call`: `[tool-door] via=… cp=… org=… sub=… agent=…
  tool=… outcome=… jti=…`, never arguments or results.
- `GET /api/health` reports `onBehalf: "ok" | "unconfigured"`.
- Lab-to-Lab calls: `createLabToolClient` (`src/lib/tool-door/lab-client.ts`)
  gets a token with the Lab's own service key and calls the target's door.
- The shared files under `src/lib/tool-door/` (except `lab-client.ts`) and
  `src/lib/platform/on-behalf.ts` are copied verbatim into every Lab; change
  them here, never in a copy.

### 5.4 Scopes on machine credentials

`src/lib/scopes.ts`. A key carries `read`, `write` and the Lab's own extra
scopes (`LAB_SCOPES`, named `<object>:<verb>`, one for every operation that
deletes data, reaches a person outside the organisation, or spends money or
credits; the example has `notes:delete`). A function needs ALL scopes its
manifest entry names; no scope implies another.

- **New keys: read only.** The key form offers every scope as a tick box; the
  list shows each key's scopes.
- **Keys from before scopes** carry `*` (full access, also to scopes added
  later), set by migration `0002_api_key_scopes`. Their owners narrow them by
  creating a new key and revoking the old one; the list marks them.
- **On-behalf tokens** carry no scopes; `onBehalfScopes` is the one mapping:
  a token that names a person gets every scope (the person is checked at the
  platform per request, and the calling product's agent safety asks a human
  before a `destructive` tool); a token without a person gets `read` and
  `write` only.
- **People in the screen** are not scoped: their limit is the container rule
  in the service, which every door shares.
- `requireScope` (`api-auth.ts`) answers `403 insufficient_scope` and names
  the missing scopes. Every tool declares `scopes` in the catalogue (the
  parity test compares them with the manifest); `/api/mcp/describe` shows
  them and sets `available` from the caller's credential.

### 5.5 Rate limit

In `requireApiKey`, after the credential is known, for `/api/v1` and
`/api/mcp` separately (`src/lib/rate-limit.ts`). Per key (`key:<id>`) or per
calling product and organisation (`cp:<product>:<org>`). Defaults per
minute: 120 per key on `/api/v1`, 60 per key on `/api/mcp`, 600 per calling
product on each door; `API_RATE_LIMIT_PER_MINUTE`,
`MCP_RATE_LIMIT_PER_MINUTE`, `ON_BEHALF_RATE_LIMIT_PER_MINUTE` (empty =
default, `0` = off). Over the limit: `429 rate_limited` with `Retry-After`
(JSON-RPC `-32029` on `/api/mcp`). A tool call also passes `/api/v1`, so keep
the v1 limit above the MCP limit.

**Per process.** The default store is in memory: each container and each
restart counts from zero. Right for one container per environment (the
Playground). A Lab with several replicas calls `setRateLimitStore` once at
start-up with a shared store. The shared tool door keeps its own coarser
token limit (1200 per minute), unchanged.

### 5.6 OpenAPI for `/api/v1`

`GET /api/v1/openapi.json` (OpenAPI 3.1) is generated by `src/lib/openapi.ts`
from the manifest and the same zod schemas the routes parse with, with zod's
built-in `z.toJSONSchema` (no extra dependency). Every operation carries
`x-required-scopes`, worker routes `x-worker-only`. **Public**, like
`/api/health`: it describes the Lab's surface, never tenant data, and a
program needs it before it holds a key; every operation still needs its
credential. `/api/mcp/describe` keeps describing the tools.

### 5.7 How a tool reaches the function (decided once)

- **Default, recommended: tool → `/api/v1` over HTTP with the caller's
  credential** (`src/lib/mcp/server.ts`). One authorisation path; a tool can
  never do more than the API, and the scope, rate limit, error and audit of
  the route apply unchanged.
- **Calling the service directly from the tool** is acceptable when the
  self-call is a real cost (large payloads, many calls per tool, a runtime
  without a reachable own address). It must then share the adapter helpers:
  `openMachineDoor` for credential, scopes and actor (the tool passes the
  incoming request), the same zod schema, `toToolResult` for errors. Its
  catalogue entry has no `toCall` route check, so review it by hand.
- **Screen calls `/api/v1` (AdvisorLab style)** is allowed and even preferred
  for new screens: exactly one path per function, the screen is a client like
  any other. Trade-offs: the browser needs a credential for `/api/v1` (a
  session-to-actor bridge in `openMachineDoor` that accepts the Suite cookie
  as door `ui`), no server actions and so no progressive enhancement, and an
  extra hop on server-rendered pages. Until a Lab builds that bridge, server
  actions as thin adapters are the template's default.

### 5.8 Worker-triggered routes

Cron-style triggers ("send due", "sync", "expire") live under
`/api/v1/worker/<job>` and are REST only by design: no screen, no tool. In the
manifest they carry `trigger: "worker"`, `screen` and `mcp` excluded with a
reason, and the scopes the job needs. `openMachineDoor` accepts only a WORKER
key of this Lab (`via === "api-key"`, `kind === "worker"`): a USER key, an
on-behalf token or an organisation agent gets `403 worker_only`. The service
sees `actor.door === "worker"` and audits as System. The parity test enforces
the path prefix and the excluded MCP door. Example:
`POST /api/v1/worker/expire-notes` (`expireNotes`), scheduled by
`ops/cron/expire-notes.sh`. A worker route that deletes is a dry run unless
the body says `"dryRun": false`; the scheduled caller sends that explicitly
and a unit test feeds its exact body through the route.

## 6. Tenant export

`GET /api/platform/export?organisationId=<uuid>` — `X-API-Key` against
`PLATFORM_EXPORT_KEY` in constant time; unset key = `503 EXPORT_NOT_CONFIGURED`;
unknown organisation = `200` with `entities: {}`; echoes the requested id;
`Cache-Control: no-store` everywhere; every tenant table included
(`tests/unit/platform-export-coverage.test.ts` enforces it against the schema).

## 6a. Tenant deletion

`DELETE /api/platform/organisation?organisationId=<uuid>&runId=<uuid>` — the
counterpart of the export. `X-API-Key` against `PLATFORM_DELETE_KEY` in
constant time. It is its OWN key and never falls back to the export key; unset
key = `503 DELETE_NOT_CONFIGURED`. Unknown organisation = `200`, `ok: true`,
every item `skipped`. Echoes the requested id and the `runId`.

The answer is `{ source, organisationId, runId, ok, items, failures }`. Each
item is `{ store, target, action, itemCount, outcome, detail }` with `outcome`
one of `success | skipped | failed`; the platform copies the items into its
deletion log unchanged.

`DELETION_PLAN` in `src/server/services/platform-delete.ts` is the one place
that decides, table by table: `delete`, `anonymise` or `retain` (the last two
with a written reason). `tests/unit/platform-delete-coverage.test.ts` enforces
it against the schema for EVERY model, child tables included; a table that
belongs to no organisation goes into `GLOBAL_TABLES` with a reason. Files and
other stores outside the database are removed in `eraseExternalStores` after
the commit and reported as items of their own.

## 6b. Person deletion

`DELETE /api/platform/member?organisationId=<uuid>&userId=<uuid>&toUserId=<uuid>&runId=<uuid>`
erases ONE Suite user from this Lab inside one organisation (the Suite's
"Delete my profile"). Same key and auth as 6a (`PLATFORM_DELETE_KEY`, no new
variable, no fallback), all four ids uuids, `toUserId` (the organisation's
owner, the successor) different from `userId`. Same answer as 6a plus
`userId`. An unknown organisation or person is `200`, `ok: true`, every item
`skipped`.

The rule: what is personal to the person is erased; what they shared with the
organisation stays and is reassigned to `toUserId`; afterwards no row with
their user id remains except anonymised evidence rows. `PERSON_PLAN` in
`src/server/services/platform-delete-member.ts` lists every (table, column)
that can hold a Suite user with `delete_rows`, `reassign`, `anonymise` or
`not_personal` (reason required). In the template: a `Note` owned by the person
is deleted when `PRIVATE` and reassigned when `COLLECTION`/`ORGANISATION`; a
`USER` API key they created is deleted, a `WORKER` key keeps working and loses
its creator. `tests/unit/platform-delete-member-coverage.test.ts` parses the
schema and fails when a user-looking column (`userId`, `ownerId`, `email`,
`...ByUserId`, `...ById`) has no entry. Every statement carries the
organisation AND the user. Files that belong only to the person are erased
BEFORE the transaction; a failure there leaves the database untouched.

People who are not Suite users (guests, signers, visitors, leads) are the
customer's data subjects. Their erasure is the customer's request to us,
handled per Lab, and is not part of the profile deletion.

## 7. Operations

- Docker Compose on the Playground, one project per environment, ports on
  `127.0.0.1`, images tagged `:latest` (production) and `:staging`.
- Thin `ci.yml` calling `beyondles-ai/beyondles-ci/quality-gates@v1`, job
  name literally `Quality Gates · app`, HARD gates TYPE/BUILD/LINT, plus
  `npm run check:frame`.
- Deploy scripts in `ops/deploy/` (copied to `/opt/scripts/` on the host).
- `GET /api/health` answers without a database and reports the door state.
- Two languages (`messages/de.json`, `messages/en.json`), same keys, checked.
- Beyondles icons in `src/app/`, "Back to Suite" link above the menu.

## 7a. Lab learnings built in (Masoud, 30.09.2026)

Each rule below cost a real incident in an earlier Lab. The template makes
it true by construction; `npm run check:frame` and the unit tests keep it so.

- **Every job ends with one line and an exit code.** Jobs run through
  `src/server/jobs/run-job.ts`: one line
  `job=<name> status=complete|incomplete counts=…` (counts, never ids), exit
  1 when incomplete. Run one with `npm run job -- <name>`; on the server from
  the host's cron:
  `docker compose ... run --rm --no-deps toolchain npm run job -- retention`.
  check-frame fails on an empty `catch {}`, `.catch(() => {})` and `|| true`
  in `src/`, `scripts/`, `ops/`, `mcp/`, `docker/`.
- **Alert before the first nightly job.** `src/server/jobs/alert.ts` mails
  ops through the platform mail door (`OPS_ALERT_EMAIL`,
  `OPS_ALERT_ORGANISATION_ID`; no mail key). Every run writes
  `job_runs.lastSuccessAt`; the `heartbeat` job alerts when a job in
  `SCHEDULED_JOBS` (`src/server/jobs/heartbeat.ts`) missed its window. Run
  the heartbeat from a different scheduler than the jobs where possible.
- **Deletion guards.** `src/server/jobs/deletion-guard.ts`: empty input
  stops, more than 10 % of a table in one run stops (`*_MAX_SHARE`), and a
  dry run is the default: only an explicit `false`/`0`/`no`/`off` is real,
  `true`/`1`/`yes`, a typo or an empty value are dry.
- **Retention.** `src/server/retention/registry.ts` lists every tenant table
  with personal data (columns, period setting, default) or says why a table
  has none (a test compares it with the export's tenant tables). The nightly
  `retention` job redacts with the guards above. A redacted row cannot be
  written back: the database trigger of migration 0003 refuses it, the
  service answers `conflict` first (`redaction.ts`), and `tests/db` proves it
  on a real Postgres. `npm run docs:retention` writes the privacy-note lines
  to `docs/RETENTION.md`.
- **Migrations run in CI.** Job `Migrations · postgres` applies every
  migration to an empty Postgres, checks schema and migrations agree, and
  runs `tests/db`. Make it a required check next to `Quality Gates · app`
  (a ruleset setting, done by a human). No Windows job: nothing in the
  template is OS-specific; a Lab with a Windows part adds one for it.
- **Contract test per platform edge.** `npm run contract:check`
  (`src/server/jobs/contract-edges.ts`) makes one real, cheap call per edge
  against staging: door `/api/llm/complete` and `/api/media`, Suite
  `auth/me`, the export key (Brain: add an edge when used). Daily via
  `.github/workflows/contract-check.yml`; a missing setting fails, it is
  never skipped. The repo secrets it needs are listed in that file and are
  set by a human.
- **Simulation with a judge before handover.** `npm run simulate [-- N]`
  (default 20), see `docs/SIMULATION.md`. Not in CI (costs money).
- **Locale.** `tests/unit/locale.test.ts` checks every key the UI uses exists
  in de and en. Dates are stored as ISO `YYYY-MM-DD` (`src/lib/dates.ts`);
  formats whose day/month order is a guess are refused.
- **Docs are generated or dated.** Every file in `docs/` has a
  `Checked on: YYYY-MM-DD` line or a `<!-- GENERATED` marker. One open-items
  file: `docs/OFFEN.md`. The handover uses `docs/HANDOVER.md`, whose
  `## Not tested` section is mandatory.
- **No provider keys, one key per purpose, pinned images.** check-frame fails
  on provider key names and on `PLATFORM_LLM_*` outside `src/lib/platform/`;
  AI calls carry `{ useCase, level }` or `{ model, fallback }`, never a key.
  Each key has one job: `PLATFORM_API_KEY` (calls to the platform),
  `PLATFORM_EXPORT_KEY` (platform reads the export), `PLATFORM_DELETE_KEY`
  (platform deletes), worker API keys (schedulers). Third-party images in
  Compose, CI and the Dockerfile are pinned by digest; check-frame warns on
  an unpinned one.

## 8. What the frame does NOT do

It does not write your product. Replace `Note` with your objects, keep the
three container columns, add each function to the functions manifest with
its route and tool (or a written exclusion), add every new tenant table to
the export. `npm run check:frame` and the unit
tests tell you when you drifted.
