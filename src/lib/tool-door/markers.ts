/**
 * Tool markers: what a tool does, said once per tool (connection layer contract, stage 6, 2.4/2.5).
 *
 * Every tool of a Lab says whether it only reads, changes something, or does something that
 * cannot be taken back by the caller (`destructive`: deletes data, reaches a person outside the
 * organisation, or spends money or provider credits). The agent safety of Beyondles HorAIzon
 * reads these markers instead of guessing from tool names.
 *
 * Tools whose effect leaves the organisation through a connected account also carry a
 * capability tag (`mail.send`, `post.publish`, `calendar.write`), the same names the connection
 * service uses.
 *
 * THIS FILE IS COPIED VERBATIM into every Lab from the template `beyondles-lab`. Do not edit a
 * copy; change the template and copy again. Node runtime only.
 */

export type ToolAccess = "read" | "write" | "destructive";

/** The same names as the connection service's capabilities; stage 5 treats these as leaving the organisation. */
export type ToolCapability = "mail.send" | "post.publish" | "calendar.write";

export const TOOL_CAPABILITIES: readonly ToolCapability[] = ["mail.send", "post.publish", "calendar.write"];

export const TOOL_CAPABILITY_META_KEY = "ai.beyondles/capability";

export interface ToolMarker {
  access: ToolAccess;
  idempotent: boolean;
  title: { de: string; en: string };
  capability?: ToolCapability;
}

/** Beyondles HorAIzon composes its own name around the tool name; providers cap at 64. */
export const TOOL_NAME_MAX = 48;

export const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9]{1,15}_$/;

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
}

const ACCESS_VALUES: readonly ToolAccess[] = ["read", "write", "destructive"];
const TITLE_MAX = 60;

/** The MCP annotations of one tool, from its marker. */
export function toolAnnotations(marker: ToolMarker): ToolAnnotations {
  return {
    title: marker.title.en,
    readOnlyHint: marker.access === "read",
    destructiveHint: marker.access === "destructive",
    idempotentHint: marker.idempotent,
    openWorldHint: false,
  };
}

/** `{ [TOOL_CAPABILITY_META_KEY]: capability }` when the marker has one, else undefined (no `_meta` member at all). */
export function toolMeta(marker: ToolMarker): Record<string, string> | undefined {
  return marker.capability ? { [TOOL_CAPABILITY_META_KEY]: marker.capability } : undefined;
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleProblem(value: unknown): string | null {
  if (typeof value !== "string") return "missing";
  const length = value.trim().length;
  if (length < 1 || value.length > TITLE_MAX) return `must be 1 to ${TITLE_MAX} characters`;
  return null;
}

/** Empty array = the catalogue follows the rule of 2.4. Each entry names the tool and the broken rule. */
export function catalogProblems(
  tools: ReadonlyArray<{ name: string } & Partial<ToolMarker>>,
  prefix: string,
): string[] {
  const problems: string[] = [];
  const prefixOk = TOOL_PREFIX_PATTERN.test(prefix);
  if (!prefixOk) problems.push(`prefix "${prefix}": must match ${TOOL_PREFIX_PATTERN}`);
  const namePattern = prefixOk ? new RegExp(`^${escapeForPattern(prefix)}[a-z0-9_]+$`) : null;

  const seen = new Set<string>();
  for (const tool of tools) {
    const name = tool.name;
    const label = `tool "${name}"`;
    if (namePattern && !namePattern.test(name)) problems.push(`${label}: name must match ^${prefix}[a-z0-9_]+$`);
    if (name.length > TOOL_NAME_MAX) problems.push(`${label}: name is longer than ${TOOL_NAME_MAX} characters`);
    if (seen.has(name)) problems.push(`${label}: name is not unique`);
    seen.add(name);

    const access = tool.access;
    if (!access || !ACCESS_VALUES.includes(access)) {
      problems.push(`${label}: access must be read, write or destructive`);
    }
    if (typeof tool.idempotent !== "boolean") {
      problems.push(`${label}: idempotent must be a boolean`);
    } else if (access === "read" && tool.idempotent !== true) {
      problems.push(`${label}: a read tool must be idempotent`);
    }

    const de = titleProblem(tool.title?.de);
    if (de) problems.push(`${label}: title.de ${de}`);
    const en = titleProblem(tool.title?.en);
    if (en) problems.push(`${label}: title.en ${en}`);

    if (tool.capability !== undefined) {
      if (!TOOL_CAPABILITIES.includes(tool.capability)) {
        problems.push(`${label}: capability must be one of ${TOOL_CAPABILITIES.join(", ")}`);
      } else if (access !== "write" && access !== "destructive") {
        problems.push(`${label}: a capability belongs on a write or destructive tool only`);
      }
    }
  }
  return problems;
}
