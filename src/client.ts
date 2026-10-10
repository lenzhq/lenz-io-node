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
 * Six API calls: `extract`, `assess`, `verify` and `ask` form a
 * research-depth ladder (find claims, judge them fast, prove them deep,
 * follow up); `review` runs it on a whole draft and `citecheck` checks a
 * draft's citations on their own.
 *
 * ```ts
 * import { Lenz, type AssessClaim } from 'lenz-io';
 * const client = new Lenz(); // reads LENZ_API_KEY
 *
 * // 1. extract — pull verifiable claims out of text (free, 1000 calls a day)
 * const out = await client.extract({ text: llmOutput });
 * const claims = (out.claims ?? []).map((c) => c.claim);
 *
 * // 2. assess — a quick verdict per claim: up to 20 claims a call, one row per
 * //    claim in the same order. A row with status 'failed' has no verdict
 * //    (`failure` says why); a compound item lists the rest in more_claims.
 * const quick: AssessClaim[] = [];
 * for (let i = 0; i < claims.length; i += 20) {
 *   quick.push(...(await client.assess({ claims: claims.slice(i, i + 20) })).claims);
 * }
 *
 * // 3. verify — deep-check the low-confidence rows (~90s, paid, 20 a call)
 * const doubtful = quick
 *   .filter((c) => c.status !== 'failed' && c.confidence === 'low' && c.claim)
 *   .map((c) => ({ claim: c.claim! }))
 *   .slice(0, 20);
 * const results = doubtful.length ? await client.verifyBatchAndWait({ claims: doubtful }) : [];
 *
 * // 4. ask — a follow-up question on a completed deep check, when there is one
 * const deep = results.find((r) => r.status === 'completed')?.verification;
 * if (deep?.verification_id) {
 *   const reply = await client.ask.send(deep.verification_id, {
 *     message: 'Which source is strongest?',
 *   });
 *   console.log(reply.content);
 * }
 *
 * // Async verify: submit, then wait (or receive the webhook)
 * const task = await client.verify({ claim: '...' }); // returns task_id
 * const v = await client.wait(task); // block until it lands
 * ```
 */

import {
  LenzAPIError,
  LenzAbortError,
  LenzApiVersionError,
  LenzAuthError,
  LenzConnectionError,
  LenzError,
  LenzGoneError,
  LenzNeedsInputError,
  LenzNotFoundError,
  LenzPipelineError,
  LenzRequestTimeoutError,
  LenzTimeoutError,
  LenzValidationError,
  MAX_RETRY_AFTER_SLEEP,
  CitecheckFailedError,
  CitecheckTimeoutError,
  ReviewFailedError,
  ReviewTimeoutError,
  UPSTREAM_503_CODES,
  mapResponseToError,
} from "./errors.js";
import type {
  AskHistory,
  AskReply,
  AskSendInput,
  AssessInput,
  AssessResponse,
  BatchAccepted,
  CancelResult,
  BatchItemResult,
  Certificate,
  ExtractInput,
  ExtractedClaims,
  LibraryItem,
  LibraryList,
  LibraryListInput,
  OnProgress,
  Progress,
  Citecheck,
  CitecheckAndWaitOptions,
  CitecheckInput,
  CitecheckStarted,
  GetReviewOptions,
  GetStatusOptions,
  RelatedVerifications,
  RequestOptions,
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
  VerificationListItem,
  VerifyAndWaitInput,
  VerifyBatchAndWaitInput,
  VerifyAndWaitOptions,
  VerifyBatchInput,
  VerifyInput,
  WaitOptions,
} from "./types.js";

/**
 * The API version this release asks for, sent on every request as
 * `X-Lenz-API-Version`: the response shape with one name for each field.
 * Every method still returns the 2.x names beside the newer ones, with their
 * 2.x values (see `compat.ts`). Releases before 3.0 sent `2026-05-13`; 3.0
 * reads only the `2026-10-11` shape.
 */
// Typed `string`, not the literal, so a later version is not a type change.
export const API_VERSION: string = "2026-10-11";
export const DEFAULT_BASE_URL = "https://lenz.io/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Floor on the per-call timeout for `assess`, BOTH forms.
 *
 * The server finds the claims and then runs a 3-model panel inside one
 * synchronous request and divides a single budget between them, so a
 * single-claim call can take as long as a list one. Typical calls answer in
 * ~15s, but a long text can use the server's whole 90s budget. The SDK
 * waits 10s longer than that, so it never gives up on a call the server is
 * still working on.
 *
 * Applied to `assess({ claim })` as well as `assess({ claims })` since 2.12.0.
 * Before that the single form used the 30s default, and a call whose framing
 * was slow could time out client-side AFTER the server had charged it — and a
 * retry with no idempotency key charged again.
 */
const ASSESS_TIMEOUT_MS = 100_000;
/**
 * Floor on the per-call timeout for `extract`.
 *
 * Extraction reads the whole input and enumerates its claims inside one
 * synchronous request. Most calls answer in seconds, but a long input can
 * take well past the 30s default, and a client timeout makes the SDK re-send
 * the call. 150s leaves room above the slowest.
 */
const EXTRACT_TIMEOUT_MS = 150_000;
/** Default deadline for `wait`, `verifyAndWait` and `verifyBatchAndWait`. */
const WAIT_DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
const POLL_BACKOFF_MS = [2000, 4000, 8000];
const POLL_BACKOFF_CAP_MS = 10_000;
// Bounds on the server's `progress.poll_after_seconds` (see `pollHintMs`).
const POLL_HINT_MIN_S = 1;
const POLL_HINT_MAX_S = 30;
// `reviewAndWait`: a review takes minutes, so its polls are never tighter
// than this, whatever the body says.
const REVIEW_POLL_FLOOR_S = 5;
const REVIEW_DEFAULT_TIMEOUT_MS = 600_000;
/**
 * `cancelOnAbort`: the whole wall-clock budget, in ms, of the cancels sent
 * after an abort (one attempt each, no retry, no stated wait; a batch's run
 * concurrently inside it). The call throws its `LenzAbortError` once they
 * have answered or this has passed.
 */
const ABORT_CANCEL_BUDGET = 5_000;

/**
 * 429 codes that throw at once instead of sleeping the stated wait.
 * `review_in_flight` means the account already runs its maximum number of
 * reviews, each of which takes minutes: sleeping inside the call would block
 * the caller silently, so it gets the error and its `retryAfter` instead.
 */
const THROW_AT_ONCE_429_CODES: readonly string[] = ["review_in_flight"];

// Generated at build time from package.json#version — see
// scripts/sync-version.mjs. Keeps the User-Agent in lockstep with the
// published package.
import { VERSION as SDK_VERSION } from "./_version.js";
import { withCitecheckDefaults, withReviewDefaults } from "./reviewDefaults.js";
import {
  normalizeAssess,
  normalizeCitecheck,
  normalizeBatchAccepted,
  normalizeExtract,
  CANCELLED_SENTENCE,
  normalizeTaskStatus,
  normalizeUsage,
  normalizeVerification,
  normalizeVerificationList,
} from "./compat.js";

/**
 * Cross-runtime UUID: the WebCrypto global, present in Node >= 20, browsers,
 * Deno, Bun and Workers. It needs no Node built-in, so the package loads
 * on every one of them. Where `randomUUID` is missing (insecure browser
 * origins, Hermes) a version 4 UUID is built from `getRandomValues`.
 */
async function generateUuid(): Promise<string> {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new Error("lenz-io needs WebCrypto (globalThis.crypto) to make an Idempotency-Key.");
  }
  const b = webCrypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The `Idempotency-Key` for one call: the caller's own key, else (unless the
 * caller opted out with `idempotency: false`) a random one generated once per
 * call and reused across that call's own retries, so a retried request is
 * deduped server-side rather than run twice.
 *
 * Deliberately NOT derived from the request body: the same text sent again
 * later is a new request, and a content-derived key would replay the first
 * answer for 24h.
 */
async function callIdempotencyKey(input: {
  idempotencyKey?: string;
  idempotency?: boolean;
}): Promise<string | undefined> {
  if (input.idempotencyKey !== undefined) return input.idempotencyKey;
  if (input.idempotency === false) return undefined;
  return (await generateUuid()).replace(/-/g, "");
}

/**
 * The key of a review or citation check: the caller's, else a random one.
 * Always keyed: this client retries a failed POST, and a retry without a key
 * could start a second job. Never derived from the text: the same draft sent
 * again later is a new job.
 */
async function jobIdempotencyKey(input: { idempotencyKey?: string }): Promise<string> {
  // `||`, not `??`: an empty key would send the job unkeyed, and a retry
  // could then start (and charge for) a second one.
  return input.idempotencyKey || (await generateUuid()).replace(/-/g, "");
}

/**
 * Run a whole `*AndWait` call, stamping its submit's key on any LenzError it
 * throws (a wait's timeout included): resending with that key replays the
 * job already started rather than starting another.
 */
async function withIdempotencyKey<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (exc) {
    stampIdempotencyKey(exc, key);
    throw exc;
  }
}

/** Read an env var without assuming a Node `process` exists (browser-safe). */
function envVar(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

/**
 * Where the client may say what it is doing. Every method is optional; the
 * client is silent without one. `console` fits.
 */
export interface LenzLogger {
  /** A retry of a failed attempt, with the reason and the wait. */
  debug?(message: string): void;
  /** A `verifyAndWait` submission: `[lenz-io] Submitted task: <task_id>`. */
  info?(message: string): void;
  /**
   * A `cancelOnAbort` cancel that failed, or that found the run already
   * ended: `[lenz-io] cancelOnAbort: …`, with the job id only.
   */
  warn?(message: string): void;
}

export interface LenzOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Inject a custom fetch implementation (testing). Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Receives the client's progress lines (`console` works). Without one the
   * client prints nothing; 2.x printed `Submitted task: …` to the console on
   * every `verifyAndWait`.
   */
  logger?: LenzLogger;
}

interface SendOptions {
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
  /**
   * A body key that makes an in-flight 409 (`idempotency_conflict`) the
   * caller's answer rather than a reason to retry: when the 409 names it
   * (e.g. `review_id`), it is thrown at once for the caller to read.
   */
  conflictReceipt?: string;

  /**
   * Signals that stop the call (a `withOptions` copy's and the call's own):
   * when one fires, the attempt is aborted, no retry is made and the call
   * throws `LenzAbortError`.
   */
  signals?: readonly AbortSignal[];
  /**
   * Headers from the request options, already merged and checked. Sent
   * after `User-Agent` / `Accept` (replacing either, in any casing) and
   * before `headers`.
   */
  optionHeaders?: HeaderList;
}

/** Headers from request options, in the order they are sent. */
type HeaderList = ReadonlyArray<readonly [string, string]>;

/** The names request options may not set, lowercased. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "x-lenz-api-version",
  "idempotency-key",
  "authorization",
  "content-type",
  "content-length",
  "host",
  "transfer-encoding",
]);

const NO_SIGNALS: readonly AbortSignal[] = [];
const NO_HEADERS: HeaderList = [];

/** What a `withOptions` copy adds to every call: its signals and headers. */
interface CopyOptions {
  signals: readonly AbortSignal[];
  headers: HeaderList;
}

/** Each client's copy options; a root client has none. */
const COPY_OPTIONS = new WeakMap<object, CopyOptions>();

/** Which request options a method takes. */
type CallKind =
  /** Every request option (a plain call). */
  | "request"
  /** `signal` and `headers` (`wait`): its `timeoutMs` is the wait's budget. */
  | "wait"
  /** `signal`, `headers` and `maxRetries` (the submit's), for the `*AndWait` calls. */
  | "submitWait";

/** A call's request options, resolved against the client's copy options. */
interface Call {
  /** The copy's signals, then the call's. */
  signals: readonly AbortSignal[];
  /** The copy's headers with the call's merged over them. */
  headers: HeaderList;
  /** The call's own attempt timeout, when it set one. */
  timeoutMs?: number;
  /** The call's own retries, when it set them. */
  maxRetries?: number;
  /**
   * The call's own options, copied when the call was made (its headers
   * object too), so a caller changing its objects later changes nothing:
   * what a nested public call (each page of a `listAll`, a wait's
   * `getStatus`, `verifyBatchAndWait`'s `verifyBatch`) is handed, since it
   * merges the copy's itself.
   */
  own: RequestOptions;
}

/** The longest delay a timer can hold (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A per-request timeout: a finite number of ms above 0 and at most
 * `MAX_TIMEOUT_MS`, or not given. `legacy` names a field 2.x already took
 * (the constructor's, the input's), where `null` still means "not given".
 */
function checkTimeoutMs(value: unknown, where: string, legacy = false): void {
  if (value === undefined || (legacy && value === null)) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${where}: timeoutMs must be a finite number of milliseconds above 0 (got ${String(value)}).`,
    );
  }
  if (value > MAX_TIMEOUT_MS) {
    throw new Error(
      `${where}: timeoutMs must be at most ${MAX_TIMEOUT_MS} ms, the longest a timer can wait ` +
        `(got ${String(value)}).`,
    );
  }
}

/**
 * A per-request retry count: a whole number, 0 or more, or not given.
 * `legacy` as for `checkTimeoutMs`.
 */
function checkMaxRetries(value: unknown, where: string, legacy = false): void {
  if (value === undefined || (legacy && value === null)) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `${where}: maxRetries must be a whole number, 0 or more (got ${String(value)}).`,
    );
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["aborted"] === "boolean" &&
    typeof v["addEventListener"] === "function" &&
    typeof v["removeEventListener"] === "function"
  );
}

function checkHeaders(headers: unknown, where: string): void {
  if (headers === undefined) return;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error(`${where}: headers must be an object of header names and values.`);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) {
      throw new Error(`${where}: ${JSON.stringify(name)} is not a valid header name.`);
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new Error(
        `${where}: the ${name} header is set by the client and cannot be sent as an option ` +
          "(use idempotencyKey for Idempotency-Key and apiKey for Authorization).",
      );
    }
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new Error(
        `${where}: the value of header ${name} must be a string, or null to remove it.`,
      );
    }
    if (typeof value === "string" && !isHeaderValue(value)) {
      throw new Error(
        `${where}: the value of header ${name} must be a string of visible ASCII characters, ` +
          "with spaces and tabs only between them (not at either end), or null.",
      );
    }
  }
}

/** A header name: an RFC 7230 token. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A header value: visible ASCII, with spaces and tabs only between visible
 * characters (never at either end, which fetch would strip), or empty.
 */
const HEADER_VALUE = /^(?:[\x21-\x7e](?:[\t\x20-\x7e]*[\x21-\x7e])?)?$/;

function isHeaderValue(value: string): boolean {
  return HEADER_VALUE.test(value);
}

/** Checks the request options a method takes, before any key or request. */
function checkOptions(options: unknown, where: string, kind: CallKind): RequestOptions {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`${where}: options must be an object.`);
  }
  const o = options as RequestOptions;
  if (o.signal !== undefined && !isAbortSignal(o.signal)) {
    throw new Error(`${where}: signal must be an AbortSignal.`);
  }
  if (kind === "request") checkTimeoutMs(o.timeoutMs, where);
  if (kind === "wait" && o.maxRetries !== undefined) {
    throw new Error(
      `${where}: a wait takes no maxRetries (each poll uses the client's); ` +
        "set it on a copy with withOptions({ maxRetries }).",
    );
  }
  if (kind !== "wait") checkMaxRetries(o.maxRetries, where);
  checkHeaders(o.headers, where);
  const cancelOnAbort = (o as { cancelOnAbort?: unknown }).cancelOnAbort;
  if (cancelOnAbort !== undefined) {
    if (kind === "request") {
      throw new Error(
        `${where}: cancelOnAbort is an option of one wait (wait, verifyAndWait, ` +
          "verifyBatchAndWait, reviewAndWait, citecheckAndWait); pass it to the call.",
      );
    }
    if (typeof cancelOnAbort !== "boolean") {
      throw new Error(
        `${where}: cancelOnAbort must be true or false (got ${String(cancelOnAbort)}).`,
      );
    }
  }
  return o;
}

