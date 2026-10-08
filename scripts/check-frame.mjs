#!/usr/bin/env node
/**
 * Frame self-check: the repo half of the `/lab-pipeline check` list, run
 * in CI on every PR and locally with `npm run check:frame`.
 *
 * It checks what a Lab built from this template must keep, so that a Lab
 * passes the pipeline checklist without manual fixes. Server-side items
 * (ports, tunnel, DNS, Access, .env on the host) are outside the repo and
 * stay with `/lab-pipeline check`.
 *
 * Exit code 1 on the first group of findings; every finding is printed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const findings = [];
const fail = (msg) => findings.push(msg);
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => existsSync(path.join(root, rel));

// 1. Mandatory files of the frame.
for (const rel of [
  "docker/Dockerfile",
  "docker/docker-compose.yml",
  "docker/compose.staging.yml",
  ".github/workflows/ci.yml",
  ".env.example",
  "messages/de.json",
  "messages/en.json",
  "src/lib/auth.ts",
  "src/lib/jwt-guard.ts",
  "src/middleware.ts",
  "src/instrumentation.ts",
  "src/app/api/health/route.ts",
  "src/app/api/platform/export/route.ts",
  "src/app/api/platform/organisation/route.ts",
  "src/server/services/platform-delete.ts",
  "tests/unit/platform-delete-coverage.test.ts",
  "src/app/api/platform/member/route.ts",
  "src/server/services/platform-delete-member.ts",
  "tests/unit/platform-delete-member-coverage.test.ts",
  "src/app/api/mcp/route.ts",
  "src/app/api/mcp/describe/route.ts",
  "src/app/api/platform/reassign-owner/route.ts",
  "src/lib/platform/on-behalf.ts",
  "src/lib/tool-door/markers.ts",
  "src/lib/tool-door/obo-door.ts",
  "src/lib/tool-door/release-gate.ts",
  "tests/unit/tool-catalog.test.ts",
  // Headless by construction (06.10.2026): the manifest, its parity test and
  // the generated exclusions list.
  "src/server/functions.manifest.ts",
  "src/server/machine-door.ts",
  "tests/unit/parity.test.ts",
  "docs/EXCLUSIONS.md",
  "src/app/icon.png",
  "src/app/apple-icon.png",
  "src/app/favicon.ico",
  "src/app/kein-zugriff/page.tsx",
  "mcp/package.json",
  "mcp/server.mjs",
  "docs/OFFEN.md",
  "README.md",
  // Builder guidance (submission path, 2026-10-08): the template is the
  // teacher for people and for AI agents building a Lab outside Beyondles.
  "CLAUDE.md",
  "AGENTS.md",
  "docs/BUILDING.md",
  "docs/SUBMISSION.md",
  "docs/HANDOVER.md",
  // Lab learnings (Masoud, 30.09.2026): job frame, alert, heartbeat,
  // deletion guards, retention, handover with "Not tested".
  "src/server/jobs/run-job.ts",
  "src/server/jobs/alert.ts",
  "src/server/jobs/heartbeat.ts",
  "src/server/jobs/deletion-guard.ts",
  "src/server/retention/registry.ts",
  "src/server/retention/redaction.ts",
  "tests/unit/jobs.test.ts",
  "tests/unit/retention.test.ts",
  "tests/unit/locale.test.ts",
  "docs/RETENTION.md",
  "docs/HANDOVER.md",
  "src/server/jobs/contract-edges.ts",
  "scripts/contract-check.ts",
  ".github/workflows/contract-check.yml",
  "src/server/jobs/simulation.ts",
  "scripts/simulate.ts",
  "docs/SIMULATION.md",
  "ops/cron/expire-notes.sh",
]) {
  if (!exists(rel)) fail(`missing mandatory file: ${rel}`);
}

// 2. Forbidden files.
for (const rel of ["ecosystem.config.js", ".env", ".env.local"]) {
  if (exists(rel)) fail(`forbidden file in repo: ${rel}`);
}

// 3. CI calls the shared quality gates with the literal job name.
if (exists(".github/workflows/ci.yml")) {
  const ci = read(".github/workflows/ci.yml");
  if (!ci.includes("beyondles-ai/beyondles-ci/quality-gates@v1"))
    fail("ci.yml does not call beyondles-ai/beyondles-ci/quality-gates@v1");
  if (!ci.includes("name: Quality Gates · app"))
    fail('ci.yml job is not named "Quality Gates · app" (required-check context)');
}

// 4. No provider or mail SDK, no provider key, no retired variable.
const pkg = JSON.parse(read("package.json"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
for (const sdk of [
  "@anthropic-ai/sdk",
  "openai",
  "@google/generative-ai",
  "@google/genai",
  "resend",
  "nodemailer",
  "@mistralai/mistralai",
]) {
  if (deps[sdk]) fail(`provider/mail SDK in package.json: ${sdk} (use the platform door)`);
}
if (pkg.scripts?.start && /\bnext start\b/.test(pkg.scripts.start))
  fail('"start" uses `next start` — standalone output needs scripts/start.mjs');

const FORBIDDEN_ENV =
  /\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_[A-Z_]*API_KEY|MISTRAL_API_KEY|DEEPSEEK_API_KEY|RESEND_API_KEY|RESEND_ENDPOINT|MAILER_MODE|SMTP_(HOST|PORT|USER|PASS|PASSWORD)|PLATFORM_SSO_URL)\b/;
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", ".next", "coverage"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const sourceFiles = ["src", "docker", "ops", "scripts", "mcp", ".github"]
  .flatMap((d) => walk(path.join(root, d)))
  .filter((f) => !f.endsWith("check-frame.mjs"))
  .concat([path.join(root, ".env.example")]);

// JWT_SECRET must never be passed by Compose (a server .env must not carry it).
{
  const compose = read("docker/docker-compose.yml");
  for (const name of ["JWT_SECRET", "ALLOW_LOCAL_JWT"]) {
    if (new RegExp(`^\\s+${name}:`, "m").test(compose)) fail(`docker-compose.yml passes ${name} to the container`);
  }
}

// Unknown files at the repo root are almost always a shell mishap (six of
// them once got committed to this template). Everything at the root must be
// on this list.
const ROOT_ALLOWED = new Set([
  ".beyondles-shared.json", ".dockerignore", ".env.example", ".gitattributes", ".gitignore", ".prettierignore", ".prettierrc.json",
  "README.md", "eslint.config.mjs", "next.config.ts", "next-env.d.ts", "package-lock.json", "package.json",
  "postcss.config.mjs", "prisma.config.ts", "tsconfig.json", "tsconfig.tsbuildinfo", "vitest.config.ts",
  "CLAUDE.md", "AGENTS.md", "LICENSE",
  // In a `git worktree` checkout `.git` is a file pointing at the main clone.
  ".git",
]);
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory()) continue;
  if (!ROOT_ALLOWED.has(entry.name)) fail(`unexpected file at the repo root: ${JSON.stringify(entry.name)}`);
}
for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  // Comments may NAME the forbidden variables (that is how the rule is
  // explained); an assignment or a read of them is the finding.
  const hits = text
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line))
    .filter((line) => FORBIDDEN_ENV.test(line));
  if (hits.length > 0)
    fail(`${path.relative(root, file)} uses a forbidden variable: ${hits[0].trim()}`);
}

// 5. Sign-in and platform variables: present in .env.example, no JWT_SECRET
//    as a mandatory line.
const envExample = read(".env.example");
for (const name of [
  "NEXT_PUBLIC_PLATFORM_URL",
  "NEXT_PUBLIC_APP_URL",
  "PLATFORM_API_URL",
  "PLATFORM_API_KEY",
  "PLATFORM_EXPORT_KEY",
]) {
  if (!new RegExp(`^${name}=`, "m").test(envExample))
    fail(`.env.example has no line ${name}=`);
}
if (/^JWT_SECRET=/m.test(envExample) || /^ALLOW_LOCAL_JWT=/m.test(envExample))
  fail(".env.example sets JWT_SECRET/ALLOW_LOCAL_JWT — a server .env must never carry them");

// 5b. The tenant deletion: its own key, passed by Compose, and never the
//     export key. (`.env.example` is checked above for the export key only;
//     the delete key is checked where it reaches the container.)
{
  const compose = read("docker/docker-compose.yml");
  if (!/^\s+PLATFORM_DELETE_KEY:/m.test(compose))
    fail("docker-compose.yml does not pass PLATFORM_DELETE_KEY to the container");
  // Comments may NAME the export key (that is how the rule is explained);
  // reading it is the finding.
  const code = (rel) =>
    read(rel)
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
  if (exists("src/lib/platform-delete-auth.ts") && /PLATFORM_EXPORT_KEY/.test(code("src/lib/platform-delete-auth.ts")))
    fail("platform-delete-auth.ts reads PLATFORM_EXPORT_KEY — deletion needs its own key");
  if (
    exists("src/app/api/platform/organisation/route.ts") &&
    !/export\s+async\s+function\s+DELETE\b/.test(read("src/app/api/platform/organisation/route.ts"))
  )
    fail("src/app/api/platform/organisation/route.ts exports no DELETE handler");
}

// 5c. The on-behalf module is a VERBATIM copy (connection layer contract,
//     stage 6, 2.5). A changed byte means a Lab verifies tokens differently
//     from every other product. Line endings are normalised to LF first, so a
//     Windows checkout with CRLF does not count as a change.
{
  const ON_BEHALF_SHA256 = "25f16f34f9653690f59a5cb3ea89060592c78cc0f88299dd61aed7aa5c5b1175";
  const rel = "src/lib/platform/on-behalf.ts";
  if (exists(rel)) {
    const digest = createHash("sha256").update(read(rel).replace(/\r\n/g, "\n"), "utf8").digest("hex");
    if (digest !== ON_BEHALF_SHA256)
      fail(`${rel} is not the verbatim copy of the contract (sha256 ${digest}, expected ${ON_BEHALF_SHA256})`);
  }
}

// 6. Sign-in never hard-codes the production Suite for /api/auth/me.
for (const file of sourceFiles.filter((f) => /\.tsx?$/.test(f))) {
  const text = readFileSync(file, "utf8");
  if (text.includes("beyondles.ai/api/auth/me"))
    fail(`${path.relative(root, file)} hard-codes the Suite address for /api/auth/me`);
}

// 7. Both languages carry the same keys and no empty text.
const keys = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
const de = JSON.parse(read("messages/de.json"));
const en = JSON.parse(read("messages/en.json"));
const deKeys = keys(de).sort();
const enKeys = keys(en).sort();
if (JSON.stringify(deKeys) !== JSON.stringify(enKeys))
  fail("messages/de.json and messages/en.json do not have the same keys");

// 8. The Lab still carries the template name? The literals are assembled at
//    runtime so `npm run rename` cannot rewrite them (it skips this file too);
//    otherwise the check would switch itself off after the rename.
const TEMPLATE_KEY = ["example", "lab"].join("");
const TEMPLATE_NAME = ["Example", "Lab"].join("");
const IS_TEMPLATE_REPO = pkg.name === TEMPLATE_KEY && /\btemplate\b/.test(pkg.description ?? "");
if (!IS_TEMPLATE_REPO) {
  const pattern = new RegExp(`${TEMPLATE_KEY}|${TEMPLATE_NAME}`);
  const leftovers = walk(root)
    .filter((f) => /\.(ts|tsx|json|yml|md|prisma|sh|mjs)$/.test(f) || path.basename(f) === "Dockerfile")
    .filter((f) => !f.endsWith("rename-lab.mjs") && !f.endsWith("check-frame.mjs"))
    .filter((f) => pattern.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(root, f));
  if (leftovers.length > 0)
    fail(`template name still present in: ${leftovers.slice(0, 10).join(", ")} — run \`npm run rename\``);
  if (pkg.name === TEMPLATE_KEY)
    fail(`package.json still carries the template name "${TEMPLATE_KEY}" — run \`npm run rename\``);
}

// 9. No swallowed failure (lab learnings, rule 2): no empty catch block, no
//    `.catch(() => {})`, no `|| true` in code and scripts. A failure is
//    handled, logged with a reason, or it propagates.
{
  const SWALLOW = [
    [/catch\s*(\([^)]*\))?\s*\{\s*\}/, "empty catch block"],
    [/\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*(\{\s*\}|undefined\s*\))/, "promise error swallowed by .catch"],
    [/\|\|\s*true\b/, "`|| true` hides a failed command"],
  ];
  const generated = [
    `${path.sep}src${path.sep}lib${path.sep}platform-client${path.sep}`,
    `${path.sep}src${path.sep}components${path.sep}share${path.sep}`,
    `${path.sep}node_modules${path.sep}`,
  ];
  const files = ["src", "scripts", "ops", "mcp", "docker"]
    .flatMap((d) => walk(path.join(root, d)))
    .filter((f) => /\.(ts|tsx|mjs|js|sh)$/.test(f) || path.basename(f) === "Dockerfile")
    .filter((f) => !f.endsWith("check-frame.mjs") && !generated.some((g) => f.includes(g)));
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(#|\/\/|\*|\/\*)/.test(line)) return;
        for (const [pattern, what] of SWALLOW) {
          if (pattern.test(line)) fail(`${path.relative(root, file)}:${i + 1}: ${what}`);
        }
      });
  }
}

// 10. Every doc is generated or dated (lab learnings, rule 9): a
//     "Checked on: YYYY-MM-DD" line, or a `<!-- GENERATED` marker (a test
//     compares it with its source). A doc nobody re-read is a doc that lies
//     (it said four assistants, there were three). docs/OFFEN.md stays the
//     ONE open-items file.
for (const file of walk(path.join(root, "docs")).filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(file, "utf8");
  if (!/^Checked on: \d{4}-\d{2}-\d{2}\s*$/m.test(text) && !text.includes("<!-- GENERATED"))
    fail(`${path.relative(root, file)} is neither generated nor has a "Checked on: YYYY-MM-DD" line`);
  if (/^(todo|open|open-items|backlog)\b/i.test(path.basename(file)))
    fail(`${path.relative(root, file)}: open items belong in docs/OFFEN.md only`);
}
if (exists("docs/HANDOVER.md") && !/^## Not tested\s*$/m.test(read("docs/HANDOVER.md")))
  fail('docs/HANDOVER.md has no "## Not tested" section');

// 11. Labs never hold provider keys (lab learnings, rule 10): no
//     PLATFORM_LLM_* setting outside the door client (src/lib/platform/).
//     Model choice and keys live on the platform; a Lab sends useCase/level.
for (const file of sourceFiles) {
  if (file.includes(`${path.sep}src${path.sep}lib${path.sep}platform${path.sep}`)) continue;
  const hit = readFileSync(file, "utf8")
    .split("\n")
    .find((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line) && /\bPLATFORM_LLM_[A-Z0-9_]+/.test(line));
  if (hit) fail(`${path.relative(root, file)} names a PLATFORM_LLM_* setting outside the door client: ${hit.trim()}`);
}

// 12. Third-party images pinned by digest (lab learnings, rule 10). A WARNING,
//     not a failure: renewing a digest is a deliberate act, and the Lab's own
//     images (built here) have no digest to pin.
const warnings = [];
{
  const dockerfile = read("docker/Dockerfile");
  const stages = new Set([...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1].toLowerCase()));
  for (const m of dockerfile.matchAll(/^FROM\s+(\S+)/gim)) {
    if (!stages.has(m[1].toLowerCase()) && !m[1].includes("@sha256:"))
      warnings.push(`docker/Dockerfile: FROM ${m[1]} is not pinned by digest`);
  }
  for (const rel of ["docker/docker-compose.yml", "docker/compose.staging.yml", ".github/workflows/ci.yml"]) {
    if (!exists(rel)) continue;
    for (const m of read(rel).matchAll(/^\s+image:\s*(\S+)/gm)) {
      const own = m[1].startsWith("${") || m[1].startsWith(`${pkg.name}-`);
      if (!own && !m[1].includes("@sha256:")) warnings.push(`${rel}: image ${m[1]} is not pinned by digest`);
    }
  }
}
if (warnings.length > 0) console.warn("Frame check warnings:\n" + warnings.map((w) => `  - ${w}`).join("\n"));

if (findings.length > 0) {
  console.error("Frame check FAILED:\n" + findings.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("Frame check passed.");
