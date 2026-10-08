#!/usr/bin/env node
/**
 * Local development without a Suite: mints a `platform-auth-token` cookie
 * that `src/lib/auth.ts` accepts in LOCAL mode (JWT_SECRET set and
 * ALLOW_LOCAL_JWT=true). Prints a `document.cookie` line to paste into the
 * browser console on http://localhost:3390.
 *
 * Never usable against a server: there JWT_SECRET does not exist, and a
 * production process refuses to start with it (src/lib/jwt-guard.ts).
 *
 *   node scripts/dev-login.mjs [email] [organisationId] [role]
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) loadEnv({ path: file });
}

const secret = process.env.JWT_SECRET;
if (!secret || process.env.ALLOW_LOCAL_JWT !== "true") {
  console.error(
    "[dev-login] JWT_SECRET and ALLOW_LOCAL_JWT=true must be set in .env (local development only).",
  );
  process.exit(1);
}

const email = process.argv[2] ?? "dev@example.com";
const organisationId = process.argv[3] ?? "11111111-1111-4111-8111-111111111111";
const role = process.argv[4] ?? "owner";

const token = jwt.sign(
  {
    type: "access",
    userId: "dev-user-1",
    email,
    name: "Dev User",
    role,
    organisationId,
    organisationSlug: "dev-org",
  },
  secret,
  { issuer: "company-brain", audience: "brain-app", expiresIn: "12h" },
);

console.log(`document.cookie = "platform-auth-token=${token}; path=/";`);
