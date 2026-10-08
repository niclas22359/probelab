# Deliberate exclusions

<!-- GENERATED from src/server/functions.manifest.ts by `npm run docs:exclusions`. Do not edit by hand: a unit test fails when this file differs. -->

Every function of this Lab is reachable through the screen, REST `/api/v1` and the MCP tool door, except where listed here with the reason.

## Doors deliberately left out

| Function | Door | Why |
|---|---|---|
| `countVisibleNotes` | REST /api/v1 | A dashboard figure; machines count the result of GET /api/v1/notes. |
| `countVisibleNotes` | MCP tool | A dashboard figure; agents use list_notes. |
| `expireNotes` | screen | Scheduled job without a person; nobody clicks it. |
| `expireNotes` | MCP tool | Worker-triggered job; an agent deletes single notes with delete_note. |
| `listApiKeys` | REST /api/v1 | Keys are managed by product admins in the screen only: a credential never mints or revokes credentials. |
| `listApiKeys` | MCP tool | Keys are managed by product admins in the screen only: a credential never mints or revokes credentials. |
| `createApiKey` | REST /api/v1 | Keys are managed by product admins in the screen only: a credential never mints or revokes credentials. |
| `createApiKey` | MCP tool | Keys are managed by product admins in the screen only: a credential never mints or revokes credentials. |
| `revokeApiKey` | REST /api/v1 | Keys are managed by product admins in the screen only: a credential never mints or revokes credentials. |
| `revokeApiKey` | MCP tool | Keys are managed by product admins in the screen only: a credential never mints or revokes credentials. |

## Worker-triggered routes (WORKER key only, REST only)

| Function | Route | Scopes |
|---|---|---|
| `expireNotes` | `POST /api/v1/worker/expire-notes` | write, notes:delete |

## Outside the rule

| Name | Why |
|---|---|
| `platform-export` | Tenant export, called by the platform through /api/platform/export. |
| `platform-delete` | Tenant deletion, called by the platform through /api/platform/organisation. |
| `platform-delete-member` | Person deletion, called by the platform through /api/platform/member. |
| `platform-reassign` | Owner hand-over, called by the platform through /api/platform/reassign-owner. |
| `dismissNewKeyAction` | Removes the one-time cookie that shows a new key; no data changes. |
