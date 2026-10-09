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
  VerificationListItem,
  VerifyAndWaitInput,
  VerifyBatchAndWaitInput,
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
  return input.idempotencyKey ?? (await generateUuid()).replace(/-/g, "");
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
  /** Reserved for warnings; nothing is sent here yet. */
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
  /**
   * A body key that makes an in-flight 409 (`idempotency_conflict`) the
   * caller's answer rather than a reason to retry: when the 409 names it
   * (e.g. `review_id`), it is thrown at once for the caller to read.
   */
  conflictReceipt?: string;
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
  if (exc instanceof LenzError) {
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
): AsyncGenerator<T, void, undefined> {
  for (let page = first; ; page++) {
    const body = await read(page);
    if (typeof body.page === "number" && body.page !== page) return;
    const items = Array.isArray(body.items) ? body.items : [];
    yield* items;
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

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
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

  async list({ page = 1 }: { page?: number } = {}): Promise<VerificationList> {
    const body = await this.client.request<VerificationList>({
      method: "GET",
      path: "/verifications",
      query: { page },
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
   */
  listAll({ page }: { page?: number } = {}): AsyncIterable<VerificationListItem> {
    return walkPages((p) => this.list({ page: p }), startPage(page));
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
  async get(verificationId: string): Promise<Verification> {
    const id = requirePathId("verifications.get", "verification_id", verificationId);
    const body = await this.client.request<Verification>({
      method: "GET",
      path: `/verifications/${id}`,
      authRequired: false,
      authOptional: true, // send the key if we have one → owner sees private rows
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
  async getCertificate(verificationId: string): Promise<Certificate> {
    const id = requirePathId("verifications.getCertificate", "verification_id", verificationId);
    return this.client.request<Certificate>({
      method: "GET",
      path: `/verifications/${id}/certificate`,
    });
  }

  async delete(verificationId: string): Promise<boolean> {
    const id = requirePathId("verifications.delete", "verification_id", verificationId);
    try {
      await this.client.request<unknown>({
        method: "DELETE",
        path: `/verifications/${id}`,
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
    { limit = 5 }: { limit?: number } = {},
  ): Promise<RelatedVerifications> {
    const id = requirePathId("verifications.related", "verification_id", verificationId);
    return this.client.request<RelatedVerifications>({
      method: "GET",
      path: `/verifications/${id}/related`,
      query: { limit },
      authRequired: false,
      authOptional: true, // send the key if we have one → owner sees own rows
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
  async history(verificationId: string): Promise<AskHistory> {
    const id = requirePathId("ask.history", "verification_id", verificationId);
    return this.client.request<AskHistory>({
      method: "GET",
      path: `/ask/${id}`,
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
  async send(verificationId: string, input: AskSendInput): Promise<AskReply> {
    const id = requirePathId("ask.send", "verification_id", verificationId);
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
    });
  }

  async reset(verificationId: string): Promise<boolean> {
    const id = requirePathId("ask.reset", "verification_id", verificationId);
    await this.client.request<unknown>({
      method: "DELETE",
      path: `/ask/${id}`,
    });
    return true;
  }
}

class LibraryNamespace {
  constructor(private readonly client: Lenz) {}

  async list(input: LibraryListInput = {}): Promise<LibraryList> {
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
    });
    return normalizeVerificationList(body) as LibraryList;
  }

  /**
   * Every library item matching the filters, across pages: one `list`
   * request per page, made when the previous page has been read; starts at
   * `page` (default 1) and stops on a short or empty page, or one that
   * reaches `total`. Throws when called for `sort: "random"`, whose pages are
   * separate samples, not one list, and for a start page below 1.
   */
  listAll(input: LibraryListInput = {}): AsyncIterable<LibraryItem> {
    if (input.sort === "random") {
      throw new Error(
        'listAll cannot walk sort: "random" (each page is a fresh sample); call library.list instead.',
      );
    }
    const first = startPage(input.page);
    return walkPages((page: number) => this.list({ ...input, page }), first);
  }
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

  // ── Marquee verbs ──

  async verify(input: VerifyInput): Promise<TaskAccepted> {
    return this.submit(input, await callIdempotencyKey(input));
  }

  async verifyBatch(input: VerifyBatchInput): Promise<BatchAccepted> {
    return this._verifyBatch(input, await callIdempotencyKey(input));
  }

  private async _verifyBatch(
    input: VerifyBatchInput,
    idempotencyKey: string | undefined,
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
  async extract(input: ExtractInput): Promise<ExtractedClaims> {
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
      // Never shortens a client configured with a longer timeout: the caller
      // asked for it.
      timeoutMs: input.timeoutMs ?? Math.max(this.timeoutMs, EXTRACT_TIMEOUT_MS),
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
  async assess(input: AssessInput): Promise<AssessResponse> {
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
    // Never shortens a client configured with a longer timeout: the caller
    // asked for it.
    const timeoutMs = input.timeoutMs ?? Math.max(this.timeoutMs, ASSESS_TIMEOUT_MS);
    // `claim` is the documented name; `text` the alias. Either way the wire
    // key is `text`, which every server version accepts.
    const single = input.claim || input.text;
    const list = input.claims;
    if (list && list.length > 0) {
      if (single) {
        throw new LenzValidationError({
          message: "assess takes one claim (`claim`) or a list (`claims`), not both.",
          cause: "`claims` was given together with a non-empty `claim` / `text`.",
          fix: "Send a single claim as `claim`, or up to 20 claims as `claims`.",
          docUrl: "https://lenz.io/docs/errors",
        });
      }
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
          timeoutMs,
          headers,
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
        timeoutMs,
        headers,
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
  async select(taskId: string, input: SelectInput): Promise<BatchAccepted> {
    const id = requirePathId("select", "task_id", taskId);
    const chosen = input.claims && input.claims.length > 0 ? input.claims : input.texts;
    if (!chosen || chosen.length === 0) {
      throw new Error("select requires a non-empty claims array");
    }
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
     * Used by the waits, which poll through this method: the request's
     * per-attempt timeout and absolute `Date.now()` deadline. An override
     * may ignore it; the wait still ends at its deadline.
     */
    budget?: { timeoutMs?: number; deadlineAt?: number },
  ): Promise<TaskStatus> {
    return this._getStatus(taskId, {
      ...(budget?.timeoutMs !== undefined ? { timeoutMs: budget.timeoutMs } : {}),
      ...(budget?.deadlineAt !== undefined ? { deadlineAt: budget.deadlineAt } : {}),
    });
  }

  private async _getStatus(
    taskId: string,
    transport: Pick<RequestOptions, "timeoutMs" | "deadlineAt"> = {},
  ): Promise<TaskStatus> {
    const id = requirePathId("getStatus", "task_id", taskId);
    const body = await this.request<TaskStatus>({
      method: "GET",
      path: `/verify/status/${id}`,
      ...transport,
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
  async cancel(taskId: string): Promise<CancelResult> {
    const id = requirePathId("cancel", "task_id", taskId);
    const path = `/verify/${id}/cancel`;
    const body = await this.request<unknown>({ method: "POST", path });
    const result = body as Partial<CancelResult> | null;
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      typeof result.task_id !== "string" ||
      typeof result.cancelled !== "boolean"
    ) {
      throw new LenzAPIError({
        message: `POST ${path} answered without a cancel result.`,
        cause: "The response carries no task_id and cancelled.",
        fix: "Read the run with getStatus(taskId); contact support with the request id if this persists.",
        docUrl: "https://lenz.io/docs/errors",
      });
    }
    return body as CancelResult;
  }

  async usage(): Promise<Usage> {
    const usage = await this.request<Usage>({ method: "GET", path: "/me/usage" });
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
  async review(input: ReviewInput): Promise<ReviewStarted> {
    return this._submitReview(input, await jobIdempotencyKey(input));
  }

  private async _submitReview(
    input: ReviewInput,
    idempotencyKey: string,
    transport: Pick<RequestOptions, "deadlineAt"> = {},
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
  getReview(reviewId: string, opts: { view: "issues" }): Promise<ReviewIssues>;
  getReview(reviewId: string, opts: { view: "full" }): Promise<ReviewFull>;
  getReview(reviewId: string, opts?: GetReviewOptions): Promise<ReviewFull | ReviewIssues>;
  getReview(reviewId: string, opts: GetReviewOptions = {}): Promise<ReviewFull | ReviewIssues> {
    return this._getReview(reviewId, opts);
  }

  // ── Citation check: the check on its own ──

  /**
   * Start a citation check: does each source the text cites (or each pair
   * sent) say what the statement says it does? Send exactly one of `text`
   * and `pairs`; `maxCitations` goes with `text`. Returns the receipt at once;
   * read the check with `getCitecheck`, wait with `citecheckAndWait`, or
   * receive `citecheck.completed` at your webhook.
   */
  async citecheck(input: CitecheckInput): Promise<CitecheckStarted> {
    return this._submitCitecheck(input, await jobIdempotencyKey(input));
  }

  private async _submitCitecheck(
    input: CitecheckInput,
    idempotencyKey: string,
    transport: Pick<RequestOptions, "deadlineAt"> = {},
  ): Promise<CitecheckStarted> {
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
  async getCitecheck(citecheckId: string): Promise<Citecheck> {
    return this._getCitecheck(citecheckId);
  }

  private async _getCitecheck(
    citecheckId: string,
    transport: Pick<RequestOptions, "timeoutMs" | "maxRetries" | "deadlineAt"> = {},
  ): Promise<Citecheck> {
    return withCitecheckDefaults(await this._readCitecheck(citecheckId, transport)) as Citecheck;
  }

  /** The body as the server sent it, before any default is filled. */
  private async _readCitecheck(
    citecheckId: string,
    transport: Pick<RequestOptions, "timeoutMs" | "maxRetries" | "deadlineAt"> = {},
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
  async cancelCitecheck(citecheckId: string): Promise<Citecheck> {
    const id = requirePathId("cancelCitecheck", "citecheck_id", citecheckId);
    const body = await this.request<unknown>({
      method: "POST",
      path: `/citechecks/${id}/cancel`,
    });
    return withCitecheckDefaults(body) as Citecheck;
  }

  /**
   * Start a citation check and poll it until it ends; returns the completed
   * check. Polls on its `poll_after_seconds` (never tighter than 5 s) and
   * calls `onUpdate` on every poll whose body changed. Throws
   * {@link CitecheckFailedError} when the check ends `failed` or `cancelled` and
   * {@link CitecheckTimeoutError} (carrying the last body seen) at the
   * deadline, which bounds the submit and every poll.
   */
  async citecheckAndWait(
    input: CitecheckInput,
    opts: CitecheckAndWaitOptions = {},
  ): Promise<Citecheck> {
    const timeoutMs = opts.timeoutMs ?? REVIEW_DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const idempotencyKey = await jobIdempotencyKey(input);
    return withIdempotencyKey(idempotencyKey, async () => {
      const started = await this._submitCitecheck(input, idempotencyKey, {
        deadlineAt: deadline,
      });
      const citecheckId = acceptedId("citecheck_id", started.citecheck_id);
      return this._waitCitecheck(citecheckId, deadline, timeoutMs, opts);
    });
  }

  private _waitCitecheck(
    citecheckId: string,
    deadline: number,
    timeoutMs: number,
    opts: CitecheckAndWaitOptions,
  ): Promise<Citecheck> {
    return this._waitJob<Citecheck>({
      deadline,
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
      onUpdate: opts.onUpdate,
    });
  }

  private async _getReview(
    reviewId: string,
    opts: GetReviewOptions,
    transport: Pick<RequestOptions, "timeoutMs" | "maxRetries" | "deadlineAt"> = {},
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
  async cancelReview(reviewId: string): Promise<ReviewFull> {
    const id = requirePathId("cancelReview", "review_id", reviewId);
    const body = await this.request<ReviewFull>({
      method: "POST",
      path: `/reviews/${id}/cancel`,
    });
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
   * server stated when it stated one (at most 60 s). The deadline bounds the
   * submit and every poll; when the submit used it up, one poll still runs so
   * the timeout can carry `partial`, and a terminal review it reads is
   * returned or thrown as usual.
   */
  async reviewAndWait(input: ReviewInput, opts: ReviewAndWaitOptions = {}): Promise<ReviewFull> {
    const timeoutMs = opts.timeoutMs ?? REVIEW_DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const idempotencyKey = await jobIdempotencyKey(input);
    return withIdempotencyKey(idempotencyKey, async () => {
      // The submit is bounded by the same deadline: its attempts are cut to
      // what is left and a retry that would pass it is not taken.
      const started = await this._submitReview(input, idempotencyKey, {
        deadlineAt: deadline,
      });
      const reviewId = acceptedId("review_id", started.review_id);
      return this._waitJob<ReviewFull>({
        deadline,
        read: (transport) => this._getReview(reviewId, {}, transport),
        isBody: (body) => isReviewBody(body, reviewId),
        failed: (review) => new ReviewFailedError(review),
        timedOut: (last) => new ReviewTimeoutError(reviewId, last, timeoutMs),
        onUpdate: opts.onUpdate,
      });
    });
  }

  /**
   * The poll loop behind every `*AndWait` of an async job (a review, a
   * citation check), from the moment it was accepted to `deadline`.
   */
  private async _waitJob<T extends { status: string; poll_after_seconds: number | null }>(job: {
    deadline: number;
    read: (transport: Pick<RequestOptions, "timeoutMs" | "maxRetries">) => Promise<unknown>;
    isBody: (body: unknown) => body is T;
    failed: (current: T) => Error;
    timedOut: (last: T | null) => Error;
    onUpdate?: (current: T) => void;
  }): Promise<T> {
    const { deadline } = job;
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
          maxRetries: 0,
          // Cut at what is left. Only when the submit used the whole budget
          // does the first poll get 5 s, so `partial` can fill.
          timeoutMs: Math.min(
            this.timeoutMs,
            poll === 0 && budget <= 0 ? REVIEW_POLL_FLOOR_S * 1000 : budget,
          ),
        });
        // A 2xx that is not this job (an empty body, a proxy's error object,
        // another id, a body missing its lists) is a failed poll, never an
        // update and never `partial`.
        if (job.isBody(body)) current = body;
      } catch (exc) {
        // Keep waiting through what a later poll can outlast: a 5xx, a rate
        // limit, and anything that is not a Lenz answer at all (a network
        // drop, a body that stops or does not decode). A Lenz answer that
        // waiting will not change (auth, 404, a purged job) ends the wait.
        if (exc instanceof LenzError && !(exc instanceof LenzAPIError) && !isRateLimit(exc)) {
          throw exc;
        }
        // The call's own refusal of an id: waiting does not change it.
        if (exc instanceof InvalidIdError) throw exc;
        // A wait the server stated outranks the poll hint, capped like every
        // other stated wait in this client: a maintenance 503 can state an
        // hour.
        const retryAfter = (exc as { retryAfter?: unknown }).retryAfter;
        if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
          statedWaitMs = Math.min(retryAfter, MAX_RETRY_AFTER_SLEEP) * 1000;
        }
      }
      if (current) {
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
        if (current.status === "completed") return current;
        // `cancelled` (API version 2026-10-11) is the original shape's `failed`
        // with failure class `cancelled`: the same error.
        if (current.status === "failed" || current.status === "cancelled") {
          throw job.failed(current);
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw job.timedOut(last);
      await sleep(Math.min(Math.max(reviewPollMs(current ?? last), statedWaitMs), remaining));
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
   * `opts` wins field by field.
   */
  async verifyAndWait(input: VerifyAndWaitInput, opts: WaitOptions = {}): Promise<Verification> {
    const { timeoutMs, onProgress } = waitOptions(input, opts);
    const idempotencyKey = await callIdempotencyKey(input);
    return withIdempotencyKey(idempotencyKey, async () => {
      const accepted = await this.submit(input, idempotencyKey);
      acceptedId("task_id", accepted.task_id);
      this.log("info", `[lenz-io] Submitted task: ${accepted.task_id}`);
      return this.wait(accepted, { timeoutMs, onProgress });
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
   * `LenzTimeoutError` on deadline.
   */
  async wait(task: string | TaskAccepted, opts: WaitOptions = {}): Promise<Verification> {
    const taskId = typeof task === "string" ? task : task.task_id;
    if (!taskId) {
      throw new Error("wait() requires a non-empty task_id (got an empty TaskAccepted.task_id).");
    }
    requirePathId("wait", "task_id", taskId);
    const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
    const { terminal, timedOut, gone, permanent } = await this._pollToTerminal(
      [taskId],
      timeoutMs,
      opts.onProgress,
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
   * `opts` wins field by field.
   */
  async verifyBatchAndWait(
    input: VerifyBatchAndWaitInput,
    opts: WaitOptions = {},
  ): Promise<BatchItemResult[]> {
    const { timeoutMs, onProgress } = waitOptions(input, opts);
    const idempotencyKey = await callIdempotencyKey(input);
    return withIdempotencyKey(idempotencyKey, () =>
      this._verifyBatchAndWait(input, idempotencyKey, timeoutMs, onProgress),
    );
  }

  private async _verifyBatchAndWait(
    input: VerifyBatchAndWaitInput,
    idempotencyKey: string | undefined,
    timeoutMs: number,
    onProgress: OnProgress | undefined,
  ): Promise<BatchItemResult[]> {
    // Through the public verifyBatch, as 2.x did, so an override (a subclass,
    // a test double) is used. The call's key rides in the input, so the
    // override and the default both send the key this call reports; with
    // the opt-out there is none and the input goes as given.
    const accepted = await this.verifyBatch(
      idempotencyKey === undefined ? input : { ...input, idempotencyKey },
    );
    for (const it of accepted.items) acceptedId("task_id", it.task_id);
    const ids = accepted.items.map((it) => it.task_id).filter((id): id is string => Boolean(id));
    const { terminal, timedOut, gone, permanent } = await this._pollToTerminal(
      ids,
      timeoutMs,
      onProgress,
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
    onProgress?: OnProgress,
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
        pending.forEach((id) => timedOut.add(id));
        break;
      }
      const transport =
        remaining > 0
          ? { timeoutMs: Math.min(this.timeoutMs, remaining), deadlineAt: deadline }
          : { timeoutMs: this.timeoutMs };
      const settled = await Promise.allSettled(
        pending.map((id) => this._pollThroughGetStatus(id, transport)),
      );
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
        } else {
          // Poll errored this round (after _request exhausted its retries) —
          // keep pending and retry next round rather than aborting the batch.
          stillPending.push(id);
        }
      });
      pending = stillPending;
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
  ): Promise<TaskStatus> {
    const poll = this.getStatus(taskId, budget);
    const deadlineAt = budget.deadlineAt;
    if (deadlineAt === undefined) return poll;
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
      return await Promise.race([poll, cutoff]);
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

  /** Internal: dispatch an HTTP call with auth + retry. Public so the
   *  namespace classes can use it; not part of the documented surface. */
  async request<T>(opts: RequestOptions): Promise<T> {
    try {
      return await this._send<T>(opts);
    } catch (exc) {
      // Every error of a keyed call carries its key: the one safe resend.
      stampIdempotencyKey(exc, idempotencyKeyIn(opts.headers));
      throw exc;
    }
  }

  private async _send<T>(opts: RequestOptions): Promise<T> {
    const idempotencyKey = idempotencyKeyIn(opts.headers);
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

    const headers: Record<string, string> = {
      "User-Agent": `lenz-io-node/${SDK_VERSION}`,
      Accept: "application/json",
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
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      let attemptMs = opts.timeoutMs ?? this.timeoutMs;
      if (deadlineAt !== undefined)
        attemptMs = Math.max(0, Math.min(attemptMs, deadlineAt - Date.now()));
      const timer = setTimeout(() => controller.abort(), attemptMs);
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
        await sleep(retrySleepMs(attempt));
        continue;
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
            return {} as T;
          }
          return (await response.json()) as T;
        } catch (exc) {
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
      //    own backoff. A Cloud Run / CDN / load-balancer
      //    maintenance-or-overload 503 states a long wait and carries no Lenz
      //    code; the server is down, not pacing us, so an hour-long
      //    Retry-After must become backoff — not an hour-long sleep, and not
      //    an abort of a request our ladder might still satisfy.
      // A request with this key still in flight (the first attempt of this
      // call, or of an earlier one with the caller's key): ask again with the
      // SAME key and body, never a new key, until it answers or the retries
      // or the deadline run out.
      if (
        response.status === 409 &&
        idempotencyKey &&
        attempt < maxRetries &&
        (await bodyErrorCode(response)) === "idempotency_conflict" &&
        !(opts.conflictReceipt && (await bodyNames(response, opts.conflictReceipt)))
      ) {
        const stated = await statedRetryAfterSeconds(response);
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
          await sleep(waitMs);
          continue;
        }
      }
      const throwAtOnce =
        response.status === 429 && THROW_AT_ONCE_429_CODES.includes(await bodyErrorCode(response));
      if (
        !throwAtOnce &&
        attempt < maxRetries &&
        (response.status >= 500 || response.status === 429)
      ) {
        const stated = await statedRetryAfterSeconds(response);
        const retryLine = (ms: number) =>
          `[lenz-io] Retrying ${opts.method} ${opts.path} after HTTP ${response.status} in ${ms}ms (attempt ${attempt + 2} of ${maxRetries + 1})`;
        if (stated !== null && stated <= MAX_RETRY_AFTER_SLEEP) {
          if (fits(stated * 1000)) {
            clearTimeout(timer);
            this.log("debug", retryLine(stated * 1000));
            await sleep(stated * 1000);
            continue;
          }
        } else if (stated === null || !(await abortsOnLongStatedWait(response))) {
          if (fits(retrySleepMs(attempt))) {
            clearTimeout(timer);
            this.log("debug", retryLine(retrySleepMs(attempt)));
            await sleep(retrySleepMs(attempt));
            continue;
          }
        }
      }

      let rawBody = "";
      try {
        rawBody = await response.text();
      } catch (exc) {
        // A body that stalled until the timer fired: the status stands, the
        // body is lost.
        if (!controller.signal.aborted) throw exc;
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
