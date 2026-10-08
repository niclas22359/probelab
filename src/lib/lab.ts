/**
 * The identity of this Lab — the single place the name is defined in code.
 *
 * LAB_KEY is at the same time: repo name, Compose project name, database
 * role, subdomain, the `labs.key` row in the Suite, the product key at the
 * platform (`/api/access/me?product=<LAB_KEY>`), the audience of on-behalf
 * tokens for this Lab and the name of the Lab's platform service key.
 * `npm run rename` replaces it everywhere.
 */
export const LAB_KEY = "examplelab";

/** Display name for people (title, navigation, notices). */
export const LAB_NAME = "ExampleLab";

/**
 * Prefix of API keys this Lab issues, so a leaked key is recognisable.
 * Derived from the key on purpose: the rename script then covers it too.
 */
export const API_KEY_PREFIX = `${LAB_KEY}_`;

/**
 * Prefix of every tool name at the tool door (`/api/mcp`). Declared once,
 * here; `catalogProblems` (src/lib/tool-door/markers.ts) checks that every
 * tool carries it. A Lab key longer than 15 characters needs a shorter
 * prefix (rule `^[a-z][a-z0-9]{1,15}_$`).
 */
export const TOOL_PREFIX = `${LAB_KEY}_`;
