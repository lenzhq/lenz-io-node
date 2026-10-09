/**
 * Freezes taken before per-call request options (`RequestOptions`,
 * `withOptions`, `signal`) were added. Each is black-box: it drives the public
 * methods with a recording `fetch` and fake timers, and pins what goes out and
 * when.
 *
 * 1. Requests: for every public method and call form, the method, URL (query
 *    as sent), the raw body bytes and the ordered header pairs. A key the
 *    client generates is masked; every other value is pinned.
 * 2. Attempt timers: when each call form's per-attempt timer fires (floors
 *    included), and the three ways a fired timer ends an attempt.
 * 3. Traces: when each request of a retried call or a wait is made.
 *
 * A call made without the new options must keep all of this byte for byte.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Lenz,
  CitecheckTimeoutError,
  LenzAPIError,
  LenzApiVersionError,
  LenzConnectionError,
  LenzNotFoundError,
  LenzRateLimitError,
  LenzRequestTimeoutError,
  LenzTimeoutError,
  LenzUpstreamUnavailableError,
  ReviewTimeoutError,
  VERSION,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(HERE, "fixtures", "contract", name), "utf-8")) as Record<
    string,
    unknown
  >;

// ── a recording fetch ────────────────────────────────────────────────────

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Never answer: the request hangs until its signal aborts. */
  hang?: true;
  /** Send the headers, then stall the body until the signal aborts. */
  stallBody?: true;
  /** Reject the fetch itself (a network error). */
  networkError?: true;
}

interface Sent {
  at: number;
  method: string;
  url: string;
  body: string | undefined;
  headers: Array<[string, string]>;
  signal: AbortSignal | undefined;
}

function recorder(replies: Iterable<Reply>, fallback?: Reply) {
  const queue = Array.from(replies);
  const sent: Sent[] = [];
  const aborts: number[] = [];
  const t0 = Date.now();
  const impl = (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const at = Date.now() - t0;
    const signal = init.signal ?? undefined;
    sent.push({
      at,
      method: String(init.method),
      url: String(url),
      body: init.body === undefined ? undefined : String(init.body),
      headers: Object.entries(init.headers as Record<string, string>),
      signal,
    });
    signal?.addEventListener("abort", () => aborts.push(Date.now() - t0));
    const next = queue.shift() ?? fallback;
    if (!next) return Promise.reject(new Error("no more mocked responses"));
    if (next.networkError) return Promise.reject(new TypeError("fetch failed"));
    if (next.hang) {
      return new Promise<Response>((_res, rej) => {
        signal?.addEventListener("abort", () =>
          rej(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    }
    const headers = new Headers(next.headers ?? {});
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (next.stallBody) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          signal?.addEventListener("abort", () =>
            controller.error(new DOMException("This operation was aborted", "AbortError")),
          );
        },
      });
      return Promise.resolve(new Response(body, { status: next.status ?? 200, headers }));
    }
    return Promise.resolve(
      new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers,
      }),
    );
  };
  return { fetch: impl as unknown as typeof fetch, sent, aborts };
}

const RANDOM_KEY = /^[0-9a-f]{32}$/;

/** A request as pinned below: one line for the request, one for the body, one per header. */
function wire(s: Sent): string[] {
  return [
    `${s.method} ${s.url}`,
    `body: ${s.body === undefined ? "<none>" : s.body}`,
    ...s.headers.map(([name, value]) => {
      if (name === "User-Agent") {
        expect(value).toBe(`lenz-io-node/${VERSION}`);
        return `${name}: lenz-io-node/<VERSION>`;
      }
      if (name === "Idempotency-Key" && RANDOM_KEY.test(value) && !value.startsWith("frozen")) {
        return `${name}: <random>`;
      }
      return `${name}: ${value}`;
    }),
  ];
}

async function settle(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (v) => v,
    (e: unknown) => e,
  );
}

// ── bodies ───────────────────────────────────────────────────────────────

