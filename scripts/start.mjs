/**
 * Starts the production server from the standalone bundle (local use and
 * non-Docker hosts). Inside the Docker image `server.js` is started directly.
 *
 * `next build` with `output: "standalone"` writes a self-contained Node server
 * to `.next/standalone`, but NOT the static files: `.next/static` and `public`
 * must sit next to it. This script copies them and then starts the server.
 * `next start` does not work with `output: "standalone"`.
 */
import { config as loadEnv } from "dotenv";
import { cpSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

// The standalone server does not read .env files by itself. Already set
// variables win; then .env.local; then .env.
for (const file of [".env.local", ".env"]) {
  const full = path.join(root, file);
  if (existsSync(full)) loadEnv({ path: full });
}

if (!existsSync(standalone)) {
  console.error("[start] .next/standalone is missing — run `npm run build` first.");
  process.exit(1);
}

cpSync(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), {
  recursive: true,
});
if (existsSync(path.join(root, "public"))) {
  cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
}

const port = process.env.PORT ?? "3390";
// Loopback only: public access goes through the Cloudflare tunnel. Override
// with HOSTNAME when running behind a proxy in another network namespace.
const hostname = process.env.HOSTNAME ?? "127.0.0.1";

const server = spawn(process.execPath, [path.join(standalone, "server.js")], {
  stdio: "inherit",
  env: { ...process.env, PORT: port, HOSTNAME: hostname },
});

server.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
