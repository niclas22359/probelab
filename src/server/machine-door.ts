import "server-only";

import { machineActor, type Actor } from "@/lib/actor";
import { requireApiKey, requireScope } from "@/lib/api-auth";
import { ApiError } from "@/lib/api-errors";
import { FUNCTIONS, type FunctionId } from "@/server/functions.manifest";

/**
 * The machine door for ONE function: the credential (key or on-behalf token,
 * release gate, rate limit), the function's scopes from the manifest, the
 * worker-only rule for worker-triggered functions, and the `Actor`.
 *
 * Every `/api/v1` route calls this with the id of the function it serves
 * (the parity test checks the id against the manifest). A tool that calls a
 * service directly (allowed, docs/FRAME.md 5) calls it too.
 */
export async function openMachineDoor(
  request: Request,
  fn: FunctionId,
): Promise<Actor> {
  const entry = FUNCTIONS[fn];
  const key = await requireApiKey(request);
  if (
    "trigger" in entry &&
    entry.trigger === "worker" &&
    !(key.via === "api-key" && key.kind === "worker")
  ) {
    throw new ApiError(
      403,
      "worker_only",
      "This route runs scheduled work and accepts a WORKER key of this Lab only.",
    );
  }
  requireScope(key, entry.scopes);
  return machineActor(key);
}