/**
 * Headers merged without regard to case: a later spelling of a name replaces
 * an earlier one, value and spelling, in the earlier one's place; `null`
 * removes it; `undefined` is not given.
 */
function mergeHeaders(
  base: HeaderList,
  add: Record<string, string | null | undefined> | undefined,
): HeaderList {
  if (!add) return base;
  const out = new Map<string, readonly [string, string]>();
  for (const [name, value] of base) out.set(name.toLowerCase(), [name, value]);
  for (const [name, value] of Object.entries(add)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    // A name set again keeps its place on the wire; its spelling and value change.
    if (value === null) out.delete(lower);
    else out.set(lower, [name, value]);
  }
  return [...out.values()];
}

/** The first of `signals` that has fired, if any. */
function firedSignal(signals: readonly AbortSignal[]): AbortSignal | undefined {
  for (const signal of signals) if (signal.aborted) return signal;
  return undefined;
}

function abortError(signal: AbortSignal): LenzAbortError {
  return new LenzAbortError("The call was aborted by its signal.", { cause: signal.reason });
}

/** Throws `LenzAbortError` when one of `signals` has fired. */
function throwIfAborted(signals: readonly AbortSignal[]): void {
  const fired = firedSignal(signals);
  if (fired) throw abortError(fired);
}

/**
 * The rule at every `catch` a call passes through: when the caller's signal
 * has fired, the error is the abort, never a retry, a timeout or a mapped
 * API error. A `LenzAbortError` already thrown is passed on as it is.
 */
function rethrowIfCallerAbort(signals: readonly AbortSignal[], exc?: unknown): void {
  if (exc instanceof LenzAbortError) throw exc;
  throwIfAborted(signals);
}

/**
 * Links `signals` to one attempt's controller: when one fires, the attempt is
 * aborted. The listeners are removed by `unlink`, so a long-lived signal
 * gathers none.
 */
function linkSignals(
  signals: readonly AbortSignal[],
  controller: AbortController,
): { unlink: () => void } {
  if (signals.length === 0) return { unlink: () => {} };
  const onAbort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    unlink: () => {
      for (const signal of signals) signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * `promise`, or `LenzAbortError` as soon as one of `signals` fires: for a
 * public method an override may have replaced (a 2.21 `getStatus` or
 * `verifyBatch` ignores the signal).
 */
async function raceAbort<T>(
  promise: Promise<T>,
  signals: readonly AbortSignal[],
  others: ReadonlyArray<Promise<never>> = [],
): Promise<T> {
  if (signals.length === 0) return others.length ? Promise.race([promise, ...others]) : promise;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_res, rej) => {
    onAbort = () => rej(abortError(firedSignal(signals) ?? signals[0]!));
  });
  // A rejection after the call settled has no reader.
  aborted.catch(() => {});
  const fired = firedSignal(signals);
  if (fired) onAbort();
  else for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted, ...others]);
  } finally {
    for (const signal of signals) signal.removeEventListener("abort", onAbort);
  }
}

type AbortContext = Partial<
  Pick<LenzAbortError, "taskId" | "taskIds" | "batchId" | "reviewId" | "citecheckId">
>;

/** Runs `run`, adding what the call knows to a `LenzAbortError` it throws. */
async function withAbortContext<T>(context: AbortContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (exc) {
    if (exc instanceof LenzAbortError) {
      for (const [key, value] of Object.entries(context) as Array<[keyof AbortContext, never]>) {
        if (exc[key] === undefined && value !== undefined) exc[key] = value;
      }
    }
    throw exc;
  }
}

/**
 * The request options of a call, checked and resolved against `client`'s
 * copy options. Throws before any key is made or request sent: a bad value,
 * then, when `checkAbort`, a signal that has already fired.
 */
function resolveCall(
  client: object,
  options: unknown,
  where: string,
  kind: CallKind = "request",
  checkAbort = true,
): Call {
  const o = snapshotOptions(checkOptions(options, where, kind), kind);
  const copy = COPY_OPTIONS.get(client);
  const signals = o.signal
    ? [...(copy?.signals ?? NO_SIGNALS), o.signal]
    : (copy?.signals ?? NO_SIGNALS);
  const call: Call = {
    signals,
    headers: mergeHeaders(copy?.headers ?? NO_HEADERS, o.headers),
    own: o,
  };
  if (o.timeoutMs !== undefined) call.timeoutMs = o.timeoutMs;
  if (o.maxRetries !== undefined) call.maxRetries = o.maxRetries;
  if (checkAbort) throwIfAborted(signals);
  return call;
}

/** The request options a method takes, copied: only the fields given, headers copied too. */
function snapshotOptions(o: RequestOptions, kind: CallKind): RequestOptions {
  const out: RequestOptions = {};
  if (o.signal !== undefined) out.signal = o.signal;
  if (kind === "request" && o.timeoutMs !== undefined) out.timeoutMs = o.timeoutMs;
  if (kind !== "wait" && o.maxRetries !== undefined) out.maxRetries = o.maxRetries;
  if (o.headers !== undefined) out.headers = { ...o.headers };
  return out;
}

/** What a resolved call hands its request. */
function transportOf(
  call: Call,
): Pick<SendOptions, "signals" | "optionHeaders" | "timeoutMs" | "maxRetries"> {
  const t: Pick<SendOptions, "signals" | "optionHeaders" | "timeoutMs" | "maxRetries"> = {
    signals: call.signals,
    optionHeaders: call.headers,
  };
  if (call.timeoutMs !== undefined) t.timeoutMs = call.timeoutMs;
  if (call.maxRetries !== undefined) t.maxRetries = call.maxRetries;
  return t;
}

/** The call's own signal and headers (as copied), for a nested public call; only the ones given. */
function ownOptions(call: Call): RequestOptions {
  const out: RequestOptions = {};
  if (call.own.signal !== undefined) out.signal = call.own.signal;
  if (call.own.headers !== undefined) out.headers = call.own.headers;
  return out;
}

/** The `Idempotency-Key` among `headers`, in any casing, or `undefined`. */
function idempotencyKeyIn(headers: Record<string, string> | undefined): string | undefined {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === "idempotency-key" && value) return value;
  }
  return undefined;
}

/**
 * Stamp the call's `Idempotency-Key` on an error it throws, so the caller
 * can resend with the same key. A key already stamped stays.
 *
 * Not only on a LenzError: a response body that breaks off after the headers
 * (the server may well have done the work) throws the runtime's own error, as
 * in 2.x, and it carries the key too. Its class is never changed, so a 2.x
 * `catch` keeps matching it.
 */
function stampIdempotencyKey(exc: unknown, key: string | undefined): void {
  if (!key) return;
  if (exc instanceof LenzError || exc instanceof LenzAbortError) {
    if (exc.idempotencyKey === undefined) exc.idempotencyKey = key;
    return;
  }
  if (exc instanceof Error && !("idempotencyKey" in exc)) {
    try {
      (exc as Error & { idempotencyKey?: string }).idempotencyKey = key;
    } catch {
      // A frozen error object keeps what it has.
    }
  }
}

/** Whether a 409 body names `key` with a non-empty string. */
async function bodyNames(response: Response, key: string): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" && value !== "";
  } catch {
    return false;
  }
}

const REVIEW_STATUSES: readonly string[] = [
  "queued",
  "assessing",
  "verifying",
  "completed",
  "failed",
  "cancelled",
];

/**
 * Every item of a paginated list, one page request at a time, from the page
 * `first` asks for. Stops after a page that is short or empty, that reaches
 * `total` (`page * page_size >= total`), or that states no usable
 * `page_size`; a response for another page than the one asked for (a server
 * that clamps a page past the end) ends the walk without yielding it. Nothing
 * is fetched before the first item is asked for, and no page ahead of the
 * one being read.
 */
async function* walkPages<T>(
  read: (
    page: number,
  ) => Promise<{ items?: T[]; page_size?: number; page?: number; total?: number }>,
  first: number,
  signals: readonly AbortSignal[] = NO_SIGNALS,
): AsyncGenerator<T, void, undefined> {
  for (let page = first; ; page++) {
    const body = await read(page);
    if (typeof body.page === "number" && body.page !== page) return;
    const items = Array.isArray(body.items) ? body.items : [];
    // The signal stops delivery too, not only the page requests: an item
    // already read is not handed out once it has fired.
    for (const item of items) {
      throwIfAborted(signals);
      yield item;
    }
    const size = body.page_size;
    if (items.length === 0 || typeof size !== "number" || !(size > 0) || items.length < size) {
      return;
    }
    if (typeof body.total === "number" && page * size >= body.total) return;
  }
}

/** The start page of a `listAll`: a whole number from 1, checked when it is called. */
function startPage(page: number | undefined): number {
  const first = page ?? 1;
  if (!Number.isInteger(first) || first < 1) {
    throw new Error(`listAll needs a whole start page of 1 or more (got ${String(page)}).`);
  }
  return first;
}

function isPlainObject(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** THIS citation check: its id, a known status, its three lists, its summary and credits. */
function isCitecheckBody(body: unknown, citecheckId: string): body is Citecheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return (
    b["citecheck_id"] === citecheckId &&
    typeof b["status"] === "string" &&
    ["queued", "checking", "completed", "failed", "cancelled"].includes(b["status"]) &&
    Array.isArray(b["citations"]) &&
    Array.isArray(b["citation_issues"]) &&
    Array.isArray(b["citation_failures"]) &&
    isPlainObject(b["summary"]) &&
    isPlainObject(b["credits"])
  );
}

/** The full view of THIS review: its id, a known status, and every list. */
function isReviewBody(body: unknown, reviewId: string): body is ReviewFull {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return (
    b["review_id"] === reviewId &&
    typeof b["status"] === "string" &&
    REVIEW_STATUSES.includes(b["status"]) &&
    Array.isArray(b["issues"]) &&
    Array.isArray(b["failures"]) &&
    Array.isArray(b["claims"])
  );
}

const REVIEW_LISTS = ["issues", "failures", "claims"] as const;
const CITECHECK_LISTS = ["citations", "citation_issues", "citation_failures"] as const;

/**
 * Whether a cancel answer is the job asked for: its id, a status and its
 * three lists (any status: a cancel answers with whatever state the job is in).
 */
function isJobBody(body: unknown, idField: string, id: string, lists: readonly string[]): boolean {
  if (!isPlainObject(body)) return false;
  const b = body as Record<string, unknown>;
  return (
    b[idField] === id && typeof b["status"] === "string" && lists.every((k) => Array.isArray(b[k]))
  );
}

/** A 200 whose body is not the thing asked for (a proxy page, another job's body). */
function unexpectedAnswer(method: string, path: string): LenzAPIError {
  return new LenzAPIError({
    message: `${method} ${path} returned an unexpected response body.`,
    cause: "The answer is not the shape the API documents for this call.",
    fix: "Retry; if it persists, contact support (https://lenz.io/contact) with the request id.",
    docUrl: "https://lenz.io/docs/errors",
  });
}

/**
 * The errors a request's transport raised (a body that broke off or did not
 * decode), remembered without touching them (a frozen error included), so a
 * poll loop can tell them from a programming error. The request still throws
 * them as they are.
 */
const TRANSPORT_FAILURES = new WeakSet<object>();

function recordTransportFailure(exc: unknown): void {
  if ((typeof exc === "object" && exc !== null) || typeof exc === "function") {
    TRANSPORT_FAILURES.add(exc as object);
  }
}

/**
 * Whether a poll's error is worth polling again for: a Lenz answer, or a
 * transport failure. A thrown primitive is read as one too: a stream can
 * reject with one and it cannot be remembered. Any other object that is not
 * a `LenzError` is a programming error (an override's bug), and ends a wait.
 */
function isPollableError(exc: unknown): boolean {
  if (exc instanceof LenzError) return true;
  if ((typeof exc === "object" && exc !== null) || typeof exc === "function") {
    return TRANSPORT_FAILURES.has(exc as object);
  }
  return true;
}

/**
 * A batch poll's answer that ends the whole wait: the call's own refusal of an
 * id, a refused key, or a programming error. Never the caller's abort, which
 * is handled after the round.
 */
function isFatalPollError(exc: unknown): boolean {
  if (exc instanceof LenzAbortError) return false;
  return exc instanceof InvalidIdError || exc instanceof LenzAuthError || !isPollableError(exc);
}

function isRateLimit(exc: unknown): boolean {
  return exc instanceof LenzError && exc.statusCode === 429;
}

/**
 * An id as it goes into a request path, or `null` when it cannot name one
 * thing: empty, `.` or `..` (a path segment that climbs or stays put), or text
 * `encodeURIComponent` refuses (a lone surrogate). Any other id is encoded
 * exactly as before.
 */
function pathId(id: string): string | null {
  if (!id || id === "." || id === "..") return null;
  try {
    return encodeURIComponent(id);
  } catch {
    return null;
  }
}

/**
 * The local error of a call given an id that cannot name one thing. A class of
 * its own so the poll loops can tell it from a failed poll: waiting does not
 * change it.
 */
class InvalidIdError extends Error {}

/** `pathId`, or the local error a call throws instead of sending a request. */
function requirePathId(method: string, field: string, id: string): string {
  const encoded = pathId(id);
  if (encoded !== null) return encoded;
  throw new InvalidIdError(
    id
      ? `${method}() was given an invalid ${field}.`
      : `${method}() requires a non-empty ${field}.`,
  );
}

/**
 * An id the API handed back in an acceptance body, checked before any poll
 * uses it. One it cannot be polled by is a bad answer from the server (not a
 * mistake of the caller's), so a LenzAPIError, raised at once.
 */
function acceptedId(field: string, id: unknown): string {
  if (typeof id === "string" && pathId(id) !== null) return id;
  throw new LenzAPIError({
    message: `The API accepted the request with an invalid ${field}.`,
    cause: `The acceptance body carries no usable ${field}.`,
    fix: "Retry the request; contact support with the request id if this persists.",
    docUrl: "https://lenz.io/docs/errors",
  });
}

