import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { chooseContainer } from "@/lib/access-rules";
import { machineActor, uiActor, type Actor } from "@/lib/actor";
import { ApiError } from "@/lib/api-errors";
import type { ApiKeyContext } from "@/lib/api-auth";
import { auditActorOf } from "@/lib/audit";
import {
  agentAccessContext,
  apiKeyAccessContext,
  workerAccessContext,
} from "@/lib/platform/access";
import { ALL_SCOPES } from "@/lib/scopes";
import {
  ServiceError,
  actionErrorCode,
  toApiError,
  toToolResult,
  toolErrorFromHttp,
} from "@/lib/service-errors";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const person = apiKeyAccessContext({
  organisationId: ORG,
  createdByUserId: USER,
});
const worker = workerAccessContext(ORG);

function key(over: Partial<ApiKeyContext>): ApiKeyContext {
  return {
    organisationId: ORG,
    keyId: "k-1",
    keyName: "k",
    createdByUserId: USER,
    kind: "user",
    access: person,
    via: "api-key",
    onBehalf: null,
    scopes: ["read"],
    ...over,
  };
}

describe("chooseContainer", () => {
  it("defaults to private for a person", () => {
    expect(chooseContainer(person, undefined)).toEqual({
      visibility: "PRIVATE",
      collectionId: null,
    });
  });

  it("refuses the default when nobody acts", () => {
    expect(() => chooseContainer(worker, undefined)).toThrow(ServiceError);
    try {
      chooseContainer(worker, undefined);
    } catch (e) {
      expect((e as ServiceError).code).toBe("container_required");
    }
  });

  it("checks an explicit wish against the allowed containers", () => {
    expect(chooseContainer(worker, "organisation")).toEqual({
      visibility: "ORGANISATION",
      collectionId: null,
    });
    expect(() => chooseContainer(worker, "private")).toThrow(
      /may not use the container 'private'/,
    );
  });

  it("puts a collection agent's rows into its collection, and refuses any wish", () => {
    const agent = agentAccessContext(ORG, "col-1");
    expect(chooseContainer(agent, undefined)).toEqual({
      visibility: "COLLECTION",
      collectionId: "col-1",
    });
    expect(() => chooseContainer(agent, "organisation")).toThrow(ServiceError);
  });
});

describe("the actor and its audit form", () => {
  it("screen: the person's token; all scopes", () => {
    const actor = uiActor({
      access: person,
      organisationId: ORG,
      token: "tok",
    });
    expect(actor).toMatchObject({ door: "ui", personUserId: USER });
    expect(actor.scopes).toEqual(ALL_SCOPES);
    expect(auditActorOf(actor)).toEqual({ token: "tok" });
  });

  it("screen without a token (local mode): the person by id", () => {
    expect(
      auditActorOf(
        uiActor({ access: person, organisationId: ORG, token: null }),
      ),
    ).toEqual({ actorUserId: USER });
  });

  it("USER key: the creator", () => {
    const actor = machineActor(key({}));
    expect(actor.door).toBe("api-key");
    expect(auditActorOf(actor)).toEqual({ actorUserId: USER });
  });

  it("WORKER key: nobody, so System", () => {
    const actor = machineActor(
      key({ kind: "worker", createdByUserId: null, access: worker }),
    );
    expect(actor).toMatchObject({ door: "worker", personUserId: null });
    expect(auditActorOf(actor)).toEqual({ system: true });
  });

  it("on-behalf token: the named person, or System without one", () => {
    const onBehalf = {
      callingProduct: "horaizon",
      userId: USER,
      role: "member" as const,
      agent: null,
      tokenId: "j",
      issuedAt: new Date(),
    };
    const withPerson = machineActor(key({ via: "on-behalf", onBehalf }));
    expect(withPerson).toMatchObject({
      door: "on-behalf",
      callingProduct: "horaizon",
    });
    expect(auditActorOf(withPerson)).toEqual({ actorUserId: USER });
    const nobody: Actor = machineActor(
      key({
        via: "on-behalf",
        kind: "worker",
        createdByUserId: null,
        access: worker,
        onBehalf: { ...onBehalf, userId: null },
      }),
    );
    expect(nobody.personUserId).toBeNull();
    expect(auditActorOf(nobody)).toEqual({ system: true });
  });
});

describe("the one error mapping", () => {
  it("service error -> HTTP", () => {
    expect(toApiError(new ServiceError("not_found", "Gone."))).toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(toApiError(new ServiceError("forbidden", "No."))).toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(
      toApiError(new ServiceError("container_required", "Name it.")),
    ).toMatchObject({
      status: 400,
      code: "invalid_request",
    });
  });

  it("service error -> tool text equals the text from the HTTP answer", () => {
    const direct = toToolResult(
      new ServiceError("not_found", "Note not found."),
    );
    const viaHttp = toolErrorFromHttp(
      404,
      JSON.stringify({
        error: { code: "not_found", message: "Note not found." },
      }),
    );
    expect(direct).toEqual(viaHttp);
    expect(direct.content[0].text).toBe(
      "not_found (HTTP 404): Note not found.",
    );
  });

  it("anything unexpected stays opaque", () => {
    expect(toToolResult(new Error("db password is x")).content[0].text).toBe(
      "internal_error (HTTP 500): Unexpected error.",
    );
    expect(
      toolErrorFromHttp(502, "<html>bad gateway</html>").content[0].text,
    ).toBe("http_error (HTTP 502): <html>bad gateway</html>");
  });

  it("service error -> screen code", () => {
    expect(actionErrorCode(new ServiceError("forbidden", "x"))).toBe(
      "forbidden",
    );
    expect(actionErrorCode(new ApiError(429, "rate_limited", "x"))).toBe(
      "rate_limited",
    );
    expect(actionErrorCode(new Error("x"))).toBe("internal_error");
  });
});
