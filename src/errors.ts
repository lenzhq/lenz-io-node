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

import { CANCELLED_DOCS_URL, legacyErrorBody, type RequestContext } from "./compat.js";
import type { Citecheck, ReviewFailureBlock, ReviewFull } from "./types.js";

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
  /**
   * Whether the same request can succeed later. Omitted: derived from
   * `statusCode` and `body` (see {@link LenzError.retryable}).
   */
  retryable?: boolean | null;
}

/**
 * The 409 codes that mean "the same request, sent again later, can succeed":
 * the run is still going (`verification_not_ready`) or the first request
 * with this `Idempotency-Key` is still in flight (`idempotency_conflict`).
 */
const RETRYABLE_409_CODES: readonly string[] = ["verification_not_ready", "idempotency_conflict"];

/**
 * `retryable` for an error built from a status and a body: a boolean the
 * body states (in its `failure` block, else at the top level) wins; else 429,
 * 5xx and the two in-progress 409s are retryable, any other 4xx is not, and
 * no status is unknown.
 */
function deriveRetryable(
  statusCode: number,
  body: Record<string, unknown> | null | undefined,
  code: string,
): boolean | null {
  const failure = body?.["failure"];
  if (failure && typeof failure === "object" && !Array.isArray(failure)) {
    const stated = (failure as Record<string, unknown>)["retryable"];
    if (typeof stated === "boolean") return stated;
  }
  const stated = body?.["retryable"];
  if (typeof stated === "boolean") return stated;
  if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) return true;
  // The code as sent too: on some endpoints the 2.x `code` reads "" here.
  const sentCode = typeof body?.["code"] === "string" ? (body["code"] as string) : "";
  if (
    statusCode === 409 &&
    (RETRYABLE_409_CODES.includes(code) || RETRYABLE_409_CODES.includes(sentCode))
  ) {
    return true;
  }
  if (statusCode >= 400 && statusCode < 500) return false;
  return null;
}

export class LenzError extends Error {
  cause_: string;
  fix: string;
  docUrl: string;
  requestId: string;
  statusCode: number;
  /**
   * The server's machine-readable error code, e.g. `"no_credits"`. Present on
   * 402, 403, 409, 410 (`"purged"`), 429 and a typed 503; `""` when the
   * server sent none. Branch on this rather than on message text. By default
   * it is the code lenz-io 2.x reported for that call (which left some out,
   * e.g. `not_found`, and renamed a few); on a client made with
   * `legacyAliases: false` it is exactly the `code` of the response body.
   */
  code: string;
  /**
   * The parsed JSON body of the error response, exactly as sent (`null` or
   * `{}` when there was none, or it was not a JSON object). The source of
   * truth: every other field is read from it.
   */
  body: Record<string, unknown> | null;
  /**
   * Whether sending the same request again later can succeed: `true` for a
   * network failure, a transport timeout, a 429, a 5xx (including
   * `upstream_unavailable`) and a 409 `verification_not_ready` or
   * `idempotency_conflict`; `false` for any other 4xx and for
   * {@link LenzApiVersionError}; `null` when unknown. A boolean the response
   * body states wins. On a failed run ({@link LenzPipelineError} and its
   * review / citation-check subclasses) it is the server's own value, `null`
   * when it stated none. A plain field, set when the error is built (typed
   * optional only so objects built against 2.x types still fit).
   */
  retryable?: boolean | null;
  /**
   * The `Idempotency-Key` the call sent, when it sent one (every paid call
   * does by default); `undefined` otherwise. To resend after this error
   * without running the work twice, pass it back:
   * `client.verify({ claim, idempotencyKey: err.idempotencyKey })`. A plain
   * new call mints a new key and can run (and charge) twice.
   */
  idempotencyKey?: string;
  /**
   * The `X-Lenz-API-Version` the error response named (`"2026-10-11"` for
   * this release's, `"2026-05-13"` for an older one), or `""` when it named
   * none or the error did not come from an HTTP answer. An error response
   * from another API version is still thrown as its own typed error; this
   * says which version wrote its `body`.
   */
  servedVersion?: string;
  /**
   * The response headers of the error answer (names in lower case), e.g.
   * `headers["retry-after"]`; `undefined` for an error with no HTTP answer
   * or one the SDK raised itself.
   */
  headers?: Record<string, string>;