/** Sleeps `ms`; rejects with `LenzAbortError` as soon as one of `signals` fires. */
function sleep(ms: number, signals: readonly AbortSignal[] = NO_SIGNALS): Promise<void> {
  if (signals.length === 0) return new Promise((res) => setTimeout(res, ms));
  return new Promise((res, rej) => {
    const fired = firedSignal(signals);
    if (fired) {
      rej(abortError(fired));
      return;
    }
    const unlink = () => {
      for (const signal of signals) signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      clearTimeout(timer);
      unlink();
      rej(abortError(firedSignal(signals) ?? signals[0]!));
    };
    const timer = setTimeout(() => {
      unlink();
      res();
    }, ms);
    for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retrySleepMs(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] ?? 4000;
}

/**
 * Seconds the server says to wait, or `null` if it didn't say.
 *
 * Header first, then the body — `reset_in_seconds` (the 429 shapes), then
 * `retry_after` (the 503 shapes). Returns `null` — not `0` — when none of
 * them states a wait, so the caller can tell "server stated no wait" from
 * "server said wait 0 seconds" and fall back to its own backoff.
 *
 * Reads the body off a `clone()`: the original response is consumed once by
 * `response.text()` on the throw path, and a `Response` body can only be read
 * once. The clone keeps the Python SDK's body-fallback behavior available here
 * without stealing it — parity between the two SDKs is a stated invariant, and
 * every 429 carrying its wait only in the body (a proxy stripping the header,
 * a future endpoint) would otherwise burn the whole retry ladder in Node while
 * Python raised on the first call.
 */
async function statedRetryAfterSeconds(response: Response): Promise<number | null> {
  let raw: unknown = response.headers.get("Retry-After");
  if (raw === null || String(raw).trim() === "") {
    try {
      const body: unknown = await response.clone().json();
      const bag = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
      // 429 shapes carry `reset_in_seconds`; the 503 shapes carry the wait
      // under `retry_after`. Fall through on an EMPTY value too, not just on
      // null/undefined — `??` alone would let `reset_in_seconds: ""` mask a
      // real `retry_after`, which is not what the Python SDK does.
      // `retry_after_seconds` is the /review endpoints' name for the same wait.
      let candidate: unknown = null;
      for (const key of ["reset_in_seconds", "retry_after", "retry_after_seconds"]) {
        candidate = bag ? bag[key] : null;
        if (candidate !== null && candidate !== undefined && String(candidate).trim() !== "") break;
      }
      raw = candidate ?? null;
    } catch {
      // A non-JSON body is not exceptional — fall back to backoff.
      return null;
    }
  }
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = Number(raw);
  // Floored at zero: `Retry-After: -5` is malformed, and a negative delay
  // triggers a TimeoutNegativeWarning on stderr.
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

/**
 * Whether `verify` / `verifyBatch` send a `webhook_url`. An unset, empty or
 * blank one is left out, which means the credential's default URL, as it did
 * in 2.x (where the API read `""` that way); the API version this release
 * asks for reads a blank value as "no webhook", so it is never sent.
 */
function sendsWebhookUrl(url: unknown): boolean {
  return typeof url === "string" ? url.trim() !== "" : Boolean(url);
}

/**
 * The wait options of `verifyAndWait` / `verifyBatchAndWait`: the second
 * argument's, field by field, else the ones 2.x read from the input.
 */
function waitOptions(
  input: { timeoutMs?: number; onProgress?: OnProgress },
  opts: WaitOptions,
): { timeoutMs: number; onProgress: OnProgress | undefined } {
  return {
    timeoutMs: opts.timeoutMs ?? input.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS,
    onProgress: opts.onProgress ?? input.onProgress,
  };
}

/** The camelCase names a batch item takes beside its 2.x snake_case ones. */
const BATCH_ITEM_ALIASES: Readonly<Record<string, string>> = {
  sourceUrl: "source_url",
  webhookUrl: "webhook_url",
};

/** The camelCase names a citation pair takes beside its 2.x snake_case ones. */
const CITATION_PAIR_ALIASES: Readonly<Record<string, string>> = {
  citedTitle: "cited_title",
  citedAuthors: "cited_authors",
  citedYear: "cited_year",
  citedJournal: "cited_journal",
};

/**
 * Equal for an alias pair: `Object.is` (so `NaN` equals `NaN`), with arrays
 * equal element by element, in order, at any depth.
 */
function sameAliasValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameAliasValue(v, b[i]));
  }
  return Object.is(a, b);
}

/** Whether a value counts as not given. */
type IsAbsent = (snake: string, value: unknown) => boolean;

/** On a citation pair only `undefined` is absent: anything else is sent. */
const undefinedIsAbsent: IsAbsent = (_snake, value) => value === undefined;

/**
 * On a batch item, a value 2.x ignored is absent: `undefined` or `null`, an
 * empty `source_url` (sent as `""` either way), and a `webhook_url` it did
 * not send (empty or blank).
 */
const batchItemAbsent: IsAbsent = (snake, value) => {
  if (value === undefined || value === null) return true;
  if (snake === "source_url") return value === "";
  if (snake === "webhook_url") return !sendsWebhookUrl(value);
  return false;
};

/**
 * Throws when an input gives both spellings of a field with different
 * values. Only the alias pairs are checked.
 */
function checkAliases(
  input: Record<string, unknown>,
  aliases: Readonly<Record<string, string>>,
  where: string,
  isAbsent: IsAbsent,
): void {
  for (const [camel, snake] of Object.entries(aliases)) {
    const a = input[camel];
    const b = input[snake];
    if (!isAbsent(snake, a) && !isAbsent(snake, b) && !sameAliasValue(a, b)) {
      throw new Error(`${where}: ${camel} and ${snake} differ; send one of them.`);
    }
  }
}

/**
 * Citation pairs as the API names their fields. A pair's own enumerable keys
 * are read (the ones it is serialized with). Pairs with no camelCase key
 * go as given (the same array when none has one), so a 2.x call sends the
 * same bytes; a pair with one is copied with the key renamed in place.
 */
function pairsToWire(pairs: unknown): unknown {
  if (!Array.isArray(pairs)) return pairs;
  let changed = false;
  const out = pairs.map((pair: unknown, i) => {
    if (pair === null || typeof pair !== "object" || Array.isArray(pair)) return pair;
    const fields = pair as Record<string, unknown>;
    checkAliases(fields, CITATION_PAIR_ALIASES, `citecheck() pairs[${i}]`, undefinedIsAbsent);
    const wire = toWireNames(fields, CITATION_PAIR_ALIASES);
    if (wire !== fields) changed = true;
    return wire;
  });
  return changed ? out : pairs;
}

/**
 * A batch item's value for an alias pair: the snake_case one when given, else
 * the camelCase one, else whatever (absent) value the snake_case name holds.
 */
function batchItemValue(input: Record<string, unknown>, camel: string, snake: string): unknown {
  if (!batchItemAbsent(snake, input[snake])) return input[snake];
  if (!batchItemAbsent(snake, input[camel])) return input[camel];
  return input[snake];
}

/**
 * The object with each camelCase alias renamed to its wire name, at the
 * same place in the caller's key order. An object with no alias key is
 * returned as it is (the same object), so a 2.x input sends the same bytes.
 * The input is never changed.
 */
function toWireNames(
  input: Record<string, unknown>,
  aliases: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const keys = Object.keys(input);
  if (!keys.some((k) => Object.hasOwn(aliases, k))) return input;
  const snakes = new Set(Object.values(aliases));
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const value = input[k];
    const camel = Object.hasOwn(aliases, k);
    // An unset spelling of an aliased field is absent: the other one places it.
    if (value === undefined && (camel || snakes.has(k))) continue;
    const name = camel ? aliases[k]! : k;
    // Both spellings given (equal, checked before): the first one places it.
    if (Object.hasOwn(out, name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * The server's machine-readable `code` from the response body, or `""`.
 *
 * Reads it exactly the way `mapResponseToError` does — string-typed only, so
 * a malformed `code: 42` reads as `""` rather than `"42"` and nothing
 * branches on a value the server never meant as a code.
 *
 * Reads off a `clone()` for the same reason `statedRetryAfterSeconds` does:
 * the original body is consumed once by `response.text()` on the throw path,
 * and a `Response` body can only be read once.
 */
async function bodyErrorCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.clone().json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return "";
    const code = (body as Record<string, unknown>)["code"];
    return typeof code === "string" ? code : "";
  } catch {
    return "";
  }
}

/**
 * Whether a stated wait past the cap should abort instead of back off.
 *
 * True for 429 (always) and for a 503 the server typed as its own
 * shed/exhaustion response. An untyped 503 — the ordinary proxy / maintenance
 * shape — is deliberately false: it keeps the ladder.
 */
/** Seconds to wait before the next review poll: the body's hint, floored. */
function reviewPollMs(review: { poll_after_seconds?: unknown } | null): number {
  const hint = review?.poll_after_seconds;
  const seconds =
    typeof hint === "number" && Number.isFinite(hint)
      ? Math.max(hint, REVIEW_POLL_FLOOR_S)
      : REVIEW_POLL_FLOOR_S;
  return seconds * 1000;
}

async function abortsOnLongStatedWait(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 503) return false;
  return UPSTREAM_503_CODES.includes(await bodyErrorCode(response));
}

function pollSleepMs(idx: number, remainingMs: number): number {
  const base = POLL_BACKOFF_MS[Math.min(idx, POLL_BACKOFF_MS.length - 1)] ?? POLL_BACKOFF_CAP_MS;
  return Math.min(base, POLL_BACKOFF_CAP_MS, Math.max(0, remainingMs));
}

/**
 * The server's suggested wait before the next poll, in ms, or `undefined`.
 *
 * Distinct from the `Retry-After` handling in the error-retry ladder, which
 * means "you errored, back off". This one means "you are fine, look again
 * shortly" and rides in the body — `Retry-After` on a 200 is off-spec enough
 * that a proxy may drop it, and a header never appears in the OpenAPI schema.
 *
 * Out-of-range values fall back to the local ladder: the floor stops a bad
 * value turning the loop hot, the ceiling stops it stalling a wait well
 * inside its own timeout.
 */
function pollHintMs(progress: Progress | undefined): number | undefined {
  const value = progress?.poll_after_seconds;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < POLL_HINT_MIN_S || value > POLL_HINT_MAX_S) return undefined;
  return value * 1000;
}

class VerificationsNamespace {
  constructor(private readonly client: Lenz) {}

  async list({
    page = 1,
    ...options
  }: { page?: number } & RequestOptions = {}): Promise<VerificationList> {
    const call = resolveCall(this.client, options, "verifications.list");
    const body = await this.client.request<VerificationList>({
      method: "GET",
      path: "/verifications",
      query: { page },
      ...transportOf(call),
    });
    return normalizeVerificationList(body) as VerificationList;
  }

  /**
   * Every verification of the account, newest first, across pages:
   *
   * ```ts
   * for await (const v of client.verifications.listAll()) console.log(v.verification_id);
   * ```
   *
   * One `list` request per page, made when the previous page has been read;
   * starts at `page` (default 1; a page below 1 throws when called) and stops
   * on a short or empty page, or one that reaches `total`.
   *
   * The request options apply to every page request; they are checked when
   * `listAll` is called. A `signal` also stops the items of a page already
   * read: once it fires, the next item throws `LenzAbortError`.
   */
  listAll({
    page,
    ...options
  }: { page?: number } & RequestOptions = {}): AsyncIterable<VerificationListItem> {
    const first = startPage(page);
    const call = resolveCall(this.client, options, "verifications.listAll", "request", false);
    // Every page uses the options as they were when listAll was called.
    return walkPages((p) => this.list({ ...call.own, page: p }), first, call.signals);
  }

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
  async get(verificationId: string, options?: RequestOptions): Promise<Verification> {
    const id = requirePathId("verifications.get", "verification_id", verificationId);
    const call = resolveCall(this.client, options, "verifications.get");
    const body = await this.client.request<Verification>({
      method: "GET",
      path: `/verifications/${id}`,
      authRequired: false,
      authOptional: true, // send the key if we have one → owner sees private rows
      ...transportOf(call),
    });
    return normalizeVerification(body) as Verification;
  }

  /**
   * Download the warranty certificate for a covered verification.
   *
   * Resolved by (verification, ACCOUNT), not by verification alone: one
   * cached analysis can have several holders, each with their own certificate
   * and their own cap, so this returns YOUR certificate over this analysis
   * and never another customer's.
   *
   * Rejects with {@link LenzNotFoundError} (404) when this verification carries no
   * certificate for your account — which is also what an uncovered verdict
   * returns, so check `verification.coverage?.status` first rather than using
   * a 404 here to mean "not covered".
   *
   * The document is byte-identical to the public
   * `/certificate/<certificate_id>.json`, so it verifies with the published
   * open-source checker without involving Lenz. A withdrawn certificate is
   * still served — it is the record of what was warranted.
   */
  async getCertificate(verificationId: string, options?: RequestOptions): Promise<Certificate> {
    const id = requirePathId("verifications.getCertificate", "verification_id", verificationId);
    const call = resolveCall(this.client, options, "verifications.getCertificate");
    return this.client.request<Certificate>({
      method: "GET",
      path: `/verifications/${id}/certificate`,
      ...transportOf(call),
    });
  }

  async delete(verificationId: string, options?: RequestOptions): Promise<boolean> {
    const id = requirePathId("verifications.delete", "verification_id", verificationId);
    const call = resolveCall(this.client, options, "verifications.delete");
    try {
      await this.client.request<unknown>({
        method: "DELETE",
        path: `/verifications/${id}`,
        ...transportOf(call),
      });
      return true;
    } catch (exc) {
      // Idempotent DELETE: 404 after retry means the row was already gone.
      // A 404 in another API version is not read as this one's.
      if (exc instanceof LenzApiVersionError) throw exc;
      if (exc instanceof LenzError && exc.statusCode === 404) return true;
      throw exc;
    }
  }

  /**
   * Public verifications semantically related to this one (pgvector ANN).
   * Server clamps `limit` to 10. Excludes the verification itself and
   * editorially-hidden claims. Keyless like the library/detail reads; a
   * key additionally unlocks the caller's own verifications.
   *
   * Throws {@link LenzGoneError} (HTTP 410) when the account's retention period has removed the verification.
   */
  async related(
    verificationId: string,
    { limit = 5, ...options }: { limit?: number } & RequestOptions = {},
  ): Promise<RelatedVerifications> {
    const id = requirePathId("verifications.related", "verification_id", verificationId);
    const call = resolveCall(this.client, options, "verifications.related");
    return this.client.request<RelatedVerifications>({
      method: "GET",
      path: `/verifications/${id}/related`,
      query: { limit },
      authRequired: false,
      authOptional: true, // send the key if we have one → owner sees own rows
      ...transportOf(call),
    });
  }
}

class AskNamespace {
  constructor(private readonly client: Lenz) {}

  /**
   * The follow-up conversation on a verification.
   *
   * Throws {@link LenzGoneError} (HTTP 410) when the account's retention period has removed the verification.
   */
  async history(verificationId: string, options?: RequestOptions): Promise<AskHistory> {
    const id = requirePathId("ask.history", "verification_id", verificationId);
    const call = resolveCall(this.client, options, "ask.history");
    return this.client.request<AskHistory>({
      method: "GET",
      path: `/ask/${id}`,
      ...transportOf(call),
    });
  }

