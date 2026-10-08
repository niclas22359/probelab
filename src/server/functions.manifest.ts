import type { z } from "zod";

import { TOOL_PREFIX } from "@/lib/lab";
import type { Scope } from "@/lib/scopes";
import {
  deletedEnvelope,
  expireNotesSchema,
  expiredEnvelope,
  listNotesQuerySchema,
  noteEnvelope,
  noteInputSchema,
  noteListEnvelope,
  noteUpdateSchema,
} from "@/server/schemas/notes";

/**
 * THE FUNCTIONS MANIFEST — every function of this Lab, and where each door
 * reaches it. The rule (owner, 06.10.2026): every function exists ONCE in a
 * service and is reachable through the screen, REST `/api/v1` (programs) and
 * the tool door `/api/mcp` (agents), or says in writing why not.
 *
 * `tests/unit/parity.test.ts` reads `src/server/services`, `src/server/actions`,
 * `src/app/api/v1` and the MCP catalogue and FAILS THE BUILD when
 *   (i)   a service export is not listed here,
 *   (ii)  an entry names an action, page, route or tool that does not exist,
 *   (iii) a route, tool or action exists that nothing here names,
 *   (iv)  an entry lacks a door without an `excluded` reason,
 * and checks that each tool declares the entry's scopes and calls the entry's
 * route, and that each route opens the door for the right function.
 * `docs/EXCLUSIONS.md` is generated from this file (`npm run docs:exclusions`);
 * a test fails when it is stale.
 *
 * Key = the service export's name. `scopes` = what a MACHINE credential needs
 * (the screen is limited by the container rules instead).
 */

export interface Excluded {
  /** Why this door deliberately does not exist. Shown in docs/EXCLUSIONS.md. */
  excluded: string;
}

/** `action`: a server action export; `page`: an app route path such as `/notes/[noteId]`. */
export type ScreenDoor = { action: string } | { page: string } | Excluded;

export interface RestDoor {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** OpenAPI form: `/api/v1/notes/{noteId}`. */
  path: string;
  summary: string;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  /** Success status, default 200. */
  status?: number;
}

export type McpDoor = { tool: string } | Excluded;

export interface FunctionEntry {
  /** File under `src/server/services` without `.ts`. */
  service: string;
  scopes: readonly Scope[];
  /** `worker`: a cron-style trigger; WORKER key only, REST only (docs/FRAME.md 5). */
  trigger?: "worker";
  screen: ScreenDoor;
  rest: RestDoor | Excluded;
  mcp: McpDoor;
}

const KEYS_ARE_FOR_PEOPLE =
  "Keys are managed by product admins in the screen only: a credential never mints or revokes credentials.";

export const FUNCTIONS = {
  listNotes: {
    service: "notes",
    scopes: ["read"],
    screen: { page: "/notes" },
    rest: {
      method: "GET",
      path: "/api/v1/notes",
      summary: "List the notes visible to the caller",
      query: listNotesQuerySchema,
      response: noteListEnvelope,
    },
    mcp: { tool: `${TOOL_PREFIX}list_notes` },
  },
  getNote: {
    service: "notes",
    scopes: ["read"],
    screen: { page: "/notes/[noteId]" },
    rest: {
      method: "GET",
      path: "/api/v1/notes/{noteId}",
      summary: "Read one note",
      response: noteEnvelope,
    },
    mcp: { tool: `${TOOL_PREFIX}get_note` },
  },
  createNote: {
    service: "notes",
    scopes: ["write"],
    screen: { action: "createNoteAction" },
    rest: {
      method: "POST",
      path: "/api/v1/notes",
      summary: "Create a note",
      body: noteInputSchema,
      response: noteEnvelope,
      status: 201,
    },
    mcp: { tool: `${TOOL_PREFIX}create_note` },
  },
  updateNote: {
    service: "notes",
    scopes: ["write"],
    screen: { action: "updateNoteAction" },
    rest: {
      method: "PATCH",
      path: "/api/v1/notes/{noteId}",
      summary: "Change a note's title, text or container",
      body: noteUpdateSchema,
      response: noteEnvelope,
    },
    mcp: { tool: `${TOOL_PREFIX}update_note` },
  },
  deleteNote: {
    service: "notes",
    scopes: ["write", "notes:delete"],
    screen: { action: "deleteNoteAction" },
    rest: {
      method: "DELETE",
      path: "/api/v1/notes/{noteId}",
      summary: "Delete a note permanently",
      response: deletedEnvelope,
    },
    mcp: { tool: `${TOOL_PREFIX}delete_note` },
  },
  countVisibleNotes: {
    service: "notes",
    scopes: ["read"],
    screen: { page: "/" },
    rest: {
      excluded:
        "A dashboard figure; machines count the result of GET /api/v1/notes.",
    },
    mcp: { excluded: "A dashboard figure; agents use list_notes." },
  },
  expireNotes: {
    service: "notes",
    scopes: ["write", "notes:delete"],
    trigger: "worker",
    screen: { excluded: "Scheduled job without a person; nobody clicks it." },
    rest: {
      method: "POST",
      path: "/api/v1/worker/expire-notes",
      summary: "Worker job: delete organisation notes older than N days",
      body: expireNotesSchema,
      response: expiredEnvelope,
    },
    mcp: {
      excluded:
        "Worker-triggered job; an agent deletes single notes with delete_note.",
    },
  },
  listApiKeys: {
    service: "api-keys",
    scopes: ["read"],
    screen: { page: "/settings" },
    rest: { excluded: KEYS_ARE_FOR_PEOPLE },
    mcp: { excluded: KEYS_ARE_FOR_PEOPLE },
  },
  createApiKey: {
    service: "api-keys",
    scopes: ["write"],
    screen: { action: "createApiKeyAction" },
    rest: { excluded: KEYS_ARE_FOR_PEOPLE },
    mcp: { excluded: KEYS_ARE_FOR_PEOPLE },
  },
  revokeApiKey: {
    service: "api-keys",
    scopes: ["write"],
    screen: { action: "revokeApiKeyAction" },
    rest: { excluded: KEYS_ARE_FOR_PEOPLE },
    mcp: { excluded: KEYS_ARE_FOR_PEOPLE },
  },
} as const satisfies Record<string, FunctionEntry>;

export type FunctionId = keyof typeof FUNCTIONS;

/** Whole service files outside the rule: the frame's platform calls, not functions of the Lab. */
export const FRAME_SERVICES: Readonly<Record<string, string>> = {
  "platform-export":
    "Tenant export, called by the platform through /api/platform/export.",
  "platform-delete":
    "Tenant deletion, called by the platform through /api/platform/organisation.",
  "platform-delete-member":
    "Person deletion, called by the platform through /api/platform/member.",
  "platform-reassign":
    "Owner hand-over, called by the platform through /api/platform/reassign-owner.",
};

/** Server actions that are screen mechanics, not functions. */
export const SCREEN_HELPERS: Readonly<Record<string, string>> = {
  dismissNewKeyAction:
    "Removes the one-time cookie that shows a new key; no data changes.",
};

/** `/api/v1` routes that are not functions of the Lab. */
export const INFRASTRUCTURE_ROUTES: ReadonlyArray<{
  method: string;
  path: string;
  reason: string;
}> = [
  {
    method: "GET",
    path: "/api/v1/openapi.json",
    reason:
      "The machine-readable description of /api/v1, generated from this manifest.",
  },
];