  /**
   * `options.cause` is the native `Error.cause` (the error this one wraps,
   * e.g. the `fetch` rejection behind a {@link LenzConnectionError}); the
   * string `cause_` is the human-readable cause line.
   */
  constructor(ctx: LenzErrorContext = {}, options?: { cause?: unknown }) {
    super(ctx.message || new.target.name, options);
    this.name = new.target.name;
    this.cause_ = ctx.cause ?? "";
    this.fix = ctx.fix ?? "";
    this.docUrl = ctx.docUrl ?? "";
    this.requestId = ctx.requestId ?? "";
    this.statusCode = ctx.statusCode ?? 0;
    this.code = ctx.code ?? "";
    this.body = ctx.body ?? null;
    this.servedVersion = "";
    this.retryable =
      ctx.retryable !== undefined
        ? ctx.retryable
        : deriveRetryable(this.statusCode, this.body, this.code);
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
 * 401 / 403 — the credential is missing, invalid, expired, or revoked.
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
 * The `apiKey` (passed, in `LENZ_API_KEY`, or given to `withOptions`) has a
 * character a key never has inside it (a space, a control character, a
 * non-ASCII character), so it cannot ride an `Authorization` header: refused
 * when the client or the copy is made, before any request (`statusCode` 0;
 * the message never contains the key). A {@link LenzAuthError}, so a handler
 * for that still catches it; a 401 / 403 from the API stays a plain
 * `LenzAuthError`. Since 3.2.
 */
export class LenzInvalidKeyError extends LenzAuthError {}

/**
 * 402 — you're out of balance, or your plan doesn't cover this call.
 *
 * `remaining` and `requested` are in the **capability's own unit** (you asked
 * for verifications, so the shortfall is reported in verifications).
 * `creditBalance` and `cost` report the same rejection in pool credits.
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
  /**
   * Credits left in the account's pool, or `null` if unreported.
   *
   * The same rejection as {@link remaining}, in pool units instead of the
   * capability's own: together with {@link cost} it separates "you hold 4
   * credits and this verification costs 10" from "you hold nothing". Server
   * field `credits_remaining`.
   *
   * Deliberately NOT named `creditsRemaining` — that name is the deprecated
   * alias of {@link remaining} and reports verifications/asks/assesses, not
   * credits. Reusing it would change the unit under existing callers.
   */
  creditBalance: number | null = null;
  /**
   * Credits the rejected call would have taken, or `null` if unreported.
   *
   * Scales with a batch: five verifications at 10 credits each reports 50.
   * Server field `cost`.
   *
   * **Depth-aware, not a fixed multiple.** A rejected `depth: "low"` verify
   * reports 5 (half a standard one), and a rejected batch that mixes depths
   * reports its real summed total — three standard plus two low is 40, which
   * is neither `5 * 10` nor `5 * 5`. Read this field rather than multiplying
   * {@link requested} by a price you assumed.
   *
   * The charge follows the depth **requested**, not the one served: a `low`
   * request is priced at `low` even when the server could have answered it
   * from a cached `standard` verdict.
   */
  cost: number | null = null;

  private static warnedCreditsRemaining = false;

  /**
   * @deprecated Use {@link remaining}. Removed in a future major release.
   *
   * Reports `0` when the balance is unknown — exactly the ambiguity
   * `remaining` exists to fix.
   *
   * **This is NOT the server's `credits_remaining` field**, despite the name.
   * It is an alias of {@link remaining} and reads in the CAPABILITY's unit
   * (verifications, asks, assesses). The pool balance the server now sends as
   * `credits_remaining` is {@link creditBalance}, and the two differ: 4
   * credits is `creditBalance === 4` and `creditsRemaining === 0`, because 4
   * credits buys no verification. The alias was never wired to a server field
   * — before the credit pool existed nothing sent one, so it always read `0`
   * unless a caller assigned it.
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
      "[lenz-io] creditsRemaining is deprecated and will be removed in a future major release; " +
        "use `remaining`, which is null when the server didn't report a " +
        "balance (creditsRemaining reports that as 0). It is not the " +
        "server's `credits_remaining` field — that pool balance is " +
        "`creditBalance`.",
    );
  }
}

export class LenzValidationError extends LenzError {
  errors: Array<Record<string, unknown>> = [];
  /**
   * On an argument the SDK refused before sending (`statusCode` 0), the
   * argument it names, e.g. `"pageSize"`, `"claims[2]"`, `"headers"`;
   * `undefined` on the API's 422 and where no one argument is at fault.
   * Since 3.2; the README lists each local `code` with its `param`.
   */
  declare param?: string;
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
  /**
   * The daily `/extract` limit's wait in seconds; `null` on any other 429.
   *
   * @deprecated Read `retryAfter`, which carries the same wait.
   */
  resetInSeconds: number | null = null;
  /**
   * Where the cap lifts. The server sends this on 429 as well as 402,
   * deliberately — someone hitting the daily `/extract` cap also wants to
   * know a paid plan raises it.
   */
  upgradeUrl = "";
}

export class LenzAPIError extends LenzError {
  /**
   * Seconds a 5xx's `Retry-After` (or body `retry_after`) asked to wait, or
   * `null` when it stated none. Informational on an untyped 5xx: this client
   * paces its own retries against it, capped at {@link MAX_RETRY_AFTER_SLEEP}.
   */
  retryAfter: number | null = null;
}

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
export class LenzUpstreamUnavailableError extends LenzAPIError {}

/**
 * A 2xx whose body is not JSON (a proxy's or captive portal's HTML page, a
 * body cut short). `statusCode` is the real HTTP status, `requestId` the
 * response's `X-Request-ID`, and `bodyText` the first 1000 characters of the
 * body as received. `retryable` is `null`: whether the request ran is
 * unknown, so resend a paid call only with `idempotencyKey: err.idempotencyKey`.
 *
 * Status 0 stays for a request that got no HTTP answer at all
 * ({@link LenzConnectionError}). Subclasses {@link LenzAPIError}.
 */
export class LenzInvalidResponseError extends LenzAPIError {
  /** The start of the body as received (at most 1000 characters, then `…`). */
  bodyText = "";
}

/**
 * The request never got an HTTP answer: DNS, a refused or dropped
 * connection, TLS. Thrown after this client's own retries. Always
 * `retryable`; the original `fetch` rejection is the native `cause`.
 *
 * The request may still have reached the server. Resend it with the same
 * key, `idempotencyKey: err.idempotencyKey`, so it cannot run twice; a plain
 * new call mints a new key and can run (and charge) twice.
 *
 * Subclasses {@link LenzAPIError}, the class 2.x threw here, so existing
 * handlers keep catching it.
 */
export class LenzConnectionError extends LenzAPIError {
  constructor(ctx: LenzErrorContext = {}, options?: { cause?: unknown }) {
    super({ retryable: true, ...ctx }, options);
  }
}

/**
 * One HTTP attempt ran past its timeout (`timeoutMs`), sending the request or
 * reading its answer. Thrown after this client's own retries.
 *
 * Not {@link LenzTimeoutError}, which means a wait (`wait`, `*AndWait`)
 * reached its deadline while the job kept running. A request that timed out
 * may still have reached the server: resend it only with the same key,
 * `idempotencyKey: err.idempotencyKey` (every paid call sends one by
 * default). A plain new call mints a new key and can run (and charge) twice.
 */
export class LenzRequestTimeoutError extends LenzConnectionError {}

/**
 * 404: nothing with the id or key the call names is visible to this
 * credential (a wrong id, another account's private verification, a deleted
 * one). Retrying will not help. Subclasses {@link LenzError}, the class 2.x
 * threw for a 404.
 */
export class LenzNotFoundError extends LenzError {}

export class LenzTimeoutError extends LenzError {
  taskId = "";
}

export class LenzNeedsInputError extends LenzError {
  taskId = "";
  kind = "";
  payload: Record<string, unknown> = {};
  /** The server's one-sentence resolution hint; "" when an older server omits it. */
  hint = "";
}

/**
 * A verification run ended in a terminal `failed` state.
 *
 * Thrown by `verifyAndWait` / `wait`, and by `verifications.get` when it is
 * handed the `taskId` of a run that failed (a 409 with `code`
 * `verification_failed`).
 */
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
  override retryable: boolean | null = null;
  /** The server's one-sentence hint on what to send instead (e.g. `not_a_claim`); "" when absent. */
  hint = "";
}