  /**
   * Ask a follow-up question about a verification. Paid, one credit per turn.
   *
   * Sends a random `Idempotency-Key` per call, reused across this client's
   * own retries, so a retried question replays its reply rather than asking
   * (and charging) again. Pin one with `idempotencyKey`, or send none with
   * `idempotency: false`. See {@link AskSendInput.idempotencyKey}.
   *
   * Throws {@link LenzGoneError} (HTTP 410) when the account's retention period has removed the verification.
   */
  async send(
    verificationId: string,
    input: AskSendInput,
    options?: RequestOptions,
  ): Promise<AskReply> {
    const id = requirePathId("ask.send", "verification_id", verificationId);
    const call = resolveCall(this.client, options, "ask.send");
    const body: Record<string, unknown> = { message: input.message };
    if (input.language) body.language = input.language;
    const idempotencyKey = await callIdempotencyKey(input);
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return this.client.request<AskReply>({
      method: "POST",
      path: `/ask/${id}`,
      json: body,
      headers,
      ...transportOf(call),
    });
  }

  async reset(verificationId: string, options?: RequestOptions): Promise<boolean> {
    const id = requirePathId("ask.reset", "verification_id", verificationId);
    const call = resolveCall(this.client, options, "ask.reset");
    await this.client.request<unknown>({
      method: "DELETE",
      path: `/ask/${id}`,
      ...transportOf(call),
    });
    return true;
  }
}

class LibraryNamespace {
  constructor(private readonly client: Lenz) {}

  async list(input: LibraryListInput = {}, options?: RequestOptions): Promise<LibraryList> {
    const call = resolveCall(this.client, options, "library.list");
    const body = await this.client.request<LibraryList>({
      method: "GET",
      path: "/library",
      query: {
        page: input.page ?? 1,
        sort: input.sort ?? "recent",
        search: input.search,
        domain: input.domain,
        entity: input.entity,
        curated: input.curated?.length ? input.curated.join(",") : undefined,
        verdict: input.verdict,
      },
      authRequired: false,
      ...transportOf(call),
    });
    return normalizeVerificationList(body) as LibraryList;
  }

  /**
   * Every library item matching the filters, across pages: one `list`
   * request per page, made when the previous page has been read; starts at
   * `page` (default 1) and stops on a short or empty page, or one that
   * reaches `total`. Throws when called for `sort: "random"`, whose pages are
   * separate samples, not one list, and for a start page below 1.
   *
   * The request options apply to every page request; they are checked when
   * `listAll` is called. A `signal` also stops the items of a page already
   * read: once it fires, the next item throws `LenzAbortError`.
   */
  listAll(input: LibraryListInput = {}, options?: RequestOptions): AsyncIterable<LibraryItem> {
    const call = resolveCall(this.client, options, "library.listAll", "request", false);
    if (input.sort === "random") {
      throw new Error(
        'listAll cannot walk sort: "random" (each page is a fresh sample); call library.list instead.',
      );
    }
    const first = startPage(input.page);
    // Every page uses the options as they were when listAll was called.
    return walkPages(
      (page: number) => this.list({ ...input, page }, call.own),
      first,
      call.signals,
    );
  }
}

/**
 * The body of `POST /citecheck`, after the input's own checks: exactly one of
 * `text` and `pairs`, and `maxCitations` only with `text`.
 */
function citecheckBody(input: CitecheckInput): Record<string, unknown> {
  const hasText = typeof input.text === "string" && input.text.trim() !== "";
  if (hasText === (input.pairs !== undefined)) {
    throw new Error("citecheck() needs exactly one of text and pairs.");
  }
  if (input.pairs !== undefined && input.maxCitations !== undefined) {
    throw new Error("maxCitations goes with text: every pair is checked.");
  }
  const body: Record<string, unknown> = hasText
    ? { text: input.text }
    : { pairs: pairsToWire(input.pairs) };
  if (input.maxCitations !== undefined) body.max_citations = input.maxCitations;
  if (input.language) body.language = input.language;
  if (input.webhookUrl !== undefined && input.webhookUrl !== null)
    body.webhook_url = input.webhookUrl;
  return body;
}

/** The statuses a verification task ends with. */
const ENDED_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "needs_input",
  "failed",
  "cancelled",
]);

/** The kinds of run `cancelOnAbort` cancels, and the noun its log lines use. */
type AbortCancelKind = "task" | "review" | "citecheck";

/** The budget of `cancelOnAbort`'s cancels ran out before one answered. */
class CancelBudgetSpent extends Error {}

/**
 * Why a `cancelOnAbort` cancel failed, for a log line: a status and an error
 * code, or the error's class. Never a message or a body (which could quote
 * what was submitted).
 */
function cancelFailure(exc: unknown): string {
  if (
    exc instanceof CancelBudgetSpent ||
    exc instanceof LenzAbortError ||
    exc instanceof LenzRequestTimeoutError
  ) {
    return `no answer within ${ABORT_CANCEL_BUDGET} ms`;
  }
  if (exc instanceof LenzError && exc.statusCode) {
    return `HTTP ${exc.statusCode}${exc.code ? ` ${exc.code}` : ""}`;
  }
  return exc instanceof Error ? exc.name : "an error";
}

export class Lenz {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private fetchImpl: typeof fetch;
  private logger: LenzLogger | undefined;

  readonly verifications: VerificationsNamespace;
  readonly ask: AskNamespace;
  readonly library: LibraryNamespace;

