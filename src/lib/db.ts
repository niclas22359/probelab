import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Prisma client as a LAZY singleton.
 *
 * Importing `{ db }` must NOT throw even when `DATABASE_URL` is missing —
 * otherwise every module that (transitively) imports it crashes before any
 * query, and `next build` in CI (no database) with it. `db` is therefore a
 * proxy; the real client is created on the first property access.
 */

export const DEFAULT_POOL_MAX = 25;

/** An empty or unusable `DATABASE_POOL_MAX` is the default, never 0. */
export function poolMax(raw: string | undefined = process.env.DATABASE_POOL_MAX): number {
  const value = raw?.trim() ?? "";
  if (value.length === 0) return DEFAULT_POOL_MAX;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_POOL_MAX;
  return n;
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Create a .env following .env.example.");
  }
  const adapter = new PrismaPg({ connectionString, max: poolMax() });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) globalForPrisma.prisma = createPrismaClient();
  return globalForPrisma.prisma;
}

export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrisma();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, prop) {
    return Reflect.has(getPrisma(), prop);
  },
  set(_target, prop, value) {
    return Reflect.set(getPrisma(), prop, value);
  },
});

export default db;