/**
 * 409 — `verifications.get` was handed the `taskId` of a run that is still
 * going, so there is no verification to return yet.
 *
 * Wait for the run with `client.wait(taskId)`, or poll
 * `client.getStatus(taskId)`, which also carries the options a `needs_input`
 * run offers. A run that FAILED throws {@link LenzPipelineError} instead: it
 * will never be ready.
 */
export class LenzVerificationNotReadyError extends LenzError {
  taskId = "";
  /** `"processing"` or `"needs_input"`. */
  status = "";
  /** The server's one-sentence next step (also on `fix`); "" when absent. */
  hint = "";
}

/**
 * 410 with `code` `"purged"` — the verification is no longer available.
 *
 * An account on Pro or Scale can set a retention period; once a verification
 * is older than it, its content is removed and every read of it answers 410.
 * Nothing brings it back, so retrying will not help. The certificate of a
 * covered verification is kept and stays downloadable.
 *
 * A caller who could not read the verification gets a 404
 * ({@link LenzNotFoundError}) instead, never this error.
 */
export class LenzGoneError extends LenzError {
  /** ISO-8601 timestamp of the removal, or `null` when the server sent none. */
  purgedAt: string | null = null;
}

export class LenzWebhookSignatureError extends LenzError {}

/**
 * The API answered a call in a version this SDK does not read.
 *
 * Every response names the version that served it in `X-Lenz-API-Version`.
 * lenz-io 3.x asks for `2026-10-11` and reads only that shape; when a
 * successful response (status below 400) names another version (in practice
 * `2026-05-13`, for example an older stored replay of an idempotent call),
 * the body is not parsed into the 3.x shapes. It is thrown instead, as sent,
 * in `body`. An error response (400 or above) in another version is thrown
 * as its own typed error, retried as usual, with the version it named in
 * `servedVersion` (since 3.2; before, it was this error too).
 *
 * A response with no `X-Lenz-API-Version` header is not checked. Webhook
 * events are not checked either: `LenzWebhooks` reads both shapes.
 */
