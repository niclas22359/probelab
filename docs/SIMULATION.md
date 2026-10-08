# Simulation before handover

Checked on: 2026-10-07

Lab learnings (Masoud, 30.09.2026, rule 13): after the deadline, 48
simulated conversations showed that only 5 of 18 reached a reservation. No
unit test and no hand test had shown it. Every Lab runs a simulation with a
judge **before** handover and puts the score and the failing cases into
`docs/HANDOVER.md`.

## What it does

`npm run simulate [-- N]` (default 20) runs N scripted flows from
`tests/simulation/scenarios.json` through `/api/v1` of a running Lab, then
asks the platform door to judge each transcript against the flow's goal
(`useCase: "verification"`; the Lab holds no provider key). It prints
`score passed/total (percent)`, one `FAILED <run>:<scenario>: <reason>` line
per failure, and the job line. Exit 1 below `SIM_MIN_PERCENT` (default 90).
The pure parts (template filling, verdict parsing, score) are unit-tested in
`tests/unit/contract-simulation.test.ts`.

## Why not in CI

Each run is one paid AI call per flow plus real writes on the target Lab.
Run it by hand against staging, or against a local stack with the door set.

## Settings

`SIM_LAB_URL`, `SIM_API_KEY` (a Lab API key with read + write for the test
organisation), `SIM_ORGANISATION_ID`, `PLATFORM_API_URL`,
`PLATFORM_API_KEY`, optional `SIM_MIN_PERCENT`. Put them in your local
`.env`, never in a file in the repo.

## Make it yours

Replace the example flows with the Lab's real main paths, including the ones
that should end in a refusal. A chat Lab sends conversation turns as steps.
Keep each goal concrete and checkable from the transcript alone.

## Contract check (the daily twin)

`npm run contract:check` makes one real, cheap call per platform edge
(`src/server/jobs/contract-edges.ts`) against staging; the workflow
`.github/workflows/contract-check.yml` runs it daily. Its header lists the
repo secrets a human must set. Until they are set, the scheduled run is red
on purpose ("missing" edges count as failed).
