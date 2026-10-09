/**
 * Public Lenz client — the ergonomic top-level surface.
 *
 * Multi-language SDK convention (12 languages):
 * - Request methods (verify, assess, extract, ask.send, …) take
 *   `language?: string`. Omit the field (or pass empty string) for
 *   English (default) — the SDK then omits the key from the request
 *   body, preserving byte-identical wire format for existing English
 *   callers. Set `language: "es"` (or any of the 12 supported codes)
 *   to receive prose fields in that language. `assess`, `verify`,
 *   `verifyAndWait` and `ask.send` also take `language: "auto"`: the answer
 *   comes back in the language of the submitted text (for `ask.send`, the
 *   language of the claim being discussed). `extract`, `verifyBatch`,
 *   `citecheck` and `review` do not take `"auto"`.
 * - Response shapes (Verification, VerificationListItem, AssessClaim)
 *   expose `language?: string` populated by the server. Verdict /
 *   domain / status enums stay English regardless of language; only
 *   free-form prose follows the request.
 * - Mixing the two (e.g. `language: "en"` on a request) would send
 *   an extra `"language": "en"` key on every English call — breaks the
 *   byte-identical English path. The omit-when-empty convention exists
 *   precisely to avoid that.
 *
 * Four API primitives form a research-depth ladder — find claims, judge
 * them fast, prove them deep, follow up:
 *
 * ```ts
 * import { Lenz } from 'lenz-io';
 * const client = new Lenz({ apiKey: 'lenz_...' });
 *
 * // 1. extract — pull verifiable claims out of text (free, 1000/day)
 * const out = await client.extract({ text: llmOutput });
 * const claims = (out.claims ?? []).map((c) => c.claim);
 *
 * // 2. assess — one call per 20 claims (extract finds up to 100), one
 * //    row per claim in the same order. A row with verdict 'Error' has
 * //    error_code + hint; a compound item lists the rest in identified_claims.
 * const quick: AssessClaim[] = [];
 * for (let i = 0; i < claims.length; i += 20) {
 *   quick.push(...(await client.assess({ claims: claims.slice(i, i + 20) })).claims);
 * }
 *
 * // 3. verify — escalate the low-confidence rows to the full pipeline (~90s, paid)
 * // verifyBatchAndWait takes up to 20 claims a call: the first 20 here
 * const doubtful = quick
 *   .filter((c) => c.verdict !== 'Error' && c.confidence === 'low')
 *   .map((c) => ({ claim: c.claim! }))
 *   .slice(0, 20);
 * const results = doubtful.length ? await client.verifyBatchAndWait({ claims: doubtful }) : [];
 *
 * // 4. ask — follow-up grounded on a verification
 * const deep = results.find((r) => r.status === 'completed')?.verification;
 * const reply = await client.ask.send(deep!.verification_id!, {
 *   message: 'Which source is strongest?',
 * });
 *
 * // Async / parallel verify-family verbs:
 * const task = await client.verify({ claim: '...' });   // returns task_id
 * const v = await client.wait(task);                     // block until it lands
 * const results = await client.verifyBatchAndWait({      // fan out + poll all
 *   claims: [{ text: '...' }, { text: '...' }],
 * });
 * ```
 */
