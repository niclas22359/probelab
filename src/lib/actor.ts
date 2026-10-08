import type { ApiKeyContext } from "@/lib/api-auth";
import type { AccessContext } from "@/lib/platform/access";
import { ALL_SCOPES, type GrantedScopes } from "@/lib/scopes";

/**
 * WHO acts, and THROUGH WHICH DOOR. Every service function takes an actor;
 * the doors only build it.
 *
 *   ui         a person in the screen (Suite cookie; server action or page)
 *   api-key    a USER key of this Lab: acts as the person who created it
 *   on-behalf  another Beyondles product with a platform-signed token
 *              (a person, a private agent's owner, or nobody)
 *   worker     a WORKER key of this Lab: nobody behind it, organisation rows only
 *
 * "No person" is decided HERE and nowhere else: `personUserId` is `null` for
 * a worker key and for a token without a person (organisation or collection
 * agent). The container default and the audit form follow from it.
 */

export type Door = "ui" | "api-key" | "on-behalf" | "worker";

export interface Actor {
  door: Door;
  organisationId: string;
  access: AccessContext;
  /** The person on whose behalf this happens, or `null` = nobody. */
  personUserId: string | null;
  /** The person's Suite token (screen only): the strongest audit form. */
  sessionToken: string | null;
  /** What the credential may do. People in the screen hold every scope; their limit is the container rule. */
  scopes: GrantedScopes;
  /** For logs: key id, `obo:<jti>` or `session`. */
  credentialId: string;
  /** The calling product of an on-behalf token, else `null`. */
  callingProduct: string | null;
}

export function uiActor(ctx: {
  access: AccessContext;
  organisationId: string;
  token: string | null;
}): Actor {
  return {
    door: "ui",
    organisationId: ctx.organisationId,
    access: ctx.access,
    personUserId: ctx.access.userId || null,
    sessionToken: ctx.token,
    scopes: [...ALL_SCOPES],
    credentialId: "session",
    callingProduct: null,
  };
}

export function machineActor(key: ApiKeyContext): Actor {
  const door: Door =
    key.via === "on-behalf"
      ? "on-behalf"
      : key.kind === "worker"
        ? "worker"
        : "api-key";
  return {
    door,
    organisationId: key.organisationId,
    access: key.access,
    personUserId:
      door === "worker"
        ? null
        : key.access.userId || key.createdByUserId || null,
    sessionToken: null,
    scopes: key.scopes,
    credentialId: key.keyId,
    callingProduct: key.onBehalf?.callingProduct ?? null,
  };
}
