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
 *
 * // 2. assess — fast 3-model verdict on each (~5-10s, paid)
 * const quick = await client.assess({ text: llmOutput });
 *
 * // 3. verify — escalate low-confidence to the full pipeline (~90s, paid)
 * for (const c of quick.claims) {
 *   if (c.confidence === 'low') {
 *     const deep = await client.verifyAndWait({ claim: c.claim! });
 *     console.log(deep.verdict, deep.lenz_score);
 *   }
 * }
 *
 * // 4. ask — follow-up grounded on a verification
 * const reply = await client.ask.send(deep.verification_id!, {
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

import { randomUUID } from "node:crypto";

import {
  LenzAPIError,
  LenzAuthError,
  LenzError,
  LenzNeedsInputError,
  LenzPipelineError,
  LenzTimeoutError,
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
  ExtractInput,
  ExtractedClaims,
  LibraryList,
  LibraryListInput,
  RelatedVerifications,
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
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
const POLL_BACKOFF_MS = [2000, 4000, 8000];
const POLL_BACKOFF_CAP_MS = 10_000;

// Generated at build time from package.json#version — see
// scripts/sync-version.mjs. Keeps the User-Agent in lockstep with the
// published package.
import { VERSION as SDK_VERSION } from "./_version.js";

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
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function retrySleepMs(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] ?? 4000;
}

function pollSleepMs(idx: number, remainingMs: number): number {
  const base = POLL_BACKOFF_MS[Math.min(idx, POLL_BACKOFF_MS.length - 1)] ?? POLL_BACKOFF_CAP_MS;
  return Math.min(base, POLL_BACKOFF_CAP_MS, Math.max(0, remainingMs));
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
   */
  get(verificationId: string): Promise<Verification> {
    return this.client.request<Verification>({
      method: "GET",
      path: `/verifications/${verificationId}`,
      authRequired: false,
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
   * editorially-hidden claims. Accessible for any verification the caller
   * owns or any public library item.
   */
  related(
    verificationId: string,
    { limit = 5 }: { limit?: number } = {},
  ): Promise<RelatedVerifications> {
    return this.client.request<RelatedVerifications>({
      method: "GET",
      path: `/verifications/${verificationId}/related`,
      query: { limit },
    });
  }
}

class AskNamespace {
  constructor(private readonly client: Lenz) {}

  history(verificationId: string): Promise<AskHistory> {
    return this.client.request<AskHistory>({
      method: "GET",
      path: `/ask/${verificationId}`,
    });
  }

  send(verificationId: string, input: AskSendInput): Promise<AskReply> {
    const body: Record<string, unknown> = { message: input.message };
    if (input.language) body.language = input.language;
    return this.client.request<AskReply>({
      method: "POST",
      path: `/ask/${verificationId}`,
      json: body,
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
    this.apiKey = opts.apiKey ?? process.env["LENZ_API_KEY"] ?? "";
    this.baseUrl = (opts.baseUrl ?? process.env["LENZ_BASE_URL"] ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
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
          text: c.text,
          source_url: c.source_url ?? "",
          webhook_url: c.webhook_url ?? "",
        };
        if (c.language) item.language = c.language;
        return item;
      }),
    };
    // Batch-wide defaults — per-item values (in the claims map above) override
    // server-side when set.
    if (input.webhookUrl) body["webhook_url"] = input.webhookUrl;
    if (input.language) body["language"] = input.language;
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
    return this.request<BatchAccepted>({
      method: "POST",
      path: "/verify/batch",
      json: body,
      headers,
    });
  }

  async extract(input: ExtractInput): Promise<ExtractedClaims> {
    const body: Record<string, unknown> = { text: input.text };
    if (input.language) body.language = input.language;
    return this.request<ExtractedClaims>({
      method: "POST",
      path: "/extract",
      json: body,
    });
  }

  /**
   * Fast 3-model panel verdict on each identified claim in the input.
   * Sync, ~5-10s. Returns one entry per atomic_claim. For deeper analysis
   * (citations, full audit trail), escalate low-confidence claims to
   * `verifyAndWait`; the two endpoints share a result cache server-side.
   *
   * Pass `language: "es"` (or any of the 12 supported codes) to receive
   * the claim text in that language. Verdict labels stay English.
   */
  async assess(input: AssessInput): Promise<AssessResponse> {
    const body: Record<string, unknown> = { text: input.text };
    if (input.language) body.language = input.language;
    return this.request<AssessResponse>({
      method: "POST",
      path: "/assess",
      json: body,
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
    if (!input.texts || input.texts.length === 0) {
      throw new Error("select requires a non-empty texts array");
    }
    return this.request<BatchAccepted>({
      method: "POST",
      path: `/verify/${taskId}/select`,
      json: { texts: input.texts },
    });
  }

  async getStatus(taskId: string): Promise<TaskStatus> {
    return this.request<TaskStatus>({
      method: "GET",
      path: `/verify/status/${taskId}`,
    });
  }

  async usage(): Promise<Usage> {
    return this.request<Usage>({ method: "GET", path: "/me/usage" });
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
      (input.idempotency !== false ? randomUUID().replace(/-/g, "") : undefined);

    const accepted = await this.submit({ ...input, idempotencyKey });
    // eslint-disable-next-line no-console
    console.info(`[lenz-io] Submitted task: ${accepted.task_id}`);
    return this.wait(accepted, { timeoutMs });
  }

  /**
   * Block on an already-submitted task until it terminates, then return its
   * `Verification`. `task` is a `task_id` string OR the `TaskAccepted` returned
   * by `verify` / `select` — so `client.wait(await client.verify({claim}))`
   * reads naturally. Throws for an empty id, `LenzNeedsInputError` /
   * `LenzPipelineError` on terminal non-success, and `LenzTimeoutError` on
   * deadline.
   */
  async wait(task: string | TaskAccepted, opts: WaitOptions = {}): Promise<Verification> {
    const taskId = typeof task === "string" ? task : task.task_id;
    if (!taskId) {
      throw new Error("wait() requires a non-empty task_id (got an empty TaskAccepted.task_id).");
    }
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const { terminal, timedOut } = await this._pollToTerminal([taskId], timeoutMs);
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
   * `BatchItemResult` with the matching `status`. (Transport/auth errors on the
   * initial submit still throw.)
   */
  async verifyBatchAndWait(input: VerifyBatchAndWaitInput): Promise<BatchItemResult[]> {
    const timeoutMs = input.timeoutMs ?? 180_000;
    const accepted = await this.verifyBatch(input);
    const ids = accepted.items.map((it) => it.task_id).filter((id): id is string => Boolean(id));
    const { terminal, timedOut } = await this._pollToTerminal(ids, timeoutMs);

    return accepted.items.map((it): BatchItemResult => {
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
   * deadline elapses. Returns `{terminal, timedOut}`; a timed-out task has no
   * `TaskStatus` (`"timeout"` is client-side, never a wire status).
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
  ): Promise<{ terminal: Map<string, TaskStatus>; timedOut: Set<string> }> {
    let pending = [...taskIds];
    const terminal = new Map<string, TaskStatus>();
    const timedOut = new Set<string>();
    const deadline = Date.now() + timeoutMs;
    let backoffIdx = 0;
    while (pending.length > 0) {
      const settled = await Promise.allSettled(pending.map((id) => this.getStatus(id)));
      const stillPending: string[] = [];
      settled.forEach((res, i) => {
        const id = pending[i]!;
        if (res.status === "fulfilled") {
          const s = res.value;
          if (s.status === "completed" || s.status === "needs_input" || s.status === "failed") {
            terminal.set(id, s);
          } else {
            stillPending.push(id);
          }
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
      await sleep(pollSleepMs(backoffIdx, remaining));
      backoffIdx += 1;
    }
    return { terminal, timedOut };
  }

  /**
   * Map a terminal `TaskStatus` to a `Verification` or throw the matching typed
   * error. Shared by `wait` (and thus `verifyAndWait`).
   */
  private _verificationFromTerminal(status: TaskStatus, taskId: string): Verification {
    if (status.status === "completed") {
      if (!status.result) {
        throw new LenzPipelineError({
          message: "Pipeline completed but the result is empty.",
          cause: "Server reported status=completed without a result block.",
          fix: "File an issue at https://github.com/lenzhq/lenz-io-node/issues with the Request ID.",
          docUrl: "https://lenz.io/docs/errors",
        });
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
      throw err;
    }
    // failed. Server sends the diagnostic under `error`; fall back to legacy fields.
    const detail = status.error || status.failure_detail || status.failure_reason || "unknown";
    const err = new LenzPipelineError({
      message: `Pipeline failed: ${detail}`,
      cause: detail,
      fix: "Retry with a different claim, or check status.error for the diagnostic.",
      docUrl: "https://lenz.io/docs/errors",
    });
    err.taskId = taskId;
    err.failureReason = status.failure_reason ?? "";
    throw err;
  }

  // ── internal helpers ──

  private async submit(input: VerifyInput): Promise<TaskAccepted> {
    const body: Record<string, unknown> = {
      text: input.claim,
      source_url: input.sourceUrl ?? "",
      webhook_url: input.webhookUrl ?? "",
    };
    // Omit-when-empty so existing English callers keep byte-identical
    // request bodies (no extra "language": "" key on the wire).
    if (input.language) body.language = input.language;
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
        fix: "Pass apiKey to new Lenz(), set LENZ_API_KEY env var, or get one at https://lenz.io/api-integration. Library endpoints work without a key.",
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
    if (authRequired && this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let lastErr: unknown = undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
        if (attempt >= this.maxRetries) {
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

      // Error path. Retry on 5xx + 429; otherwise raise.
      if (attempt < this.maxRetries && (response.status >= 500 || response.status === 429)) {
        const ra = response.headers.get("Retry-After");
        let waitMs: number = retrySleepMs(attempt);
        if (ra) {
          const parsed = Number(ra);
          if (Number.isFinite(parsed)) waitMs = parsed * 1000;
        }
        await sleep(waitMs);
        continue;
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
