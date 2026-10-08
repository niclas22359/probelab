import "server-only";

import { readDoorConfig } from "@/lib/platform/door";
import { purposeFor } from "@/lib/platform/llm";

/**
 * The mail door of the platform: `POST /api/mail/send`.
 *
 * WHY NOT SEND YOURSELF: the platform resolves the sender against the
 * organisation's VERIFIED mail domains, books every message, deduplicates via
 * `idempotencyKey` in a 24 h window and receives the provider's delivery
 * events. Rebuilding that in a Lab means a second place holding a mail key.
 *
 * NEVER REPEAT A SEND WITHOUT AN `idempotencyKey`. A timeout does not mean
 * "not sent" — the platform may already have handed the mail to the
 * provider. Build the key from something stable (`<recordId>:<kind>`, not a
 * timestamp), at most 128 characters. With a key a network error may be
 * retried; without one this function makes exactly ONE attempt.
 *
 * NEVER THROWS. An error comes back as a result so the caller can leave its
 * record untouched and try again in the next run.
 */

export interface MailAddress {
  email: string;
  name?: string;
}

export interface MailRequest {
  organisationId: string;
  /** The action part; the Lab key is prefixed automatically. */
  action: string;
  to: MailAddress[];
  subject: string;
  text?: string;
  html?: string;
  idempotencyKey: string;
  replyTo?: MailAddress;
  from?: MailAddress;
  /** Fail with 403 instead of sending "via Beyondles" from an unverified domain. */
  strictFrom?: boolean;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
}

export type MailResult =
  | { ok: true; messageId: string | null; mode: string | null }
  | { ok: false; status: number; code: string; message: string };

const TIMEOUT_MS = 15_000;

export async function sendMail(
  request: MailRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<MailResult> {
  const config = readDoorConfig();
  if (!config) {
    return { ok: false, status: 503, code: "DOOR_NOT_CONFIGURED", message: "The platform door is not configured." };
  }
  if (!request.idempotencyKey || request.idempotencyKey.length > 128) {
    return { ok: false, status: 400, code: "VALIDATION", message: "idempotencyKey is required (1–128 characters)." };
  }

  const attempts = 2; // one retry on a network error — the key makes it safe
  let last: MailResult = { ok: false, status: 0, code: "NETWORK", message: "no attempt made" };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res: Response;
    try {
      res = await fetchImpl(`${config.baseUrl}/api/mail/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
        body: JSON.stringify({
          organisationId: request.organisationId,
          purpose: purposeFor(request.action),
          to: request.to,
          subject: request.subject,
          text: request.text,
          html: request.html,
          idempotencyKey: request.idempotencyKey,
          replyTo: request.replyTo,
          from: request.from,
          strictFrom: request.strictFrom,
          headers: request.headers,
          metadata: request.metadata,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      last = { ok: false, status: 0, code: "NETWORK", message: error instanceof Error ? error.message : "network error" };
      continue;
    }

    const envelope = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: { messageId?: unknown; mode?: unknown }; error?: { code?: string; message?: string } }
      | null;

    if (res.ok && envelope?.success === true) {
      const id = envelope.data?.messageId;
      const mode = envelope.data?.mode;
      return {
        ok: true,
        messageId: typeof id === "string" ? id : null,
        mode: typeof mode === "string" ? mode : null,
      };
    }
    last = {
      ok: false,
      status: res.status,
      code: envelope?.error?.code ?? `HTTP_${res.status}`,
      message: envelope?.error?.message ?? `The platform answered HTTP ${res.status}.`,
    };
    // 429/503: the platform itself answered, it had not sent. Everything
    // else is final.
    if (res.status !== 429 && res.status !== 503) return last;
  }
  return last;
}