  constructor(opts: LenzOptions = {}) {
    // One rule for every per-request timeout and retry count, checked first.
    checkTimeoutMs(opts.timeoutMs, "new Lenz()", true);
    checkMaxRetries(opts.maxRetries, "new Lenz()", true);
    this.apiKey = opts.apiKey ?? envVar("LENZ_API_KEY") ?? "";
    this.baseUrl = (opts.baseUrl ?? envVar("LENZ_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger;

    this.verifications = new VerificationsNamespace(this);
    this.ask = new AskNamespace(this);
    this.library = new LibraryNamespace(this);
  }

  /**
   * A copy of this client with request options that apply to every call made
   * through it: a cheap object that shares the `fetch`, key, base URL and
   * logger. `timeoutMs` and `maxRetries` replace the client's (the copy's
   * `timeoutMs` is also the attempt timeout of a wait's polls, which a wait's
   * own `timeoutMs`, its budget, does not set); `headers` merge over the
   * client's copy headers; a `signal` is added to any the client already has.
   * A call's own options win over the copy's, field by field.
   *
   * A copy with a `signal` is dead once it fires: every later call on it
   * throws `LenzAbortError`. Make one per request
   * (`client.withOptions({ signal: request.signal })`), and cancel server-side
   * work through the client you made it from.
   */
  withOptions(opts: RequestOptions): this {
    const o = checkOptions(opts, "withOptions()", "request");
    const base = COPY_OPTIONS.get(this);
    const copy = Object.assign(Object.create(Object.getPrototypeOf(this) as object) as this, this);
    if (o.timeoutMs !== undefined) copy.timeoutMs = o.timeoutMs;
    if (o.maxRetries !== undefined) copy.maxRetries = o.maxRetries;
    COPY_OPTIONS.set(copy, {
      signals: o.signal
        ? [...(base?.signals ?? NO_SIGNALS), o.signal]
        : (base?.signals ?? NO_SIGNALS),
      headers: mergeHeaders(base?.headers ?? NO_HEADERS, o.headers),
    });
    // Each namespace is copied from the one it replaces (its class and any
    // method set on it kept) and bound to the copy.
    const namespaces = copy as unknown as Record<"verifications" | "ask" | "library", object>;
    for (const name of ["verifications", "ask", "library"] as const) {
      const from = namespaces[name];
      namespaces[name] = Object.assign(
        Object.create(Object.getPrototypeOf(from) as object) as object,
        from,
        { client: copy },
      );
    }
    return copy;
  }

  // ── Marquee verbs ──

  async verify(input: VerifyInput, options?: RequestOptions): Promise<TaskAccepted> {
    const call = resolveCall(this, options, "verify()");
    return this.submit(input, await callIdempotencyKey(input), transportOf(call));
  }

  async verifyBatch(input: VerifyBatchInput, options?: RequestOptions): Promise<BatchAccepted> {
    const call = resolveCall(this, options, "verifyBatch()");
    return this._verifyBatch(input, await callIdempotencyKey(input), call);
  }

  private async _verifyBatch(
    input: VerifyBatchInput,
    idempotencyKey: string | undefined,
    call: Call,
  ): Promise<BatchAccepted> {
    const body: Record<string, unknown> = {
      // Per-item shape passes through verbatim — `VerifyBatchItem` allows
      // any subset including a per-item `language` override.
      claims: input.claims.map((c, i) => {
        // `sourceUrl` / `webhookUrl` are the camelCase names of `source_url` /
        // `webhook_url`; the body is built in a fixed key order either way.
        const fields = c as Record<string, unknown>;
        checkAliases(fields, BATCH_ITEM_ALIASES, `verifyBatch() claims[${i}]`, batchItemAbsent);
        const sourceUrl = batchItemValue(fields, "sourceUrl", "source_url");
        const webhookUrl = batchItemValue(fields, "webhookUrl", "webhook_url");
        const item: Record<string, unknown> = {
          text: c.claim || c.text,
          source_url: sourceUrl ?? "",
        };
        // Omitted when unset: an omitted webhook_url means the key's default
        // URL. An empty string is never sent in its place.
        if (sendsWebhookUrl(webhookUrl)) item.webhook_url = webhookUrl;
        if (c.language) item.language = c.language;
        if (c.visibility) item.visibility = c.visibility;
        if (c.depth) item.depth = c.depth;
        return item;
      }),
    };
    // Batch-wide defaults — per-item values (in the claims map above) override
    // server-side when set.
    if (sendsWebhookUrl(input.webhookUrl)) body["webhook_url"] = input.webhookUrl;
    if (input.language) body["language"] = input.language;
    if (input.visibility) body["visibility"] = input.visibility;
    if (input.depth) body["depth"] = input.depth;
    // One key per call, reused across its own retries, so a retried batch
    // does not start (and charge for) its claims twice.
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const accepted = await this.request<BatchAccepted>({
      method: "POST",
      path: "/verify/batch",
      json: body,
      headers,
      ...transportOf(call),
    });
    return normalizeBatchAccepted(accepted) as BatchAccepted;
  }

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
  async extract(input: ExtractInput, options?: RequestOptions): Promise<ExtractedClaims> {
    checkTimeoutMs(input.timeoutMs, "extract() input", true);
    const call = resolveCall(this, options, "extract()");
    const body: Record<string, unknown> = { text: input.text };
    if (input.language) body.language = input.language;
    // No client-side length check on `focus`: the server's 422 is the
    // contract, and a cap duplicated here would drift from it.
    if (input.focus) body.focus = input.focus;
    // Unlike `focus`, an explicit `false` is sent too; only an omitted value
    // is left out, so the server's default governs it.
    if (input.locate !== undefined) body.locate = input.locate;
    // One key per call, reused across its own retries: a retry after a client
    // timeout replays the first extraction instead of starting it over.
    const idempotencyKey = await callIdempotencyKey(input);
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const out = await this.request<ExtractedClaims>({
      method: "POST",
      path: "/extract",
      json: body,
      headers,
      ...transportOf(call),
      // The floor applies to an inherited timeout only: it never shortens a
      // client configured with a longer one, and a value given for the call
      // (in the options, or the deprecated input field) is used as given.
      timeoutMs: call.timeoutMs ?? input.timeoutMs ?? Math.max(this.timeoutMs, EXTRACT_TIMEOUT_MS),
    });
    return normalizeExtract(out, input.locate) as ExtractedClaims;
  }

  /**
   * Fast 3-model panel verdict. Sync, ~15s for one claim. Two forms:
   *
   * - `assess({ claim })` — one text; returns one entry per claim found in
   *   it (up to 20, 1 credit each), and the claims past those in
   *   `more_claims`, unchecked and free.
   * - `assess({ claims })` — up to 20 claims in one call (~15s); returns
   *   exactly one entry per item, in the order sent. This is the step after
   *   `extract` in the ladder. A row with `status === "failed"` has no
   *   verdict, a `failure` saying why (`code`, `hint`) and is free; a
   *   compound item is assessed on its main claim and lists the rest in
   *   `more_claims`.
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
   *   .filter((c) => c.status !== "failed" && c.confidence === "low" && c.claim)
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
  async assess(input: AssessInput, options?: RequestOptions): Promise<AssessResponse> {
    checkTimeoutMs(input.timeoutMs, "assess() input", true);
    // `claim` is the documented name; `text` the alias. Either way the wire
    // key is `text`, which every server version accepts.
    const single = input.claim || input.text;
    const list = input.claims;
    if (list && list.length > 0 && single) {
      throw new LenzValidationError({
        message: "assess takes one claim (`claim`) or a list (`claims`), not both.",
        cause: "`claims` was given together with a non-empty `claim` / `text`.",
        fix: "Send a single claim as `claim`, or up to 20 claims as `claims`.",
        docUrl: "https://lenz.io/docs/errors",
      });
    }
    const call = resolveCall(this, options, "assess()");
    // A random key per invocation, reused across this client's own retries so
    // a 5xx retry is deduped server-side rather than charged twice.
    //
    // Deliberately NOT derived from the claim text: an identical claim sent an
    // hour later is a new question, and a content-derived key would replay the
    // first answer for 24h — including for a claim whose verdict the server
    // would otherwise refresh.
    const idempotencyKey = await callIdempotencyKey(input);
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    // The floor applies to an inherited timeout only: it never shortens a
    // client configured with a longer one, and a value given for the call (in
    // the options, or the deprecated input field) is used as given.
    const timeoutMs =
      call.timeoutMs ?? input.timeoutMs ?? Math.max(this.timeoutMs, ASSESS_TIMEOUT_MS);
    const transport = { ...transportOf(call), timeoutMs };
    if (list && list.length > 0) {
      const body: Record<string, unknown> = { claims: list };
      if (input.language) body.language = input.language;
      // Sent only when asked, so a request without the option (and what its
      // idempotency key covers) is exactly what it was before.
      if (input.suggestRewrite) body.suggest_rewrite = true;
      return normalizeAssess(
        await this.request<AssessResponse>({
          method: "POST",
          path: "/assess",
          json: body,
          headers,
          ...transport,
        }),
      ) as AssessResponse;
    }
    const body: Record<string, unknown> = { text: single };
    if (input.language) body.language = input.language;
    if (input.suggestRewrite) body.suggest_rewrite = true;
    return normalizeAssess(
      await this.request<AssessResponse>({
        method: "POST",
        path: "/assess",
        json: body,
        headers,
        ...transport,
      }),
    ) as AssessResponse;
  }

  /**
   * Resolve a needs-input interrupt by selecting one or more claims.
   *
   * Each selected claim fans out into its own pipeline; the returned
   * `BatchAccepted` carries one `items` entry (each with its own `task_id`)
   * per claim. Poll each via `getStatus` / `wait`. Every text must match a
   * claim offered in the prior interrupt — the server rejects anything else.
   */
  async select(
    taskId: string,
    input: SelectInput,
    options?: RequestOptions,
  ): Promise<BatchAccepted> {
    const id = requirePathId("select", "task_id", taskId);
    const chosen = input.claims && input.claims.length > 0 ? input.claims : input.texts;
    if (!chosen || chosen.length === 0) {
      throw new Error("select requires a non-empty claims array");
    }
    const call = resolveCall(this, options, "select()");
    // One key per call, reused across its own retries, so a retried select
    // does not start (and charge for) the chosen claims twice.
    const idempotencyKey = await callIdempotencyKey(input);
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const accepted = await this.request<BatchAccepted>({
      method: "POST",
      path: `/verify/${id}/select`,
      json: { texts: chosen },
      headers,
      ...transportOf(call),
    });
    return normalizeBatchAccepted(accepted) as BatchAccepted;
  }

  /**
   * One non-blocking poll of a task.
   *
   * On a completed task, throws {@link LenzGoneError} (HTTP 410) when the
   * account's retention period has removed the verification. A running task
   * never answers 410.
   */
  async getStatus(
    taskId: string,
    /**
     * The request options, plus `deadlineAt`. The waits poll through this
     * method and pass the per-attempt timeout, their absolute `Date.now()`
     * deadline, and their own `signal` and `headers`. An override may ignore
     * them; the wait still ends at its deadline, and at its signal.
     */
    options?: GetStatusOptions,
  ): Promise<TaskStatus> {
    const id = requirePathId("getStatus", "task_id", taskId);
    const call = resolveCall(this, options, "getStatus()");
    const deadlineAt = options?.deadlineAt;
    const body = await this.request<TaskStatus>({
      method: "GET",
      path: `/verify/status/${id}`,
      ...transportOf(call),
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    });
    return normalizeTaskStatus(body) as TaskStatus;
  }

  /**
   * Stop a verification. A cancelled run is not charged and saves nothing.
   *
   * Answers for every run of yours, whatever its state. `cancelled: true`
   * means the run is cancelled, by this call or an earlier one (so a repeat,
   * or a retry after a lost response, answers `true` again). `cancelled:
   * false` means it was not cancelled and nothing changed: `status` is the
   * run's status, normally `completed` (the verification exists and was
   * charged as usual) or `failed`. A task that `select` already resolved
   * answers `cancelled: false` with `needs_input`; cancel the task ids
   * `select` returned. Cancelling is safe to repeat, so the call sends no
   * Idempotency-Key and is retried like any other request.
   *
   * Throws {@link LenzNotFoundError} (404) for a task that does not exist, is
   * not yours, or was started on the website. A review's deep check cannot be
   * cancelled on its own: the API answers 409 with code `use_review_cancel`
   * (a {@link LenzError}, not retryable); stop the review with
   * {@link Lenz.cancelReview} instead. Throws {@link LenzAPIError} when a 200
   * carries no cancel result.
   */
  async cancel(taskId: string, options?: RequestOptions): Promise<CancelResult> {
    requirePathId("cancel", "task_id", taskId);
    const call = resolveCall(this, options, "cancel()");
    return this._cancelTask(taskId, transportOf(call));
  }

  private async _cancelTask(
    taskId: string,
    transport: Partial<SendOptions>,
  ): Promise<CancelResult> {
    const id = requirePathId("cancel", "task_id", taskId);
    const path = `/verify/${id}/cancel`;
    const body = await this.request<unknown>({ method: "POST", path, ...transport });
    const result = body as Partial<CancelResult> | null;
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      result.task_id !== taskId ||
      typeof result.cancelled !== "boolean" ||
      typeof result.status !== "string"
    ) {
      throw new LenzAPIError({
        message: `POST ${path} answered without a cancel result.`,
        cause: "The response carries no task_id (this task's), cancelled and status.",
        fix: "Read the run with getStatus(taskId); contact support with the request id if this persists.",
        docUrl: "https://lenz.io/docs/errors",
      });
    }
    return body as CancelResult;
  }

  async usage(options?: RequestOptions): Promise<Usage> {
    const call = resolveCall(this, options, "usage()");
    const usage = await this.request<Usage>({
      method: "GET",
      path: "/me/usage",
      ...transportOf(call),
    });
    // Both response shapes: `credits.extra` / `credits.bonus` (the same
    // number), `quota_resets_at`, and the per-capability blocks, recomputed
    // from `credits` and `costs` when the server sends only the pool.
    return normalizeUsage(usage) as Usage;
  }

  // ── Review: the whole recipe in one call ──

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
  async review(input: ReviewInput, options?: RequestOptions): Promise<ReviewStarted> {
    const call = resolveCall(this, options, "review()");
    return this._submitReview(input, await jobIdempotencyKey(input), transportOf(call));
  }

  private async _submitReview(
    input: ReviewInput,
    idempotencyKey: string,
    transport: Partial<SendOptions> = {},
  ): Promise<ReviewStarted> {
    const body: Record<string, unknown> = { text: input.text };
    if (input.language) body.language = input.language;
    // Three states: omitted or null → the credential's default URL;
    // "" → no webhook for this review; a URL → that URL.
    if (input.webhookUrl !== undefined && input.webhookUrl !== null) {
      body.webhook_url = input.webhookUrl;
    }
    body.visibility = input.visibility ?? "private";
    const escalate: Record<string, unknown> = {};
    if (input.verdicts !== undefined) escalate.verdicts = input.verdicts;
    if (input.confidence !== undefined) escalate.confidence = input.confidence;
    if (input.maxAssessments !== undefined) escalate.max_assessments = input.maxAssessments;
    if (input.maxVerifications !== undefined) escalate.max_verifications = input.maxVerifications;
    if (input.depth !== undefined) escalate.depth = input.depth;
    // 0 means no citation check, the server default: sent as nothing, so the
    // body (and what its idempotency key covers) is what it is without it.
    if (input.maxCitations) escalate.max_citations = input.maxCitations;
    // Sent only when asked, for the same reason.
    if (input.suggestEdits) escalate.suggest_edits = true;
    if (Object.keys(escalate).length > 0) body.escalate = escalate;
    try {
      return await this.request<ReviewStarted>({
        method: "POST",
        path: "/review",
        json: body,
        headers: { "Idempotency-Key": idempotencyKey },
        conflictReceipt: "review_id",
        ...transport,
      });
    } catch (exc) {
      // A retried submit whose first attempt created the review (its socket
      // dropped before the 202 arrived) meets the review still being created
      // under the same key. When the server names it, that IS the receipt.
      const reviewId = exc instanceof LenzError ? exc.body?.["review_id"] : undefined;
      if (
        exc instanceof LenzError &&
        exc.statusCode === 409 &&
        exc.code === "idempotency_conflict" &&
        typeof reviewId === "string" &&
        reviewId !== ""
      ) {
        return { review_id: reviewId, status: "queued" };
      }
      throw exc;
    }
  }

  /**
   * Read a review. `{ view: "issues" }` returns the envelope without
   * `claims[]`: the issues, the failures and the summary.
   *
   * Throws {@link LenzGoneError} (HTTP 410) when the review was purged.
   */
  getReview(reviewId: string): Promise<ReviewFull>;
  getReview(reviewId: string, opts: { view: "issues" } & RequestOptions): Promise<ReviewIssues>;
  getReview(reviewId: string, opts: { view: "full" } & RequestOptions): Promise<ReviewFull>;
  getReview(reviewId: string, opts: { view?: undefined } & RequestOptions): Promise<ReviewFull>;
  getReview(
    reviewId: string,
    opts?: GetReviewOptions & RequestOptions,
  ): Promise<ReviewFull | ReviewIssues>;
  async getReview(
    reviewId: string,
    opts: GetReviewOptions & RequestOptions = {},
  ): Promise<ReviewFull | ReviewIssues> {
    requirePathId("getReview", "review_id", reviewId);
    const call = resolveCall(this, opts, "getReview()");
    return this._getReview(reviewId, opts, transportOf(call));
  }

  // ── Citation check: the check on its own ──

  /**
   * Start a citation check: does each source the text cites (or each pair
   * sent) say what the statement says it does? Send exactly one of `text`
   * and `pairs`; `maxCitations` goes with `text`. Returns the receipt at once;
   * read the check with `getCitecheck`, wait with `citecheckAndWait`, or
   * receive `citecheck.completed` at your webhook.
   */
  async citecheck(input: CitecheckInput, options?: RequestOptions): Promise<CitecheckStarted> {
    const body = citecheckBody(input);
    const call = resolveCall(this, options, "citecheck()");
    return this._submitCitecheck(body, await jobIdempotencyKey(input), transportOf(call));
  }

  private async _submitCitecheck(
    body: Record<string, unknown>,
    idempotencyKey: string,
    transport: Partial<SendOptions> = {},
  ): Promise<CitecheckStarted> {
    try {
      return await this.request<CitecheckStarted>({
        method: "POST",
        path: "/citecheck",
        json: body,
        headers: { "Idempotency-Key": idempotencyKey },
        conflictReceipt: "citecheck_id",
        ...transport,
      });
    } catch (exc) {
      // A retried submit that meets the first attempt's check still being
      // created: when the server names it, that IS the receipt.
      const named = exc instanceof LenzError ? exc.body?.["citecheck_id"] : undefined;
      if (
        exc instanceof LenzError &&
        exc.statusCode === 409 &&
        exc.code === "idempotency_conflict" &&
        typeof named === "string" &&
        named !== ""
      ) {
        return { citecheck_id: named, status: "queued" };
      }
      throw exc;
    }
  }

  /**
   * Read a citation check. Throws {@link LenzGoneError} (HTTP 410) once the
   * account's retention period has removed it.
   */
  async getCitecheck(citecheckId: string, options?: RequestOptions): Promise<Citecheck> {
    requirePathId("getCitecheck", "citecheck_id", citecheckId);
    const call = resolveCall(this, options, "getCitecheck()");
    return this._getCitecheck(citecheckId, transportOf(call));
  }

  private async _getCitecheck(
    citecheckId: string,
    transport: Partial<SendOptions> = {},
  ): Promise<Citecheck> {
    return withCitecheckDefaults(await this._readCitecheck(citecheckId, transport)) as Citecheck;
  }

  /** The body as the server sent it, before any default is filled. */
  private async _readCitecheck(
    citecheckId: string,
    transport: Partial<SendOptions> = {},
  ): Promise<unknown> {
    const id = requirePathId("getCitecheck", "citecheck_id", citecheckId);
    return this.request<unknown>({
      method: "GET",
      path: `/citechecks/${id}`,
      ...transport,
    });
  }

  /**
   * Stop a citation check. Returns the check as it stands afterwards (as
   * `getCitecheck` returns it): `status: "cancelled"`, or unchanged
   * (`completed`, `failed`) when it had already ended. Cancelling again is
   * safe, so the call sends no Idempotency-Key.
   *
   * Throws {@link LenzNotFoundError} (404) for a check that does not exist
   * or is not yours, and {@link LenzGoneError} (HTTP 410) once the account's
   * retention period has removed it.
   */
  async cancelCitecheck(citecheckId: string, options?: RequestOptions): Promise<Citecheck> {
    requirePathId("cancelCitecheck", "citecheck_id", citecheckId);
    const call = resolveCall(this, options, "cancelCitecheck()");
    return this._cancelCitecheck(citecheckId, transportOf(call));
  }

  private async _cancelCitecheck(
    citecheckId: string,
    transport: Partial<SendOptions>,
  ): Promise<Citecheck> {
    const id = requirePathId("cancelCitecheck", "citecheck_id", citecheckId);
    const body = await this.request<unknown>({
      method: "POST",
      path: `/citechecks/${id}/cancel`,
      ...transport,
    });
    if (!isJobBody(body, "citecheck_id", citecheckId, CITECHECK_LISTS)) {
      throw unexpectedAnswer("POST", `/citechecks/${id}/cancel`);
    }
    return withCitecheckDefaults(body) as Citecheck;
  }

  /**
   * Start a citation check and poll it until it ends; returns the completed
   * check. Polls on its `poll_after_seconds` (never tighter than 5 s) and
   * calls `onUpdate` on every poll whose body changed. Throws
   * {@link CitecheckFailedError} when the check ends `failed` or `cancelled` and
   * {@link CitecheckTimeoutError} (carrying the last body seen) at the
   * deadline, which bounds every poll. The deadline starts after the submit
   * (since 3.0), which makes its attempts with the client's timeout and the
   * retries of `opts.maxRetries` (else the client's); `timeoutMs` of 0 or
   * less reads the check once.
   */
  async citecheckAndWait(
    input: CitecheckInput,
    opts: CitecheckAndWaitOptions = {},
  ): Promise<Citecheck> {
    // Read once, with the other options: a later change to `opts` changes nothing.
    const timeoutMs = opts.timeoutMs ?? REVIEW_DEFAULT_TIMEOUT_MS;
    const onUpdate = opts.onUpdate;
    const body = citecheckBody(input);
    const call = resolveCall(this, opts, "citecheckAndWait()", "submitWait");
    const cancelOnAbort = opts.cancelOnAbort === true;
    const idempotencyKey = await jobIdempotencyKey(input);
    return withIdempotencyKey(idempotencyKey, async () => {
      const started = await this._submitCitecheck(body, idempotencyKey, transportOf(call));
      const citecheckId = acceptedId("citecheck_id", started.citecheck_id);
      const deadline = Date.now() + timeoutMs;
      const ended = { value: false };
      return this._cancellingOnAbort(
        cancelOnAbort,
        call,
        "citecheck",
        () => (ended.value ? [] : [citecheckId]),
        () =>
          withAbortContext({ citecheckId }, () =>
            this._waitCitecheck(citecheckId, deadline, timeoutMs, onUpdate, call, ended),
          ),
      );
    });
  }

  private _waitCitecheck(
    citecheckId: string,
    deadline: number,
    timeoutMs: number,
    onUpdate: CitecheckAndWaitOptions["onUpdate"],
    call: Call,
    ended?: { value: boolean },
  ): Promise<Citecheck> {
    return this._waitJob<Citecheck>({
      deadline,
      call,
      ...(ended ? { ended } : {}),
      // The raw body, so the guard judges what the server sent: a default
      // filled first would let a bare `{citecheck_id, status}` pass as a result.
      read: async (transport) => {
        const raw = await this._readCitecheck(citecheckId, transport);
        // Both response shapes' names, on a body that already passes as this
        // check, so the guard still judges what the server sent.
        return isCitecheckBody(raw, citecheckId) ? normalizeCitecheck(raw) : raw;
      },
      isBody: (body) => isCitecheckBody(body, citecheckId),
      failed: (check) => new CitecheckFailedError(check),
      timedOut: (last) => new CitecheckTimeoutError(citecheckId, last, timeoutMs),
      onUpdate,
    });
  }

  private async _getReview(
    reviewId: string,
    opts: GetReviewOptions,
    transport: Partial<SendOptions> = {},
  ): Promise<ReviewFull | ReviewIssues> {
    const id = requirePathId("getReview", "review_id", reviewId);
    const body = await this.request<ReviewFull | ReviewIssues>({
      method: "GET",
      path: `/reviews/${id}`,
      query: opts.view && opts.view !== "full" ? { view: opts.view } : undefined,
      ...transport,
    });
    return withReviewDefaults(body);
  }

  /**
   * Stop a review, including the deep checks it started. Returns the review
   * as it stands afterwards (the full view, as `getReview` returns it):
   * `status: "cancelled"`, or unchanged (`completed`, `failed`) when it had
   * already ended. Cancelling again is safe, so the call sends no
   * Idempotency-Key.
   *
   * Throws {@link LenzNotFoundError} (404) for a review that does not exist
   * or is not yours, and {@link LenzGoneError} (HTTP 410) when the review was
   * purged.
   */
  async cancelReview(reviewId: string, options?: RequestOptions): Promise<ReviewFull> {
    requirePathId("cancelReview", "review_id", reviewId);
    const call = resolveCall(this, options, "cancelReview()");
    return this._cancelReview(reviewId, transportOf(call));
  }

  private async _cancelReview(
    reviewId: string,
    transport: Partial<SendOptions>,
  ): Promise<ReviewFull> {
    const id = requirePathId("cancelReview", "review_id", reviewId);
    const body = await this.request<ReviewFull>({
      method: "POST",
      path: `/reviews/${id}/cancel`,
      ...transport,
    });
    if (!isJobBody(body, "review_id", reviewId, REVIEW_LISTS)) {
      throw unexpectedAnswer("POST", `/reviews/${id}/cancel`);
    }
    return withReviewDefaults(body) as ReviewFull;
  }

  /**
   * Start a review and poll it until it ends; returns the completed review.
   *
   * Polls on the review's `poll_after_seconds` (never tighter than 5 s) and
   * calls `onUpdate` with the review on every poll whose body changed, so a
   * caller can show the quick verdicts as soon as they land. Throws
   * {@link ReviewFailedError} when the review ends `failed` or `cancelled` and
   * {@link ReviewTimeoutError} (carrying the last body seen) at the deadline;
   * a transient poll error is retried on the next poll, after the wait the
   * server stated when it stated one (at most 60 s). The deadline starts
   * after the submit (since 3.0; before, it bounded the submit too), and
   * bounds every poll; the submit makes its attempts with the client's
   * timeout and the retries of `opts.maxRetries` (else the client's). The
   * first poll always runs, so a `timeoutMs` of 0 or less reads the review
   * once, and a terminal review it reads is returned or thrown as usual.
   */
  async reviewAndWait(input: ReviewInput, opts: ReviewAndWaitOptions = {}): Promise<ReviewFull> {
    // Read once, with the other options: a later change to `opts` changes nothing.
    const timeoutMs = opts.timeoutMs ?? REVIEW_DEFAULT_TIMEOUT_MS;
    const onUpdate = opts.onUpdate;
    const call = resolveCall(this, opts, "reviewAndWait()", "submitWait");
    const cancelOnAbort = opts.cancelOnAbort === true;
    const idempotencyKey = await jobIdempotencyKey(input);
    return withIdempotencyKey(idempotencyKey, async () => {
      const started = await this._submitReview(input, idempotencyKey, transportOf(call));
      const reviewId = acceptedId("review_id", started.review_id);
      // The wait's clock starts once the review is accepted, as every other
      // wait's does.
      const deadline = Date.now() + timeoutMs;
      const ended = { value: false };
      return this._cancellingOnAbort(
        cancelOnAbort,
        call,
        "review",
        () => (ended.value ? [] : [reviewId]),
        () =>
          withAbortContext({ reviewId }, () =>
            this._waitJob<ReviewFull>({
              deadline,
              call,
              read: (transport) => this._getReview(reviewId, {}, transport),
              isBody: (body) => isReviewBody(body, reviewId),
              failed: (review) => new ReviewFailedError(review),
              timedOut: (last) => new ReviewTimeoutError(reviewId, last, timeoutMs),
              onUpdate,
              ended,
            }),
          ),
      );
    });
  }

  /**
   * The poll loop behind every `*AndWait` of an async job (a review, a
   * citation check), from the moment it was accepted to `deadline`.
   */
  private async _waitJob<T extends { status: string; poll_after_seconds: number | null }>(job: {
    deadline: number;
    /** The call's signals and headers, sent with every poll. */
    call?: Call;
    read: (transport: Partial<SendOptions>) => Promise<unknown>;
    isBody: (body: unknown) => body is T;
    failed: (current: T) => Error;
    timedOut: (last: T | null) => Error;
    onUpdate?: (current: T) => void;
    /** Set once a poll reads the job ended (`cancelOnAbort` then sends no cancel). */
    ended?: { value: boolean };
  }): Promise<T> {
    const { deadline } = job;
    const signals = job.call?.signals ?? NO_SIGNALS;
    const optionHeaders = job.call?.headers ?? NO_HEADERS;
    let last: T | null = null;
    let lastJson = "";
    for (let poll = 0; ; poll++) {
      const budget = deadline - Date.now();
      // The first poll always runs, even when the submit used up the budget,
      // so a timeout can still hand back what the job looks like.
      if (budget <= 0 && poll > 0) throw job.timedOut(last);
      let current: T | null = null;
      let statedWaitMs = 0;
      try {
        // One attempt per poll, bounded by what is left: this loop owns the
        // waits, so a retry ladder inside the request cannot outlive the
        // deadline.
        const body = await job.read({
          signals,
          optionHeaders,
          maxRetries: 0,
          // Cut at what is left. A first poll with no budget left (a
          // `timeoutMs` of 0 or less) gets the client's own timeout, so the
          // one read can fill `partial`.
          timeoutMs: poll === 0 && budget <= 0 ? this.timeoutMs : Math.min(this.timeoutMs, budget),
        });
        // A 2xx that is not this job (an empty body, a proxy's error object,
        // another id, a body missing its lists) is a failed poll, never an
        // update and never `partial`.
        if (job.isBody(body)) current = body;
      } catch (exc) {
        // The caller's abort ends the wait; it is never a transient failure.
        rethrowIfCallerAbort(signals, exc);
        // Keep waiting through what a later poll can outlast: a 5xx, a rate
        // limit, and anything that is not a Lenz answer at all (a network
        // drop, a body that stops or does not decode). A Lenz answer that
        // waiting will not change (auth, 404, a purged job) ends the wait.
        if (exc instanceof LenzError && !(exc instanceof LenzAPIError) && !isRateLimit(exc)) {
          throw exc;
        }
        // Anything else that is not a Lenz answer or a transport failure is a
        // programming error (the call's refusal of an id included): waiting
        // does not change it.
        if (!isPollableError(exc)) throw exc;
        // A wait the server stated outranks the poll hint, capped like every
        // other stated wait in this client: a maintenance 503 can state an
        // hour.
        const retryAfter = (exc as { retryAfter?: unknown } | null | undefined)?.retryAfter;
        if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
          statedWaitMs = Math.min(retryAfter, MAX_RETRY_AFTER_SLEEP) * 1000;
        }
      }
      if (current) {
        if (
          job.ended &&
          (current.status === "completed" ||
            current.status === "failed" ||
            current.status === "cancelled")
        ) {
          job.ended.value = true;
        }
        const json = JSON.stringify(current);
        if (json !== lastJson) {
          lastJson = json;
          last = current;
          if (job.onUpdate) {
            try {
              job.onUpdate(current);
            } catch {
              // A caller's bug must not end the wait.
            }
          }
        }
        // The callback may have aborted: the abort wins over the job's own
        // result, terminal or not.
        throwIfAborted(signals);
        if (current.status === "completed") return current;
        // `cancelled` (API version 2026-10-11) is the original shape's `failed`
        // with failure class `cancelled`: the same error.
        if (current.status === "failed" || current.status === "cancelled") {
          throw job.failed(current);
        }
      }
      // An abort that comes with the deadline is an abort, not a timeout.
      throwIfAborted(signals);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw job.timedOut(last);
      await sleep(
        Math.min(Math.max(reviewPollMs(current ?? last), statedWaitMs), remaining),
        signals,
      );
    }
  }