import type {
  AskHistory,
  AskReply,
  AskSendInput,
  AssessInput,
  AssessResponse,
  BatchAccepted,
  BatchItemResult,
  Certificate,
  ExtractInput,
  ExtractedClaims,
  LibraryList,
  LibraryListInput,
  Citecheck,
  CitecheckAndWaitOptions,
  CitecheckInput,
  CitecheckStarted,
  GetReviewOptions,
  RelatedVerifications,
  ReviewAndWaitOptions,
  ReviewFull,
  ReviewInput,
  ReviewIssues,
  ReviewStarted,
  SelectInput,
  TaskAccepted,
  TaskStatus,
  Usage,
  Verification,
  VerificationList,
  VerifyAndWaitInput,
  VerifyBatchAndWaitInput,
  VerifyBatchInput,
  VerifyInput,
  WaitOptions,
} from "./types.js";
export declare const API_VERSION = "2026-05-13";
export declare const DEFAULT_BASE_URL = "https://lenz.io/api/v1";
export interface LenzOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Inject a custom fetch implementation (testing). Defaults to global fetch. */
  fetch?: typeof fetch;
}
interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  json?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  authRequired?: boolean;
  /** Per-call override of the client's `timeoutMs` (each attempt's AbortController). */
  timeoutMs?: number;
  /** Per-call override of the client's `maxRetries`. */
  maxRetries?: number;
  /**
   * Absolute `Date.now()` bound for the whole call: each attempt's timeout is
   * cut to what is left, and a retry whose sleep would reach it is not taken
   * (the last error is thrown instead).
   */
  deadlineAt?: number;
  /**
   * Optional-auth endpoint: don't fail when no key, but DO send the key when
   * we have one. The server returns a caller's own private/hidden rows only to
   * the owning bearer, so `verifications.get` opts in (→ a fresh private claim
   * is retrievable). Purely public reads (`library.list`) leave this off so a
   * key never reaches an endpoint that doesn't need it.
   */
  authOptional?: boolean;
}
declare class VerificationsNamespace {
  private readonly client;
  constructor(client: Lenz);
  list({ page }?: { page?: number }): Promise<VerificationList>;
  /**
   * Fetch a single verification. Accepts anon callers — any non-hidden
   * public claim resolves without an API key (the old `library.get`
   * endpoint merged into this one).
   *
   * With a key, also accepts the `taskId` that `verify` returned: a completed
   * run resolves to its verification. A run with no result yet throws
   * {@link LenzVerificationNotReadyError} while it is running or waiting for
   * input, and {@link LenzPipelineError} when it failed. To wait for a run,
   * use `client.wait(taskId)`.
   *
   * Throws {@link LenzGoneError} (HTTP 410) when the account's retention period has removed the verification.
   */
  get(verificationId: string): Promise<Verification>;
  /**
   * Download the warranty certificate for a covered verification.
   *
   * Resolved by (verification, ACCOUNT), not by verification alone: one
   * cached analysis can have several holders, each with their own certificate
   * and their own cap, so this returns YOUR certificate over this analysis
   * and never another customer's.
   *
   * Rejects with a 404 `LenzError` when this verification carries no
   * certificate for your account — which is also what an uncovered verdict
   * returns, so check `verification.coverage?.status` first rather than using
   * a 404 here to mean "not covered".
   *
   * The document is byte-identical to the public
   * `/certificate/<certificate_id>.json`, so it verifies with the published
   * open-source checker without involving Lenz. A withdrawn certificate is
   * still served — it is the record of what was warranted.
   */
  getCertificate(verificationId: string): Promise<Certificate>;
  delete(verificationId: string): Promise<boolean>;
  /**
   * Public verifications semantically related to this one (pgvector ANN).
   * Server clamps `limit` to 10. Excludes the verification itself and
   * editorially-hidden claims. Keyless like the library/detail reads; a
   * key additionally unlocks the caller's own verifications.
   *
   * Throws {@link LenzGoneError} (HTTP 410) when the account's retention period has removed the verification.
   */
  related(
    verificationId: string,
    {
      limit,
    }?: {
      limit?: number;
    },
  ): Promise<RelatedVerifications>;
}
declare class AskNamespace {
  private readonly client;
  constructor(client: Lenz);
  /**
   * The follow-up conversation on a verification.
   *
   * Throws {@link LenzGoneError} (HTTP 410) when the account's retention period has removed the verification.
   */
  history(verificationId: string): Promise<AskHistory>;
  /**
   * Ask a follow-up question about a verification. Paid, one credit per turn.
   *
   * Pass `idempotencyKey` to make a retry safe: with a key, a retry of a
   * question that already got a reply replays that reply rather than asking
   * again. It is never generated here — see {@link AskSendInput.idempotencyKey}.
   *
   * Throws {@link LenzGoneError} (HTTP 410) when the account's retention period has removed the verification.
   */
  send(verificationId: string, input: AskSendInput): Promise<AskReply>;
  reset(verificationId: string): Promise<boolean>;
}
declare class LibraryNamespace {
  private readonly client;
  constructor(client: Lenz);
  list(input?: LibraryListInput): Promise<LibraryList>;
}
export declare class Lenz {
  private apiKey;
  private baseUrl;
  private timeoutMs;
  private maxRetries;
  private fetchImpl;
  readonly verifications: VerificationsNamespace;
  readonly ask: AskNamespace;
  readonly library: LibraryNamespace;
  constructor(opts?: LenzOptions);
  verify(input: VerifyInput): Promise<TaskAccepted>;
  verifyBatch(input: VerifyBatchInput): Promise<BatchAccepted>;
  /**
   * Pull the verifiable claims out of any text. Sync, free, capped at
   * 1000 calls/account/day (shared across your API keys).
   *
   * Pass `focus` to narrow the result to the claims you care about, e.g.
   * `"market size and competitors"`. A focus can only SELECT from the claims
   * the extractor found — see {@link ExtractInput.focus}.
   *
   * Pass `locate: true` to keep only the claims traced back to the text,
   * with where the text makes each one in `locations` (code-point offsets —
   * see {@link Position}).
   *
   * `status` is `"ready"`, `"not_a_claim"` (no verifiable claim in the text
   * at all), or `"no_match"` (claims were found, none fell within `focus`).
   */
  extract(input: ExtractInput): Promise<ExtractedClaims>;
  /**
   * Fast 3-model panel verdict. Sync, ~15s for one claim. Two forms:
   *
   * - `assess({ claim })` — one text; returns one entry per claim found in
   *   it (up to 20, 1 credit each), and the claims past those in
   *   `more_claims`, unchecked and free.
   * - `assess({ claims })` — up to 20 claims in one call (~15s); returns
   *   exactly one entry per item, in the order sent. This is the step after
   *   `extract` in the ladder. A row with `verdict === "Error"` has
   *   `error_code` and `hint` and is free; a compound item is assessed on
   *   its main claim and lists the rest in `identified_claims`.
   *
   * ```ts
   * const out = await client.extract({ text: llmOutput });
   * const claims = (out.claims ?? []).map((c) => c.claim);
   * const quick: AssessClaim[] = []; // one row per claim, same order, 20 claims a call
   * for (let i = 0; i < claims.length; i += 20) {
   *   quick.push(...(await client.assess({ claims: claims.slice(i, i + 20) })).claims);
   * }
   * // verifyBatchAndWait takes up to 20 claims a call: the first 20 here
   * const doubtful = quick
   *   .filter((c) => c.verdict !== "Error" && c.confidence === "low")
   *   .map((c) => ({ claim: c.claim! }))
   *   .slice(0, 20);
   * const results = doubtful.length ? await client.verifyBatchAndWait({ claims: doubtful }) : [];
   * ```
   *
   * The two forms are mutually exclusive — giving `claims` together with a
   * non-empty `claim` / `text` throws `LenzValidationError` before any
   * request is made. For deeper analysis (citations, full audit trail),
   * escalate low-confidence rows to `verifyBatchAndWait`; the endpoints
   * share a result cache server-side.
   *
   * Pass `language: "es"` (or any of the 12 supported codes) to receive
   * the claim text in that language. Verdict labels stay English. Pass
   * `language: "auto"` to receive the answer in the language of the
   * submitted text; with a `claims` list, one language is chosen for the
   * whole request (the language most items agree on, else English), so name
   * a code for a list in mixed languages.
   *
   * Pass `suggestRewrite: true` to also get `suggested_rewrite` on each row
   * the check found `"False"` or `"Mostly False"` with high confidence: the
   * claim with its wrong part corrected. No extra credit; not itself
   * verified.
   */
  assess(input: AssessInput): Promise<AssessResponse>;
  /**
   * Resolve a needs-input interrupt by selecting one or more claims.
   *
   * Each selected claim fans out into its own pipeline; the returned
   * `BatchAccepted` carries one `items` entry (each with its own `task_id`)
   * per claim. Poll each via `getStatus` / `wait`. Every text must match a
   * claim offered in the prior interrupt — the server rejects anything else.
   */
  select(taskId: string, input: SelectInput): Promise<BatchAccepted>;
  /**
   * One non-blocking poll of a task.
   *
   * On a completed task, throws {@link LenzGoneError} (HTTP 410) when the
   * account's retention period has removed the verification. A running task
   * never answers 410.
   */
  getStatus(taskId: string): Promise<TaskStatus>;
  usage(): Promise<Usage>;
  /**
   * Start a review of a draft: Lenz reads its claims, gives each a quick
   * verdict, and deep-checks the ones that look wrong or uncertain.
   * Returns the receipt at once; read the review with `getReview`, wait with
   * `reviewAndWait`, or receive `review.completed` at your webhook.
   *
   * The flat options are sent as the request's `escalate` policy, and only
   * the ones you set: an omitted option takes the server's default. It
   * spends what the calls it makes spend: 1 credit per claim assessed, and
   * 10 (5 at `depth: "low"`) per deep check.
   *
   * A resend with the same `idempotencyKey` within 24 hours returns the same
   * review; a new key is a new review.
   */
  review(input: ReviewInput): Promise<ReviewStarted>;
  private _submitReview;
  /**
   * Read a review. `{ view: "issues" }` returns the envelope without
   * `claims[]`: the issues, the failures and the summary.
   *
   * Throws {@link LenzGoneError} (HTTP 410) when the review was purged.
   */
  getReview(reviewId: string): Promise<ReviewFull>;
  getReview(
    reviewId: string,
    opts: {
      view: "issues";
    },
  ): Promise<ReviewIssues>;
  getReview(
    reviewId: string,
    opts: {
      view: "full";
    },
  ): Promise<ReviewFull>;
  getReview(reviewId: string, opts?: GetReviewOptions): Promise<ReviewFull | ReviewIssues>;
  /**
   * Start a citation check: does each source the text cites (or each pair
   * sent) say what the statement says it does? Send exactly one of `text`
   * and `pairs`; `maxCitations` goes with `text`. Returns the receipt at once;
   * read the check with `getCitecheck`, wait with `citecheckAndWait`, or
   * receive `citecheck.completed` at your webhook.
   */
  citecheck(input: CitecheckInput): Promise<CitecheckStarted>;
  private _submitCitecheck;
  /**
   * Read a citation check. Throws {@link LenzGoneError} (HTTP 410) once the
   * account's retention period has removed it.
   */
  getCitecheck(citecheckId: string): Promise<Citecheck>;
  private _getCitecheck;
  /** The body as the server sent it, before any default is filled. */
  private _readCitecheck;
  /**
   * Start a citation check and poll it until it ends; returns the completed
   * check. Polls on its `poll_after_seconds` (never tighter than 5 s) and
   * calls `onUpdate` on every poll whose body changed. Throws
   * {@link CitecheckFailedError} when the check ends `failed` and
   * {@link CitecheckTimeoutError} (carrying the last body seen) at the
   * deadline, which bounds the submit and every poll.
   */
  citecheckAndWait(input: CitecheckInput, opts?: CitecheckAndWaitOptions): Promise<Citecheck>;
  private _getReview;
  /**
   * Start a review and poll it until it ends; returns the completed review.
   *
   * Polls on the review's `poll_after_seconds` (never tighter than 5 s) and
   * calls `onUpdate` with the review on every poll whose body changed, so a
   * caller can show the quick verdicts as soon as they land. Throws
   * {@link ReviewFailedError} when the review ends `failed` and
   * {@link ReviewTimeoutError} (carrying the last body seen) at the deadline;
   * a transient poll error is retried on the next poll, after the wait the
   * server stated when it stated one (at most 60 s). The deadline bounds the
   * submit and every poll; when the submit used it up, one poll still runs so
   * the timeout can carry `partial`, and a terminal review it reads is
   * returned or thrown as usual.
   */
  reviewAndWait(input: ReviewInput, opts?: ReviewAndWaitOptions): Promise<ReviewFull>;
  /**
   * The poll loop behind every `*AndWait` of an async job (a review, a
   * citation check), from the moment it was accepted to `deadline`.
   */
  private _waitJob;
  /**
   * Submit + poll until the pipeline terminates. Returns the completed
   * Verification, or throws LenzNeedsInputError / LenzPipelineError /
   * LenzTimeoutError. By default sends an auto-generated Idempotency-Key
   * so a network retry on submit doesn't spawn a duplicate task.
   */
  verifyAndWait(input: VerifyAndWaitInput): Promise<Verification>;
  /**
   * Block on an already-submitted task until it terminates, then return its
   * `Verification`. `task` is a `task_id` string OR the `TaskAccepted` returned
   * by `verify` / `select` — so `client.wait(await client.verify({claim}))`
   * reads naturally. Throws for an empty id, `LenzNeedsInputError` /
   * `LenzPipelineError` on terminal non-success, `LenzGoneError` when the
   * verification was removed under its account's retention period, and
   * `LenzTimeoutError` on deadline.
   */
  wait(task: string | TaskAccepted, opts?: WaitOptions): Promise<Verification>;
  /**
   * Submit a batch and poll every item to a terminal state. Returns one
   * `BatchItemResult` per task the batch accepted, in input order. Never throws
   * on a per-item outcome — a claim that fails, pauses, or times out becomes a
   * `BatchItemResult` with the matching `status`. A claim removed under the
   * account's retention period reads `"failed"` with no `status_detail`.
   * (Transport/auth errors on the initial submit still throw.)
   */
  verifyBatchAndWait(input: VerifyBatchAndWaitInput): Promise<BatchItemResult[]>;
  /**
   * Round-robin poll `taskIds` until each reaches a terminal state or the
   * deadline elapses. Returns `{terminal, timedOut, gone}`; a timed-out task
   * has no `TaskStatus` (`"timeout"` is client-side, never a wire status), and
   * a task whose poll threw {@link LenzGoneError} (removed under its account's
   * retention period) is in `gone`, final and never polled again. Any other
   * poll error keeps the task pending.
   *
   * Each round polls every still-pending id once (via `Promise.allSettled`, so
   * one poll's transport failure doesn't abort the batch — that id stays
   * pending and retries next round) BEFORE the deadline check, preserving the
   * legacy `verifyAndWait` behavior of polling once more after sleeping the
   * remaining time. Timeout is therefore approximate. Backoff reuses the
   * existing 2/4/8/8…ms sequence; the 10s cap is currently unreachable and kept
   * only to preserve identical timing.
   */
  private _pollToTerminal;
  /**
   * Map a terminal `TaskStatus` to a `Verification` or throw the matching typed
   * error. Shared by `wait` (and thus `verifyAndWait`).
   */
  private _verificationFromTerminal;
  private submit;
  /** Internal: dispatch an HTTP call with auth + retry. Public so the
   *  namespace classes can use it; not part of the documented surface. */
  request<T>(opts: RequestOptions): Promise<T>;
}
export {};
