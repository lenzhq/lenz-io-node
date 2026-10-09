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
import type { Citecheck, ReviewFull } from "./types.js";
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
export declare class LenzError extends Error {
  cause_: string;
  fix: string;
  docUrl: string;
  requestId: string;
  statusCode: number;
  /**
   * The server's machine-readable error code, e.g. `"no_credits"`. Present on
   * 402, 403, 409, 410 (`"purged"`), 429 and a typed 503; `""` when the
   * server sent none. Branch on this rather than on message text.
   */
  code: string;
  body: Record<string, unknown> | null;
  constructor(ctx?: LenzErrorContext);
  toString(): string;
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
export declare class LenzAuthError extends LenzError {}
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
export declare class LenzQuotaExceededError extends LenzError {
  /** Where the wall lifts — the plans page. */
  upgradeUrl: string;
  /** Usable capacity left for the capability, or `null` if unreported. */
  remaining: number | null;
  /** ISO-8601 timestamp of the next monthly reset, or `null`. */
  resetsAt: string | null;
  /** For a batch call, how many units were asked for. */
  requested: number | null;
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
  creditBalance: number | null;
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
  cost: number | null;
  private static warnedCreditsRemaining;
  /**
   * @deprecated Use {@link remaining}. Removed in 3.0.
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
  get creditsRemaining(): number;
  /**
   * Writes through to {@link remaining}.
   *
   * A getter with no setter would be a breaking change in a MINOR release:
   * ESM is always strict, so `err.creditsRemaining = 5` throws `TypeError`,
   * and a TypeScript consumer assigning it fails to compile (TS2540). Both
   * break on a caret-range `npm update` inside 2.x.
   */
  set creditsRemaining(value: number | null);
  private static warnCreditsRemaining;
}
export declare class LenzValidationError extends LenzError {
  errors: Array<Record<string, unknown>>;
}
/**
 * 429 — rate limited.
 *
 * Being thrown does not always mean the automatic retry ladder was exhausted:
 * waits longer than {@link MAX_RETRY_AFTER_SLEEP} throw immediately so a call
 * can't block for hours inside a sleeping retry.
 */
export declare class LenzRateLimitError extends LenzError {
  /** Seconds until the next allowed call, from the header or the body. */
  retryAfter: number;
  /** The cap that was hit, when the server states it. */
  limit: number | null;
  /** The body's raw echo of the same wait. */
  resetInSeconds: number | null;
  /**
   * Where the cap lifts. The server sends this on 429 as well as 402,
   * deliberately — someone hitting the daily `/extract` cap also wants to
   * know a paid plan raises it.
   */
  upgradeUrl: string;
}
export declare class LenzAPIError extends LenzError {
  /**
   * Seconds a 5xx's `Retry-After` (or body `retry_after`) asked to wait, or
   * `null` when it stated none. Informational on an untyped 5xx: this client
   * paces its own retries against it, capped at {@link MAX_RETRY_AFTER_SLEEP}.
   */
  retryAfter: number | null;
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
export declare class LenzUpstreamUnavailableError extends LenzAPIError {}
export declare class LenzTimeoutError extends LenzError {
  taskId: string;
}
export declare class LenzNeedsInputError extends LenzError {
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  /** The server's one-sentence resolution hint; "" when an older server omits it. */
  hint: string;
}
/**
 * A verification run ended in a terminal `failed` state.
 *
 * Thrown by `verifyAndWait` / `wait`, and by `verifications.get` when it is
 * handed the `taskId` of a run that failed (a 409 with `code`
 * `verification_failed`).
 */
export declare class LenzPipelineError extends LenzError {
  taskId: string;
  failureReason: string;
  /**
   * WHY (closed set: `upstream_unavailable` | `insufficient_evidence` |
   * `invalid_input` | `cancelled` | `internal`); "" when an older server
   * omits it.
   */
  failureClass: string;
  /** true iff `upstream_unavailable` — resubmit the same claim after a short wait. `null` = server didn't say. */
  retryable: boolean | null;
  /** The server's one-sentence hint on what to send instead (e.g. `not_a_claim`); "" when absent. */
  hint: string;
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
export declare class LenzVerificationNotReadyError extends LenzError {
  taskId: string;
  /** `"processing"` or `"needs_input"`. */
  status: string;
  /** The server's one-sentence next step (also on `fix`); "" when absent. */
  hint: string;
}
/**
 * 410 with `code` `"purged"` — the verification is no longer available.
 *
 * An account on Pro or Scale can set a retention period; once a verification
 * is older than it, its content is removed and every read of it answers 410.
 * Nothing brings it back, so retrying will not help. The certificate of a
 * covered verification is kept and stays downloadable.
 *
 * A caller who could not read the verification gets a plain 404 instead,
 * never this error.
 */
export declare class LenzGoneError extends LenzError {
  /** ISO-8601 timestamp of the removal, or `null` when the server sent none. */
  purgedAt: string | null;
}
export declare class LenzWebhookSignatureError extends LenzError {}
/**
 * `reviewAndWait` reached its deadline before the review finished.
 *
 * The review keeps running server-side: read it later with
 * `client.getReview(reviewId)`. `partial` is the last body the wait saw, or
 * `null` when no poll answered.
 */
export declare class ReviewTimeoutError extends LenzTimeoutError {
  reviewId: string;
  partial: ReviewFull | null;
  constructor(reviewId: string, partial: ReviewFull | null, timeoutMs: number);
}
/** `citecheckAndWait` reached its deadline before the check ended; it keeps running. */
export declare class CitecheckTimeoutError extends LenzTimeoutError {
  citecheckId: string;
  partial: Citecheck | null;
  constructor(citecheckId: string, partial: Citecheck | null, timeoutMs: number);
}
/**
 * `citecheckAndWait` read a check that ended `failed`. `errorCode` is the
 * failure's `failure_reason` (an open set) and `citecheck` the failed check.
 * A subclass of {@link LenzPipelineError}.
 */
export declare class CitecheckFailedError extends LenzPipelineError {
  citecheckId: string;
  errorCode: string;
  citecheck: Citecheck;
  constructor(check: Citecheck);
}
/**
 * `reviewAndWait` read a review that ended `failed`.
 *
 * `errorCode` is the failure's `failure_reason` (`no_claim`,
 * `insufficient_credits`, `upstream_unavailable`, …: an open set), `hint`
 * says what to send next, and `review` is the failed review itself. A
 * subclass of {@link LenzPipelineError}, so `failureClass` and `retryable`
 * are set too.
 */
export declare class ReviewFailedError extends LenzPipelineError {
  reviewId: string;
  errorCode: string;
  review: ReviewFull;
  constructor(review: ReviewFull);
}
/**
 * Longest `Retry-After` we'll sleep through inside the automatic retry ladder.
 *
 * The `/extract` daily cap sends seconds-until-UTC-midnight, so honoring the
 * raw value could block a call for ~24h — three times over, once per retry.
 * Above this we throw immediately with the true `retryAfter` so the caller can
 * schedule the work.
 */
export declare const MAX_RETRY_AFTER_SLEEP = 60;
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
export declare const UPSTREAM_503_CODES: readonly string[];
export declare function mapResponseToError(
  statusCode: number,
  body: string | null | undefined,
  headers?: Record<string, string>,
): LenzError;
