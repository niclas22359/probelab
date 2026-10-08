import { ApiError } from "@/lib/api-errors";

/**
 * The ONE error mapping of the Lab. A service throws a `ServiceError` with a
 * stable code; each door maps it here and nowhere else:
 *
 *   service  -> ServiceError(code, message)
 *   route    -> toApiError        -> `{ error: { code, message } }` + HTTP status
 *   action   -> actionErrorCode   -> `?error=<code>` (the screen shows its own text)
 *   tool     -> toToolResult      -> MCP result `isError`, text `<code> (HTTP <status>): <message>`
 *               toolErrorFromHttp  the same text from an `/api/v1` answer (the default wiring)
 *
 * Messages are English and say what to do; they never reveal whether a
 * foreign id exists ("not found" and "belongs to somebody else" are equal).
 */

export type ServiceErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_request"
  | "conflict"
  | "container_required";

export const SERVICE_ERROR_STATUS: Record<ServiceErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_request: 400,
  conflict: 409,
  container_required: 400,
};

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly fields?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export function toApiError(error: ServiceError): ApiError {
  const code =
    error.code === "container_required" ? "invalid_request" : error.code;
  return new ApiError(
    SERVICE_ERROR_STATUS[error.code],
    code,
    error.message,
    error.fields,
  );
}

/** The code the screen turns into its own text (`notes.errors.<code>`); unknown errors are `internal_error`. */
export function actionErrorCode(error: unknown): string {
  if (error instanceof ServiceError) return error.code;
  if (error instanceof ApiError) return error.code;
  return "internal_error";
}

/** A type alias, not an interface: the MCP SDK's result type needs the implicit index signature. */
export type ToolErrorResult = {
  isError: true;
  content: { type: "text"; text: string }[];
};

export function toolErrorText(
  status: number,
  code: string,
  message: string,
): string {
  return `${code} (HTTP ${status}): ${message}`;
}

function toolError(text: string): ToolErrorResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** For a tool that calls a service directly (allowed wiring, docs/FRAME.md 5): same text as over HTTP. */
export function toToolResult(error: unknown): ToolErrorResult {
  if (error instanceof ServiceError) {
    return toolError(
      toolErrorText(
        SERVICE_ERROR_STATUS[error.code],
        toApiError(error).code,
        error.message,
      ),
    );
  }
  if (error instanceof ApiError)
    return toolError(toolErrorText(error.status, error.code, error.message));
  return toolError(toolErrorText(500, "internal_error", "Unexpected error."));
}

/** The default wiring: the tool called `/api/v1` and got an error answer. */
export function toolErrorFromHttp(
  status: number,
  body: string,
): ToolErrorResult {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown };
    };
    if (
      typeof parsed.error?.code === "string" &&
      typeof parsed.error.message === "string"
    ) {
      return toolError(
        toolErrorText(status, parsed.error.code, parsed.error.message),
      );
    }
  } catch {
    // not the envelope: fall through
  }
  const short = body.length > 500 ? `${body.slice(0, 500)}…` : body;
  return toolError(
    toolErrorText(status, "http_error", short || "No answer body."),
  );
}
