/**
 * Public Lenz client — the ergonomic top-level surface.
 *
 * ```ts
 * import { Lenz } from 'lenz-io';
 * const client = new Lenz({ apiKey: 'lenz_...' });
 *
 * // Marquee verbs — top-level
 * const v = await client.verifyAndWait({ claim: "Sharks don't get cancer" });
 * const t = await client.verify({ claim: '...' });
 * const out = await client.extract({ text: '...' });
 * const batch = await client.verifyBatch({ claims: [...] });
 *
 * // Resource namespaces
 * await client.verifications.list();
 * await client.verifications.get(id);
 * await client.verifications.delete(id);
 * await client.followup.history(id);
 * await client.library.list();
 * await client.usage();
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
  BatchAccepted,
  ExtractInput,
  ExtractedClaims,
  FollowupHistory,
  FollowupReply,
  LibraryItem,
  LibraryList,
  LibraryListInput,
  SelectInput,
  TaskAccepted,
  TaskStatus,
  Usage,
  Verification,
  VerificationList,
  VerifyAndWaitInput,
  VerifyBatchInput,
  VerifyInput,
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

// Pulled in at runtime via JSON import; declared here to keep the User-Agent
// fresh without circular imports.
const SDK_VERSION = "1.0.0-rc.1";

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

  get(verificationId: string): Promise<Verification> {
    return this.client.request<Verification>({
      method: "GET",
      path: `/verifications/${verificationId}`,
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

  setVisibility(
    verificationId: string,
    visibility: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: "PATCH",
      path: `/verifications/${verificationId}/visibility`,
      json: { visibility },
    });
  }
}

class FollowupNamespace {
  constructor(private readonly client: Lenz) {}

  history(verificationId: string): Promise<FollowupHistory> {
    return this.client.request<FollowupHistory>({
      method: "GET",
      path: `/verifications/${verificationId}/follow-up`,
    });
  }

  send(verificationId: string, { message }: { message: string }): Promise<FollowupReply> {
    return this.client.request<FollowupReply>({
      method: "POST",
      path: `/verifications/${verificationId}/follow-up`,
      json: { message },
    });
  }

  async reset(verificationId: string): Promise<boolean> {
    await this.client.request<unknown>({
      method: "DELETE",
      path: `/verifications/${verificationId}/follow-up`,
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

  get(verificationId: string): Promise<LibraryItem> {
    return this.client.request<LibraryItem>({
      method: "GET",
      path: `/library/${verificationId}`,
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
  readonly followup: FollowupNamespace;
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
    this.followup = new FollowupNamespace(this);
    this.library = new LibraryNamespace(this);
  }

  // ── Marquee verbs ──

  async verify(input: VerifyInput): Promise<TaskAccepted> {
    return this.submit(input);
  }

  async verifyBatch(input: VerifyBatchInput): Promise<BatchAccepted> {
    const body: Record<string, unknown> = {
      claims: input.claims.map((c) => ({
        text: c.text,
        source_url: c.sourceUrl ?? "",
        webhook_url: c.webhookUrl ?? "",
        visibility: c.visibility ?? "",
      })),
    };
    // Batch-wide defaults — per-item values (in the claims map above) override
    // server-side when set.
    if (input.webhookUrl) body["webhook_url"] = input.webhookUrl;
    if (input.visibility) body["visibility"] = input.visibility;
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
    return this.request<ExtractedClaims>({
      method: "POST",
      path: "/extract",
      json: { text: input.text },
    });
  }

  async select(taskId: string, input: SelectInput): Promise<TaskAccepted> {
    if (!input.text && input.claimIndex === undefined) {
      throw new Error("select requires either text or claimIndex");
    }
    const body: Record<string, unknown> = {};
    if (input.text) body["text"] = input.text;
    if (input.claimIndex !== undefined) body["claim_index"] = input.claimIndex;
    return this.request<TaskAccepted>({
      method: "POST",
      path: `/verify/${taskId}/select`,
      json: body,
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
    const taskId = accepted.task_id;
    // eslint-disable-next-line no-console
    console.info(`[lenz-io] Submitted task: ${taskId}`);

    const deadline = Date.now() + timeoutMs;
    let backoffIdx = 0;
    while (true) {
      const status = await this.getStatus(taskId);
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
          fix: "Inspect the payload, then call client.select(taskId, { text or claimIndex }).",
          docUrl: "https://lenz.io/docs/verify#needs-input",
        });
        err.taskId = taskId;
        err.kind = status.reason ?? "";
        err.payload = status as unknown as Record<string, unknown>;
        throw err;
      }
      if (status.status === "failed") {
        const err = new LenzPipelineError({
          message: `Pipeline failed: ${status.failure_reason ?? "unknown"}`,
          cause: status.failure_detail ?? status.failure_reason ?? "Unknown failure.",
          fix: "Retry with a different claim, or check failure_reason for the diagnostic.",
          docUrl: "https://lenz.io/docs/errors",
        });
        err.taskId = taskId;
        err.failureReason = status.failure_reason ?? "";
        throw err;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const err = new LenzTimeoutError({
          message: `verifyAndWait timed out after ${timeoutMs}ms`,
          cause: "Pipeline still running server-side.",
          fix: `Resume via client.getStatus('${taskId}') later.`,
          docUrl: "https://lenz.io/docs/verify#timeout",
        });
        err.taskId = taskId;
        throw err;
      }
      await sleep(pollSleepMs(backoffIdx, remaining));
      backoffIdx += 1;
    }
  }

  // ── internal helpers ──

  private async submit(input: VerifyInput): Promise<TaskAccepted> {
    const body = {
      text: input.claim,
      source_url: input.sourceUrl ?? "",
      visibility: input.visibility ?? "",
      webhook_url: input.webhookUrl ?? "",
    };
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
      if (
        attempt < this.maxRetries &&
        (response.status >= 500 || response.status === 429)
      ) {
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
