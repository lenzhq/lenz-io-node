/**
 * Public Lenz client — the ergonomic top-level surface.
 *
 * Multi-language SDK convention (12 languages):
 * - Request methods (verify, assess, extract, ask.send, …) take
 *   `language?: string`. Omit the field (or pass empty string) for
 *   English (default) — the SDK then omits the key from the request
 *   body, preserving byte-identical wire format for existing English
 *   callers. Set `language: "es"` (or any of the 12 supported codes)
 *   to receive prose fields in that language.
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
 * const claims = out.identified_claims?.length ? out.identified_claims : [out.claim!];
 *
 * // 2. assess — ONE call over the extracted claims (up to 20), one row per
 * //    claim in the same order. A row with verdict 'Error' has error_code +
 * //    hint; a compound item lists the rest in identified_claims.
 * const quick = (await client.assess({ claims })).claims;
 *
 * // 3. verify — escalate the low-confidence rows to the full pipeline (~90s, paid)
 * const doubtful = quick
 *   .filter((c) => c.verdict !== 'Error' && c.confidence === 'low')
 *   .map((c) => ({ claim: c.claim! }));
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

import {
  LenzAPIError,
  LenzAuthError,
  LenzError,
  LenzGoneError,
  LenzNeedsInputError,
  LenzPipelineError,
  LenzTimeoutError,
  LenzValidationError,
  MAX_RETRY_AFTER_SLEEP,
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
  BatchItemResult,
  Certificate,
  ExtractInput,
  ExtractedClaims,
  LibraryList,
  LibraryListInput,
  OnProgress,
  Progress,
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

// Pin the API version the SDK was built against. The server logs it on
// every request; when v2 ships, old SDKs keep getting v1 behavior.
export const API_VERSION = "2026-05-13";
export const DEFAULT_BASE_URL = "https://lenz.io/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Floor on the per-call timeout for `assess`, BOTH forms.
 *
 * The server runs framing and then a 3-model panel inside one synchronous
 * request and divides a single budget between them, so a single-claim call
 * can take as long as a list one. Typical calls answer in 10-25s; this is the
 * ceiling the server sizes its own budget against.
 *
 * Applied to `assess({ claim })` as well as `assess({ claims })` since 2.12.0.
 * Before that the single form used the 30s default, and a call whose framing
 * was slow could time out client-side AFTER the server had charged it — and a
 * retry with no idempotency key charged again.
 */
const ASSESS_TIMEOUT_MS = 45_000;
/**
 * Floor on the per-call timeout for `extract`.
 *
 * Extraction reads the whole input and enumerates its claims inside one
 * synchronous request. Most calls answer in 3-17s, but the slowest take
 * 30-60s, past the 30s default, and a client timeout makes the SDK re-send
 * the call, which runs the same extraction again. 90s leaves room above them.
 */
const EXTRACT_TIMEOUT_MS = 90_000;
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

/**
 * Cross-runtime UUID. Prefers the WebCrypto global (browsers, Node ≥20, Deno,
 * Workers); lazily falls back to node:crypto on Node 18 without global
 * WebCrypto. The computed specifier keeps browser bundlers from statically
 * resolving node:crypto — this branch is unreachable in a browser, which
 * always exposes globalThis.crypto.
 */
async function generateUuid(): Promise<string> {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID();
  const nodeCryptoSpecifier: string = "node:crypto";
  const mod = (await import(
    /* @vite-ignore */ nodeCryptoSpecifier
  )) as typeof import("node:crypto");
  return mod.randomUUID();
}

