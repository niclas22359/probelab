import {
  apiJson,
  readJson,
  withErrorEnvelope,
  zodToApiError,
} from "@/lib/api-errors";
import { realJobDeps } from "@/server/jobs/jobs";
import { runJob } from "@/server/jobs/run-job";
import { openMachineDoor } from "@/server/machine-door";
import { expireNotesSchema } from "@/server/schemas/notes";
import { expireNotes } from "@/server/services/notes";

/**
 * WORKER-TRIGGERED ROUTE (docs/FRAME.md 5, "Worker routes").
 *   POST /api/v1/worker/expire-notes  { "olderThanDays": 365, "dryRun": false }
 * Called by a scheduler (cron on the host, a platform job) with a WORKER key
 * of this Lab that carries `write` and `notes:delete`. A USER key, an
 * on-behalf token or a missing scope is refused by `openMachineDoor`.
 * REST only by design: no screen, no MCP tool (see the manifest).
 * All worker routes live under `/api/v1/worker/`.
 *
 * The pattern every Lab copies: the work runs through the job frame
 * (`runJob`: one completion line, `job_runs` heartbeat state, ops alert when
 * incomplete) and the service asks the deletion guard before it deletes.
 * Dry run unless the body says `"dryRun": false`, so every SCHEDULED caller
 * sends it explicitly (the template's caller: ops/cron/expire-notes.sh).
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return withErrorEnvelope(async () => {
    const actor = await openMachineDoor(request, "expireNotes");
    const parsed = expireNotesSchema.safeParse(await readJson(request));
    if (!parsed.success) throw zodToApiError(parsed.error);
    let output: Awaited<ReturnType<typeof expireNotes>> | undefined;
    let failure: unknown;
    await runJob(
      "expire-notes",
      async () => {
        try {
          output = await expireNotes(actor, parsed.data);
        } catch (error) {
          failure = error;
          throw error;
        }
        return { counts: { expired: output.expired, deleted: output.deleted, dry_run: output.dryRun ? 1 : 0 } };
      },
      realJobDeps(),
    );
    // The frame logged and alerted; the caller still gets the real error.
    if (failure !== undefined || !output) throw failure ?? new Error("expire-notes produced no result");
    return apiJson({ data: output });
  });
}