  // ── Headline ergonomic ──

  /**
   * Submit + poll until the pipeline terminates. Returns the completed
   * Verification, or throws LenzNeedsInputError / LenzPipelineError /
   * LenzTimeoutError. By default sends an auto-generated Idempotency-Key
   * so a network retry on submit doesn't spawn a duplicate task.
   *
   * `opts` takes `timeoutMs` (started after the submit) and `onProgress`,
   * as `wait` does. The same fields inside `input` still work (deprecated);
   * `opts` wins field by field. `opts.signal` and `opts.headers` apply to the
   * submit and every poll; `opts.maxRetries` to the submit only.
   */
  async verifyAndWait(
    input: VerifyAndWaitInput,
    opts: VerifyAndWaitOptions = {},
  ): Promise<Verification> {
    const { timeoutMs, onProgress } = waitOptions(input, opts);
    const call = resolveCall(this, opts, "verifyAndWait()", "submitWait");
    const cancelOnAbort = opts.cancelOnAbort === true;
    const idempotencyKey = await callIdempotencyKey(input);
    return withIdempotencyKey(idempotencyKey, async () => {
      const accepted = await this.submit(input, idempotencyKey, transportOf(call));
      acceptedId("task_id", accepted.task_id);
      this.log("info", `[lenz-io] Submitted task: ${accepted.task_id}`);
      // This call owns the cancel: the wait below is not handed the flag.
      return this._cancellingOnAbort(
        cancelOnAbort,
        call,
        "task",
        () => [accepted.task_id],
        () =>
          withAbortContext({ taskId: accepted.task_id }, () =>
            // Raced, in case an override of `wait` ignores the signal.
            raceAbort(
              this.wait(accepted, { timeoutMs, onProgress, ...ownOptions(call) }),
              call.signals,
            ),
          ),
      );
    });
  }

  /**
   * Block on an already-submitted task until it terminates, then return its
   * `Verification`. `task` is a `task_id` string OR the `TaskAccepted` returned
   * by `verify` / `select` — so `client.wait(await client.verify({claim}))`
   * reads naturally. Throws for an empty id, `LenzNeedsInputError` /
   * `LenzPipelineError` on terminal non-success (a task cancelled elsewhere
   * too, with `failureClass` `"cancelled"`), `LenzGoneError` when the
   * verification was removed under its account's retention period, and
   * `LenzTimeoutError` on deadline. `opts.signal` stops it with
   * `LenzAbortError` (carrying the `taskId`); `opts.headers` go on every poll.
   */
  async wait(task: string | TaskAccepted, opts: WaitOptions = {}): Promise<Verification> {
    const taskId = typeof task === "string" ? task : task.task_id;
    if (!taskId) {
      throw new Error("wait() requires a non-empty task_id (got an empty TaskAccepted.task_id).");
    }
    requirePathId("wait", "task_id", taskId);
    const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
    const onProgress = opts.onProgress;
    const call = resolveCall(this, opts, "wait()", "wait");
    const ended = new Set<string>();
    const { terminal, timedOut, gone, permanent } = await this._cancellingOnAbort(
      opts.cancelOnAbort === true,
      call,
      "task",
      () => (ended.has(taskId) ? [] : [taskId]),
      () =>
        withAbortContext({ taskId }, () =>
          this._pollToTerminal([taskId], timeoutMs, onProgress, call, ended),
        ),
    );
    const goneErr = gone.get(taskId);
    if (goneErr) throw goneErr;
    const stopped = permanent.get(taskId);
    if (stopped) throw stopped;
    if (timedOut.has(taskId)) {
      const err = new LenzTimeoutError({
        message: `wait timed out after ${timeoutMs}ms`,
        cause: "Pipeline still running server-side.",
        fix: `Resume via client.getStatus('${taskId}') later.`,
        docUrl: "https://lenz.io/docs/verify#timeout",
      });
      err.taskId = taskId;
      throw err;
    }
    return this._verificationFromTerminal(terminal.get(taskId)!, taskId);
  }

  /**
   * Submit a batch and poll every item to a terminal state. Returns one
   * `BatchItemResult` per task the batch accepted, in input order. Never throws
   * on a per-item outcome — a claim that fails, pauses, or times out becomes a
   * `BatchItemResult` with the matching `status`. A claim removed under the
   * account's retention period reads `"failed"` with no `status_detail`, and
   * so does a claim whose poll answered an error waiting will not change for
   * it (404, or an answer in another API version); the other claims keep
   * being polled. A 401 or 403 is about the key, not one claim: it throws
   * {@link LenzAuthError} from the wait, as do transport/auth errors on the
   * initial submit. Polls go through `getStatus` and none runs past the
   * deadline.
   *
   * `opts` takes `timeoutMs` (started after the submit) and `onProgress`,
   * as `wait` does. The same fields inside `input` still work (deprecated);
   * `opts` wins field by field. `opts.signal` and `opts.headers` apply to the
   * submit and every poll; `opts.maxRetries` to the submit only. An abort
   * after the receipt carries the `batchId` and every accepted `taskIds`.
   */
  async verifyBatchAndWait(
    input: VerifyBatchAndWaitInput,
    opts: VerifyAndWaitOptions = {},
  ): Promise<BatchItemResult[]> {
    const { timeoutMs, onProgress } = waitOptions(input, opts);
    const call = resolveCall(this, opts, "verifyBatchAndWait()", "submitWait");
    const cancelOnAbort = opts.cancelOnAbort === true;
    const idempotencyKey = await callIdempotencyKey(input);
    return withIdempotencyKey(idempotencyKey, () =>
      this._verifyBatchAndWait(input, idempotencyKey, timeoutMs, onProgress, call, cancelOnAbort),
    );
  }

  private async _verifyBatchAndWait(
    input: VerifyBatchAndWaitInput,
    idempotencyKey: string | undefined,
    timeoutMs: number,
    onProgress: OnProgress | undefined,
    call: Call,
    cancelOnAbort = false,
  ): Promise<BatchItemResult[]> {
    // Through the public verifyBatch, as 2.x did, so an override (a subclass,
    // a test double) is used. The call's key rides in the input, so the
    // override and the default both send the key this call reports; with
    // the opt-out there is none and the input goes as given. The call's own
    // options go as a second argument only when it has any (a 2.21 override
    // sees the call it always saw), and the submit is raced against the
    // signal in case an override ignores it.
    const batchInput = idempotencyKey === undefined ? input : { ...input, idempotencyKey };
    const submitOptions: RequestOptions = ownOptions(call);
    if (call.maxRetries !== undefined) submitOptions.maxRetries = call.maxRetries;
    const accepted = await raceAbort(
      Object.keys(submitOptions).length > 0
        ? this.verifyBatch(batchInput, submitOptions)
        : this.verifyBatch(batchInput),
      call.signals,
    );
    for (const it of accepted.items) acceptedId("task_id", it.task_id);
    const ids = accepted.items.map((it) => it.task_id).filter((id): id is string => Boolean(id));
    // Each accepted task not yet seen to end is cancelled on an abort.
    const ended = new Set<string>();
    const { terminal, timedOut, gone, permanent } = await this._cancellingOnAbort(
      cancelOnAbort,
      call,
      "task",
      () => ids.filter((id) => !ended.has(id)),
      () =>
        withAbortContext({ batchId: accepted.batch_id, taskIds: ids }, () =>
          this._pollToTerminal(ids, timeoutMs, onProgress, call, ended),
        ),
    );

    return accepted.items.map((it): BatchItemResult => {
      // Removed under the account's retention period, or a poll answered an
      // error polling again will not change (401, 403, 404): final, with no
      // result.
      if (gone.has(it.task_id) || permanent.has(it.task_id)) {
        return {
          task_id: it.task_id,
          claim: it.claim ?? it.claim_text,
          claim_text: it.claim_text ?? it.claim,
          status: "failed",
        };
      }
      const status = terminal.get(it.task_id);
      if (!it.task_id || timedOut.has(it.task_id) || !status) {
        return {
          task_id: it.task_id,
          claim: it.claim ?? it.claim_text,
          claim_text: it.claim_text ?? it.claim,
          status: "timeout",
        };
      }
      if (status.status === "completed" && status.result) {
        return {
          task_id: it.task_id,
          claim: it.claim ?? it.claim_text,
          claim_text: it.claim_text ?? it.claim,
          status: "completed",
          verification: status.result,
          status_detail: status,
        };
      }
      if (status.status === "needs_input") {
        return {
          task_id: it.task_id,
          claim: it.claim ?? it.claim_text,
          claim_text: it.claim_text ?? it.claim,
          status: "needs_input",
          status_detail: status,
        };
      }
      // failed, or completed-without-result (treated as failed).
      return {
        task_id: it.task_id,
        claim: it.claim ?? it.claim_text,
        claim_text: it.claim_text ?? it.claim,
        status: "failed",
        status_detail: status,
      };
    });
  }

