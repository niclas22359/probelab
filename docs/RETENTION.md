# Retention

<!-- GENERATED from src/server/retention/registry.ts by `npm run docs:retention`. Do not edit by hand: tests/unit/retention.test.ts fails when a registry line is missing. -->

Periods are the defaults; the setting named in the
registry overrides them per environment. The periods are a customer
decision: until the customer signs them off they stay in docs/OFFEN.md.

## Privacy-note lines

- Notes (title, body): kept 365 days after creation, then the personal content is erased for good.

## Settings

- `RETENTION_NOTES_DAYS` (days, default 365) for `notes`

## Tenant tables without personal data

- `organisations`: Mirror of the Suite organisation: id, slug, name of a company.
- `api_keys`: Key hash, scopes and the Suite user id of the creator; deleted with the person (platform-delete-member).
