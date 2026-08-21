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
  /** The server's machine-readable error code, e.g. `"no_credits"`. */
  code?: string;
  body?: Record<string, unknown> | null;
}

export class LenzError extends Error {
  cause_: string;
  fix: string;
  docUrl: string;
  requestId: string;
  statusCode: number;
  /**
   * The server's machine-readable error code, e.g. `"no_credits"`. Present on
   * 402, 403 and 429; `""` when the server sent none. Branch on this rather
   * than on message text.
   */
  code: string;
  body: Record<string, unknown> | null;

  constructor(ctx: LenzErrorContext = {}) {
    super(ctx.message || new.target.name);
    this.name = new.target.name;
    this.cause_ = ctx.cause ?? "";
    this.fix = ctx.fix ?? "";
    this.docUrl = ctx.docUrl ?? "";
    this.requestId = ctx.requestId ?? "";
    this.statusCode = ctx.statusCode ?? 0;
    this.code = ctx.code ?? "";
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

/**
 * 401 / 403 — the API key is missing, invalid, or revoked.
 *
 * Note: an out-of-credits response is NOT this error. It used to be — the API
 * returned 403 for quota, which landed here — but the API now returns 402 and
 * that maps to {@link LenzQuotaExceededError}. If you were catching
 * `LenzAuthError` to handle an empty balance, catch the quota error instead.
 * The two do not share a parent on purpose: "fix your key" and "top up your
 * account" are different actions.
 */
export class LenzAuthError extends LenzError {}

/**
 * 402 — you're out of balance, or your plan doesn't cover this call.
 *
 * `remaining` is **nullable**: `null` means the server didn't report a
 * balance, `0` means it reported an empty one. The old `creditsRemaining = 0`
 * could not tell those apart, which made it useless to branch on. The server
 * omits these fields rather than sending `null`, so the distinction survives
 * the wire.
 */
export class LenzQuotaExceededError extends LenzError {
  /** Where the wall lifts — the plans page. */
  upgradeUrl = "";
  /** Usable capacity left for the capability, or `null` if unreported. */
  remaining: number | null = null;
  /** ISO-8601 timestamp of the next monthly reset, or `null`. */
  resetsAt: string | null = null;
  /** For a batch call, how many units were asked for. */
  requested: number | null = null;

  private static warnedCreditsRemaining = false;

  /**
   * @deprecated Use {@link remaining}. Removed in 3.0.
   *
   * Reports `0` when the balance is unknown — exactly the ambiguity
   * `remaining` exists to fix. The server never sent the `credits_remaining`
   * field this read, so it was always `0`.
   */
  get creditsRemaining(): number {
    LenzQuotaExceededError.warnCreditsRemaining();
    return this.remaining ?? 0;
  }

  /**
   * Writes through to {@link remaining}.
   *
   * A getter with no setter would be a breaking change in a MINOR release:
   * ESM is always strict, so `err.creditsRemaining = 5` throws `TypeError`,
   * and a TypeScript consumer assigning it fails to compile (TS2540). Both
   * break on a caret-range `npm update` inside 2.x.
   */
  set creditsRemaining(value: number | null) {
    LenzQuotaExceededError.warnCreditsRemaining();
    this.remaining = value;
  }

  private static warnCreditsRemaining(): void {
    if (LenzQuotaExceededError.warnedCreditsRemaining) return;
    LenzQuotaExceededError.warnedCreditsRemaining = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[lenz-io] creditsRemaining is deprecated and will be removed in 3.0; " +
        "use `remaining`, which is null when the server didn't report a " +
        "balance (creditsRemaining reports that as 0).",
    );
  }
}

export class LenzValidationError extends LenzError {
  errors: Array<Record<string, unknown>> = [];
}

/**
 * 429 — rate limited.
 *
 * Being thrown does not always mean the automatic retry ladder was exhausted:
 * waits longer than {@link MAX_RETRY_AFTER_SLEEP} throw immediately so a call
 * can't block for hours inside a sleeping retry.
 */
export class LenzRateLimitError extends LenzError {
  /** Seconds until the next allowed call, from the header or the body. */
  retryAfter = 0;
  /** The cap that was hit, when the server states it. */
  limit: number | null = null;
  /** The body's raw echo of the same wait. */
  resetInSeconds: number | null = null;
  /**
   * Where the cap lifts. The server sends this on 429 as well as 402,
   * deliberately — someone hitting the daily `/extract` cap also wants to
   * know a paid plan raises it.
   */
  upgradeUrl = "";
}

export class LenzAPIError extends LenzError {}

/**
 * 503 with `code` `upstream_unavailable` or `capacity`.
 *
 * The server is stating a *transient* condition: its model/search providers
 * are exhausted (`upstream_unavailable` — nothing was charged; the same
 * request succeeds once they recover) or the pipeline is at capacity
 * (`capacity` — nothing was accepted or charged). Retry the SAME request
 * after `retryAfter` seconds.
 *
 * Subclasses {@link LenzAPIError}, so existing `instanceof LenzAPIError`
 * handlers keep catching it. Waits up to {@link MAX_RETRY_AFTER_SLEEP} are
 * already slept through by the automatic retry ladder — this being thrown
 * means the stated wait was longer, and `retryAfter` carries it.
 */
export class LenzUpstreamUnavailableError extends LenzAPIError {
  retryAfter: number | null = null;
}

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
  /**
   * WHY (closed set: `upstream_unavailable` | `insufficient_evidence` |
   * `invalid_input` | `cancelled` | `internal`); "" when an older server
   * omits it.
   */
  failureClass = "";
  /** true iff `upstream_unavailable` — resubmit the same claim after a short wait. `null` = server didn't say. */
  retryable: boolean | null = null;
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
  401: "Generate a new key at https://lenz.io/api-credentials.",
  403: "This key doesn't have access to that resource.",
  402: "Top up or upgrade at https://lenz.io/plans, or wait for the period reset.",
  422: "Check the request body against the OpenAPI spec.",
  429: "Wait Retry-After seconds and retry.",
};