  // ── poll engine (shared by wait + verifyBatchAndWait) ──

  /**
   * Round-robin poll `taskIds` until each reaches a terminal state or the
   * deadline elapses. Returns `{terminal, timedOut, gone, permanent}`; a
   * timed-out task has no `TaskStatus` (`"timeout"` is client-side, never a
   * wire status), a task whose poll threw {@link LenzGoneError} (removed under
   * its account's retention period) is in `gone`, and one whose poll answered
   * 404 or another API version is in `permanent`: final, never polled again.
   * A 401/403 throws (it is the key's, not the task's). Any other poll error
   * keeps the task pending.
   *
   * Each round polls every still-pending id once through `getStatus` (via
   * `Promise.allSettled`, so one poll's transport failure doesn't abort the
   * batch — that id stays pending and retries next round). Every poll ends by
   * the deadline; once the deadline is spent no poll is made and the pending
   * ids time out. Backoff reuses the existing 2/4/8/8…ms sequence.
   */
  private async _pollToTerminal(
    taskIds: string[],
    timeoutMs: number,
    onProgress: OnProgress | undefined,
    call: Call,
    /** Filled with every task seen to end (terminal, gone or not there), even on a throw. */
    ended?: Set<string>,
  ): Promise<{
    terminal: Map<string, TaskStatus>;
    timedOut: Set<string>;
    gone: Map<string, LenzGoneError>;
    permanent: Map<string, LenzError>;
  }> {
    let pending = [...taskIds];
    const terminal = new Map<string, TaskStatus>();
    const timedOut = new Set<string>();
    // A 410 is final: the run finished and its account's retention period has
    // since removed it. Polling again would only spin to the deadline.
    const gone = new Map<string, LenzGoneError>();
    // An answer polling again cannot change: the key is refused (401/403) or
    // the task is not there (404). Final for that task.
    const permanent = new Map<string, LenzError>();
    const deadline = Date.now() + timeoutMs;
    let backoffIdx = 0;
    for (let round = 0; pending.length > 0; round++) {
      const remaining = deadline - Date.now();
      // The budget is spent: no poll past the deadline. Only a wait given no
      // budget at all (timeoutMs <= 0) still looks once, bounded by the
      // client's own timeout, as 2.x did.
      if (remaining <= 0 && (round > 0 || timeoutMs > 0)) {
        throwIfAborted(call.signals);
        pending.forEach((id) => timedOut.add(id));
        break;
      }
      const transport =
        remaining > 0
          ? { timeoutMs: Math.min(this.timeoutMs, remaining), deadlineAt: deadline }
          : { timeoutMs: this.timeoutMs };
      // Each poll is classified as it settles: a fatal answer (an id the call
      // refused, a refused key, a programming error) ends the wait at once,
      // and the round's own signal stops the polls still running.
      const roundCtl = new AbortController();
      // The round's signal follows the wait's own (with its reason), and is
      // released when the round ends.
      const own = call.own.signal;
      const follow = () => roundCtl.abort(own?.reason);
      if (own?.aborted) follow();
      else own?.addEventListener("abort", follow, { once: true });
      let onFatal: (exc: unknown) => void = () => {};
      const fatal = new Promise<never>((_res, rej) => {
        onFatal = rej;
      });
      fatal.catch(() => {});
      const polls = pending.map((id) =>
        this._pollThroughGetStatus(id, transport, call, roundCtl.signal).catch((exc: unknown) => {
          if (isFatalPollError(exc)) onFatal(exc);
          throw exc;
        }),
      );
      const all = Promise.allSettled(polls);
      let settled: PromiseSettledResult<TaskStatus>[];
      try {
        settled = await Promise.race([all, fatal]);
      } catch (exc) {
        roundCtl.abort();
        await all;
        // The caller's abort, if it came first, still wins.
        throwIfAborted(call.signals);
        throw exc;
      } finally {
        own?.removeEventListener("abort", follow);
      }
      // What this round saw end, recorded before an abort can be thrown, so
      // `cancelOnAbort` does not cancel a run that already finished.
      if (ended) {
        settled.forEach((res, i) => {
          const done =
            res.status === "fulfilled"
              ? ENDED_TASK_STATUSES.has(res.value.status)
              : res.reason instanceof LenzGoneError ||
                res.reason instanceof LenzNotFoundError ||
                res.reason instanceof LenzApiVersionError;
          if (done) ended.add(pending[i]!);
        });
      }
      // The caller's abort, before any rejection is classified: never a
      // pending poll to try again.
      if (firedSignal(call.signals)) {
        const aborted = settled.find(
          (res): res is PromiseRejectedResult =>
            res.status === "rejected" && res.reason instanceof LenzAbortError,
        );
        if (aborted) throw aborted.reason;
        throwIfAborted(call.signals);
      }
      const stillPending: string[] = [];
      let serverHintMs: number | undefined;
      settled.forEach((res, i) => {
        const id = pending[i]!;
        if (res.status === "fulfilled") {
          const s = res.value;
          if (
            s.status === "completed" ||
            s.status === "needs_input" ||
            s.status === "failed" ||
            s.status === "cancelled"
          ) {
            terminal.set(id, s);
          } else {
            stillPending.push(id);
            const hint = pollHintMs(s.progress);
            // The shortest hint wins: with a batch in flight, waiting the
            // longest one would starve the fastest claim.
            if (hint !== undefined && (serverHintMs === undefined || hint < serverHintMs)) {
              serverHintMs = hint;
            }
            if (onProgress) {
              try {
                // A shallow copy — a caller must not be able to mutate our state.
                onProgress(id, { ...(s.progress ?? { step: "" }) });
              } catch {
                // A caller's bug is not ours to raise, and it must not kill
                // the poll. Swallowed with no console output: there is no
                // established logger here, and inventing one is worse than
                // silence for a library.
              }
            }
          }
        } else if (res.reason instanceof InvalidIdError) {
          // The call's own refusal of an id: waiting does not change it.
          throw res.reason;
        } else if (res.reason instanceof LenzGoneError) {
          gone.set(id, res.reason);
        } else if (res.reason instanceof LenzAuthError) {
          // The key is refused: no item of this wait can be read with it.
          throw res.reason;
        } else if (
          res.reason instanceof LenzApiVersionError ||
          res.reason instanceof LenzNotFoundError
        ) {
          // This task's answer, which polling again will not change: another
          // API version, or no such task. Final for this task only.
          permanent.set(id, res.reason);
        } else if (!isPollableError(res.reason)) {
          // Not a Lenz answer or a transport failure: a programming error (an
          // override's bug), which waiting does not change.
          throw res.reason;
        } else {
          // Poll errored this round (after _request exhausted its retries) —
          // keep pending and retry next round rather than aborting the batch.
          stillPending.push(id);
        }
      });
      pending = stillPending;
      // A callback may have aborted: that is the abort, whatever this round
      // read (a finished item, the deadline).
      throwIfAborted(call.signals);
      if (pending.length === 0) break;
      const left = deadline - Date.now();
      if (left <= 0) {
        pending.forEach((id) => timedOut.add(id));
        break;
      }
      await sleep(
        serverHintMs === undefined
          ? pollSleepMs(backoffIdx, left)
          : Math.min(serverHintMs, Math.max(0, left)),
        call.signals,
      );
      backoffIdx += 1;
    }
    return { terminal, timedOut, gone, permanent };
  }

