# beyondles-lab — the template for a Beyondles Lab

> **ExampleLab does nothing yet. Replace this sentence with what YOUR Lab does, and for whom.**

A Lab is a standalone tool under `<name>.beyondles.ai`: used internally,
offered to customers, and attached to Beyondles HorAIzon as a tool. This
repository is the **frame** every Lab shares — sign-in through the Suite,
the three-level access model, the platform door for AI and mail, the tenant
export, the API and MCP doors, two languages, Docker, CI and deploy scripts.
The product itself is yours. `docs/FRAME.md` lists what the frame guarantees.

## Start a new Lab (5 minutes)

**Outside Beyondles** (customer, partner): use **Use this template** on GitHub
in your own account, then read `docs/BUILDING.md` — it takes you from the
first commit to the submission in the Beyondles Suite. `CLAUDE.md` tells
your AI coding agent what to build and what to leave alone.

**Inside Beyondles:**

```bash
gh repo create beyondles-ai/<name> --private --template beyondles-ai/beyondles-lab --clone
cd <name>
npm run rename -- <name> "<Display Name>"     # e.g. bookinglab "BookingLab"
npm ci
npm run check:frame && npm test
```

`<name>` is one word, lower-case, ending in `lab`. Then follow
`/lab-pipeline neu <name>` for branches, rulesets, Suite row, platform keys,
host, tunnel, DNS and the Suite tile — the template covers phase 2 and 3 of
that pipeline, the host side stays with the pipeline.

## Run locally

```bash
cp .env.example .env            # fill DATABASE_URL, POSTGRES_PASSWORD
# local development without a Suite:
#   JWT_SECRET=<any string>  ALLOW_LOCAL_JWT=true  (in .env)
npm run db:migrate              # needs a local Postgres
npm run dev                     # http://localhost:3390
node scripts/dev-login.mjs      # prints a cookie line for the browser console
```

Local mode needs `JWT_SECRET` + `ALLOW_LOCAL_JWT=true` (otherwise there is
no way to sign in and the middleware answers 503). In local mode, and only
while `PLATFORM_API_URL/KEY` are NOT set, the gate is open, every signed-in
person is a user and owners are product admins. As soon as the platform
door is configured, the platform decides — also locally. Never on a
server — see `src/lib/jwt-guard.ts`.

## What is where

| Path | Purpose |
|---|---|
| `src/lib/lab.ts` | the Lab's name — the single place |
| `src/lib/auth.ts`, `src/middleware.ts` | sign-in through the Suite |
| `src/lib/platform-access.ts` | level 1: release switch (Suite) |
| `src/lib/platform/access.ts` | level 2 + 3: product access, collections, grants (platform) |
| `src/lib/access-rules.ts` | the container filter every query uses |
| `src/lib/platform/llm.ts`, `mail.ts` | AI and mail through the platform door |
| `src/app/api/platform/export/route.ts` | tenant export for the platform |
| `src/app/api/platform/organisation/route.ts` | tenant deletion for the platform (own key `PLATFORM_DELETE_KEY`) |
| `src/app/api/platform/member/route.ts` | person deletion for the platform (same key; plan in `platform-delete-member.ts`) |
| `src/app/api/v1/…`, `src/lib/api-auth.ts` | HTTP door (`x-api-key` or on-behalf token, release gate) |
| `src/app/api/mcp/route.ts`, `src/app/api/mcp/describe/route.ts`, `src/lib/mcp/` | MCP door for agents and its description |
| `src/lib/tool-door/`, `src/lib/platform/on-behalf.ts` | Shared tool-door files (copied verbatim into every Lab) |
| `src/app/api/platform/reassign-owner/route.ts` | Hand-over when a person leaves |
| `src/app/(app)/notes` + `src/server/…` | the worked example of a tenant object: list, read, create, change, delete, and a worker job |
| `src/server/functions.manifest.ts` | every function and its three doors (or the reason one is left out) |
| `src/server/machine-door.ts`, `src/lib/actor.ts` | the door for one function, and who acts through which door |
| `src/lib/audit.ts`, `src/lib/service-errors.ts` | the audit line (written by services) and the one error mapping |
| `src/lib/scopes.ts`, `src/lib/rate-limit.ts` | key scopes and the rate limit of the machine doors |
| `src/app/api/v1/openapi.json/route.ts`, `src/lib/openapi.ts` | the OpenAPI document of `/api/v1`, generated from the manifest |
| `docs/EXCLUSIONS.md`, `docs/HEADLESS-MIGRATION.md` | the generated exclusions list; how an existing Lab adopts the headless pieces |
| `src/components/share/`, `.beyondles-shared.json` | the share blocks (picker, badge, people picker, dialog): **generated from `beyondles-ai/beyondles-shared`, never edited here** |
| `src/lib/platform-client/` | the access client, decisions and container rules behind `platform-access.ts`, `platform/access.ts`, `access-rules.ts`, `rbac.ts` and `api-auth.ts`: **generated from `beyondles-ai/beyondles-shared`, never edited here** |
| `src/components/ui/share-primitives/` | the four small components the share blocks draw with (this Lab's own look) |
| `docker/`, `ops/deploy/` | container stack and host scripts |
| `scripts/check-frame.mjs` | the repo half of `/lab-pipeline check`, runs in CI |
| `docs/FRAME.md` | what the frame guarantees |
| `docs/SUBMISSION.md` | how a Lab gets into the ecosystem (concept) |
| `docs/OFFEN.md` | what is deliberately not finished |

## Rules that the checks enforce

- No provider or mail key, no provider SDK. AI and mail go through the door.
- Every tenant table (with `organisationId`) appears in the export (test fails otherwise).
- Every table has a decision in the deletion plan: delete, anonymise, retain with a reason, or global with a reason (test fails otherwise).
  Child tables without that column are the reviewer's job.
- Every variable the code reads is passed by Compose and explained in `.env.example`.
- `src/components/share/` and the `share` part of `messages/*.json` are generated from `beyondles-ai/beyondles-shared` and never edited locally: the CI step "Shared code is unchanged" fails on any difference. To change them, change the shared repo, tag a version, and run its `sync/sync.mjs --target <this repo>` from a checkout of that tag (what a Lab must provide: `share-ui/HOST-CONTRACT.md` there).
- `messages/de.json` and `messages/en.json` carry the same keys.
- `JWT_SECRET` never on a server; a production process refuses to start with it (unless `ALLOW_LOCAL_JWT=true`, the E2E exception, which is logged loudly).
- **Headless by construction:** every function exists once in a service and is reachable through the screen, `/api/v1` and an MCP tool, or carries a written exclusion. `src/server/functions.manifest.ts` lists them; `tests/unit/parity.test.ts` fails the build when a service export, route, tool or action is missing from it or it points at something that does not exist, and when `docs/EXCLUSIONS.md` (generated, `npm run docs:exclusions`) is stale. Audit and container choice happen in the service, never in a door (docs/FRAME.md section 5).
- Every `/api/v1` handler opens its door with `openMachineDoor(request, "<functionId>")`: credential, rate limit, the function's scopes, the worker-only rule.

## Where it runs

Playground server (`ssh playground`), Docker Compose, one project per
environment (`/opt/<name>/staging`, `/opt/<name>/production`), public only
through the Cloudflare tunnel under `<name>.beyondles.ai` and
`<name>-staging.beyondles.ai`. Operating description:
`beyondles-ci/docs/SIDE-PROJECTS.md`.
