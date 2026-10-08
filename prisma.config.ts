import "dotenv/config";
import path from "node:path";
import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7: the database URL lives here for the CLI (`prisma migrate`,
 * `prisma generate`). At runtime the client connects through the pg driver
 * adapter in `src/lib/db.ts`. `dotenv/config` loads `.env` because the
 * Prisma CLI no longer does that by itself.
 */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: { path: path.join("prisma", "migrations") },
  datasource: { url: env("DATABASE_URL") },
});