const TASK = { task_id: "t1", status: "queued" };
const BATCH = {
  batch_id: "b1",
  items: [
    { task_id: "t1", claim: "a" },
    { task_id: "t2", claim: "b" },
  ],
};
const PROCESSING = { status: "processing", progress: { step: "research" } };
const COMPLETED = {
  status: "completed",
  result: { verification_id: "v1", verdict: { label: "True", score: 9, confidence: "high" } },
};
const REVIEW_ACCEPTED = fixture("review_accepted.json");
const REVIEW_ID = String(REVIEW_ACCEPTED["review_id"]);
const REVIEW_VERIFYING = fixture("review_verifying.json");
const REVIEW_COMPLETED = fixture("review_completed.json");
const CITECHECK_ACCEPTED = fixture("citecheck_accepted.json");
const CITECHECK_ID = String(CITECHECK_ACCEPTED["citecheck_id"]);
const CITECHECK_COMPLETED = fixture("citecheck_completed.json");
const LIST = (page: number, n: number, total: number) => ({
  items: Array.from({ length: n }, (_, i) => ({ verification_id: `v${page}${i}` })),
  total,
  page,
  page_size: 2,
});

// ── 1. requests ──────────────────────────────────────────────────────────

/** One call form: what it is given and the replies it reads. */
interface Form {
  name: string;
  replies: Reply[];
  run: (c: Lenz) => Promise<unknown>;
  apiKey?: string;
}

