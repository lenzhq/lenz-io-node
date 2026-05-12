/**
 * Typed exception hierarchy for the Lenz SDK.
 *
 * All HTTP error responses funnel through `mapResponseToError`, which is
 * table-driven: one place to update when the API adds new error contracts.
 * The Python SDK mirrors this exact mapping; the table is the
 * cross-language invariant.
 *
 * Every error subclass carries a `requestId` (the `X-Request-ID` value from
 * the response headers) so customers can quote it on support tickets.
 *
 * Error messages follow the Tier 2 Rust-style format:
 *
 *     Cause:  {what went wrong}
 *     Fix:    {what to do about it}
 *     Docs:   https://lenz.io/docs/{topic}
 *     Request ID: {id}
 */

export interface LenzErrorContext {
  message?: string;
  cause?: string;
  fix?: string;
  docUrl?: string;
  requestId?: string;
  statusCode?: number;
  body?: Record<string, unknown> | null;
}

export class LenzError extends Error {
  cause_: string;
  fix: string;
  docUrl: string;
  requestId: string;
  statusCode: number;
  body: Record<string, unknown> | null;

  constructor(ctx: LenzErrorContext = {}) {
    super(ctx.message || new.target.name);
    this.name = new.target.name;
    this.cause_ = ctx.cause ?? "";
    this.fix = ctx.fix ?? "";
    this.docUrl = ctx.docUrl ?? "";
    this.requestId = ctx.requestId ?? "";
    this.statusCode = ctx.statusCode ?? 0;
    this.body = ctx.body ?? null;
  }

  override toString(): string {
    const lines: string[] = [this.message || this.name];
    if (this.cause_) lines.push(`  Cause:  ${this.cause_}`);
    if (this.fix) lines.push(`  Fix:    ${this.fix}`);
    if (this.docUrl) lines.push(`  Docs:   ${this.docUrl}`);
    if (this.requestId) lines.push(`  Request ID: ${this.requestId}`);
    return lines.join("\n");
  }
}

export class LenzAuthError extends LenzError {}

export class LenzQuotaExceededError extends LenzError {
  creditsRemaining = 0;
}

export class LenzValidationError extends LenzError {
  errors: Array<Record<string, unknown>> = [];
}

export class LenzRateLimitError extends LenzError {
  retryAfter = 0;
}

export class LenzAPIError extends LenzError {}

export class LenzTimeoutError extends LenzError {
  taskId = "";
}

export class LenzNeedsInputError extends LenzError {
  taskId = "";
  kind = "";
  payload: Record<string, unknown> = {};
}

export class LenzPipelineError extends LenzError {
  taskId = "";
  failureReason = "";
}

export class LenzWebhookSignatureError extends LenzError {}

// ── Mapping table ────────────────────────────────────────────────────────
//
// Single source of truth for HTTP status → exception class + default
// message text. The Python SDK ships an equivalent table; both must stay
// in sync. Tests pin the mapping.

const DOCS_BASE = "https://lenz.io/docs";

interface StatusEntry {
  cls: new (ctx: LenzErrorContext) => LenzError;
  message: string;
  docUrl: string;
}

const STATUS_MAP: Record<number, StatusEntry> = {
  401: { cls: LenzAuthError, message: "Unauthorized", docUrl: `${DOCS_BASE}/auth` },
  403: { cls: LenzAuthError, message: "Forbidden", docUrl: `${DOCS_BASE}/auth` },
  402: {
    cls: LenzQuotaExceededError,
    message: "Payment required",
    docUrl: `${DOCS_BASE}/billing`,
  },
  422: {
    cls: LenzValidationError,
    message: "Validation failed",
    docUrl: `${DOCS_BASE}/errors/validation`,
  },
  429: {
    cls: LenzRateLimitError,
    message: "Rate limit exceeded",
    docUrl: `${DOCS_BASE}/rate-limits`,
  },
};

const FIX_HINTS: Record<number, string> = {
  401: "Generate a new key at https://lenz.io/api-integration.",
  403: "This key doesn't have access to that resource.",
  402: "Upgrade your plan or wait for the period reset.",
  422: "Check the request body against the OpenAPI spec.",
  429: "Wait Retry-After seconds and retry.",
};

function parseBody(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function getHeader(headers: Record<string, string>, name: string): string {
  // Try common header casings.
  return (
    headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? ""
  );
}

export function mapResponseToError(
  statusCode: number,
  body: string | null | undefined,
  headers: Record<string, string> = {},
): LenzError {
  const parsed = parseBody(body);
  const requestId = getHeader(headers, "X-Request-ID");

  let entry: StatusEntry;
  if (statusCode in STATUS_MAP) {
    entry = STATUS_MAP[statusCode]!;
  } else if (statusCode >= 500 && statusCode < 600) {
    entry = { cls: LenzAPIError, message: "Server error", docUrl: `${DOCS_BASE}/errors` };
  } else {
    entry = { cls: LenzError, message: `HTTP ${statusCode}`, docUrl: `${DOCS_BASE}/errors` };
  }

  const detailRaw = parsed["detail"];
  const detail =
    typeof detailRaw === "string"
      ? detailRaw
      : Array.isArray(detailRaw)
        ? "Validation failed"
        : entry.message;

  const err = new entry.cls({
    message: detail,
    cause: detail,
    fix: FIX_HINTS[statusCode] ?? "Retry; if the error persists, file an issue with the Request ID.",
    docUrl: entry.docUrl,
    requestId,
    statusCode,
    body: parsed,
  });

  // Per-class enrichment
  if (err instanceof LenzQuotaExceededError) {
    err.creditsRemaining = Number(parsed["credits_remaining"] ?? 0);
  } else if (err instanceof LenzValidationError) {
    if (Array.isArray(parsed["detail"])) {
      err.errors = parsed["detail"] as Array<Record<string, unknown>>;
    } else if (Array.isArray(parsed["errors"])) {
      err.errors = parsed["errors"] as Array<Record<string, unknown>>;
    }
  } else if (err instanceof LenzRateLimitError) {
    const ra =
      getHeader(headers, "Retry-After") ||
      String(parsed["retry_after"] ?? "");
    const parsedRa = Number(ra);
    err.retryAfter = Number.isFinite(parsedRa) ? parsedRa : 0;
  }

  return err;
}