export class LenzApiVersionError extends LenzError {
  /** The version the response named, e.g. `"2026-05-13"`. Same as `servedVersion`. */
  apiVersion = "";
  /** The version this SDK reads (`API_VERSION`, `"2026-10-11"`). */
  expectedVersion = "";
  /** Always `false`: the same request reads the same version again. */
  override retryable: boolean | null = false;
}

/**
 * The caller's `signal` fired: the call stopped where it was.
 *
 * Not a {@link LenzError}: an abort is the caller's own decision, not an
 * answer from the API, so code that retries every `LenzError` does not retry
 * it. Its `name` is `"AbortError"`, so a check of `err.name === "AbortError"`
 * still matches; `cause` is the signal's `reason` (a `TimeoutError` for
 * `AbortSignal.timeout(ms)`).
 *
 * It carries what the call knew when it stopped: the `idempotencyKey` of a
 * keyed request (resend with it to get the same answer back), and once the
 * server had accepted the work, its `taskId` (or a batch's `batchId` and
 * `taskIds`), `reviewId` or `citecheckId`. Nothing is cancelled on the
 * server unless the wait was called with `cancelOnAbort: true`: the work
 * keeps running and is charged if it completes. Stop it with `cancel`,
 * `cancelReview` or `cancelCitecheck`, called without the fired signal (on
 * the client, not a `withOptions` copy made with that signal).
 */