const FORMS: Form[] = [
  {
    name: "verify, pinned key",
    replies: [{ status: 202, body: TASK }],
    run: (c) => c.verify({ claim: "a", idempotencyKey: "frozen-v" }),
  },
  {
    name: "verify, every field, random key",
    replies: [{ status: 202, body: TASK }],
    run: (c) =>
      c.verify({
        claim: "a",
        sourceUrl: "https://s.example/p",
        webhookUrl: "https://h.example/w",
        language: "de",
        visibility: "unlisted",
        depth: "low",
      }),
  },
  {
    name: "verify, idempotency false",
    replies: [{ status: 202, body: TASK }],
    run: (c) => c.verify({ text: "a", idempotency: false }),
  },
  {
    name: "verifyBatch",
    replies: [{ status: 202, body: BATCH }],
    run: (c) =>
      c.verifyBatch({
        claims: [{ claim: "a", sourceUrl: "https://s.example/p" }, { claim: "b" }],
        language: "de",
        depth: "low",
        idempotencyKey: "frozen-b",
      }),
  },
  {
    name: "extract",
    replies: [{ body: { claims: [], status: "not_a_claim" } }],
    run: (c) => c.extract({ text: "x", idempotencyKey: "frozen-e" }),
  },
  {
    name: "extract, focus + locate + language + in-input timeout",
    replies: [{ body: { claims: [], status: "not_a_claim" } }],
    run: (c) =>
      c.extract({ text: "x", focus: "f", locate: false, language: "es", timeoutMs: 5_000 }),
  },
  {
    name: "assess, single",
    replies: [{ body: { claims: [] } }],
    run: (c) => c.assess({ claim: "a", idempotencyKey: "frozen-a" }),
  },
  {
    name: "assess, list + suggestRewrite + language",
    replies: [{ body: { claims: [] } }],
    run: (c) =>
      c.assess({
        claims: ["a", "b"],
        suggestRewrite: true,
        language: "auto",
        idempotency: false,
      }),
  },
  {
    name: "select",
    replies: [{ status: 202, body: BATCH }],
    run: (c) => c.select("t0", { claims: ["a", "b"], idempotencyKey: "frozen-s" }),
  },
  {
    name: "getStatus",
    replies: [{ body: PROCESSING }],
    run: (c) => c.getStatus("t1"),
  },
  {
    name: "cancel",
    replies: [{ body: { task_id: "t1", cancelled: true, status: "cancelled" } }],
    run: (c) => c.cancel("t1"),
  },
  {
    name: "usage",
    replies: [{ body: fixture("usage.json") }],
    run: (c) => c.usage(),
  },
  {
    name: "review, every knob",
    replies: [{ status: 202, body: REVIEW_ACCEPTED }],
    run: (c) =>
      c.review({
        text: "draft",
        language: "de",
        webhookUrl: "",
        verdicts: ["False"],
        confidence: ["low"],
        maxAssessments: 5,
        maxVerifications: 2,
        depth: "low",
        maxCitations: 3,
        suggestEdits: true,
        idempotencyKey: "frozen-r",
      }),
  },
  {
    name: "review, bare",
    replies: [{ status: 202, body: REVIEW_ACCEPTED }],
    run: (c) => c.review({ text: "draft" }),
  },
  {
    name: "getReview",
    replies: [{ body: REVIEW_COMPLETED }],
    run: (c) => c.getReview(REVIEW_ID),
  },
  {
    name: "getReview issues",
    replies: [{ body: fixture("review_completed_issues.json") }],
    run: (c) => c.getReview(REVIEW_ID, { view: "issues" }),
  },
  {
    name: "getReview full",
    replies: [{ body: REVIEW_COMPLETED }],
    run: (c) => c.getReview(REVIEW_ID, { view: "full" }),
  },
  {
    name: "cancelReview",
    replies: [{ body: REVIEW_COMPLETED }],
    run: (c) => c.cancelReview(REVIEW_ID),
  },
  {
    name: "citecheck, text",
    replies: [{ status: 202, body: CITECHECK_ACCEPTED }],
    run: (c) =>
      c.citecheck({ text: "t", maxCitations: 4, language: "fr", idempotencyKey: "frozen-c" }),
  },
  {
    name: "citecheck, pairs",
    replies: [{ status: 202, body: CITECHECK_ACCEPTED }],
    run: (c) =>
      c.citecheck({
        pairs: [{ statement: "s", doi: "10.1/x", citedYear: "2020" }],
        webhookUrl: "https://h.example/w",
      }),
  },
  {
    name: "getCitecheck",
    replies: [{ body: CITECHECK_COMPLETED }],
    run: (c) => c.getCitecheck(CITECHECK_ID),
  },
  {
    name: "cancelCitecheck",
    replies: [{ body: CITECHECK_COMPLETED }],
    run: (c) => c.cancelCitecheck(CITECHECK_ID),
  },
  {
    name: "verifications.list",
    replies: [{ body: LIST(1, 1, 1) }],
    run: (c) => c.verifications.list(),
  },
  {
    name: "verifications.list page 3",
    replies: [{ body: LIST(3, 1, 5) }],
    run: (c) => c.verifications.list({ page: 3 }),
  },
  {
    name: "verifications.listAll from page 2",
    replies: [{ body: LIST(2, 2, 6) }, { body: LIST(3, 1, 6) }],
    run: async (c) => {
      const out: unknown[] = [];
      for await (const v of c.verifications.listAll({ page: 2 })) out.push(v);
      return out;
    },
  },
  {
    name: "verifications.get",
    replies: [{ body: fixture("verifications_detail.json") }],
    run: (c) => c.verifications.get("v1"),
  },
  {
    name: "verifications.get, keyless",
    apiKey: "",
    replies: [{ body: fixture("verifications_detail.json") }],
    run: (c) => c.verifications.get("v1"),
  },
  {
    name: "verifications.getCertificate",
    replies: [{ body: fixture("certificate.json") }],
    run: (c) => c.verifications.getCertificate("v1"),
  },
  {
    name: "verifications.delete",
    replies: [{ status: 204 }],
    run: (c) => c.verifications.delete("v1"),
  },
  {
    name: "verifications.delete, already gone",
    replies: [{ status: 404, body: { detail: "Not found." } }],
    run: (c) => c.verifications.delete("v1"),
  },
  {
    name: "verifications.related",
    replies: [{ body: { items: [] } }],
    run: (c) => c.verifications.related("v1"),
  },
  {
    name: "verifications.related limit 3",
    replies: [{ body: { items: [] } }],
    run: (c) => c.verifications.related("v1", { limit: 3 }),
  },
  {
    name: "ask.history",
    replies: [{ body: { messages: [] } }],
    run: (c) => c.ask.history("v1"),
  },
  {
    name: "ask.send",
    replies: [{ body: { content: "x" } }],
    run: (c) => c.ask.send("v1", { message: "why?", language: "de", idempotencyKey: "frozen-q" }),
  },
  {
    name: "ask.send, random key",
    replies: [{ body: { content: "x" } }],
    run: (c) => c.ask.send("v1", { message: "why?" }),
  },
  {
    name: "ask.reset",
    replies: [{ status: 204 }],
    run: (c) => c.ask.reset("v1"),
  },
  {
    name: "library.list",
    replies: [{ body: LIST(1, 1, 1) }],
    run: (c) => c.library.list(),
  },
  {
    name: "library.list, every filter",
    replies: [{ body: LIST(2, 1, 1) }],
    run: (c) =>
      c.library.list({
        page: 2,
        sort: "most_true",
        search: "a b",
        domain: "health",
        entity: "WHO",
        curated: ["x", "y"],
        verdict: "False",
      }),
  },
  {
    name: "library.listAll",
    replies: [{ body: LIST(1, 2, 3) }, { body: LIST(2, 1, 3) }],
    run: async (c) => {
      const out: unknown[] = [];
      for await (const v of c.library.listAll({ search: "s" })) out.push(v);
      return out;
    },
  },
  {
    name: "wait",
    replies: [{ body: COMPLETED }],
    run: (c) => c.wait("t1"),
  },
  {
    name: "verifyAndWait",
    replies: [{ status: 202, body: TASK }, { body: COMPLETED }],
    run: (c) => c.verifyAndWait({ claim: "a", idempotencyKey: "frozen-vw" }, { timeoutMs: 60_000 }),
  },
  {
    name: "verifyBatchAndWait",
    replies: [{ status: 202, body: BATCH }, { body: COMPLETED }, { body: COMPLETED }],
    run: (c) => c.verifyBatchAndWait({ claims: [{ claim: "a" }, { claim: "b" }] }),
  },
  {
    name: "reviewAndWait",
    replies: [{ status: 202, body: REVIEW_ACCEPTED }, { body: REVIEW_COMPLETED }],
    run: (c) => c.reviewAndWait({ text: "draft", idempotencyKey: "frozen-rw" }),
  },
  {
    name: "citecheckAndWait",
    replies: [{ status: 202, body: CITECHECK_ACCEPTED }, { body: CITECHECK_COMPLETED }],
    run: (c) => c.citecheckAndWait({ text: "t" }),
  },
  {
    name: "raw request with a lowercase accept",
    replies: [{ body: {} }],
    run: (c) =>
      c.request({
        method: "POST",
        path: "/x",
        json: { a: 1 },
        query: { q: "v", empty: "", n: 0, b: false },
        headers: { accept: "text/plain", "x-lenz-api-version": "old", "X-Custom": "1" },
      }),
  },
];

