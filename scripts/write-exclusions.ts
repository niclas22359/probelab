/**
 * Writes docs/EXCLUSIONS.md from the functions manifest.
 * Run: `npm run docs:exclusions` (after every manifest change; the parity
 * test fails while the file is stale).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { renderExclusions } from "../src/server/exclusions";

const target = path.resolve(__dirname, "..", "docs", "EXCLUSIONS.md");
writeFileSync(target, renderExclusions(), "utf8");
console.log(`Wrote ${path.relative(process.cwd(), target)}`);