/**
 * Longest `Retry-After` we'll sleep through inside the automatic retry ladder.
 *
 * The `/extract` daily cap sends seconds-until-UTC-midnight, so honoring the
 * raw value could block a call for ~24h — three times over, once per retry.
 * Above this we throw immediately with the true `retryAfter` so the caller can
 * schedule the work.
 */
export const MAX_RETRY_AFTER_SLEEP = 60;

/**
 * The body `code` values the server sends on a 503 it produced deliberately:
 * providers exhausted mid-pipeline, or a submission shed at the door. Both
 * map to {@link LenzUpstreamUnavailableError} and both state an honest wait.
 *
 * The retry ladder in `client.ts` keys its immediate-abort decision on THIS,
 * not on the status number: an ordinary Cloud Run / CDN / load-balancer 503
 * carries no Lenz code, states a maintenance-window wait, and must keep being
 * retried exactly as it was before 2.8.0.
 */
export const UPSTREAM_503_CODES: readonly string[] = ["upstream_unavailable", "capacity"];

/**
 * Coerce to a number, or `null` when absent/unparseable.
 *
 * `Number("")` is `0` and `Number(null)` is `0` in JS, so a plain `Number()`
 * turns "the server said nothing" into "the balance is zero" — the exact
 * ambiguity the nullable fields exist to avoid.
 */
function optNumber(value: unknown): number | null {
  if (typeof value === "string") value = value.trim();
  if (value === null || value === undefined || value === "") return null;
  // Booleans coerce to 0/1 in JS, which would read as a real balance.
  if (typeof value === "boolean") return null;
  const n = Number(value);
  // Truncated so "42.7" and 42.7 agree, matching Python's _opt_int. Every
  // field this parses (counts, seconds) is an integer on the wire; a float is
  // malformed either way, and the two SDKs disagreeing is worse than either
  // answer.
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

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
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? "";
}

export function mapResponseToError(
  statusCode: number,
  body: string | null | undefined,
  headers: Record<string, string> = {},
): LenzError {
  const parsed = parseBody(body);
  const requestId = getHeader(headers, "X-Request-ID");

  const codeForClass = typeof parsed["code"] === "string" ? (parsed["code"] as string) : "";
  let entry: StatusEntry;
  if (statusCode in STATUS_MAP) {
    entry = STATUS_MAP[statusCode]!;
  } else if (statusCode === 503 && UPSTREAM_503_CODES.includes(codeForClass)) {
    entry = {
      cls: LenzUpstreamUnavailableError,
      message: "Service temporarily unavailable",
      docUrl: `${DOCS_BASE}/errors#unavailable`,
    };
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

  const codeRaw = parsed["code"];
  const code = typeof codeRaw === "string" ? codeRaw : "";

  const err = new entry.cls({
    message: detail,
    cause: detail,
    fix:
      FIX_HINTS[statusCode] ?? "Retry; if the error persists, file an issue with the Request ID.",
    docUrl: entry.docUrl,
    requestId,
    statusCode,
    code,
    body: parsed,
  });

  // Per-class enrichment
  if (err instanceof LenzUpstreamUnavailableError) {
    // Body `retry_after` first (both 503 shapes carry it), header as the
    // fallback for any proxy that strips the body.
    err.retryAfter =
      optNumber(parsed["retry_after"]) ?? optNumber(getHeader(headers, "Retry-After"));
  } else if (err instanceof LenzQuotaExceededError) {
    const upgradeUrl = parsed["upgrade_url"];
    err.upgradeUrl = typeof upgradeUrl === "string" ? upgradeUrl : "";
    err.remaining = optNumber(parsed["remaining"]);
    err.requested = optNumber(parsed["requested"]);
    const resetsAt = parsed["resets_at"];
    err.resetsAt = typeof resetsAt === "string" && resetsAt ? resetsAt : null;
  } else if (err instanceof LenzValidationError) {
    if (Array.isArray(parsed["detail"])) {
      err.errors = parsed["detail"] as Array<Record<string, unknown>>;
    } else if (Array.isArray(parsed["errors"])) {
      err.errors = parsed["errors"] as Array<Record<string, unknown>>;
    }
  } else if (err instanceof LenzRateLimitError) {
    err.limit = optNumber(parsed["limit"]);
    err.resetInSeconds = optNumber(parsed["reset_in_seconds"]);
    const rlUpgradeUrl = parsed["upgrade_url"];
    err.upgradeUrl = typeof rlUpgradeUrl === "string" ? rlUpgradeUrl : "";
    // Header first, then the body. `reset_in_seconds` is what the server
    // actually sends; `retry_after` was an SDK-side invention the server has
    // never emitted — kept last purely as a defensive read.
    err.retryAfter =
      optNumber(getHeader(headers, "Retry-After")) ??
      optNumber(parsed["reset_in_seconds"]) ??
      optNumber(parsed["retry_after"]) ??
      0;
  }

  return err;
}
