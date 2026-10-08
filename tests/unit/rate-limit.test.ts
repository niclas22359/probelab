import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RATE_LIMIT_DEFAULTS,
  __resetRateLimitForTests,
  checkRateLimit,
  createMemoryStore,
  rateLimitFor,
  setRateLimitStore,
  type RateLimitStore,
} from "@/lib/rate-limit";

afterEach(() => {
  vi.unstubAllEnvs();
  __resetRateLimitForTests();
});

describe("createMemoryStore (fixed one-minute window)", () => {
  it("allows up to the limit, then refuses with the seconds until the window ends", () => {
    const store = createMemoryStore();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++)
      expect(store.hit("k", 3, 60_000, t0 + i).allowed).toBe(true);
    const refused = store.hit("k", 3, 60_000, t0 + 15_000);
    expect(refused).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 45,
    });
  });

  it("starts a new window after the old one ended", () => {
    const store = createMemoryStore();
    for (let i = 0; i < 4; i++) store.hit("k", 3, 60_000, 0);
    expect(store.hit("k", 3, 60_000, 60_000).allowed).toBe(true);
  });

  it("keeps buckets apart", () => {
    const store = createMemoryStore();
    for (let i = 0; i < 3; i++) store.hit("a", 3, 60_000, 0);
    expect(store.hit("a", 3, 60_000, 1).allowed).toBe(false);
    expect(store.hit("b", 3, 60_000, 1).allowed).toBe(true);
  });

  it("forgets expired buckets when it grows past its cap", () => {
    const store = createMemoryStore(2);
    store.hit("a", 1, 60_000, 0);
    store.hit("b", 1, 60_000, 0);
    store.hit("c", 1, 60_000, 120_000); // a and b expired: swept
    expect(store.hit("a", 1, 60_000, 120_001).allowed).toBe(true);
  });
});

describe("rateLimitFor (defaults, env-tunable)", () => {
  it("has the documented defaults", () => {
    expect(RATE_LIMIT_DEFAULTS).toEqual({ v1: 120, mcp: 60, onBehalf: 600 });
    expect(rateLimitFor("v1", "key", {})).toBe(120);
    expect(rateLimitFor("mcp", "key", {})).toBe(60);
    expect(rateLimitFor("v1", "on-behalf", {})).toBe(600);
    expect(rateLimitFor("mcp", "on-behalf", {})).toBe(600);
  });

  it("reads the three variables; empty or garbage keeps the default; 0 switches the limit off", () => {
    expect(
      rateLimitFor("v1", "key", { API_RATE_LIMIT_PER_MINUTE: "300" }),
    ).toBe(300);
    expect(
      rateLimitFor("mcp", "key", { MCP_RATE_LIMIT_PER_MINUTE: "10" }),
    ).toBe(10);
    expect(
      rateLimitFor("v1", "on-behalf", {
        ON_BEHALF_RATE_LIMIT_PER_MINUTE: "50",
      }),
    ).toBe(50);
    expect(rateLimitFor("v1", "key", { API_RATE_LIMIT_PER_MINUTE: "" })).toBe(
      120,
    );
    expect(
      rateLimitFor("v1", "key", { API_RATE_LIMIT_PER_MINUTE: "lots" }),
    ).toBe(120);
    expect(rateLimitFor("v1", "key", { API_RATE_LIMIT_PER_MINUTE: "0" })).toBe(
      0,
    );
  });
});

describe("checkRateLimit", () => {
  it("counts per door and per subject", () => {
    vi.stubEnv("API_RATE_LIMIT_PER_MINUTE", "2");
    vi.stubEnv("MCP_RATE_LIMIT_PER_MINUTE", "2");
    const now = 5_000;
    expect(
      checkRateLimit({ door: "v1", credential: "key", subject: "key:1", now })
        .allowed,
    ).toBe(true);
    expect(
      checkRateLimit({ door: "v1", credential: "key", subject: "key:1", now })
        .allowed,
    ).toBe(true);
    expect(
      checkRateLimit({ door: "v1", credential: "key", subject: "key:1", now })
        .allowed,
    ).toBe(false);
    expect(
      checkRateLimit({ door: "mcp", credential: "key", subject: "key:1", now })
        .allowed,
    ).toBe(true);
    expect(
      checkRateLimit({ door: "v1", credential: "key", subject: "key:2", now })
        .allowed,
    ).toBe(true);
  });

  it("a limit of 0 never refuses", () => {
    vi.stubEnv("API_RATE_LIMIT_PER_MINUTE", "0");
    for (let i = 0; i < 500; i++) {
      expect(
        checkRateLimit({ door: "v1", credential: "key", subject: "key:1" })
          .allowed,
      ).toBe(true);
    }
  });

  it("uses a replaced store (the seam for a shared store)", () => {
    const hit = vi.fn<RateLimitStore["hit"]>(() => ({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 7,
    }));
    setRateLimitStore({ hit });
    expect(
      checkRateLimit({
        door: "mcp",
        credential: "on-behalf",
        subject: "cp:x:org",
        now: 1,
      }),
    ).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 7,
    });
    expect(hit).toHaveBeenCalledWith("mcp|cp:x:org", 600, 60_000, 1);
  });
});
