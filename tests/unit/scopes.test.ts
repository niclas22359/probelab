import { describe, expect, it } from "vitest";

import {
  ALL_SCOPES,
  DEFAULT_KEY_SCOPES,
  FULL_ACCESS,
  LAB_SCOPES,
  hasScopes,
  missingScopes,
  normaliseKeyScopes,
  onBehalfScopes,
} from "@/lib/scopes";

/** Scopes on machine credentials: a small generic model, one place for each rule. */

describe("the scope vocabulary", () => {
  it("is read, write and the Lab's own extra scopes", () => {
    expect(ALL_SCOPES).toEqual(["read", "write", ...Object.keys(LAB_SCOPES)]);
    expect(Object.keys(LAB_SCOPES)).toContain("notes:delete");
  });

  it("gives a new key read only", () => {
    expect(DEFAULT_KEY_SCOPES).toEqual(["read"]);
  });

  it("labels every Lab scope in German and English", () => {
    for (const [name, label] of Object.entries(LAB_SCOPES)) {
      expect(label.de.length, name).toBeGreaterThan(0);
      expect(label.en.length, name).toBeGreaterThan(0);
    }
  });
});

describe("hasScopes / missingScopes", () => {
  it("needs every scope asked for; write does not imply read or anything else", () => {
    expect(hasScopes(["read"], ["read"])).toBe(true);
    expect(hasScopes(["write"], ["read"])).toBe(false);
    expect(hasScopes(["read", "write"], ["write", "notes:delete"])).toBe(false);
    expect(missingScopes(["read", "write"], ["write", "notes:delete"])).toEqual(
      ["notes:delete"],
    );
    expect(hasScopes(["read"], [])).toBe(true);
  });

  it("the legacy full-access marker covers every scope, also future ones", () => {
    expect(hasScopes([FULL_ACCESS], ["read", "write", "notes:delete"])).toBe(
      true,
    );
    expect(missingScopes([FULL_ACCESS], ALL_SCOPES)).toEqual([]);
  });

  it("an empty grant covers nothing", () => {
    expect(missingScopes([], ["read"])).toEqual(["read"]);
  });
});

describe("normaliseKeyScopes (what the key form may store)", () => {
  it("keeps known scopes in vocabulary order, without duplicates", () => {
    expect(
      normaliseKeyScopes(["notes:delete", "read", "read", "write"]),
    ).toEqual(["read", "write", "notes:delete"]);
  });

  it("drops unknown values and never stores the legacy marker", () => {
    expect(normaliseKeyScopes(["read", "admin", FULL_ACCESS, 7])).toEqual([
      "read",
    ]);
  });

  it("falls back to read only when nothing usable was chosen", () => {
    expect(normaliseKeyScopes([])).toEqual(["read"]);
    expect(normaliseKeyScopes(["bogus"])).toEqual(["read"]);
  });
});

describe("onBehalfScopes (tokens carry no scopes; this is the one mapping)", () => {
  it("a token that names a person gets read, write and the Lab's extra scopes", () => {
    expect(onBehalfScopes({ personUserId: "u-1" })).toEqual(ALL_SCOPES);
  });

  it("a token without a person (organisation or collection agent) gets read and write only", () => {
    expect(onBehalfScopes({ personUserId: null })).toEqual(["read", "write"]);
  });
});
