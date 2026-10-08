# Adopting "headless by construction" in an existing Lab

Checked on: 2026-10-07

The template enforces since 06.10.2026 what it used to only state: every
function exists once, in a service, and is reachable through the screen,
`/api/v1` and an MCP tool, or carries a written exclusion (docs/FRAME.md
section 5). This is the order in which an existing Lab adopts it. Each step
is its own PR and leaves the Lab working; nothing changes for a caller until
step 7.

Prerequisite: the Lab already uses the shared access code
(`src/lib/platform-client/`, card #339). Without it, `src/lib/audit.ts` has no
protocol client to call.

## 1. Copy the new files (no behaviour change yet)

Copy from the template unchanged:

| File                                                                        | What it is                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/lib/scopes.ts`                                                         | scope vocabulary; replace `LAB_SCOPES` with the Lab's own       |
| `src/lib/rate-limit.ts`                                                     | rate limit with a replaceable store                             |
| `src/lib/service-errors.ts`                                                 | `ServiceError` and the one error mapping                        |
| `src/lib/actor.ts`                                                          | the `Actor` and `uiActor` / `machineActor`                      |
| `src/lib/audit.ts`                                                          | `recordAudit`; set `defaultObjectType` to the Lab's main object |
| `src/lib/openapi.ts`                                                        | OpenAPI from the manifest                                       |
| `src/server/machine-door.ts`                                                | `openMachineDoor(request, functionId)`                          |
| `src/server/parity.ts`, `src/server/exclusions.ts`                          | the parity check and the exclusions rendering                   |
| `tests/support/parity-sources.ts`, `scripts/write-exclusions.ts`            | folder reader, docs writer                                      |
| `tests/unit/scopes.test.ts`, `rate-limit.test.ts`, `headless-units.test.ts` | unit tests of the above                                         |

Add `"docs:exclusions": "tsx scripts/write-exclusions.ts"` to `package.json`.

**Changed shared file (verbatim copy):** `src/lib/tool-door/describe.ts` now
takes an optional `scopes` per tool and returns `scopes` per tool. Copy it
unchanged; it stays self-contained. Its test expectation in
`tests/unit/tool-door.test.ts` gains `scopes`.

In `src/lib/api-errors.ts` add the codes `insufficient_scope` and
`worker_only`, and in `withErrorEnvelope` the line
`if (error instanceof ServiceError) return apiErrorResponse(toApiError(error));`.
In an existing German file keep writing German comments.

## 2. Write the manifest for the Lab AS IT IS

Create `src/server/functions.manifest.ts` (template shape) and list every
exported service function with its action or page, route and tool. Where a
door is missing today, write it down instead of building it now:
`mcp: { excluded: "Not built yet (backlog, <date>)" }`. Then copy
`tests/unit/parity.test.ts`, replace its fixture-independent expectations
(the route list) with the Lab's, and run it until it is green. Run
`npm run docs:exclusions` and commit `docs/EXCLUSIONS.md`; delete the
door lists from `docs/OFFEN.md`. From now on drift fails the build, and the
gaps are visible in one generated file (LeadLab: the 14 routes without a tool
show up here).

## 3. Scopes on keys, without breaking a single key

1. Add `scopes String[] @default(["read"])` to `ApiKey` and copy
   `prisma/migrations/0002_api_key_scopes/migration.sql` under the Lab's next
   number. It adds the column with `ARRAY['*']` (every existing key keeps full
   access) and then sets the default to `read` for new keys.
2. `api-auth.ts`: select `scopes`, return them on the key context, map tokens
   with `onBehalfScopes`, add `requireScope` (template diff of
   `src/lib/api-auth.ts`). Delete the Lab's own scope model (SignatureLab,
   BookingLab, SummarizeLab) after mapping its names onto `LAB_SCOPES`: a key
   that had the old "send" right gets the new extra scope in the same
   migration (`UPDATE api_keys SET scopes = ... WHERE ...`).
3. Settings: tick boxes for the scopes on create, scopes in the key list
   (template `src/app/(app)/settings/page.tsx`, messages `settings.scope*`).
   Owners narrow old `*` keys by creating a new key and revoking the old one.

## 4. Rate limit

Wire `enforceRateLimit` into `requireApiKey` as in the template (after the
key row is found, after the token is verified). Add the three variables to
`docker/docker-compose.yml` and `.env.example`. Delete the Lab's own limiter
(BookingLab, AdvisorLab) once the template's covers the same paths; if the
Lab runs more than one replica, plug its shared store into
`setRateLimitStore`.

## 5. Move audit into the services, without changing a single audit row

Per function, in this order:

1. **Pin the current lines first.** Write a test that calls the action and the
   route and captures what reaches the protocol client (mock the Lab's
   `platform/protocol.ts`): action, objectType, objectId, objectTitle,
   details, and the actor form.
2. Change the service signature to take `actor: Actor` (keep the
   `AccessContext` reachable as `actor.access`) and build the actor in each
   door: `uiActor(ctx)` in actions and pages, `openMachineDoor(request, id)` in
   routes.
3. Move the `writePlatformAudit` / `writeBackgroundAudit` call into the
   service as `recordAudit(actor, { ...same fields })`: same action name, same
   object type, same title, same details. Delete it from the action and the
   route.
4. Switch the pinned test to `__setAuditWriterForTests` and assert the same
   lines. The only allowed difference: a WORKER key (and a token without a
   person) used to write NO line and now writes a `system: true` line. That
   is an addition, no existing row changes.

Where the action and the route wrote different lines for the same function
(the audit found this in several Labs), decide which one is right, write it
down in the PR, and keep only that one.

## 6. One error mapping

Services throw `ServiceError` instead of returning `{ ok: false }` or
throwing `ApiError`. Routes need nothing more (`withErrorEnvelope` maps it);
actions use `actionErrorCode`; a directly wired tool uses `toToolResult`.

## 7. One container default (the one step callers notice)

Replace `readMachineContainer`, `waehleBehaelter` and similar variants with
`chooseContainer` from `src/lib/access-rules.ts`. Behaviour change for
machines: a create without a container used to land in the organisation; it
now lands private for a person, and is refused (`400`, `container_required`)
for a credential without a person. Before switching, log every machine create
that names no container for one or two weeks; tell the owners of the keys
that show up to send `"visibility": "organisation"`; then switch.

## 8. Doors, tools, worker routes

- Every route calls `openMachineDoor(request, "<functionId>")` first; the
  parity test checks the id.
- Every tool declares `scopes` equal to its manifest entry.
- Fill the backlog exclusions from step 2 with real tools, or turn them into
  real reasons.
- Move cron-style triggers to `/api/v1/worker/<job>` with `trigger: "worker"`;
  point the scheduler at the new path, then delete the old one.
- MCP wiring: keep "tool calls `/api/v1`" (template default). BookingLab's
  direct service calls are allowed if each tool uses `openMachineDoor` and
  `toToolResult` (docs/FRAME.md 5.7). AdvisorLab's "screen calls `/api/v1`"
  stays allowed.
- Add `src/app/api/v1/openapi.json/route.ts` and list it in
  `INFRASTRUCTURE_ROUTES`.

## 9. Check

`npm run typecheck && npm run lint && npm test && npm run build && npm run check:frame`.
The frame check now also requires the manifest, the machine door, the parity
test and `docs/EXCLUSIONS.md`.