export class LenzAbortError extends Error {
  /** The request's `Idempotency-Key`, when the call sent one. */
  idempotencyKey?: string;
  /** The verification run the call was waiting on. */
  taskId?: string;
  /** Every run a batch accepted, in input order. */
  taskIds?: string[];
  /** The batch the call submitted. */
  batchId?: string;
  /** The review the call was waiting on. */
  reviewId?: string;
  /** The citation check the call was waiting on. */
  citecheckId?: string;

  constructor(message = "The call was aborted.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AbortError";
  }
}

/**
 * `reviewAndWait` reached its deadline before the review finished.
 *
 * The review keeps running server-side: read it later with
 * `client.getReview(reviewId)`. `partial` is the last body the wait saw, or
 * `null` when no poll answered.
 */
export class ReviewTimeoutError extends LenzTimeoutError {
  reviewId: string;
  partial: ReviewFull | null;

  constructor(reviewId: string, partial: ReviewFull | null, timeoutMs: number) {
    super({
      message: `Review ${reviewId} did not finish within ${timeoutMs}ms`,
      cause: "The review is still running server-side.",
      fix: `Read it later with client.getReview('${reviewId}'), or wait on the review.completed webhook.`,
      docUrl: `${DOCS_BASE}/quickstart`,
    });
    this.reviewId = reviewId;
    this.partial = partial;
  }
}

/** `citecheckAndWait` reached its deadline before the check ended; it keeps running. */
export class CitecheckTimeoutError extends LenzTimeoutError {
  citecheckId: string;
  partial: Citecheck | null;

  constructor(citecheckId: string, partial: Citecheck | null, timeoutMs: number) {
    super({
      message: `Citation check ${citecheckId} did not finish within ${timeoutMs}ms`,
      cause: "The citation check is still running server-side.",
      fix: `Read it later with client.getCitecheck('${citecheckId}'), or wait on the citecheck.completed webhook.`,
      docUrl: `${DOCS_BASE}/citations`,
    });
    this.citecheckId = citecheckId;
    this.partial = partial;
  }
}

/**
 * What a review or citation check cancelled elsewhere states (API version
 * 2026-10-11 gives it no `failure` of its own; the original shape's `failed`
 * said exactly this).
 */
const CANCELLED_FAILURE: ReviewFailureBlock = {
  failure_reason: "cancelled",
  failure_class: "cancelled",
  retryable: false,
  hint: null,
  docs_url: CANCELLED_DOCS_URL,
};

/**
 * `citecheckAndWait` read a check that ended `failed`, or `cancelled` (failure
 * class `cancelled`, `errorCode` `"cancelled"`). `errorCode` is the failure's
 * `failure_reason` (an open set) and `citecheck` the ended check. A subclass
 * of {@link LenzPipelineError}.
 */
export class CitecheckFailedError extends LenzPipelineError {
  citecheckId: string;
  /** @deprecated Read `citecheck.failure.code`. */
  errorCode: string;
  citecheck: Citecheck;

  constructor(check: Citecheck) {
    const failure = check.failure ?? (check.status === "cancelled" ? CANCELLED_FAILURE : undefined);
    const errorCode = failure?.failure_reason ?? "";
    const hint = failure?.hint ?? "";
    super({
      message: `Citation check ${check.citecheck_id} failed: ${errorCode || "unknown"}`,
      cause: errorCode || "unknown",
      fix:
        hint ||
        (!failure
          ? `The check failed without a stated reason; read it with client.getCitecheck('${check.citecheck_id}').`
          : failure.retryable
            ? "Retry the same request after a short wait."
            : "Check the request and resubmit."),
      docUrl: failure?.docs_url || `${DOCS_BASE}/errors`,
    });
    this.citecheckId = check.citecheck_id;
    this.errorCode = errorCode;
    this.citecheck = check;
    this.failureReason = errorCode;
    this.failureClass = failure?.failure_class ?? "";
    this.retryable = typeof failure?.retryable === "boolean" ? failure.retryable : null;
    this.hint = hint;
  }
}

