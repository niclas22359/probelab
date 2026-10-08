import { createPrivateKey, sign as signBytes } from "node:crypto";

import vectors from "../fixtures/on-behalf-vectors.json";

/**
 * Test helpers for on-behalf tokens. They sign with the TEST key pair of the
 * contract vectors (section 1.7), which protects nothing and is never
 * configured on a server.
 */

export const TEST_ISSUER = vectors.issuer;
export const PLATFORM = "https://platform.test";
export const JWKS_URL = `${PLATFORM}/api/on-behalf/jwks`;

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export interface TestClaims {
  iss?: string;
  aud: string;
  cp?: string;
  org: string;
  sub?: string;
  role?: "owner" | "admin" | "member";
  agt?: { id: string; level: "private" | "collection" | "organisation"; owner?: string; col?: string };
  jti?: string;
  iat?: number;
  exp?: number;
}

let counter = 0;

/** A fresh token for now (or `iat`), claim order as the platform writes it. */
export function signToken(input: TestClaims): string {
  counter += 1;
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { iss: input.iss ?? TEST_ISSUER, aud: input.aud, cp: input.cp ?? "horaizon", org: input.org };
  if (input.sub) {
    claims.sub = input.sub;
    claims.role = input.role ?? "member";
  }
  if (input.agt) claims.agt = input.agt;
  claims.jti = input.jti ?? `aaaaaaaa-aaaa-4aaa-8aaa-${String(counter).padStart(12, "0")}`;
  claims.iat = iat;
  claims.exp = input.exp ?? iat + 300;

  const key = createPrivateKey({ key: Buffer.from(vectors.privateKey, "base64url"), format: "der", type: "pkcs8" });
  const header = { alg: "EdDSA", typ: "beyondles-obo+jwt", kid: vectors.keyId };
  const signingInput = `${encode(header)}.${encode(claims)}`;
  return `${signingInput}.${signBytes(null, Buffer.from(signingInput, "ascii"), key).toString("base64url")}`;
}

/** The platform's key document, as `GET /api/on-behalf/jwks` answers it. */
export function keyDocument(): unknown {
  return vectors.keyDocument;
}
