import { afterEach, describe, expect, it, vi } from "vitest";

import { checkExportKey, exportKeyEquals } from "@/lib/platform-export-auth";

function request(key?: string): Request {
  return new Request("http://lab.test/api/platform/export?organisationId=x", {
    headers: key === undefined ? {} : { "x-api-key": key },
  });
}

describe("export key", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is CLOSED when PLATFORM_EXPORT_KEY is unset (503, never open)", () => {
    vi.stubEnv("PLATFORM_EXPORT_KEY", "");
    const r = checkExportKey(request("anything"));
    expect(r).toMatchObject({ ok: false, status: 503, code: "EXPORT_NOT_CONFIGURED" });
  });

  it("answers 401 for missing, wrong and wrong-length keys", () => {
    vi.stubEnv("PLATFORM_EXPORT_KEY", "correct-key");
    expect(checkExportKey(request())).toMatchObject({ ok: false, status: 401 });
    expect(checkExportKey(request("wrong-key!!"))).toMatchObject({ ok: false, status: 401 });
    expect(checkExportKey(request("x"))).toMatchObject({ ok: false, status: 401 });
  });

  it("accepts the right key", () => {
    vi.stubEnv("PLATFORM_EXPORT_KEY", "correct-key");
    expect(checkExportKey(request("correct-key"))).toEqual({ ok: true });
  });

  it("compares in constant time without throwing on unequal length", () => {
    expect(() => exportKeyEquals("a", "much-longer-value")).not.toThrow();
    expect(exportKeyEquals("a", "much-longer-value")).toBe(false);
    expect(exportKeyEquals("same", "same")).toBe(true);
  });
});