/**
 * `reviewAndWait` read a review that ended `failed`, or `cancelled` (failure
 * class `cancelled`, `errorCode` `"cancelled"`).
 *
 * `errorCode` is the failure's `failure_reason` (`no_claim`,
 * `insufficient_credits`, `upstream_unavailable`, …: an open set), `hint`
 * says what to send next, and `review` is the failed review itself. A
 * subclass of {@link LenzPipelineError}, so `failureClass` and `retryable`
 * are set too.
 */
export class ReviewFailedError extends LenzPipelineError {
  reviewId: string;
  /** @deprecated Read `review.failure.code` (which says `no_checkable_claim` where this says `no_claim`). */
  errorCode: string;
  review: ReviewFull;

  constructor(review: ReviewFull) {
    const failure =
      review.failure ?? (review.status === "cancelled" ? CANCELLED_FAILURE : undefined);
    const errorCode = failure?.failure_reason ?? "";
    const hint = failure?.hint ?? "";
    super({
      message: `Review ${review.review_id} failed: ${errorCode || "unknown"}`,
      cause: errorCode || "unknown",
      fix:
        hint ||
        (!failure
          ? `The review failed without a stated reason; read it with client.getReview('${review.review_id}').`
          : failure.retryable
            ? "Transient provider outage — resubmit the same draft after a short wait."
            : "Resubmit with a different draft."),
      docUrl: failure?.docs_url || `${DOCS_BASE}/errors`,
    });
    this.reviewId = review.review_id;
    this.errorCode = errorCode;
    this.review = review;
    this.failureReason = errorCode;
    this.failureClass = failure?.failure_class ?? "";
    this.retryable = typeof failure?.retryable === "boolean" ? failure.retryable : null;
    this.hint = hint;
  }
}

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
  // The 2.x message ("HTTP 404" when the body has no detail) is kept.
  404: { cls: LenzNotFoundError, message: "HTTP 404", docUrl: `${DOCS_BASE}/errors` },
};

/**
 * The two 409s `GET /verifications/{id}` answers when handed the task_id of a
 * run with no result yet. Keyed on `code`, not the status: every other 409 (an
 * Idempotency-Key still in flight, a select with nothing pending) stays a
 * plain {@link LenzError}, exactly as before.
 */
const VERIFICATION_409_CODES: Record<string, StatusEntry> = {
  verification_not_ready: {
    cls: LenzVerificationNotReadyError,
    message: "Verification not ready",
    docUrl: `${DOCS_BASE}/verify`,
  },
  verification_failed: {
    cls: LenzPipelineError,
    message: "Verification failed",
    docUrl: `${DOCS_BASE}/errors`,
  },
};

/**
 * The 410 every reader of a verification answers once its account's retention
 * period has removed it. Keyed on `code`, like the 409s: a 410 without it
 * stays a plain {@link LenzError}.
 */
const GONE_410: StatusEntry = {
  cls: LenzGoneError,
  message: "Verification removed",
  docUrl: `${DOCS_BASE}/errors`,
};
const GONE_FIX =
  "Its account's retention period removed it. A certificate issued for it is still available.";

/** `POST /verify/{task_id}/cancel` on a review's deep check: retrying cannot succeed. */
const USE_REVIEW_CANCEL_FIX =
  "Cancel the review that started this task instead: client.cancelReview(reviewId).";