/** Read an env var without assuming a Node `process` exists (browser-safe). */
function envVar(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

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

function isRateLimit(exc: unknown): boolean {
  return exc instanceof LenzError && exc.statusCode === 429;
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
      let candidate: unknown = bag ? bag["reset_in_seconds"] : null;
      if (candidate === null || candidate === undefined || String(candidate).trim() === "") {
        candidate = bag ? bag["retry_after"] : null;
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

  list({ page = 1 }: { page?: number } = {}): Promise<VerificationList> {
    return this.client.request<VerificationList>({
      method: "GET",
      path: "/verifications",
      query: { page },
    });
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
  get(verificationId: string): Promise<Verification> {
    return this.client.request<Verification>({
      method: "GET",
      path: `/verifications/${verificationId}`,
      authRequired: false,
      authOptional: true, // send the key if we have one → owner sees private rows
    });
  }

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
  getCertificate(verificationId: string): Promise<Certificate> {
    return this.client.request<Certificate>({
      method: "GET",
      path: `/verifications/${verificationId}/certificate`,
    });
  }

  async delete(verificationId: string): Promise<boolean> {
    try {
      await this.client.request<unknown>({
        method: "DELETE",
        path: `/verifications/${verificationId}`,
      });
      return true;
    } catch (exc) {
      // Idempotent DELETE: 404 after retry means the row was already gone.
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
  related(
    verificationId: string,
    { limit = 5 }: { limit?: number } = {},
  ): Promise<RelatedVerifications> {
    return this.client.request<RelatedVerifications>({
      method: "GET",
      path: `/verifications/${verificationId}/related`,
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
  history(verificationId: string): Promise<AskHistory> {
    return this.client.request<AskHistory>({
      method: "GET",
      path: `/ask/${verificationId}`,
    });
  }

  /**
   * Ask a follow-up question about a verification. Paid, one credit per turn.
   *
   * Pass `idempotencyKey` to make a retry safe: with a key, a retry of a
   * question that already got a reply replays that reply rather than asking
   * again. It is never generated here — see {@link AskSendInput.idempotencyKey}.
   *
   * Throws {@link LenzGoneError} (HTTP 410) when the account's retention period has removed the verification.
   */
  send(verificationId: string, input: AskSendInput): Promise<AskReply> {
    const body: Record<string, unknown> = { message: input.message };
    if (input.language) body.language = input.language;
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
    return this.client.request<AskReply>({
      method: "POST",
      path: `/ask/${verificationId}`,
      json: body,
      headers,
    });
  }

  async reset(verificationId: string): Promise<boolean> {
    await this.client.request<unknown>({
      method: "DELETE",
      path: `/ask/${verificationId}`,
    });
    return true;
  }
}

class LibraryNamespace {
  constructor(private readonly client: Lenz) {}

  list(input: LibraryListInput = {}): Promise<LibraryList> {
    return this.client.request<LibraryList>({
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
  }
}

export class Lenz {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private fetchImpl: typeof fetch;

  readonly verifications: VerificationsNamespace;
  readonly ask: AskNamespace;
  readonly library: LibraryNamespace;

  constructor(opts: LenzOptions = {}) {
    this.apiKey = opts.apiKey ?? envVar("LENZ_API_KEY") ?? "";
    this.baseUrl = (opts.baseUrl ?? envVar("LENZ_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);

    this.verifications = new VerificationsNamespace(this);
    this.ask = new AskNamespace(this);
    this.library = new LibraryNamespace(this);
  }

  // ── Marquee verbs ──

  async verify(input: VerifyInput): Promise<TaskAccepted> {
    return this.submit(input);
  }

  async verifyBatch(input: VerifyBatchInput): Promise<BatchAccepted> {
    const body: Record<string, unknown> = {
      // Per-item shape passes through verbatim — `VerifyBatchItem` allows
      // any subset including a per-item `language` override.
      claims: input.claims.map((c) => {
        const item: Record<string, unknown> = {
          text: c.claim || c.text,
          source_url: c.source_url ?? "",
          webhook_url: c.webhook_url ?? "",
        };
        if (c.language) item.language = c.language;
        if (c.visibility) item.visibility = c.visibility;
        if (c.depth) item.depth = c.depth;
        return item;
      }),
    };
    // Batch-wide defaults — per-item values (in the claims map above) override
    // server-side when set.
    if (input.webhookUrl) body["webhook_url"] = input.webhookUrl;
    if (input.language) body["language"] = input.language;
    if (input.visibility) body["visibility"] = input.visibility;
    if (input.depth) body["depth"] = input.depth;
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
    return this.request<BatchAccepted>({
      method: "POST",
      path: "/verify/batch",
      json: body,
      headers,
    });
  }

  /**
   * Pull the verifiable claims out of any text. Sync, free, capped at
   * 1000 calls/account/day (shared across your API keys).
   *
   * Pass `focus` to narrow the result to the claims you care about, e.g.
   * `"market size and competitors"`. A focus can only SELECT from the claims
   * the extractor found — see {@link ExtractInput.focus}.
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
    return this.request<ExtractedClaims>({
      method: "POST",
      path: "/extract",
      json: body,
      // Never shortens a client configured with a longer timeout: the caller
      // asked for it.
      timeoutMs: input.timeoutMs ?? Math.max(this.timeoutMs, EXTRACT_TIMEOUT_MS),
    });
  }

  /**
   * Fast 3-model panel verdict. Sync, ~10s for one claim. Two forms:
   *
   * - `assess({ claim })` — one text; returns one entry per claim found in
   *   it (up to 20, 1 credit each).
   * - `assess({ claims })` — up to 20 claims in one call (~10-25s); returns
   *   exactly one entry per item, in the order sent. This is the step after
   *   `extract` in the ladder. A row with `verdict === "Error"` has
   *   `error_code` and `hint` and is free; a compound item is assessed on
   *   its main claim and lists the rest in `identified_claims`.
   *
   * ```ts
   * const out = await client.extract({ text: llmOutput });
   * const claims = out.identified_claims?.length ? out.identified_claims : [out.claim!];
   * const quick = (await client.assess({ claims })).claims; // one row per claim, same order
   * const doubtful = quick
   *   .filter((c) => c.verdict !== "Error" && c.confidence === "low")
   *   .map((c) => ({ claim: c.claim! }));
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
   * the claim text in that language. Verdict labels stay English.
   */
  async assess(input: AssessInput): Promise<AssessResponse> {
    // A random key per invocation, reused across this client's own retries so
    // a 5xx retry is deduped server-side rather than charged twice.
    //
    // Deliberately NOT derived from the claim text: an identical claim sent an
    // hour later is a new question, and a content-derived key would replay the
    // first answer for 24h — including for a claim whose verdict the server
    // would otherwise refresh.
    const idempotencyKey =
      input.idempotencyKey ??
      (input.idempotency !== false ? (await generateUuid()).replace(/-/g, "") : undefined);
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
      return this.request<AssessResponse>({
        method: "POST",
        path: "/assess",
        json: body,
        timeoutMs,
        headers,
      });
    }
    const body: Record<string, unknown> = { text: single };
    if (input.language) body.language = input.language;
    return this.request<AssessResponse>({
      method: "POST",
      path: "/assess",
      json: body,
      timeoutMs,
      headers,
    });
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
    const chosen = input.claims && input.claims.length > 0 ? input.claims : input.texts;
    if (!chosen || chosen.length === 0) {
      throw new Error("select requires a non-empty claims array");
    }
    return this.request<BatchAccepted>({
      method: "POST",
      path: `/verify/${taskId}/select`,
      json: { texts: chosen },
    });
  }

  /**
   * One non-blocking poll of a task.
   *
   * On a completed task, throws {@link LenzGoneError} (HTTP 410) when the
   * account's retention period has removed the verification. A running task
   * never answers 410.
   */
  async getStatus(taskId: string): Promise<TaskStatus> {
    return this.request<TaskStatus>({
      method: "GET",
      path: `/verify/status/${taskId}`,
    });
  }

  async usage(): Promise<Usage> {
    const usage = await this.request<Usage>({ method: "GET", path: "/me/usage" });
    // `credits.extra` and its deprecated old name `credits.bonus` are the same
    // number. Fill whichever one the server did not send, so both read
    // correctly against a server that sends only one of them.
    const credits = usage.credits as unknown as Record<string, unknown> | undefined;
    if (credits && typeof credits === "object") {
      if (credits["extra"] == null && credits["bonus"] != null) {
        credits["extra"] = credits["bonus"];
      } else if (credits["bonus"] == null && credits["extra"] != null) {
        credits["bonus"] = credits["extra"];
      }
    }
    return usage;
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
    return this._submitReview(input);
  }

  private async _submitReview(
    input: ReviewInput,
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
    if (Object.keys(escalate).length > 0) body.escalate = escalate;
    // Always keyed: this client retries a failed POST, and a retry without a
    // key could start a second review. Random per call, never derived from
    // the text: the same draft submitted again later is a new review.
    const idempotencyKey = input.idempotencyKey ?? (await generateUuid()).replace(/-/g, "");
    try {
      return await this.request<ReviewStarted>({
        method: "POST",
        path: "/review",
        json: body,
        headers: { "Idempotency-Key": idempotencyKey },
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

  private async _getReview(
    reviewId: string,
    opts: GetReviewOptions,
    transport: Pick<RequestOptions, "timeoutMs" | "maxRetries" | "deadlineAt"> = {},
  ): Promise<ReviewFull | ReviewIssues> {
    if (!reviewId) {
      throw new Error("getReview() requires a non-empty review_id.");
    }
    return this.request<ReviewFull | ReviewIssues>({
      method: "GET",
      path: `/reviews/${encodeURIComponent(reviewId)}`,
      query: opts.view && opts.view !== "full" ? { view: opts.view } : undefined,
      ...transport,
    });
  }

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
  async reviewAndWait(input: ReviewInput, opts: ReviewAndWaitOptions = {}): Promise<ReviewFull> {
    const timeoutMs = opts.timeoutMs ?? REVIEW_DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    // The submit is bounded by the same deadline: its attempts are cut to
    // what is left and a retry that would pass it is not taken.
    const { review_id: reviewId } = await this._submitReview(input, { deadlineAt: deadline });
    let last: ReviewFull | null = null;
    let lastJson = "";
    for (let poll = 0; ; poll++) {
      const budget = deadline - Date.now();
      // The first poll always runs, even when the submit used up the budget,
      // so a timeout can still hand back what the review looks like.
      if (budget <= 0 && poll > 0) throw new ReviewTimeoutError(reviewId, last, timeoutMs);
      let current: ReviewFull | null = null;
      let statedWaitMs = 0;
      try {
        // One attempt per poll, bounded by what is left: this loop owns the
        // waits, so a retry ladder inside the request cannot outlive the
        // deadline.
        const body = (await this._getReview(
          reviewId,
          {},
          {
            maxRetries: 0,
            // Cut at what is left. Only when the submit used the whole
            // budget does the first poll get 5 s, so `partial` can fill.
            timeoutMs: Math.min(
              this.timeoutMs,
              poll === 0 && budget <= 0 ? REVIEW_POLL_FLOOR_S * 1000 : budget,
            ),
          },
        )) as unknown;
        // A 2xx that is not a review (an empty body, a proxy's page) is a
        // failed poll, never an update and never `partial`.
        if (
          body &&
          typeof body === "object" &&
          typeof (body as { status?: unknown }).status === "string"
        ) {
          current = body as ReviewFull;
        }
      } catch (exc) {
        // Keep waiting through what a later poll can outlast: a 5xx, a rate
        // limit, and anything that is not a Lenz answer at all (a network
        // drop, a body that stops or does not decode). A Lenz answer that
        // waiting will not change (auth, 404, a purged review) ends the wait.
        if (exc instanceof LenzError && !(exc instanceof LenzAPIError) && !isRateLimit(exc)) {
          throw exc;
        }
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
          if (opts.onUpdate) {
            try {
              opts.onUpdate(current);
            } catch {
              // A caller's bug must not end the wait.
            }
          }
        }
        if (current.status === "completed") return current;
        if (current.status === "failed") throw new ReviewFailedError(current);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ReviewTimeoutError(reviewId, last, timeoutMs);
      await sleep(Math.min(Math.max(reviewPollMs(current ?? last), statedWaitMs), remaining));
    }
  }

  // ── Headline ergonomic ──

  /**
   * Submit + poll until the pipeline terminates. Returns the completed
   * Verification, or throws LenzNeedsInputError / LenzPipelineError /
   * LenzTimeoutError. By default sends an auto-generated Idempotency-Key
   * so a network retry on submit doesn't spawn a duplicate task.
   */
  async verifyAndWait(input: VerifyAndWaitInput): Promise<Verification> {
    const timeoutMs = input.timeoutMs ?? 120_000;
    const idempotencyKey =
      input.idempotencyKey ??
      (input.idempotency !== false ? (await generateUuid()).replace(/-/g, "") : undefined);

    const accepted = await this.submit({ ...input, idempotencyKey });
    // eslint-disable-next-line no-console
    console.info(`[lenz-io] Submitted task: ${accepted.task_id}`);
    return this.wait(accepted, { timeoutMs, onProgress: input.onProgress });
  }

  /**
   * Block on an already-submitted task until it terminates, then return its
   * `Verification`. `task` is a `task_id` string OR the `TaskAccepted` returned
   * by `verify` / `select` — so `client.wait(await client.verify({claim}))`
   * reads naturally. Throws for an empty id, `LenzNeedsInputError` /
   * `LenzPipelineError` on terminal non-success, `LenzGoneError` when the
   * verification was removed under its account's retention period, and
   * `LenzTimeoutError` on deadline.
   */
  async wait(task: string | TaskAccepted, opts: WaitOptions = {}): Promise<Verification> {
    const taskId = typeof task === "string" ? task : task.task_id;
    if (!taskId) {
      throw new Error("wait() requires a non-empty task_id (got an empty TaskAccepted.task_id).");
    }
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const { terminal, timedOut, gone } = await this._pollToTerminal(
      [taskId],
      timeoutMs,
      opts.onProgress,
    );
    const goneErr = gone.get(taskId);
    if (goneErr) throw goneErr;
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
   * account's retention period reads `"failed"` with no `status_detail`.
   * (Transport/auth errors on the initial submit still throw.)
   */
  async verifyBatchAndWait(input: VerifyBatchAndWaitInput): Promise<BatchItemResult[]> {
    const timeoutMs = input.timeoutMs ?? 180_000;
    const accepted = await this.verifyBatch(input);
    const ids = accepted.items.map((it) => it.task_id).filter((id): id is string => Boolean(id));
    const { terminal, timedOut, gone } = await this._pollToTerminal(
      ids,
      timeoutMs,
      input.onProgress,
    );

    return accepted.items.map((it): BatchItemResult => {
      // Removed under the account's retention period: final, with no result.
      if (gone.has(it.task_id)) {
        return { task_id: it.task_id, claim_text: it.claim_text, status: "failed" };
      }
      const status = terminal.get(it.task_id);
      if (!it.task_id || timedOut.has(it.task_id) || !status) {
        return { task_id: it.task_id, claim_text: it.claim_text, status: "timeout" };
      }
      if (status.status === "completed" && status.result) {
        return {
          task_id: it.task_id,
          claim_text: it.claim_text,
          status: "completed",
          verification: status.result,
          status_detail: status,
        };
      }
      if (status.status === "needs_input") {
        return {
          task_id: it.task_id,
          claim_text: it.claim_text,
          status: "needs_input",
          status_detail: status,
        };
      }
      // failed, or completed-without-result (treated as failed).
      return {
        task_id: it.task_id,
        claim_text: it.claim_text,
        status: "failed",
        status_detail: status,
      };
    });
  }

  // ── poll engine (shared by wait + verifyBatchAndWait) ──

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
  private async _pollToTerminal(
    taskIds: string[],
    timeoutMs: number,
    onProgress?: OnProgress,
  ): Promise<{
    terminal: Map<string, TaskStatus>;
    timedOut: Set<string>;
    gone: Map<string, LenzGoneError>;
  }> {
    let pending = [...taskIds];
    const terminal = new Map<string, TaskStatus>();
    const timedOut = new Set<string>();
    // A 410 is final: the run finished and its account's retention period has
    // since removed it. Polling again would only spin to the deadline.
    const gone = new Map<string, LenzGoneError>();
    const deadline = Date.now() + timeoutMs;
    let backoffIdx = 0;
    while (pending.length > 0) {
      const settled = await Promise.allSettled(pending.map((id) => this.getStatus(id)));
      const stillPending: string[] = [];
      let serverHintMs: number | undefined;
      settled.forEach((res, i) => {
        const id = pending[i]!;
        if (res.status === "fulfilled") {
          const s = res.value;
          if (s.status === "completed" || s.status === "needs_input" || s.status === "failed") {
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
        } else if (res.reason instanceof LenzGoneError) {
          gone.set(id, res.reason);
        } else {
          // Poll errored this round (after _request exhausted its retries) —
          // keep pending and retry next round rather than aborting the batch.
          stillPending.push(id);
        }
      });
      pending = stillPending;
      if (pending.length === 0) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        pending.forEach((id) => timedOut.add(id));
        break;
      }
      await sleep(
        serverHintMs === undefined
          ? pollSleepMs(backoffIdx, remaining)
          : Math.min(serverHintMs, Math.max(0, remaining)),
      );
      backoffIdx += 1;
    }
    return { terminal, timedOut, gone };
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
    // failed. Server sends the diagnostic under `error`; fall back to legacy fields.
    const detail = status.error || status.failure_detail || status.failure_reason || "unknown";
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

  private async submit(input: VerifyInput): Promise<TaskAccepted> {
    const body: Record<string, unknown> = {
      // `claim` is the documented name; `text` the alias. The wire key stays
      // `text`, which every server version accepts.
      text: input.claim || input.text,
      source_url: input.sourceUrl ?? "",
      webhook_url: input.webhookUrl ?? "",
    };
    // Omit-when-empty so existing English callers keep byte-identical
    // request bodies (no extra "language": "" key on the wire).
    if (input.language) body.language = input.language;
    // Omit-when-empty: the server defaults to "private".
    if (input.visibility) body.visibility = input.visibility;
    // Omit-when-empty: the server defaults to "standard".
    if (input.depth) body.depth = input.depth;
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
    return this.request<TaskAccepted>({
      method: "POST",
      path: "/verify",
      json: body,
      headers,
    });
  }

  /** Internal: dispatch an HTTP call with auth + retry. Public so the
   *  namespace classes can use it; not part of the documented surface. */
  async request<T>(opts: RequestOptions): Promise<T> {
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
      "X-Lenz-API-Version": API_VERSION,
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };
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
        if (attempt >= maxRetries || !fits(retrySleepMs(attempt))) {
          throw new LenzAPIError({
            message: `${opts.method} ${opts.path} failed after ${attempt + 1} attempts: ${String(exc)}`,
            cause: String(exc),
            fix: "Check your network connection; verify baseUrl is reachable.",
            docUrl: "https://lenz.io/docs/errors",
          });
        }
        await sleep(retrySleepMs(attempt));
        continue;
      }
      clearTimeout(timer);

      if (response.status < 400) {
        if (response.status === 204 || response.headers.get("content-length") === "0") {
          return {} as T;
        }
        return (await response.json()) as T;
      }

      // Error path. Retry on 5xx + 429; otherwise throw.
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
      const throwAtOnce =
        response.status === 429 && THROW_AT_ONCE_429_CODES.includes(await bodyErrorCode(response));
      if (
        !throwAtOnce &&
        attempt < maxRetries &&
        (response.status >= 500 || response.status === 429)
      ) {
        const stated = await statedRetryAfterSeconds(response);
        if (stated !== null && stated <= MAX_RETRY_AFTER_SLEEP) {
          if (fits(stated * 1000)) {
            await sleep(stated * 1000);
            continue;
          }
        } else if (stated === null || !(await abortsOnLongStatedWait(response))) {
          if (fits(retrySleepMs(attempt))) {
            await sleep(retrySleepMs(attempt));
            continue;
          }
        }
      }

      const rawBody = await response.text();
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      throw mapResponseToError(response.status, rawBody, respHeaders);
    }

    if (lastErr) {
      throw new LenzAPIError({
        message: String(lastErr),
        cause: String(lastErr),
      });
    }
    throw new LenzAPIError({ message: `${opts.method} ${opts.path} failed without diagnostic` });
  }
}
