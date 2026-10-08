import { TOOL_PREFIX } from "@/lib/lab";
import type { Scope } from "@/lib/scopes";
import type { ToolMarker } from "@/lib/tool-door/markers";

/**
 * The tool catalogue — the ONE truth about what agents can do with this Lab.
 *
 * Every tool maps to exactly one `/api/v1` call. The MCP server never touches
 * the database: it calls the HTTP door with the same `x-api-key`, so tenant
 * separation, access model and error handling apply unchanged. A tool can
 * never see more than an ordinary API caller.
 *
 * Schemas are literal JSON Schema, as they reach the agent. Descriptions are
 * English and say what the tool does for the person, not how it is built.
 *
 * Every tool carries a MARKER (`src/lib/tool-door/markers.ts`): `access`
 * (`read`, `write`, `destructive`), `idempotent`, a title in German and
 * English (verb first), and a `capability` when its effect leaves the
 * organisation through a connected account. Names start with `TOOL_PREFIX`
 * (`src/lib/lab.ts`); `tests/unit/tool-catalog.test.ts` checks the rule.
 *
 * Every tool declares the SCOPES its route needs (the same as the function's
 * entry in `src/server/functions.manifest.ts`; the parity test compares
 * them) and `/api/mcp/describe` shows them. A tool exists for every route
 * the manifest does not exclude. `delete_note` is `destructive` and needs the
 * extra scope `notes:delete`: Beyondles HorAIzon asks a human before it runs.
 */

export type ToolArguments = Record<string, unknown>;

export interface V1Call {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

export interface ToolDefinition extends ToolMarker {
  name: string;
  scopes: readonly Scope[];
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  toCall: (args: ToolArguments) => V1Call;
}

function str(args: ToolArguments, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: `${TOOL_PREFIX}list_notes`,
    scopes: ["read"],
    access: "read",
    idempotent: true,
    title: { de: "Notizen auflisten", en: "List notes" },
    description:
      "List the notes visible to the key's organisation and view, newest first. " +
      "Optional free-text search over title and body.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional text to search for." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max rows (default 50)." },
      },
      additionalProperties: false,
    },
    toCall: (args) => {
      const params = new URLSearchParams();
      const search = str(args, "search");
      if (search) params.set("search", search);
      if (typeof args.limit === "number") params.set("limit", String(args.limit));
      const qs = params.toString();
      return { method: "GET", path: `/api/v1/notes${qs ? `?${qs}` : ""}` };
    },
  },
  {
    name: `${TOOL_PREFIX}get_note`,
    scopes: ["read"],
    access: "read",
    idempotent: true,
    title: { de: "Notiz lesen", en: "Read a note" },
    description: "Read one note by id, if the key's view may see it.",
    inputSchema: {
      type: "object",
      properties: { noteId: { type: "string", description: "The note id (uuid)." } },
      required: ["noteId"],
      additionalProperties: false,
    },
    toCall: (args) => ({
      method: "GET",
      path: `/api/v1/notes/${encodeURIComponent(str(args, "noteId") ?? "")}`,
    }),
  },
  {
    name: `${TOOL_PREFIX}create_note`,
    scopes: ["write"],
    access: "write",
    idempotent: false,
    title: { de: "Notiz anlegen", en: "Create a note" },
    description:
      "Create a note. `visibility`: 'private' (only the caller's person, the default) or " +
      "'organisation' (everybody in the organisation). A credential without a person (worker key, " +
      "organisation agent) has no private container and must pass 'organisation' explicitly. A " +
      "collection agent passes no visibility: its notes always land in its own collection.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", maxLength: 20000 },
        visibility: { type: "string", enum: ["private", "organisation"] },
      },
      required: ["title"],
      additionalProperties: false,
    },
    toCall: (args) => {
      const visibility = str(args, "visibility");
      return {
        method: "POST",
        path: "/api/v1/notes",
        body: {
          title: str(args, "title") ?? "",
          body: typeof args.body === "string" ? args.body : "",
          ...(visibility ? { visibility } : {}),
        },
      };
    },
  },
  {
    name: `${TOOL_PREFIX}update_note`,
    scopes: ["write"],
    access: "write",
    idempotent: true,
    title: { de: "Notiz ändern", en: "Change a note" },
    description:
      "Change the title, text or visibility of a note the caller may edit. Only the note's owner " +
      "changes its visibility. Pass only the fields to change.",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "The note id (uuid)." },
        title: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", maxLength: 20000 },
        visibility: { type: "string", enum: ["private", "organisation"] },
      },
      required: ["noteId"],
      additionalProperties: false,
    },
    toCall: (args) => {
      const body: Record<string, unknown> = {};
      const title = str(args, "title");
      if (title) body.title = title;
      if (typeof args.body === "string") body.body = args.body;
      const visibility = str(args, "visibility");
      if (visibility) body.visibility = visibility;
      return { method: "PATCH", path: `/api/v1/notes/${encodeURIComponent(str(args, "noteId") ?? "")}`, body };
    },
  },
  {
    name: `${TOOL_PREFIX}delete_note`,
    scopes: ["write", "notes:delete"],
    access: "destructive",
    idempotent: false,
    title: { de: "Notiz löschen", en: "Delete a note" },
    description: "Delete a note permanently. Cannot be undone. Needs a credential with the scope notes:delete.",
    inputSchema: {
      type: "object",
      properties: { noteId: { type: "string", description: "The note id (uuid)." } },
      required: ["noteId"],
      additionalProperties: false,
    },
    toCall: (args) => ({ method: "DELETE", path: `/api/v1/notes/${encodeURIComponent(str(args, "noteId") ?? "")}` }),
  },
];

export const TOOLS_BY_NAME = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));
export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);
