# Submitting a Lab into the Beyondles ecosystem

Checked on: 2026-10-08

Status: **decided 2026-10-08 (Niclas), build in progress.** This is the
process behind "Build your own Lab" in the Suite. `docs/BUILDING.md` is the
same path told to the builder; this file is the Beyondles side.

## The decision

The builder (customer, partner) builds **in their own GitHub account** from
this template. Beyondles neither pays seats nor CI minutes for it, and the
builder's code stays private to them. At submission Beyondles takes a
**copy** of a tagged commit into `beyondles-ai/<name>`; from then on the copy
is what is reviewed, deployed and operated. Beyondles never pushes into the
builder's repository, the builder never pushes into Beyondles'.

Why not a repository in `beyondles-ai` from day one: on the Team plan every
outside collaborator in a private repository is a paid seat and every CI run
is paid from Beyondles' minutes. A public repository would avoid both but
exposes the builder's code. A copy on submission keeps ownership of the
operated code with Beyondles and the cost with the builder.

Consequence: this template repository is **public**. It contains the frame,
no secrets, no customer data. It also serves as the technical description of
"what a Lab is".

## Two consent moments

1. **At the request** (Suite form, before the builder gets the template link):
   Beyondles hosts and operates accepted Labs and holds the right to run the
   code; the builder keeps the right to reuse their own contribution; the Lab
   must pass the checks and a review.
2. **At the submission** (Suite form, before "Submit a Lab"): hosting, review,
   data protection (per-Lab annex), liability for the builder's code, exit.

Both texts come from legal review (see "Open legal questions"). The Suite
stores who ticked what and when; until the texts exist, the boxes carry a
placeholder and the submission path is enabled for Beyondles' own
organisation only.

## The states a submission goes through

`received → checking → in_review → changes_requested → on_staging → accepted → live`
(`rejected` from any state, with a written reason). The builder sees the state
and the reviewer's list on the Suite page; every transition mails the builder
and `development@beyondles.ai` through the platform mail door.

## What Beyondles does per state

- **received:** the Suite stores repository, tag, name, sentence, the four
  answers and the consent. Beyondles needs read access (collaborator or
  public repo); the page names the GitHub user to add.
- **checking:** `ops/submission/intake.sh <repo> <tag> <name>` clones the
  tag, creates `beyondles-ai/<name>` from it (private, `develop` default,
  rulesets mirrored, team `developers` push, squash/rebase off), pushes, and
  lets CI run. Red CI = `changes_requested` with the CI link, automatically.
- **in_review:** a developer reviews with the frame checklist
  (`.github/pull_request_template.md`) and `docs/HANDOVER.md`, starting at
  "Not tested". Findings go to the builder as a list on the Suite page.
- **changes_requested:** the builder fixes in their repository and submits a
  new tag; intake replaces `develop` of the copy with the new tag (a merge
  commit, history kept).
- **on_staging:** the server side of `/lab-pipeline` (phases 4 to 7): host,
  tunnel, DNS, Suite row with `enabled = FALSE`, platform keys, two test
  accounts for the builder.
- **accepted:** release PR `develop → main` (Niclas' click), Suite tile,
  platform export/delete registration, HorAIzon tool registration.
- **live:** Niclas switches the Lab on for the builder's organisation.

## What the template already enforces (so the review can be short)

- Suite login, three-level access model, platform door, export and deletion
  endpoints, API + MCP with manifest and parity test, scopes, rate limits,
  jobs with exit codes and alerts, retention, two languages, Docker layout,
  CI, deploy scripts, icons, "Back to Suite" link.
- `npm run check:frame` fails on: missing frame files, provider or mail
  SDKs, forbidden variables, hard-coded Suite address, empty `catch`,
  `|| true`, undated docs, unknown root files, template name leftovers.
- The unit tests fail on: a tenant table missing from export, deletion plans
  or retention, a function missing a door or a manifest entry, a variable
  read by the code but not passed by Compose, locale gaps.

## What the template cannot enforce (so the review must look)

- The tenant filter on every new query (the pattern is there; following it
  is a human decision).
- What the Lab does with personal data, and whether the retention periods
  are the ones the customer agreed.
- Quality and purpose of the product itself, overlap with existing Labs.
- Anything in "Not tested".

## Open legal questions — before the first external submission

1. **IP and licence.** Which licence does the builder grant on the copy?
   Proposal: a broad licence to Beyondles to run, modify and operate; the
   builder keeps the right to reuse their own contribution.
2. **Liability.** Builder for their code, Beyondles for platform and hosting.
3. **Data protection.** The existing AVV covers Suite and HorAIzon; a Lab the
   customer wrote needs an annex per Lab.
4. **Partner model.** May a builder submit a Lab for OTHER customers? The
   access model isolates tenants; the contracts must say who sells to whom.
5. **Exit.** The copy stays with Beyondles. May Beyondles keep operating it
   for others, must it delete it?

## Not in scope of this document

- Rewriting the existing Labs onto the template.
- The shared skill collection (card #309).
