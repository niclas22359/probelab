# Open items

Checked on: 2026-10-07

What is deliberately not finished. Every entry says WHY, so the next person
can decide instead of guessing. Remove entries when done.

## In the template itself

- **Retention periods are placeholders.** `RETENTION_NOTES_DAYS` defaults to
  365 for the example table. The period is the customer's decision; a Lab
  keeps this entry until the customer signed its periods off.
- **Contract check secrets, per Lab.** `.github/workflows/contract-check.yml`
  lists them. The job does not run in the template repo itself (no staging Lab
  there); a Lab created from the template sets them for its own staging, until
  then its daily run is red on purpose. The `door-media-route` edge asks the
  door for its image routing (free); a real generation would cost money daily.

- **Worker keys are never re-checked.** They skip the platform on purpose
  (no person behind them). A product admin who is later demoted keeps the
  worker key they minted until someone revokes it in the Lab's settings.
  Smallest fix: a periodic organisation-level check, or revoke all worker
  keys when the platform reports the organisation lost the product.
- **Only the unit tests cover the frame.** No tests reach the route
  handlers themselves (export route, v1 routes, middleware) or the
  platform-context parsing with a fake platform. The Playground proof
  covered them once by hand; a Lab that changes them needs its own tests.

- **Collections in the UI.** The access rules understand `COLLECTION`
  visibility (platform collections). The example form uses the shared
  `VisibilityPicker` but passes no collections, because the note input
  schema stores `private` and `organisation` only, so the "A collection" row
  is shown as not available. A Lab that shares by collection passes
  `access.collections` to `NoteVisibilityField` and extends the input schema
  (with a check that the person is in that collection).
- **Individual grants (share dialog).** The share blocks
  (`src/components/share`, generated from `beyondles-ai/beyondles-shared`)
  include `ShareDialog`, but the example does not use it: there is no
  `/api/share/<type>/<id>` route. Reading grants works (`grantedLevels` from
  the platform). Writing them (`PUT/DELETE /api/access/objects/...`) is not
  in the template; copy LeadLab's `src/lib/platform/protocol.ts` and its
  share route when a Lab needs the dialog.
- **E2E tests.** Unit tests only. LeadLab's Playwright setup
  (`tests/e2e`, `.github/workflows/e2e.yml`) is the pattern.
- **Stale organisation in the token.** Known platform-wide weakness: the
  organisation uuid is a snapshot of the login moment (see SIDE-PROJECTS.md,
  "Stale organisation"). Not fixable in a Lab.

- **Rate limit per process.** The in-memory store counts per container and
  starts from zero on restart (docs/FRAME.md 5.5). Enough for one container
  per environment; several replicas need `setRateLimitStore` with a shared
  store.
- **Narrowing an existing key.** Keys from before scopes keep `*` (full
  access). There is no "edit scopes" button: the owner creates a narrower key
  and revokes the old one. Add an edit action when Labs ask for it.
- **Screen through `/api/v1`.** The AdvisorLab style (docs/FRAME.md 5.7) needs
  a bridge that accepts the Suite cookie in `openMachineDoor`; not built.

Deliberately missing doors are NOT listed here: they live in the functions
manifest and `docs/EXCLUSIONS.md`.

## In a Lab built from this template

- (add yours here, one line each: what, why not yet, who decides)
