import "server-only";

import { createSuiteClient } from "@/lib/platform-client/core/suite";
import type { LabGate } from "@/lib/platform-client/core/types";
import { LAB_KEY } from "@/lib/lab";
import { localJwtActive, platformUrl } from "@/lib/platform/door";

/**
 * Access model, LEVEL 1 — the release switch, which lives in the Suite.
 *
 * Every Lab has a row in the Suite table `labs` with `enabled` (default OFF)
 * and two exception lists (e-mail addresses and organisations). While the Lab
 * is not released, NOBODY gets in, not even an owner, unless they or their
 * organisation are on a list. The Lab asks `GET <suite>/api/labs/<LAB_KEY>/access`
 * with the person's cookie, caches clear answers 60 s per token hash, and
 * treats a network error or an unreadable answer as CLOSED (never cached).
 *
 * Without the Suite row the Suite answers 404 and the Lab is closed for all —
 * on purpose (fail closed). Order for a new Lab: Suite row FIRST, then roll
 * out.
 *
 * Local mode (JWT_SECRET + ALLOW_LOCAL_JWT): there is no Suite, the gate is
 * open.
 *
 * The client is the shared one of beyondles-ai/beyondles-shared
 * (`core/suite.ts`); this file configures it for this Lab.
 */

export type { GateReason, LabGate } from "@/lib/platform-client/core/types";

const suite = createSuiteClient({
  labKey: LAB_KEY,
  suiteUrl: () => platformUrl() ?? "",
  local: () => localJwtActive(),
});

const UNREACHABLE: LabGate = { allowed: false, reason: "unreachable", lab: null };

export async function getLabGate(token: string): Promise<LabGate> {
  // Without a Suite address there is nobody to ask: closed, nothing is sent.
  if (!localJwtActive() && !platformUrl()) return { ...UNREACHABLE };
  return suite.gate(token);
}

/** Tests only. */
export function __clearGateCacheForTests(): void {
  suite.clear();
}
