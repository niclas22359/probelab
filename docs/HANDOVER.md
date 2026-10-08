# Handover

Checked on: 2026-10-07

Copy this file into the handover of a Lab (one per handover, dated) and fill
in every section. The reviewer starts at **Not tested**. No passwords, keys
or tokens in this file or anywhere in the handover: name the Bitwarden item
instead.

## What was built

- One line per function (screen, `/api/v1`, MCP tool); link the manifest.

## How to run it locally

- The one command that starts the Lab with a seeded test user, and what it
  starts or fakes (Suite login, platform door, Brain).

## Accounts on staging

- Two test accounts (owner, member), by Bitwarden item name.

## Scheduled jobs and alerts

- Every job from `src/server/jobs/heartbeat.ts` with its cron line and window.
- Where the alert mail goes (`OPS_ALERT_EMAIL`) and when it was last tried.

## Retention

- Periods signed off by the customer (or "not yet", then in docs/OFFEN.md).
- Whether a first real run was done, with which `RETENTION_MAX_SHARE`.

## Checks that ran

- `npm run check:frame`, CI run link, contract check run link, simulation
  score (`npm run simulate`, docs/SIMULATION.md) with the failing cases.

## Not tested

One line per thing that was NOT tried, and why. Be specific: "uploads over
10 MB", "answer quality on the production model", "the member role",
"load beyond one user". An empty section is a claim that everything was
tested; the reviewer will check that claim first.

- 

## Open items

- Link to docs/OFFEN.md (the only open-items file).