  /**
   * One poll, made through the public `getStatus` (so a subclass's or a test
   * double's override is honoured) with the wait's budget, and cut at the
   * wait's deadline even when an override ignores that budget: a poll that
   * has not answered by then counts as no answer.
   */
  private async _pollThroughGetStatus(
    taskId: string,
    budget: { timeoutMs: number; deadlineAt?: number },
    call: Call,
    roundSignal: AbortSignal,
  ): Promise<TaskStatus> {
    // The wait's own headers: getStatus adds the copy's itself. An override
    // that ignores the signal still stops at it (the race). One race, so the
    // listeners go when any of them wins, the deadline included (an override
    // that never settles keeps none).
    // The round's signal goes as the poll's own `signal`: a public field an
    // override can copy along. It fires with the wait's own signal (same
    // reason) and when the round ends on a fatal answer.
    const options: GetStatusOptions = { ...budget, ...ownOptions(call), signal: roundSignal };
    const poll = this.getStatus(taskId, options);
    const signals = [...call.signals, roundSignal];
    const deadlineAt = budget.deadlineAt;
    if (deadlineAt === undefined) return raceAbort(poll, signals);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cutoff = new Promise<never>((_res, rej) => {
      timer = setTimeout(
        () =>
          rej(
            new LenzRequestTimeoutError({
              message: `GET /verify/status/${taskId} did not answer by the wait's deadline`,
            }),
          ),
        Math.max(0, deadlineAt - Date.now()),
      );
    });
    try {
      return await raceAbort(poll, signals, [cutoff]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Map a terminal `TaskStatus` to a `Verification` or throw the matching typed
   * error. Shared by `wait` (and thus `verifyAndWait`).
   */
  private _verificationFromTerminal(status: TaskStatus, taskId: string): Verification {
    if (status.status === "completed") {
      if (!status.result) {
        const emptyErr = new LenzPipelineError({
          message: "Pipeline completed but the result is empty.",
          cause: "Server reported status=completed without a result block.",
          fix: "File an issue at https://github.com/lenzhq/lenz-io-node/issues with the Request ID.",
          docUrl: "https://lenz.io/docs/errors",
        });
        emptyErr.taskId = taskId; // parity: the Python SDK sets task_id here too
        throw emptyErr;
      }
      return status.result;
    }
    if (status.status === "needs_input") {
      const err = new LenzNeedsInputError({
        message: `Pipeline paused: ${status.reason ?? "needs input"}`,
        cause: "The verification needs caller input to proceed.",
        fix: "Inspect the payload, then call client.select(taskId, { texts: [...] }) with the chosen claim(s).",
        docUrl: "https://lenz.io/docs/verify#needs-input",
      });
      err.taskId = taskId;
      err.kind = status.reason ?? "";
      err.payload = status as unknown as Record<string, unknown>;
      err.hint = status.hint ?? "";
      throw err;
    }
    if (status.status === "cancelled") {
      // Cancelled elsewhere: the original shape's `failed` with failure class
      // `cancelled`, so the same error, with what that shape said.
      const cancelled = new LenzPipelineError({
        message: `Pipeline failed: ${CANCELLED_SENTENCE}`,
        cause: CANCELLED_SENTENCE,
        fix: "Retry with a different claim, or check status.error for the diagnostic.",
        docUrl: "https://lenz.io/docs/errors",
      });
      cancelled.taskId = taskId;
      cancelled.failureReason = "cancelled";
      cancelled.failureClass = "cancelled";
      cancelled.retryable = false;
      cancelled.hint = "";
      throw cancelled;
    }
    // failed. `getStatus` fills `error` from `failure.detail` on the newer
    // response shape; the other fields are older fallbacks.
    const detail =
      status.error ||
      status.failure?.detail ||
      status.failure_detail ||
      status.failure_reason ||
      "unknown";
    const err = new LenzPipelineError({
      message: `Pipeline failed: ${detail}`,
      cause: detail,
      fix: status.retryable
        ? "Transient provider outage — retry the same request after a short wait."
        : "Retry with a different claim, or check status.error for the diagnostic.",
      docUrl: "https://lenz.io/docs/errors",
    });
    err.taskId = taskId;
    err.failureReason = status.failure_reason ?? "";
    err.failureClass = status.failure_class ?? "";
    err.retryable = typeof status.retryable === "boolean" ? status.retryable : null;
    err.hint = status.hint ?? "";
    throw err;
  }

  // ── internal helpers ──

  private async submit(
    input: VerifyInput,
    idempotencyKey: string | undefined,
    transport: Partial<SendOptions> = {},
  ): Promise<TaskAccepted> {
    const body: Record<string, unknown> = {
      // `claim` is the documented name; `text` the alias. The wire key stays
      // `text`, which every server version accepts.
      text: input.claim || input.text,
      source_url: input.sourceUrl ?? "",
    };
    // Omitted when unset, never sent as "": an omitted webhook_url means the
    // key's default URL.
    if (sendsWebhookUrl(input.webhookUrl)) body.webhook_url = input.webhookUrl;
    // Omit-when-empty so existing English callers keep byte-identical
    // request bodies (no extra "language": "" key on the wire).
    if (input.language) body.language = input.language;
    // Omit-when-empty: the server defaults to "private".
    if (input.visibility) body.visibility = input.visibility;
    // Omit-when-empty: the server defaults to "standard".
    if (input.depth) body.depth = input.depth;
    // One key per call, reused across its own retries, so a network retry
    // does not start (and charge for) a second verification.
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return this.request<TaskAccepted>({
      method: "POST",
      path: "/verify",
      json: body,
      headers,
      ...transport,
    });
  }

  /**
   * A line to the caller's logger, if any. A logger that throws, or whose
   * method returns a promise that rejects, is ignored.
   */
  private log(level: keyof LenzLogger, message: string): void {
    try {
      const out: unknown = this.logger?.[level]?.(message);
      // An async logger's rejection must not surface as an unhandled one.
      if (out !== null && (typeof out === "object" || typeof out === "function")) {
        const then = (out as { then?: unknown }).then;
        if (typeof then === "function") {
          (then as (ok: unknown, fail: (e: unknown) => void) => unknown).call(
            out,
            undefined,
            () => {},
          );
        }
      }
    } catch {
      // A logger's bug must never break the call.
    }
  }

  /**
   * `cancelOnAbort`: runs `run`, and when it throws because the caller's
   * signal fired, cancels the runs `live()` names before throwing the same
   * error. Only the outermost wait owns this: the waits it calls are never
   * handed the flag, so a run is cancelled once.
   */
  private async _cancellingOnAbort<T>(
    enabled: boolean,
    call: Call,
    kind: AbortCancelKind,
    live: () => readonly string[],
    run: () => Promise<T>,
  ): Promise<T> {
    if (!enabled) return run();
    try {
      return await run();
    } catch (exc) {
      // Only the caller's abort: the wait's own deadline throws a timeout
      // error, which never cancels.
      if (exc instanceof LenzAbortError && firedSignal(call.signals)) {
        await this._cancelAfterAbort(kind, live(), call);
      }
      throw exc;
    }
  }

  /**
   * Sends the cancel of each distinct id, concurrently, one attempt each,
   * inside one `ABORT_CANCEL_BUDGET`. Never throws: a cancel that fails or
   * finds the run ended is a `warn` line with the id, and the rest go on.
   * The call's signals are dead by now, so the cancels carry only the
   * budget's (and the call's headers).
   */
  private async _cancelAfterAbort(
    kind: AbortCancelKind,
    ids: readonly string[],
    call: Call,
  ): Promise<void> {
    const distinct = [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))];
    if (distinct.length === 0) return;
    const budget = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const spent = new Promise<never>((_res, rej) => {
      timer = setTimeout(() => {
        rej(new CancelBudgetSpent());
        budget.abort();
      }, ABORT_CANCEL_BUDGET);
    });
    spent.catch(() => {});
    const transport: Partial<SendOptions> = {
      signals: [budget.signal],
      optionHeaders: call.headers,
      maxRetries: 0,
      timeoutMs: ABORT_CANCEL_BUDGET,
      deadlineAt: Date.now() + ABORT_CANCEL_BUDGET,
    };
    const one = async (id: string): Promise<void> => {
      try {
        // Raced, so a fetch that ignores its signal still ends at the budget.
        const ended = await Promise.race([this._cancelOne(kind, id, transport), spent]);
        if (ended !== null) {
          this.log(
            "warn",
            `[lenz-io] cancelOnAbort: ${kind} ${id} was not cancelled: it had already ended ` +
              `(status ${ended}), and a run that finished is charged as usual.`,
          );
        }
      } catch (exc) {
        this.log(
          "warn",
          `[lenz-io] cancelOnAbort: could not cancel ${kind} ${id} (${cancelFailure(exc)}); ` +
            "it may still run and be charged.",
        );
      }
    };
    try {
      await Promise.all(distinct.map(one));
    } finally {
      clearTimeout(timer);
      budget.abort();
    }
  }

  /** One cancel: `null` when the run is cancelled, else the status it ended with. */
  private async _cancelOne(
    kind: AbortCancelKind,
    id: string,
    transport: Partial<SendOptions>,
  ): Promise<string | null> {
    if (kind === "task") {
      const out = await this._cancelTask(id, transport);
      return out.cancelled ? null : String(out.status);
    }
    const out =
      kind === "review"
        ? await this._cancelReview(id, transport)
        : await this._cancelCitecheck(id, transport);
    return out.status === "cancelled" ? null : String(out.status);
  }

  /** Internal: dispatch an HTTP call with auth + retry. Public so the
   *  namespace classes can use it; not part of the documented surface. */
  async request<T>(opts: SendOptions): Promise<T> {
    try {
      return await this._send<T>(opts);
    } catch (exc) {
      // Every error of a keyed call carries its key: the one safe resend.
      stampIdempotencyKey(exc, idempotencyKeyIn(opts.headers));
      throw exc;
    }
  }

  private async _send<T>(opts: SendOptions): Promise<T> {
    const idempotencyKey = idempotencyKeyIn(opts.headers);
    const signals = opts.signals ?? NO_SIGNALS;
    const authRequired = opts.authRequired !== false;
    if (authRequired && !this.apiKey) {
      throw new LenzAuthError({
        message: "API key required",
        cause: "This method requires authentication; no API key was provided.",
        fix: "Pass apiKey to new Lenz(), set LENZ_API_KEY env var, or get one at https://lenz.io/api-credentials. Library endpoints work without a key.",
        docUrl: "https://lenz.io/docs/auth",
      });
    }

    const url = new URL(`${this.baseUrl}${opts.path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== "" && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }

    // The request options' headers go after the defaults, replacing one in
    // any casing, and before the method's own (which keep today's spread).
    const optionHeaders = opts.optionHeaders ?? NO_HEADERS;
    const optionNames = new Set(optionHeaders.map(([name]) => name.toLowerCase()));
    const defaults: Record<string, string> = {};
    if (!optionNames.has("user-agent")) defaults["User-Agent"] = `lenz-io-node/${SDK_VERSION}`;
    if (!optionNames.has("accept")) defaults["Accept"] = "application/json";
    for (const [name, value] of optionHeaders) defaults[name] = value;
    const headers: Record<string, string> = {
      ...defaults,
      ...(opts.headers ?? {}),
    };
    // The version is this release's, whatever a call's own headers say: set
    // last, over any casing of the name, so a stale value cannot ride along.
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "x-lenz-api-version") delete headers[name];
    }
    headers["X-Lenz-API-Version"] = API_VERSION;
    if (this.apiKey && (authRequired || opts.authOptional)) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const maxRetries = opts.maxRetries ?? this.maxRetries;
    let lastErr: unknown = undefined;
    const deadlineAt = opts.deadlineAt;
    /** A retry sleep is taken only when it ends before the deadline. */
    const fits = (ms: number): boolean => deadlineAt === undefined || Date.now() + ms < deadlineAt;

    /**
     * One attempt: its answer, or the sleep before the next one. The caller's
     * signals are linked to the attempt's controller until it ends.
     */
    const once = async (
      attempt: number,
    ): Promise<{ done: true; value: T } | { done: false; pauseMs: number }> => {
      const controller = new AbortController();
      let attemptMs = opts.timeoutMs ?? this.timeoutMs;
      if (deadlineAt !== undefined)
        attemptMs = Math.max(0, Math.min(attemptMs, deadlineAt - Date.now()));
      const timer = setTimeout(() => controller.abort(), attemptMs);
      const link = linkSignals(signals, controller);
      try {
        let response: Response;
        try {
          response = await this.fetchImpl(url.toString(), {
            method: opts.method,
            headers,
            body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
            signal: controller.signal,
          });
        } catch (exc) {
          lastErr = exc;
          clearTimeout(timer);
          // The caller's abort is never retried, and never a request timeout.
          rethrowIfCallerAbort(signals);
          const timedOut = controller.signal.aborted;
          if (attempt >= maxRetries || !fits(retrySleepMs(attempt))) {
            const attempts = `${attempt + 1} attempt${attempt === 0 ? "" : "s"}`;
            if (timedOut) {
              throw new LenzRequestTimeoutError(
                {
                  message: `${opts.method} ${opts.path} timed out after ${attemptMs}ms (${attempts}).`,
                  cause: String(exc),
                  fix:
                    (idempotencyKey
                      ? "The request may have reached the server: resend it with the same key " +
                        "(idempotencyKey: err.idempotencyKey) so it cannot run twice; a new call " +
                        "without it mints a new key and can. "
                      : "Retry. ") +
                    "If it persists, raise timeoutMs or check the network between you and baseUrl.",
                  docUrl: "https://lenz.io/docs/errors",
                },
                { cause: exc },
              );
            }
            throw new LenzConnectionError(
              {
                message: `${opts.method} ${opts.path} failed after ${attempt + 1} attempts: ${String(exc)}`,
                cause: String(exc),
                fix: "Check your network connection; verify baseUrl is reachable.",
                docUrl: "https://lenz.io/docs/errors",
              },
              { cause: exc },
            );
          }
          this.log(
            "debug",
            `[lenz-io] Retrying ${opts.method} ${opts.path} after ${timedOut ? "a timeout" : "a network error"} in ${retrySleepMs(attempt)}ms (attempt ${attempt + 2} of ${maxRetries + 1})`,
          );
          return { done: false, pauseMs: retrySleepMs(attempt) };
        }
        const served = response.headers.get("X-Lenz-API-Version")?.trim();
        if (served && served !== API_VERSION) {
          // Another version's body is not read as this one's: no retry, no
          // typed mapping. The body goes back as sent.
          let rawBody = "";
          try {
            rawBody = await response.text();
          } catch {
            // The version is already known; an unreadable body leaves body null.
          } finally {
            clearTimeout(timer);
          }
          // A read the caller aborted is the abort, not a version error.
          rethrowIfCallerAbort(signals);
          let sentBody: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(rawBody);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              sentBody = parsed as Record<string, unknown>;
            }
          } catch {
            // not JSON: stays null
          }
          const err = new LenzApiVersionError({
            message: `The API answered in version ${served}; lenz-io 3.x reads ${API_VERSION} only.`,
            cause: `The response carries X-Lenz-API-Version: ${served}.`,
            fix:
              "If this persists, contact support (https://lenz.io/contact) with the request id; " +
              "lenz-io 2.x reads both versions.",
            docUrl: "https://lenz.io/docs/errors",
            requestId: response.headers.get("X-Request-ID") ?? "",
            statusCode: response.status,
            body: sentBody,
          });
          err.apiVersion = served;
          throw err;
        }
        if (response.status < 400) {
          // The attempt's timer stays armed until the body is read: headers
          // arriving is not the response arriving, and a body that stalls
          // after them must not hang the call.
          try {
            if (response.status === 204 || response.headers.get("content-length") === "0") {
              return { done: true, value: {} as T };
            }
            return { done: true, value: (await response.json()) as T };
          } catch (exc) {
            rethrowIfCallerAbort(signals);
            if (controller.signal.aborted) {
              throw new LenzRequestTimeoutError(
                {
                  message: `${opts.method} ${opts.path} timed out reading the response body`,
                  cause: String(exc),
                  fix: "Retry; if it persists, check the network between you and baseUrl.",
                  docUrl: "https://lenz.io/docs/errors",
                },
                { cause: exc },
              );
            }
            recordTransportFailure(exc);
            throw exc;
          } finally {
            clearTimeout(timer);
          }
        }
        // Error path. Retry on 5xx + 429; otherwise throw. The attempt's
        // timer stays armed while the error body is read, and is cleared
        // before any retry sleep.
        //
        // A stated wait is honored only up to MAX_RETRY_AFTER_SLEEP. Past that,
        // whether we abort or keep retrying is decided by the typed body `code`
        // — NOT by the status number:
        //
        //  * 429 — throw. The /extract daily cap sends seconds-until-UTC-
        //    midnight, so sleeping it blocks the call for most of a day, and
        //    this sleep sits OUTSIDE the AbortController so `timeoutMs` would
        //    not bound it. The caller gets the true retryAfter and can schedule.
        //  * 503 carrying a Lenz code in UPSTREAM_503_CODES
        //    (`upstream_unavailable` / `capacity`) — throw, same reasoning.
        //    These are the server's own shed/exhaustion responses; they state
        //    an honest 90-120s and burning the 1/2/4s ladder against them is
        //    the opposite of what the header asks (mapResponseToError types
        //    them LenzUpstreamUnavailableError, carrying the true retryAfter).
        //  * every other 5xx, including an UNTYPED 503 — keep retrying on our
        //    own backoff. A proxy / CDN / load-balancer
        //    maintenance-or-overload 503 states a long wait and carries no Lenz
        //    code; the server is down, not pacing us, so an hour-long
        //    Retry-After must become backoff — not an hour-long sleep, and not
        //    an abort of a request our ladder might still satisfy.
        //
        // The cloned-body reads below swallow their own errors, so the
        // caller's signal is checked after each one returns.
        //
        // A request with this key still in flight (the first attempt of this
        // call, or of an earlier one with the caller's key): ask again with the
        // SAME key and body, never a new key, until it answers or the retries
        // or the deadline run out.
        if (response.status === 409 && idempotencyKey && attempt < maxRetries) {
          const code = await bodyErrorCode(response);
          rethrowIfCallerAbort(signals);
          let receipt = false;
          if (code === "idempotency_conflict" && opts.conflictReceipt) {
            receipt = await bodyNames(response, opts.conflictReceipt);
            rethrowIfCallerAbort(signals);
          }
          if (code === "idempotency_conflict" && !receipt) {
            const stated = await statedRetryAfterSeconds(response);
            rethrowIfCallerAbort(signals);
            const waitMs =
              stated !== null && stated <= MAX_RETRY_AFTER_SLEEP
                ? stated * 1000
                : retrySleepMs(attempt);
            if (fits(waitMs)) {
              clearTimeout(timer);
              this.log(
                "debug",
                `[lenz-io] Retrying ${opts.method} ${opts.path} after HTTP 409 (still in flight) in ${waitMs}ms (attempt ${attempt + 2} of ${maxRetries + 1})`,
              );
              return { done: false, pauseMs: waitMs };
            }
          }
        }
        let throwAtOnce = false;
        if (response.status === 429) {
          throwAtOnce = THROW_AT_ONCE_429_CODES.includes(await bodyErrorCode(response));
          rethrowIfCallerAbort(signals);
        }
        if (
          !throwAtOnce &&
          attempt < maxRetries &&
          (response.status >= 500 || response.status === 429)
        ) {
          const stated = await statedRetryAfterSeconds(response);
          rethrowIfCallerAbort(signals);
          const retryLine = (ms: number) =>
            `[lenz-io] Retrying ${opts.method} ${opts.path} after HTTP ${response.status} in ${ms}ms (attempt ${attempt + 2} of ${maxRetries + 1})`;
          if (stated !== null && stated <= MAX_RETRY_AFTER_SLEEP) {
            if (fits(stated * 1000)) {
              clearTimeout(timer);
              this.log("debug", retryLine(stated * 1000));
              return { done: false, pauseMs: stated * 1000 };
            }
          } else {
            const aborts = stated !== null && (await abortsOnLongStatedWait(response));
            rethrowIfCallerAbort(signals);
            if (!aborts && fits(retrySleepMs(attempt))) {
              clearTimeout(timer);
              this.log("debug", retryLine(retrySleepMs(attempt)));
              return { done: false, pauseMs: retrySleepMs(attempt) };
            }
          }
        }

        let rawBody = "";
        try {
          rawBody = await response.text();
        } catch (exc) {
          rethrowIfCallerAbort(signals);
          // A body that stalled until the timer fired: the status stands, the
          // body is lost.
          if (!controller.signal.aborted) {
            recordTransportFailure(exc);
            throw exc;
          }
        } finally {
          clearTimeout(timer);
        }
        const respHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          respHeaders[k] = v;
        });
        throw mapResponseToError(response.status, rawBody, respHeaders, {
          method: opts.method,
          path: opts.path,
        });
      } finally {
        // Whatever ended the attempt (an abort while an error response was
        // inspected included), its timer and listeners go with it.
        clearTimeout(timer);
        link.unlink();
      }
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      throwIfAborted(signals);
      const outcome = await once(attempt);
      if (outcome.done) return outcome.value;
      await sleep(outcome.pauseMs, signals);
    }

    if (lastErr) {
      throw new LenzConnectionError(
        { message: String(lastErr), cause: String(lastErr) },
        { cause: lastErr },
      );
    }
    throw new LenzAPIError({ message: `${opts.method} ${opts.path} failed without diagnostic` });
  }
}
