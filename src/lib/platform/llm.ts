import "server-only";

import { LAB_KEY } from "@/lib/lab";
import { readDoorConfig } from "@/lib/platform/door";

/**
 * The AI door of the platform: `POST /api/llm/complete`.
 *
 * A Lab holds NO provider key and NO provider SDK. The platform picks
 * provider and model (or the tier you ask for), applies the customer's rules
 * (third-country providers off by default), books the cost to the
 * organisation and the purpose, and the Suite shows it — the Lab does nothing
 * for cost reporting.
 *
 * Purposes are `<lab>.<action>`, lower-case, stable: they are the ledger key
 * the Suite groups costs by. Renaming one splits a customer's cost history.
 *
 * Retry only on 429/503, never on other 4xx; the error code is surfaced to
 * the caller, never swallowed.
 */

export type LlmTier = "fast" | "balanced" | "best";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  organisationId: string;
  /** The action part; the Lab key is prefixed automatically. */
  action: string;
  messages: LlmMessage[];
  system?: string;
  tier?: LlmTier;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** The acting person, for the ledger. Omit for worker calls. */
  userId?: string;
  metadata?: Record<string, string>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export type LlmResult =
  | {
      ok: true;
      text: string;
      model: string;
      provider: string;
      usage: LlmUsage;
      ledgerId: string | null;
    }
  | { ok: false; status: number; code: string; message: string };

const TIMEOUT_MS = 120_000;
const RETRY_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;

export function purposeFor(action: string): string {
  const clean = action.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${LAB_KEY}.${clean}`.slice(0, 120);
}

export async function complete(
  request: LlmRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmResult> {
  const config = readDoorConfig();
  if (!config) {
    return { ok: false, status: 503, code: "DOOR_NOT_CONFIGURED", message: "The platform door is not configured." };
  }

  const body = JSON.stringify({
    organisationId: request.organisationId,
    purpose: purposeFor(request.action),
    messages: request.messages,
    system: request.system,
    tier: request.model ? undefined : (request.tier ?? "balanced"),
    model: request.model,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    userId: request.userId,
    metadata: request.metadata,
  });

  let last: LlmResult = { ok: false, status: 0, code: "NETWORK", message: "no attempt made" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await fetchImpl(`${config.baseUrl}/api/llm/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // NO retry on a network error or timeout: the platform may already have
      // completed and billed the call. Only 429/503 (the platform itself
      // answered, it did nothing) are retried below.
      return { ok: false, status: 0, code: "NETWORK", message: error instanceof Error ? error.message : "network error" };
    }

    const envelope = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } }
      | null;

    if (res.ok && envelope?.success === true && envelope.data) {
      const d = envelope.data;
      const usage = (d.usage ?? {}) as Partial<LlmUsage>;
      return {
        ok: true,
        text: String(d.text ?? ""),
        model: String(d.model ?? ""),
        provider: String(d.provider ?? ""),
        usage: {
          inputTokens: Number(usage.inputTokens ?? 0),
          outputTokens: Number(usage.outputTokens ?? 0),
          costCents: Number(usage.costCents ?? 0),
        },
        ledgerId: typeof d.ledgerId === "string" ? d.ledgerId : null,
      };
    }

    last = {
      ok: false,
      status: res.status,
      code: envelope?.error?.code ?? `HTTP_${res.status}`,
      message: envelope?.error?.message ?? `The platform answered HTTP ${res.status}.`,
    };
    if (!RETRY_STATUSES.has(res.status)) return last;
    if (attempt < MAX_ATTEMPTS) await wait(500 * attempt);
  }
  return last;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
