import { describe, expect, it } from "vitest";

import { assertProductionEnvSane, isLocalMode, localJwtSecret } from "@/lib/jwt-guard";

describe("jwt-guard", () => {
  it("returns no secret when JWT_SECRET is empty", () => {
    expect(localJwtSecret({})).toBeNull();
    expect(localJwtSecret({ JWT_SECRET: "  " })).toBeNull();
  });

  it("ignores the secret without ALLOW_LOCAL_JWT=true", () => {
    expect(localJwtSecret({ JWT_SECRET: "x" })).toBeNull();
    expect(localJwtSecret({ JWT_SECRET: "x", ALLOW_LOCAL_JWT: "TRUE" })).toBeNull();
    expect(localJwtSecret({ JWT_SECRET: "x", ALLOW_LOCAL_JWT: "1" })).toBeNull();
  });

  it("uses the secret only with the exact switch", () => {
    expect(localJwtSecret({ JWT_SECRET: "x", ALLOW_LOCAL_JWT: "true" })).toBe("x");
    expect(isLocalMode({ JWT_SECRET: "x", ALLOW_LOCAL_JWT: "true" })).toBe(true);
    expect(isLocalMode({ JWT_SECRET: "x" })).toBe(false);
  });

  it("refuses to start a production process that carries JWT_SECRET", () => {
    expect(() => assertProductionEnvSane({ NODE_ENV: "production", JWT_SECRET: "x" })).toThrow(/JWT_SECRET/);
  });

  it("starts a production process without the secret", () => {
    expect(() => assertProductionEnvSane({ NODE_ENV: "production" })).not.toThrow();
  });

  it("does not throw outside production (development, CI)", () => {
    expect(() => assertProductionEnvSane({ NODE_ENV: "test", JWT_SECRET: "x" })).not.toThrow();
  });
});