const FIX_HINTS: Record<number, string> = {
  401: "Your credential is missing, invalid or expired. Check the key you passed, or get a new one at https://lenz.io/api-credentials.",
  403: "This key doesn't have access to that resource.",
  402: "Top up or upgrade at https://lenz.io/plans, or wait for the period reset.",
  422: "Check the request body against the OpenAPI spec.",
  429: "Wait Retry-After seconds and retry.",
  404: "Check the id or key the call names: nothing with it is visible to this credential. Retrying will not help.",
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
 * not on the status number: an ordinary proxy / CDN / load-balancer 503
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

/** String-typed only: anything else reads as absent, never as its string form. */
function optString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** An error body in the API's newer shape: it links `docs_url`, never `doc_url`. */
function isNewErrorShape(parsed: Record<string, unknown>): boolean {
  return "docs_url" in parsed && !("doc_url" in parsed);
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

/**
 * The typed error for an HTTP error response.
 *
 * `request` names the call it answered. With it, a body in the API's newer
 * shape is read as the original one first ({@link legacyErrorBody}), so every
 * field of the error keeps its original value: `code` is `""` where the
 * original error had none, a schema error's `errors` are its field items,
 * `resetInSeconds` reads the daily limit's wait. With `request.legacyAliases`
 * `false`, `code` is the body's own `code`, exactly. `body` is always the body
 * as sent, and is the source of truth: every other field is read from it.
 * `headers` are the response headers given, names in lower case.
 */
/**
 * The longest wait `retryAfter` reports, in seconds: 2,147,483 s, the longest
 * a timer can hold in ms, so code that sleeps `retryAfter * 1000` never
 * overflows `setTimeout`.
 */
const MAX_STATED_WAIT_S = 2_147_483;

function capWait(seconds: number | null): number | null {
  return seconds === null ? null : Math.min(seconds, MAX_STATED_WAIT_S);
}

export function mapResponseToError(
  statusCode: number,
  body: string | null | undefined,
  headers: Record<string, string> = {},
  request?: RequestContext,
): LenzError {
  const raw = parseBody(body);
  const parsed = request
    ? (legacyErrorBody(statusCode, raw, request) as Record<string, unknown>)
    : raw;
  const requestId = getHeader(headers, "X-Request-ID");

  const codeForClass = typeof parsed["code"] === "string" ? (parsed["code"] as string) : "";
  let entry: StatusEntry;
  if (statusCode in STATUS_MAP) {
    entry = STATUS_MAP[statusCode]!;
  } else if (
    statusCode === 409 &&
    // Own keys only: a `code` of "toString" must not match the prototype.
    Object.prototype.hasOwnProperty.call(VERIFICATION_409_CODES, codeForClass)
  ) {
    entry = VERIFICATION_409_CODES[codeForClass]!;
  } else if (statusCode === 410 && codeForClass === "purged") {
    entry = GONE_410;
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

  // With `legacyAliases: false` the code is the one the API sent, exactly;
  // by default it is the 2.x reading of it (which may rename or drop it).
  const codeRaw = request?.legacyAliases === false ? raw["code"] : parsed["code"];
  const code = typeof codeRaw === "string" ? codeRaw : "";

  const err = new entry.cls({
    message: detail,
    cause: detail,
    fix:
      statusCode === 409 && code === "use_review_cancel"
        ? USE_REVIEW_CANCEL_FIX
        : (FIX_HINTS[statusCode] ??
          "Retry; if the error persists, file an issue with the Request ID."),
    docUrl: entry.docUrl,
    requestId,
    statusCode,
    code,
    body: raw,
  });
  err.headers = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  err.servedVersion = (err.headers["x-lenz-api-version"] ?? "").trim();

  // Per-class enrichment
  if (
    statusCode === 409 &&
    (err instanceof LenzVerificationNotReadyError || err instanceof LenzPipelineError)
  ) {
    // The generic 4xx advice ("retry; file an issue") is wrong for both: the
    // server's own hint says what to do, with a class default behind it.
    err.taskId = optString(parsed["task_id"]);
    err.hint = optString(parsed["hint"]);
    if (err instanceof LenzVerificationNotReadyError) {
      err.status = optString(parsed["status"]);
      err.fix = err.hint || "Wait for the run with client.wait(taskId), then read its result.";
    } else {
      // The newer response shape nests these in `failure` (its `code` says
      // `no_checkable_claim` where the original says `not_a_claim`). Read
      // there only when the body is in that shape; the original's flat fields
      // are read exactly as before.
      const nested = parsed["failure"];
      const failure =
        nested &&
        typeof nested === "object" &&
        !Array.isArray(nested) &&
        !("failure_reason" in parsed)
          ? (nested as Record<string, unknown>)
          : null;
      const source = failure ?? parsed;
      const reason = failure ? optString(failure["code"]) : optString(parsed["failure_reason"]);
      err.failureReason = reason === "no_checkable_claim" ? "not_a_claim" : reason;
      err.failureClass = optString(source["failure_class"]);
      // Only a real boolean is a retry signal, as in the wait path.
      const retryable = source["retryable"];
      err.retryable = typeof retryable === "boolean" ? retryable : null;
      err.docUrl = optString(source["docs_url"]) || err.docUrl;
      err.fix =
        err.hint ||
        (err.retryable
          ? // Same words as the wait path's LenzPipelineError (client.ts).
            "Transient provider outage — retry the same request after a short wait."
          : "This run will not produce a result. Resubmit with a different claim.");
    }
  }

  if (err instanceof LenzGoneError) {
    // Retrying does not bring it back; the generic hint says to.
    err.fix = GONE_FIX;
    const purgedAt = parsed["purged_at"];
    err.purgedAt = typeof purgedAt === "string" && purgedAt ? purgedAt : null;
  }

  if (err instanceof LenzAPIError) {
    // Body `retry_after` first (both 503 shapes carry it), header as the
    // fallback for any proxy that strips the body.
    err.retryAfter = capWait(
      optNumber(parsed["retry_after"]) ??
        optNumber(parsed["retry_after_seconds"]) ??
        optNumber(getHeader(headers, "Retry-After")),
    );
  } else if (err instanceof LenzQuotaExceededError) {
    const upgradeUrl = parsed["upgrade_url"];
    err.upgradeUrl = typeof upgradeUrl === "string" ? upgradeUrl : "";
    err.remaining = optNumber(parsed["remaining"]);
    err.requested = optNumber(parsed["requested"]);
    if (err.remaining === null && isNewErrorShape(parsed)) {
      // The newer shape may send only the pool: the capability's unit is the
      // price of one of the units requested.
      const balance = optNumber(parsed["credits_remaining"]);
      const cost = optNumber(parsed["cost"]);
      const unit = cost !== null && err.requested ? cost / err.requested : cost;
      if (balance !== null && unit) err.remaining = Math.floor(balance / unit);
    }
    // Pool units. Assigned to their own fields, never folded into
    // `remaining` — that one is in the capability's unit and callers branch
    // on it.
    err.creditBalance = optNumber(parsed["credits_remaining"]);
    err.cost = optNumber(parsed["cost"]);
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
    // The newer response shape names the wait `retry_after` only. The
    // in-flight 429s never carried `reset_in_seconds`, so they keep `null`.
    err.resetInSeconds = optNumber(parsed["reset_in_seconds"]);
    // The newer response shape (it links `docs_url`, never `doc_url`) names
    // the daily cap's wait `retry_after`. A 429 that never carried
    // `reset_in_seconds` (the in-flight ones, no doc link) keeps `null`.
    if (
      err.resetInSeconds === null &&
      isNewErrorShape(parsed) &&
      !("retry_after_seconds" in parsed)
    ) {
      err.resetInSeconds = optNumber(parsed["retry_after"]);
    }
    const rlUpgradeUrl = parsed["upgrade_url"];
    err.upgradeUrl = typeof rlUpgradeUrl === "string" ? rlUpgradeUrl : "";
    // Header first, then the body. `reset_in_seconds` is what the server
    // actually sends; `retry_after` was an SDK-side invention the server has
    // never emitted — kept last purely as a defensive read.
    // `retry_after_seconds` is the /review in-flight 429's name for it.
    err.retryAfter =
      capWait(
        optNumber(getHeader(headers, "Retry-After")) ??
          optNumber(parsed["reset_in_seconds"]) ??
          optNumber(parsed["retry_after_seconds"]) ??
          optNumber(parsed["retry_after"]),
      ) ?? 0;
  }

  return err;
}
