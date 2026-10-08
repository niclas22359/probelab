import { afterEach, describe, expect, it, vi } from "vitest";

import { checkDeleteKey } from "@/lib/platform-delete-auth";

function request(key?: string): Request {
  return new Request(
    "http://lab.test/api/platform/organisation?organisationId=x",
    {
      method: "DELETE",
      headers: key === undefined ? {} : { "x-api-key": key },
    },
  );
}

describe("delete key", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is CLOSED when PLATFORM_DELETE_KEY is unset (503, never open)", () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "");
    const r = checkDeleteKey(request("anything"));
    expect(r).toMatchObject({
      ok: false,
      status: 503,
      code: "DELETE_NOT_CONFIGURED",
    });
  });

  it("does NOT fall back to the export key", () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "");
    vi.stubEnv("PLATFORM_EXPORT_KEY", "export-key");
    expect(checkDeleteKey(request("export-key"))).toMatchObject({
      ok: false,
      status: 503,
    });
  });

  it("refuses the export key when both keys are set", () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "delete-key");
    vi.stubEnv("PLATFORM_EXPORT_KEY", "export-key");
    expect(checkDeleteKey(request("export-key"))).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("answers 401 for missing, wrong and wrong-length keys", () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "correct-key");
    expect(checkDeleteKey(request())).toMatchObject({ ok: false, status: 401 });
    expect(checkDeleteKey(request("wrong-key!!"))).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(checkDeleteKey(request("x"))).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("accepts the right key", () => {
    vi.stubEnv("PLATFORM_DELETE_KEY", "correct-key");
    expect(checkDeleteKey(request("correct-key"))).toEqual({ ok: true });
  });
});