describe("frozen: the request of every call form", () => {
  for (const form of FORMS) {
    it(form.name, async () => {
      const { fetch, sent } = recorder(form.replies);
      const client = new Lenz({ apiKey: form.apiKey ?? "lenz_t", fetch });
      const out = await form.run(client);
      expect(out).not.toBeInstanceOf(Error);
      expect(sent.map(wire)).toMatchSnapshot();
    });
  }
});

// ── 2. attempt timers ────────────────────────────────────────────────────

describe("frozen: when each attempt's timer fires", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The delay after which the single attempt of `run` is aborted. */
  async function timerOf(
    run: (c: Lenz) => Promise<unknown>,
    clientOpts: { timeoutMs?: number } = {},
  ): Promise<{ abortAt: number; err: unknown }> {
    const { fetch, aborts } = recorder([], { hang: true });
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, ...clientOpts });
    const pending = settle(run(client));
    await vi.advanceTimersByTimeAsync(1_000_000);
    const err = await pending;
    return { abortAt: aborts[0]!, err };
  }

  const CASES: Array<[string, (c: Lenz) => Promise<unknown>, { timeoutMs?: number }, number]> = [
    ["usage, client default", (c) => c.usage(), {}, 30_000],
    ["usage, client 5 s", (c) => c.usage(), { timeoutMs: 5_000 }, 5_000],
    ["verify", (c) => c.verify({ claim: "a" }), {}, 30_000],
    ["review", (c) => c.review({ text: "a" }), {}, 30_000],
    ["extract, default floor", (c) => c.extract({ text: "a" }), {}, 150_000],
    ["extract, client 5 s → floor", (c) => c.extract({ text: "a" }), { timeoutMs: 5_000 }, 150_000],
    ["extract, client 200 s", (c) => c.extract({ text: "a" }), { timeoutMs: 200_000 }, 200_000],
    [
      "extract, in-input 5 s (below the floor)",
      (c) => c.extract({ text: "a", timeoutMs: 5_000 }),
      {},
      5_000,
    ],
    ["assess single, default floor", (c) => c.assess({ claim: "a" }), {}, 100_000],
    ["assess list, default floor", (c) => c.assess({ claims: ["a"] }), {}, 100_000],
    ["assess, client 120 s", (c) => c.assess({ claims: ["a"] }), { timeoutMs: 120_000 }, 120_000],
    ["assess, in-input 2 s", (c) => c.assess({ claim: "a", timeoutMs: 2_000 }), {}, 2_000],
    ["wait, poll cut at the budget", (c) => c.wait("t1", { timeoutMs: 10_000 }), {}, 10_000],
    ["wait, poll at the client timeout", (c) => c.wait("t1", { timeoutMs: 100_000 }), {}, 30_000],
  ];

  for (const [name, run, clientOpts, expected] of CASES) {
    it(name, async () => {
      const { abortAt } = await timerOf(run, clientOpts);
      expect(abortAt).toBe(expected);
    });
  }

  it("a wait given no budget polls once with the client's timeout", async () => {
    const { abortAt, err } = await timerOf((c) => c.wait("t1", { timeoutMs: 0 }));
    expect(abortAt).toBe(30_000);
    expect(err).toBeInstanceOf(LenzTimeoutError);
  });

  it("a timer that fires before the response is retried like a network error", async () => {
    const { fetch, sent } = recorder([{ hang: true }, { body: { claims: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 1 });
    const pending = settle(client.assess({ claim: "a" }));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(await pending).not.toBeInstanceOf(Error);
    expect(sent.map((s) => s.at)).toEqual([0, 101_000]);
    expect(sent[1]!.headers).toEqual(sent[0]!.headers);
  });

  it("a timer that fires on the last attempt throws LenzRequestTimeoutError", async () => {
    const { err } = await timerOf((c) => c.usage());
    expect(err).toBeInstanceOf(LenzRequestTimeoutError);
    expect((err as Error).message).toBe("GET /me/usage timed out after 30000ms (1 attempt).");
  });

  it("a timer that fires while a 2xx body is read throws at once, never retried", async () => {
    const { fetch, sent } = recorder([{ stallBody: true }, { body: {} }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 3 });
    const pending = settle(client.usage());
    await vi.advanceTimersByTimeAsync(100_000);
    const err = await pending;
    expect(err).toBeInstanceOf(LenzRequestTimeoutError);
    expect((err as Error).message).toBe("GET /me/usage timed out reading the response body");
    expect(sent).toHaveLength(1);
  });

  it("a timer that fires while an error body is read keeps the status", async () => {
    const { fetch, sent } = recorder([{ status: 404, stallBody: true }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 3 });
    const pending = settle(client.usage());
    await vi.advanceTimersByTimeAsync(100_000);
    const err = await pending;
    expect(err).toBeInstanceOf(LenzNotFoundError);
    expect((err as LenzNotFoundError).statusCode).toBe(404);
    expect(sent).toHaveLength(1);
  });

  it("a wait's poll retries inside the deadline with the client's retries", async () => {
    const { fetch, sent } = recorder([{ hang: true }, { hang: true }, { body: COMPLETED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch, timeoutMs: 1_000 });
    const pending = settle(client.wait("t1", { timeoutMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ verification_id: "v1" });
    expect(sent.map((s) => s.at)).toEqual([0, 2_000, 5_000]);
  });
});

// ── 3. traces ────────────────────────────────────────────────────────────

describe("frozen: retry and sleep traces", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function trace(
    replies: Reply[],
    run: (c: Lenz) => Promise<unknown>,
    clientOpts: { maxRetries?: number; timeoutMs?: number } = {},
    advance = 1_000_000,
  ) {
    const { fetch, sent } = recorder(replies);
    const lines: string[] = [];
    const client = new Lenz({
      apiKey: "lenz_t",
      fetch,
      logger: { debug: (m) => lines.push(m), info: (m) => lines.push(m) },
      ...clientOpts,
    });
    const pending = settle(run(client));
    await vi.advanceTimersByTimeAsync(advance);
    return { out: await pending, at: sent.map((s) => s.at), sent, lines };
  }

  it("untyped 503s back off 1 s, 2 s", async () => {
    const t = await trace([{ status: 503 }, { status: 503 }, { body: {} }], (c) => c.usage());
    expect(t.out).not.toBeInstanceOf(Error);
    expect(t.at).toEqual([0, 1_000, 3_000]);
    expect(t.lines).toEqual([
      "[lenz-io] Retrying GET /me/usage after HTTP 503 in 1000ms (attempt 2 of 4)",
      "[lenz-io] Retrying GET /me/usage after HTTP 503 in 2000ms (attempt 3 of 4)",
    ]);
  });

  it("500s exhaust the ladder and throw the mapped error", async () => {
    const t = await trace(
      Array.from({ length: 4 }, () => ({ status: 500, body: { detail: "boom" } })),
      (c) => c.usage(),
    );
    expect(t.out).toBeInstanceOf(LenzAPIError);
    expect(t.at).toEqual([0, 1_000, 3_000, 7_000]);
  });

  it("network errors back off, then a LenzConnectionError", async () => {
    const t = await trace(
      Array.from({ length: 4 }, () => ({ networkError: true as const })),
      (c) => c.usage(),
    );
    expect(t.out).toBeInstanceOf(LenzConnectionError);
    expect((t.out as Error).message).toBe(
      "GET /me/usage failed after 4 attempts: TypeError: fetch failed",
    );
    expect(t.at).toEqual([0, 1_000, 3_000, 7_000]);
    expect(t.lines[0]).toBe(
      "[lenz-io] Retrying GET /me/usage after a network error in 1000ms (attempt 2 of 4)",
    );
  });

  it("a 429 stating its wait in the header sleeps it", async () => {
    const t = await trace(
      [{ status: 429, body: { detail: "slow" }, headers: { "Retry-After": "2" } }, { body: {} }],
      (c) => c.usage(),
    );
    expect(t.at).toEqual([0, 2_000]);
  });

  it("a 429 stating its wait only in the body sleeps it", async () => {
    const t = await trace(
      [{ status: 429, body: { detail: "slow", reset_in_seconds: 3 } }, { body: {} }],
      (c) => c.usage(),
    );
    expect(t.at).toEqual([0, 3_000]);
  });

  it("a 429 stating a wait past the cap throws at once", async () => {
    const t = await trace(
      [{ status: 429, body: { detail: "cap" }, headers: { "Retry-After": "3600" } }],
      (c) => c.usage(),
    );
    expect(t.out).toBeInstanceOf(LenzRateLimitError);
    expect(t.at).toEqual([0]);
  });

  it("a typed 503 stating a wait past the cap throws at once", async () => {
    const t = await trace(
      [
        {
          status: 503,
          body: { detail: "busy", code: "upstream_unavailable" },
          headers: { "Retry-After": "120" },
        },
      ],
      (c) => c.usage(),
    );
    expect(t.out).toBeInstanceOf(LenzUpstreamUnavailableError);
    expect(t.at).toEqual([0]);
  });

  it("an untyped 503 stating a wait past the cap keeps the ladder", async () => {
    const t = await trace(
      [{ status: 503, headers: { "Retry-After": "3600" } }, { body: {} }],
      (c) => c.usage(),
    );
    expect(t.at).toEqual([0, 1_000]);
  });

  it("review_in_flight throws at once", async () => {
    const t = await trace(
      [{ status: 429, body: fixture("error_review_in_flight_429.json") }],
      (c) => c.review({ text: "a" }),
    );
    expect(t.out).toBeInstanceOf(LenzRateLimitError);
    expect(t.at).toEqual([0]);
  });

  it("a keyed 409 still in flight is asked again with the same key", async () => {
    const t = await trace(
      [
        { status: 409, body: { detail: "in flight", code: "idempotency_conflict" } },
        {
          status: 409,
          body: { detail: "in flight", code: "idempotency_conflict" },
          headers: { "Retry-After": "5" },
        },
        { status: 202, body: TASK },
      ],
      (c) => c.verify({ claim: "a", idempotencyKey: "frozen-409" }),
    );
    expect(t.out).toMatchObject({ task_id: "t1" });
    expect(t.at).toEqual([0, 1_000, 6_000]);
    expect(t.lines[0]).toBe(
      "[lenz-io] Retrying POST /verify after HTTP 409 (still in flight) in 1000ms (attempt 2 of 4)",
    );
  });

  it("a review 409 naming the review is the receipt", async () => {
    const t = await trace(
      [
        {
          status: 409,
          body: { detail: "in flight", code: "idempotency_conflict", review_id: "r9" },
        },
      ],
      (c) => c.review({ text: "a" }),
    );
    expect(t.out).toEqual({ review_id: "r9", status: "queued" });
    expect(t.at).toEqual([0]);
  });

  it("an answer in another API version is thrown at once, unread as this one's", async () => {
    const t = await trace(
      [{ status: 503, body: { detail: "x" }, headers: { "X-Lenz-API-Version": "2026-05-13" } }],
      (c) => c.usage(),
    );
    expect(t.out).toBeInstanceOf(LenzApiVersionError);
    expect(t.at).toEqual([0]);
  });

  it("verifyAndWait polls on the 2/4/8 s ladder after the submit", async () => {
    const t = await trace(
      [
        { status: 202, body: TASK },
        { body: PROCESSING },
        { body: PROCESSING },
        { body: PROCESSING },
        { body: COMPLETED },
      ],
      (c) => c.verifyAndWait({ claim: "a" }),
    );
    expect(t.out).toMatchObject({ verification_id: "v1" });
    expect(t.at).toEqual([0, 0, 2_000, 6_000, 14_000]);
    expect(t.lines).toEqual(["[lenz-io] Submitted task: t1"]);
  });

  it("verifyAndWait follows the poll hint", async () => {
    const t = await trace(
      [
        { status: 202, body: TASK },
        { body: { ...PROCESSING, progress: { step: "r", poll_after_seconds: 3 } } },
        { body: COMPLETED },
      ],
      (c) => c.verifyAndWait({ claim: "a" }),
    );
    expect(t.at).toEqual([0, 0, 3_000]);
  });

  it("verifyAndWait times out at its budget, started after the submit", async () => {
    const t = await trace(
      [{ status: 503 }, { status: 202, body: TASK }],
      (c) => c.verifyAndWait({ claim: "a" }, { timeoutMs: 5_000 }),
      { maxRetries: 1 },
    );
    // The submit retried for 1 s; the wait's polls then run for 5 s.
    expect(t.out).toBeInstanceOf(LenzTimeoutError);
    expect(t.at.slice(0, 3)).toEqual([0, 1_000, 1_000]);
  });

  it("verifyBatchAndWait polls every item each round", async () => {
    const t = await trace(
      [
        { status: 202, body: BATCH },
        { body: PROCESSING },
        { body: COMPLETED },
        { body: COMPLETED },
      ],
      (c) => c.verifyBatchAndWait({ claims: [{ claim: "a" }, { claim: "b" }] }),
    );
    expect((t.out as Array<{ status: string }>).map((r) => r.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(t.at).toEqual([0, 0, 0, 2_000]);
    expect(t.sent.map((s) => s.url.split("/").pop())).toEqual(["batch", "t1", "t2", "t1"]);
  });

  it("reviewAndWait polls on the review's hint, never under 5 s", async () => {
    const t = await trace(
      [
        { status: 202, body: REVIEW_ACCEPTED },
        { body: { ...REVIEW_VERIFYING, poll_after_seconds: 1 } },
        { body: { ...REVIEW_VERIFYING, poll_after_seconds: 12 } },
        { body: REVIEW_COMPLETED },
      ],
      (c) => c.reviewAndWait({ text: "a" }),
    );
    expect(t.out).toMatchObject({ status: "completed" });
    expect(t.at).toEqual([0, 0, 5_000, 17_000]);
  });

  it("reviewAndWait: a transient poll error waits the floor and polls again", async () => {
    const t = await trace(
      [
        { status: 202, body: REVIEW_ACCEPTED },
        { status: 500, body: { detail: "x" } },
        { body: REVIEW_COMPLETED },
      ],
      (c) => c.reviewAndWait({ text: "a" }),
      { maxRetries: 3 },
    );
    expect(t.out).toMatchObject({ status: "completed" });
    // Polls make one attempt each (no retry inside a poll).
    expect(t.at).toEqual([0, 0, 5_000]);
  });

  it("citecheckAndWait polls on the check's hint, never under 5 s", async () => {
    const t = await trace(
      [
        { status: 202, body: CITECHECK_ACCEPTED },
        { body: { ...CITECHECK_COMPLETED, status: "checking", poll_after_seconds: 7 } },
        { body: CITECHECK_COMPLETED },
      ],
      (c) => c.citecheckAndWait({ text: "a" }),
    );
    expect(t.out).toMatchObject({ status: "completed" });
    expect(t.at).toEqual([0, 0, 7_000]);
  });

  it("reviewAndWait times out with the last body seen", async () => {
    const t = await trace(
      [
        { status: 202, body: REVIEW_ACCEPTED },
        ...Array.from({ length: 5 }, () => ({
          body: { ...REVIEW_VERIFYING, poll_after_seconds: 5 },
        })),
      ],
      (c) => c.reviewAndWait({ text: "a" }, { timeoutMs: 12_000 }),
      {},
      60_000,
    );
    expect(t.out).toBeInstanceOf(ReviewTimeoutError);
    expect((t.out as ReviewTimeoutError).partial?.status).toBe("verifying");
    expect(t.at).toEqual([0, 0, 5_000, 10_000]);
  });
});

// ── the review / citation-check wait clock ───────────────────────────────

// Re-baselined for D7 (3.0): reviewAndWait and citecheckAndWait start their
// budget after the submit, as every other wait does. The submit makes its
// attempts with the client's timeout and retries; `timeoutMs <= 0` submits
// normally, then reads once. Before, the budget bounded the submit (its
// attempt was cut at the budget, 0 ms for a budget of 0).
describe("frozen: the review and citecheck wait clock (D7: started after the submit)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const [name, run] of [
    ["reviewAndWait", (c: Lenz, o: { timeoutMs: number }) => c.reviewAndWait({ text: "a" }, o)],
    [
      "citecheckAndWait",
      (c: Lenz, o: { timeoutMs: number }) => c.citecheckAndWait({ text: "a" }, o),
    ],
  ] as const) {
    it(`${name}: the submit's attempt keeps the client's timeout, not the wait's budget`, async () => {
      const { fetch, aborts, sent } = recorder([], { hang: true });
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const pending = settle(run(client, { timeoutMs: 10_000 }));
      await vi.advanceTimersByTimeAsync(100_000);
      expect(await pending).toBeInstanceOf(LenzRequestTimeoutError);
      expect(aborts).toEqual([30_000]);
      expect(sent).toHaveLength(1);
    });

    it(`${name}: with timeoutMs 0 the submit is made normally`, async () => {
      const { fetch, aborts } = recorder([], { hang: true });
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const pending = settle(run(client, { timeoutMs: 0 }));
      await vi.advanceTimersByTimeAsync(100_000);
      expect(await pending).toBeInstanceOf(LenzRequestTimeoutError);
      expect(aborts).toEqual([30_000]);
    });
  }

  it("reviewAndWait with timeoutMs 0 and an in-process answer reads once", async () => {
    const { fetch, sent } = recorder([
      { status: 202, body: REVIEW_ACCEPTED },
      { body: REVIEW_COMPLETED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = settle(client.reviewAndWait({ text: "a" }, { timeoutMs: 0 }));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(await pending).toMatchObject({ status: "completed" });
    expect(sent).toHaveLength(2);
  });

  it("reviewAndWait with timeoutMs 0 reads a running review once, then times out", async () => {
    const { fetch, sent } = recorder([
      { status: 202, body: REVIEW_ACCEPTED },
      { body: REVIEW_VERIFYING },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = settle(client.reviewAndWait({ text: "a" }, { timeoutMs: 0 }));
    await vi.advanceTimersByTimeAsync(100_000);
    const err = await pending;
    expect(err).toBeInstanceOf(ReviewTimeoutError);
    expect((err as ReviewTimeoutError).partial?.status).toBe("verifying");
    expect(sent).toHaveLength(2);
  });

  it("citecheckAndWait with timeoutMs 0 reads a running check once, then times out", async () => {
    const { fetch, sent } = recorder([
      { status: 202, body: CITECHECK_ACCEPTED },
      { body: { ...CITECHECK_COMPLETED, status: "checking" } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = settle(client.citecheckAndWait({ text: "a" }, { timeoutMs: 0 }));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(await pending).toBeInstanceOf(CitecheckTimeoutError);
    expect(sent).toHaveLength(2);
  });

  it("the budget starts once the submit is accepted", async () => {
    // A submit retried for 3 s against a 4 s budget: the polls still get the
    // whole 4 s after it (first poll at 3 s, then the 4 s left, then the timeout).
    const { fetch, sent } = recorder(
      [
        { status: 503, headers: { "Retry-After": "3" } },
        { status: 202, body: REVIEW_ACCEPTED },
      ],
      { body: { ...REVIEW_VERIFYING, poll_after_seconds: 5 } },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = settle(client.reviewAndWait({ text: "a" }, { timeoutMs: 4_000 }));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(await pending).toBeInstanceOf(ReviewTimeoutError);
    expect(sent.map((s) => s.at)).toEqual([0, 3_000, 3_000]);
  });
});
