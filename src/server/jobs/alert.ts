import { sendMail, type MailResult } from "@/lib/platform/mail";
import { LAB_KEY } from "@/lib/lab";
import { completionLine, type JobResult } from "@/server/jobs/run-job";

/**
 * Ops alert through the platform mail door (lab learnings, rule 3).
 *
 * WHY: the nightly retention job of a Lab could stop and nobody would know;
 * the alarm was built four weeks after handover. Every Lab has this path
 * BEFORE its first nightly job.
 *
 * The mail goes through `POST /api/mail/send` like every other mail of a Lab
 * (no mail key here). It is booked to `OPS_ALERT_ORGANISATION_ID` (the
 * Beyondles organisation on the platform) and goes to `OPS_ALERT_EMAIL`
 * (alerts@beyondles.ai). The idempotency key holds the hour, so a job that
 * fails every minute sends one mail per hour, not sixty.
 *
 * NEVER THROWS, NEVER SILENT: when the alert itself cannot go out, that is
 * written to stderr as `alert=failed` so the log still shows it.
 */

export interface AlertConfig {
  email: string;
  organisationId: string;
}

export function readAlertConfig(): AlertConfig | null {
  const email = process.env.OPS_ALERT_EMAIL?.trim();
  const organisationId = process.env.OPS_ALERT_ORGANISATION_ID?.trim();
  return email && organisationId ? { email, organisationId } : null;
}

export interface AlertMessage {
  /** Stable identifier of what failed: a job name or a contract edge. */
  source: string;
  /** One line, counts and codes only. */
  summary: string;
}

type Send = (request: Parameters<typeof sendMail>[0]) => Promise<MailResult>;

export async function sendOpsAlert(
  message: AlertMessage,
  deps: { send?: Send; config?: AlertConfig | null; now?: Date; warn?: (line: string) => void } = {},
): Promise<boolean> {
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const config = deps.config === undefined ? readAlertConfig() : deps.config;
  if (!config) {
    warn(`alert=failed source=${message.source} code=ALERT_NOT_CONFIGURED`);
    return false;
  }
  const hour = (deps.now ?? new Date()).toISOString().slice(0, 13);
  const result = await (deps.send ?? sendMail)({
    organisationId: config.organisationId,
    action: "ops-alert",
    to: [{ email: config.email }],
    subject: `[${LAB_KEY}] ${message.source} failed`,
    text: `${message.summary}\n\nLab: ${LAB_KEY}\nTime: ${hour}:00 UTC\n`,
    idempotencyKey: `alert:${message.source}:${hour}`.slice(0, 128),
  });
  if (!result.ok) {
    warn(`alert=failed source=${message.source} code=${result.code}`);
    return false;
  }
  return true;
}

/** The `alert` dependency of `runJob`. */
export async function alertJobFailure(result: JobResult): Promise<void> {
  await sendOpsAlert({ source: `job:${result.name}`, summary: completionLine(result) });
}
