#!/usr/bin/env node
/**
 * Turns the template into YOUR Lab. Run once, right after creating the repo
 * from the template:
 *
 *   npm run rename -- <name> "<Display Name>"
 *   e.g. npm run rename -- bookinglab "BookingLab"
 *
 * `<name>`: one word, lower-case letters only, ending in "lab". It is at the
 * same time repo name, folder name, Compose project name, database role,
 * subdomain, Lab key in the Suite and the name of the platform service key.
 *
 * What it does: replaces `examplelab` -> <name>, `ExampleLab` -> <Display
 * Name> and `EXAMPLELAB` -> <NAME> in every text file of the repo (except
 * node_modules, .git, .next and this script), then prints what is left for
 * a human to decide. It does not touch the git history.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [name, display] = process.argv.slice(2);

if (!name || !/^[a-z]+lab$/.test(name) || name === "examplelab") {
  console.error(
    'Usage: npm run rename -- <name> "<Display Name>"\n' +
      '  <name> is lower-case letters ending in "lab", e.g. bookinglab.',
  );
  process.exit(1);
}
const displayName = display?.trim() || name.charAt(0).toUpperCase() + name.slice(1);
if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{0,39}$/.test(displayName)) {
  console.error('The display name may contain letters, digits, spaces, "." and "-" only (max 40).');
  process.exit(1);
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "coverage"]);
const SKIP_FILES = new Set(["rename-lab.mjs", "check-frame.mjs"]);
const TEXT = /\.(ts|tsx|mjs|js|json|md|yml|yaml|prisma|sql|sh|css|example|txt)$/;
// Files without an extension that still carry the name (comments, image tags).
const EXTENSIONLESS = new Set(["Dockerfile", ".gitattributes", ".dockerignore", ".prettierignore"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (
      !SKIP_FILES.has(entry.name) &&
      (TEXT.test(entry.name) || entry.name.startsWith(".env") || EXTENSIONLESS.has(entry.name))
    )
      out.push(full);
  }
  return out;
}

let changed = 0;
for (const file of walk(root)) {
  if (statSync(file).size > 2_000_000) continue;
  const before = readFileSync(file, "utf8");
  // Replacer FUNCTIONS: a display name containing a dollar sequence must be
  // inserted literally, not interpreted by String.replace.
  const after = before
    .replaceAll("examplelab", () => name)
    .replaceAll("ExampleLab", () => displayName)
    .replaceAll("EXAMPLELAB", () => name.toUpperCase());
  if (after !== before) {
    writeFileSync(file, after);
    changed += 1;
    console.log(`renamed: ${path.relative(root, file)}`);
  }
}

console.log(`\n${changed} file(s) updated for "${name}" ("${displayName}").`);
console.log(`
Still yours to do (the template cannot know these):
  1. Ports: pick the next free pair on the Playground (SIDE-PROJECTS.md port
     map) and replace the dev port 3390 in ALL of: package.json ("dev"),
     scripts/start.mjs, src/lib/mcp/server.ts, mcp/server.mjs, README.md and
     the APP_PORT default in docker/docker-compose.yml. Two Labs on the same
     dev port let the MCP self-call hit the wrong Lab with your key.
  2. The one sentence in README.md that says what this Lab does.
  3. Replace the example object "Note" (prisma/schema.prisma, src/server,
     src/app/(app)/notes, src/lib/mcp/catalog.ts) with your own objects.
     Keep the three container columns and the export coverage test.
  4. Register the Lab: Suite migration (labs row, enabled = FALSE), platform
     service key + export key in Bitwarden, EXPORT_SOURCES on the platform.
  Then: npm install && npm run check:frame
`);
