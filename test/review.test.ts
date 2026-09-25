/**
 * `POST /review` + `GET /reviews/{id}` + `reviewAndWait`.
 *
 * Responses come from the recorded fixtures in `test/fixtures/contract/`
 * (the same files the Python SDK reads), so the helper is driven through
 * the real states a review goes through: queued → assessing → verifying →
 * completed, and the two failures that end a review before it assesses
 * anything.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Lenz,
  LenzAPIError,
  LenzError,
  LenzGoneError,
  LenzRateLimitError,
  LenzTimeoutError,
  LenzPipelineError,
  LenzUpstreamUnavailableError,
  LenzValidationError,
  ReviewFailedError,
  ReviewTimeoutError,
} from "../src/index.js";
import type { ReviewEntity, ReviewFull, ReviewIssues, VerdictLabel } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "contract", name), "utf-8")) as T;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeFetch(responses: Iterable<MockResponse>) {
  const queue = Array.from(responses);
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("No more mocked responses");
    const headers = new Headers(next.headers ?? {});
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers,
    });
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

function sentBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function sentHeaders(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

const ACCEPTED = fixture("review_accepted.json");
const QUEUED = fixture("review_queued.json");
const ASSESSING = fixture("review_assessing.json");
const VERIFYING = fixture("review_verifying.json");
const COMPLETED = fixture<ReviewFull>("review_completed.json");
const ISSUES = fixture<ReviewIssues>("review_completed_issues.json");
const NO_CLAIM = fixture<ReviewFull>("review_failed_no_claim.json");
const NO_CREDITS = fixture<ReviewFull>("review_failed_insufficient_credits.json");
const DRAFT = "The EU AI Act entered into force on 1 August 2024.";

// ── submit ───────────────────────────────────────────────────────────────

describe("review()", () => {
  it("posts the draft and returns the receipt", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const started = await client.review({ text: DRAFT });
    expect(started).toEqual({ review_id: ACCEPTED["review_id"], status: "queued" });
    expect(calls[0]!.url).toBe("https://lenz.io/api/v1/review");
    expect(calls[0]!.init.method).toBe("POST");
    // No knob set: the server's defaults apply, so no `escalate` goes out,
    // and no webhook_url either (the credential's default).
    expect(sentBody(calls[0]!)).toEqual({ text: DRAFT, visibility: "private" });
  });

  it("assembles the flat knobs into `escalate`", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.review({
      text: DRAFT,
      verdicts: ["False"],
      confidence: ["low", "medium"],
      maxAssessments: 5,
      maxVerifications: 0,
      depth: "low",
      language: "de",
      visibility: "unlisted",
    });
    expect(sentBody(calls[0]!)).toEqual({
      text: DRAFT,
      language: "de",
      visibility: "unlisted",
      escalate: {
        verdicts: ["False"],
        confidence: ["low", "medium"],
        max_assessments: 5,
        max_verifications: 0,
        depth: "low",
      },
    });
  });

  it("sends an empty selector list, which means 'no rule', not 'default'", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.review({ text: DRAFT, verdicts: [], confidence: [] });
    expect(sentBody(calls[0]!)["escalate"]).toEqual({ verdicts: [], confidence: [] });
  });

  it("webhookUrl has three states: omitted, empty (no webhook), a URL", async () => {
    const { fetch, calls } = makeFetch([
      { status: 202, body: ACCEPTED },
      { status: 202, body: ACCEPTED },
      { status: 202, body: ACCEPTED },
      { status: 202, body: ACCEPTED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.review({ text: DRAFT });
    await client.review({ text: DRAFT, webhookUrl: null });
    await client.review({ text: DRAFT, webhookUrl: "" });
    await client.review({ text: DRAFT, webhookUrl: "https://example.com/hook" });
    expect("webhook_url" in sentBody(calls[0]!)).toBe(false);
    expect("webhook_url" in sentBody(calls[1]!)).toBe(false);
    expect(sentBody(calls[2]!)["webhook_url"]).toBe("");
    expect(sentBody(calls[3]!)["webhook_url"]).toBe("https://example.com/hook");
  });

  it("always sends an Idempotency-Key, reused across its own retries", async () => {
    // A retried POST without a key could start a second review.
    const { fetch, calls } = makeFetch([
      { status: 502, body: { detail: "bad gateway" }, headers: { "Retry-After": "0" } },
      { status: 202, body: ACCEPTED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.review({ text: DRAFT });
    const first = sentHeaders(calls[0]!)["Idempotency-Key"];
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(sentHeaders(calls[1]!)["Idempotency-Key"]).toBe(first);
  });

  it("a 409 idempotency_conflict carrying the review_id is the receipt", async () => {
    // A retried submit whose first attempt created the review before its
    // socket dropped: the id must not be lost.
    const { fetch } = makeFetch([
      {
        status: 409,
        body: {
          detail: "A review with this Idempotency-Key is still being created. Retry shortly.",
          code: "idempotency_conflict",
          review_id: "442b6aa9",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(await client.review({ text: DRAFT, idempotencyKey: "k" })).toEqual({
      review_id: "442b6aa9",
      status: "queued",
    });
  });

  for (const reviewId of [null, "", 42]) {
    it(`a 409 idempotency_conflict with review_id ${JSON.stringify(reviewId)} still throws`, async () => {
      const { fetch } = makeFetch([
        {
          status: 409,
          body: {
            detail: "Still being created.",
            code: "idempotency_conflict",
            review_id: reviewId,
          },
        },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const err = (await client
        .review({ text: DRAFT, idempotencyKey: "k" })
        .catch((e: unknown) => e)) as LenzError;
      expect(err).toBeInstanceOf(LenzError);
      expect(err.statusCode).toBe(409);
    });
  }

  it("another 409 code carrying a review_id still throws", async () => {
    const { fetch } = makeFetch([
      { status: 409, body: { detail: "No.", code: "something_else", review_id: "442b6aa9" } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.review({ text: DRAFT })).rejects.toBeInstanceOf(LenzError);
  });

  it("uses the caller's Idempotency-Key when given", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.review({ text: DRAFT, idempotencyKey: "draft-42" });
    expect(sentHeaders(calls[0]!)["Idempotency-Key"]).toBe("draft-42");
  });

  it("review_in_flight throws at once with retryAfter, rather than sleeping it", async () => {
    // A review runs for minutes; sleeping the stated wait inside the call
    // would block the caller silently for up to three retries.
    const { fetch, calls } = makeFetch([
      {
        status: 429,
        body: fixture("error_review_in_flight_429.json"),
        headers: { "Retry-After": "60" },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = await client.review({ text: DRAFT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzRateLimitError);
    expect((err as LenzRateLimitError).code).toBe("review_in_flight");
    expect((err as LenzRateLimitError).retryAfter).toBe(60);
    expect(calls).toHaveLength(1);
  });

  it("review_in_flight reads retry_after_seconds when the header is missing", async () => {
    const { fetch } = makeFetch([
      { status: 429, body: fixture("error_review_in_flight_429.json") },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = (await client
      .review({ text: DRAFT })
      .catch((e: unknown) => e)) as LenzRateLimitError;
    expect(err.retryAfter).toBe(60);
  });

  for (const code of [
    "invalid_verdict_label",
    "invalid_confidence_band",
    "webhook_secret_missing",
  ]) {
    it(`a 422 ${code} surfaces its code and field errors`, async () => {
      const body = {
        ...fixture("error_review_invalid_verdict_label_422.json"),
        code,
      };
      const { fetch } = makeFetch([{ status: 422, body }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const err = (await client
        .review({ text: DRAFT, verdicts: ["Wrong" as VerdictLabel] })
        .catch((e: unknown) => e)) as LenzValidationError;
      expect(err).toBeInstanceOf(LenzValidationError);
      expect(err.code).toBe(code);
      expect(err.errors[0]!["loc"]).toEqual(["body", "payload", "escalate", "verdicts"]);
    });
  }
});

// ── read ─────────────────────────────────────────────────────────────────

describe("getReview()", () => {
  it("reads the full view by default", async () => {
    const { fetch, calls } = makeFetch([{ body: COMPLETED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const review = await client.getReview("442b6aa9");
    expect(calls[0]!.url).toBe("https://lenz.io/api/v1/reviews/442b6aa9");
    expect(review.view).toBe("full");
    expect(review.claims).toHaveLength(4);
  });

  it("asks for ?view=issues and types the answer without claims", async () => {
    const { fetch, calls } = makeFetch([{ body: ISSUES }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const review = await client.getReview("442b6aa9", { view: "issues" });
    expect(calls[0]!.url).toBe("https://lenz.io/api/v1/reviews/442b6aa9?view=issues");
    expect(review.view).toBe("issues");
    expect("claims" in review).toBe(false);
    expect(review.issues[0]!.suggested_rewrite).toBe(
      "The EU AI Act entered into force on 1 August 2024.",
    );
    expect(review.issues[1]!.suggested_rewrite).toBeNull();
  });

  it("an empty id rejects instead of throwing synchronously", async () => {
    const client = new Lenz({ apiKey: "lenz_t", fetch: makeFetch([]).fetch });
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = client.getReview("");
    }).not.toThrow();
    await expect(promise).rejects.toThrow(/non-empty review_id/);
  });

  it("a purged review throws LenzGoneError", async () => {
    const { fetch } = makeFetch([
      {
        status: 410,
        body: { detail: "Purged.", code: "purged", purged_at: "2026-10-01T00:00:00Z" },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.getReview("442b6aa9")).rejects.toBeInstanceOf(LenzGoneError);
  });
});

// ── wait ─────────────────────────────────────────────────────────────────

describe("reviewAndWait()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function drain<T>(pending: Promise<T>, ms = 600_000): Promise<T> {
    await vi.advanceTimersByTimeAsync(ms);
    return pending;
  }

  it("polls queued → assessing → verifying → completed and returns the review", async () => {
    const { fetch, calls } = makeFetch([
      { status: 202, body: ACCEPTED },
      { body: QUEUED },
      { body: ASSESSING },
      { body: ASSESSING }, // unchanged: no update fires
      { body: VERIFYING },
      { body: COMPLETED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const seen: string[] = [];
    const review = await drain(
      client.reviewAndWait({ text: DRAFT }, { onUpdate: (r) => seen.push(r.status) }),
    );
    expect(review.outcome).toBe("issues_found");
    expect(review.issues[0]!.verdict).toBe("False");
    expect(review.issues.map((i) => i.claim_index)).toEqual([0, 3]);
    expect(review.credits.charged).toBe(14);
    expect(seen).toEqual(["queued", "assessing", "verifying", "completed"]);
    expect(calls.slice(1).every((c) => c.url.endsWith("/reviews/442b6aa9"))).toBe(true);
  });

  it("waits poll_after_seconds between polls", async () => {
    const { fetch, calls } = makeFetch([
      { status: 202, body: ACCEPTED },
      { body: VERIFYING }, // poll_after_seconds: 15
      { body: COMPLETED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = client.reviewAndWait({ text: DRAFT });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe("completed");
  });

  for (const hint of [0, 1, null, "10", -3]) {
    it(`floors a poll hint of ${JSON.stringify(hint)} at 5 s`, async () => {
      const { fetch, calls } = makeFetch([
        { status: 202, body: ACCEPTED },
        { body: { ...VERIFYING, poll_after_seconds: hint } },
        { body: COMPLETED },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const pending = client.reviewAndWait({ text: DRAFT });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe("completed");
    });
  }

  it("a throwing onUpdate does not kill the wait", async () => {
    const { fetch } = makeFetch([
      { status: 202, body: ACCEPTED },
      { body: VERIFYING },
      { body: COMPLETED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const review = await drain(
      client.reviewAndWait(
        { text: DRAFT },
        {
          onUpdate: () => {
            throw new Error("caller bug");
          },
        },
      ),
    );
    expect(review.status).toBe("completed");
  });

  it("times out with the last body it saw as `partial`", async () => {
    const polls = Array.from({ length: 20 }, () => ({ body: VERIFYING }));
    const { fetch } = makeFetch([{ status: 202, body: ACCEPTED }, ...polls]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = client
      .reviewAndWait({ text: DRAFT }, { timeoutMs: 40_000 })
      .catch((e: unknown) => e);
    const err = await drain(pending, 60_000);
    expect(err).toBeInstanceOf(ReviewTimeoutError);
    expect(err).toBeInstanceOf(LenzTimeoutError);
    const t = err as ReviewTimeoutError;
    expect(t.reviewId).toBe("442b6aa9");
    expect(t.partial?.status).toBe("verifying");
    expect(t.message).toContain("442b6aa9");
  });

  it("a timeout before any poll answered carries partial = null", async () => {
    const { fetch } = makeFetch([
      { status: 202, body: ACCEPTED },
      ...Array.from({ length: 10 }, () => ({ status: 500, body: { detail: "boom" } })),
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const pending = client
      .reviewAndWait({ text: DRAFT }, { timeoutMs: 12_000 })
      .catch((e: unknown) => e);
    const err = (await drain(pending, 60_000)) as ReviewTimeoutError;
    expect(err).toBeInstanceOf(ReviewTimeoutError);
    expect(err.partial).toBeNull();
  });

  it("keeps polling through a transient poll error", async () => {
    const { fetch } = makeFetch([
      { status: 202, body: ACCEPTED },
      { status: 500, body: { detail: "boom" } },
      { body: COMPLETED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const review = await drain(client.reviewAndWait({ text: DRAFT }));
    expect(review.status).toBe("completed");
  });

  it("a submit that used up the budget still polls once, so partial is filled", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }, { body: VERIFYING }]);
    const slowFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      await new Promise((res) => setTimeout(res, 50));
      return fetch(url, init);
    }) as typeof globalThis.fetch;
    const slow = new Lenz({ apiKey: "lenz_t", fetch: slowFetch });
    const pending = slow.reviewAndWait({ text: DRAFT }, { timeoutMs: 10 }).catch((e: unknown) => e);
    const err = (await drain(pending, 1_000)) as ReviewTimeoutError;
    expect(err).toBeInstanceOf(ReviewTimeoutError);
    expect(err.partial?.status).toBe("verifying");
    expect(calls).toHaveLength(2); // the POST, then exactly one GET
  });

  it("the submit's retry ladder stops at the deadline", async () => {
    // An untyped 503 stating 3 s against a 500 ms budget: the submit gives
    // up at once rather than sleeping past the deadline and retrying.
    const { fetch, calls } = makeFetch([
      { status: 503, body: { detail: "down" }, headers: { "Retry-After": "3" } },
      { status: 202, body: ACCEPTED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    let settled: unknown = "pending";
    const pending = client.reviewAndWait({ text: DRAFT }, { timeoutMs: 500 }).then(
      (r) => (settled = r),
      (e: unknown) => (settled = e),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(settled).toBeInstanceOf(LenzAPIError);
    expect(calls).toHaveLength(1);
    await pending;
  });

  it("a hung submit is aborted at the deadline, not at the client timeout", async () => {
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch: hanging });
    let settled: unknown = "pending";
    const pending = client.reviewAndWait({ text: DRAFT }, { timeoutMs: 10_000 }).then(
      (r) => (settled = r),
      (e: unknown) => (settled = e),
    );
    await vi.advanceTimersByTimeAsync(10_001);
    expect(settled).toBeInstanceOf(LenzAPIError);
    expect(hanging).toHaveBeenCalledTimes(1);
    await pending;
  });

  it("honours a poll's stated Retry-After (capped at 60 s) instead of the 5 s floor", async () => {
    const { fetch, calls } = makeFetch([
      { status: 202, body: ACCEPTED },
      {
        status: 503,
        body: { detail: "Busy.", code: "capacity", retry_after: 90 },
        headers: { "Retry-After": "90" },
      },
      { body: COMPLETED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const pending = client.reviewAndWait({ text: DRAFT });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe("completed");
  });

  it("with the default retries, a poll's internal retry cannot outlive the deadline", async () => {
    const { fetch, calls } = makeFetch([
      { status: 202, body: ACCEPTED },
      {
        status: 429,
        body: { detail: "Slow down.", code: "rate_limited" },
        headers: { "Retry-After": "60" },
      },
      { body: COMPLETED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch }); // default maxRetries
    let settled: unknown = "pending";
    const pending = client.reviewAndWait({ text: DRAFT }, { timeoutMs: 20_000 }).then(
      (r) => (settled = r),
      (e: unknown) => (settled = e),
    );
    await vi.advanceTimersByTimeAsync(20_001);
    expect(settled).toBeInstanceOf(ReviewTimeoutError);
    expect(calls).toHaveLength(2);
    await pending;
  });

  it("a poll's Retry-After never sleeps past the deadline", async () => {
    const { fetch } = makeFetch([
      { status: 202, body: ACCEPTED },
      {
        status: 429,
        body: { detail: "Slow down.", code: "rate_limited" },
        headers: { "Retry-After": "300" },
      },
      { body: VERIFYING },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const pending = client
      .reviewAndWait({ text: DRAFT }, { timeoutMs: 20_000 })
      .catch((e: unknown) => e);
    const err = await drain(pending, 30_000);
    expect(err).toBeInstanceOf(ReviewTimeoutError);
  });

  for (const [label, body] of [
    ["an empty body", {}],
    ["a body with no status", { review_id: "442b6aa9" }],
    ["a body whose status is not a string", { status: 3 }],
    ["a proxy's error object", { status: "error" }],
    ["a bare completed status", { status: "completed" }],
    ["another review's body", { ...COMPLETED, review_id: "deadbeef" }],
    ["a review without its arrays", { ...COMPLETED, issues: undefined, claims: undefined }],
    ["an unknown status", { ...COMPLETED, status: "exploded" }],
  ] as const) {
    it(`a 2xx poll with ${label} is a transient failure, not a review`, async () => {
      const { fetch } = makeFetch([
        { status: 202, body: ACCEPTED },
        { body: VERIFYING },
        { body },
        { body: COMPLETED },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const seen: unknown[] = [];
      const review = await drain(
        client.reviewAndWait({ text: DRAFT }, { onUpdate: (r) => seen.push(r.status) }),
      );
      expect(review).toEqual(COMPLETED);
      expect(seen).toEqual(["verifying", "completed"]);
    });
  }

  for (const [label, raw] of [
    ["an HTML proxy page", "<html>502 Bad Gateway</html>"],
    ["truncated JSON", '{"review_id": "442b'],
    ["an empty body with no Content-Length: 0", ""],
  ] as const) {
    it(`a 200 poll carrying ${label} is a failed poll, not the end of the wait`, async () => {
      const queue: Array<() => Response> = [
        () => new Response(JSON.stringify(ACCEPTED), { status: 202 }),
        () => new Response(JSON.stringify(VERIFYING), { status: 200 }),
        () => new Response(raw, { status: 200, headers: { "content-type": "text/html" } }),
        () => new Response(JSON.stringify(COMPLETED), { status: 200 }),
      ];
      const fetchImpl = vi.fn(async () => queue.shift()!()) as unknown as typeof fetch;
      const client = new Lenz({ apiKey: "lenz_t", fetch: fetchImpl });
      const review = await drain(client.reviewAndWait({ text: DRAFT }));
      expect(review.status).toBe("completed");
    });
  }

  it("a connection dropped while a poll body is read is a failed poll", async () => {
    const dropped = () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new TypeError("terminated"));
        },
      });
      return new Response(body, { status: 200 });
    };
    const queue: Array<() => Response> = [
      () => new Response(JSON.stringify(ACCEPTED), { status: 202 }),
      dropped,
      () => new Response(JSON.stringify(COMPLETED), { status: 200 }),
    ];
    const fetchImpl = vi.fn(async () => queue.shift()!()) as unknown as typeof fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch: fetchImpl });
    const review = await drain(client.reviewAndWait({ text: DRAFT }));
    expect(review.status).toBe("completed");
  });

  it("a poll whose body stalls after the headers cannot outlive the deadline", async () => {
    let n = 0;
    const fetchImpl = vi.fn((_u: string | URL | Request, init?: RequestInit) => {
      n += 1;
      if (n === 1) return Promise.resolve(new Response(JSON.stringify(ACCEPTED), { status: 202 }));
      // Headers arrive; the body never finishes unless aborted.
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"review_id": "442b'));
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch: fetchImpl });
    let settled: unknown = "pending";
    const pending = client.reviewAndWait({ text: DRAFT }, { timeoutMs: 8_000 }).then(
      (r) => (settled = r),
      (e: unknown) => (settled = e),
    );
    await vi.advanceTimersByTimeAsync(8_001);
    expect(settled).toBeInstanceOf(ReviewTimeoutError);
    await pending;
  });

  it("a 503 stating its wait only as retry_after_seconds is surfaced, not retried at once", async () => {
    const { fetch, calls } = makeFetch([
      { status: 503, body: { detail: "Busy.", code: "capacity", retry_after_seconds: 90 } },
      { status: 202, body: ACCEPTED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = (await client.review({ text: DRAFT }).catch((e: unknown) => e)) as LenzAPIError;
    expect(err).toBeInstanceOf(LenzUpstreamUnavailableError);
    expect(err.retryAfter).toBe(90);
    expect(calls).toHaveLength(1);
  });

  it("the first poll keeps to a budget the submit left positive", async () => {
    let n = 0;
    const fetchImpl = vi.fn((_u: string | URL | Request, init?: RequestInit) => {
      n += 1;
      if (n === 1) return Promise.resolve(new Response(JSON.stringify(ACCEPTED), { status: 202 }));
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch: fetchImpl });
    let settled: unknown = "pending";
    const pending = client.reviewAndWait({ text: DRAFT }, { timeoutMs: 100 }).then(
      (r) => (settled = r),
      (e: unknown) => (settled = e),
    );
    await vi.advanceTimersByTimeAsync(101);
    expect(settled).toBeInstanceOf(ReviewTimeoutError);
    await pending;
  });

  it("a later poll's request is cut at the remaining budget, not the 5 s floor", async () => {
    // Poll 1 answers at once; poll 2 hangs. With 2 s left at poll 2 its
    // request must abort at the deadline, not 5 s later.
    let n = 0;
    const fetchImpl = vi.fn((_u: string | URL | Request, init?: RequestInit) => {
      n += 1;
      if (n === 1) return Promise.resolve(new Response(JSON.stringify(ACCEPTED), { status: 202 }));
      if (n === 2) return Promise.resolve(new Response(JSON.stringify(VERIFYING), { status: 200 }));
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch: fetchImpl });
    let settled: unknown = "pending";
    const pending = client.reviewAndWait({ text: DRAFT }, { timeoutMs: 17_000 }).then(
      (r) => (settled = r),
      (e: unknown) => (settled = e),
    );
    // 15 s poll hint → poll 2 at 15 s, 2 s before the deadline.
    await vi.advanceTimersByTimeAsync(17_001);
    expect(settled).toBeInstanceOf(ReviewTimeoutError);
    expect((settled as ReviewTimeoutError).partial?.status).toBe("verifying");
    await pending;
  });

  it("a non-review 2xx body is never stored as partial", async () => {
    const { fetch } = makeFetch([
      { status: 202, body: ACCEPTED },
      ...Array.from({ length: 10 }, () => ({ body: {} })),
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = client
      .reviewAndWait({ text: DRAFT }, { timeoutMs: 12_000 })
      .catch((e: unknown) => e);
    const err = (await drain(pending, 60_000)) as ReviewTimeoutError;
    expect(err).toBeInstanceOf(ReviewTimeoutError);
    expect(err.partial).toBeNull();
  });

  for (const [stated, expectedMs] of [
    [45, 45_000],
    [3600, 60_000],
  ] as const) {
    it(`an untyped 503 stating ${stated} s paces the next poll at ${expectedMs / 1000} s`, async () => {
      const { fetch, calls } = makeFetch([
        { status: 202, body: ACCEPTED },
        {
          status: 503,
          body: { detail: "maintenance" },
          headers: { "Retry-After": String(stated) },
        },
        { body: COMPLETED },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const pending = client.reviewAndWait({ text: DRAFT }, { timeoutMs: 7_200_000 });
      await vi.advanceTimersByTimeAsync(expectedMs - 1);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe("completed");
    });
  }

  it("a stated retry_after_seconds on a poll is capped at 60 s too", async () => {
    const { fetch, calls } = makeFetch([
      { status: 202, body: ACCEPTED },
      { status: 429, body: { detail: "Slow.", code: "rate_limited", retry_after_seconds: 900 } },
      { body: COMPLETED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = client.reviewAndWait({ text: DRAFT }, { timeoutMs: 7_200_000 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe("completed");
  });

  it("a failed review with no failure block reads neutrally", async () => {
    const body = { ...NO_CLAIM, failure: null };
    const { fetch } = makeFetch([
      { status: 202, body: { review_id: body.review_id, status: "queued" } },
      { body },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = (await drain(
      client.reviewAndWait({ text: DRAFT }).catch((e: unknown) => e),
    )) as ReviewFailedError;
    expect(err).toBeInstanceOf(ReviewFailedError);
    expect(err.errorCode).toBe("");
    expect(err.retryable).toBeNull();
    expect(err.fix).toBe(
      `The review failed without a stated reason; read it with client.getReview('${body.review_id}').`,
    );
    expect(err.fix).not.toContain("different draft");
  });

  it("a purged review mid-wait throws LenzGoneError, not a timeout", async () => {
    const { fetch } = makeFetch([
      { status: 202, body: ACCEPTED },
      { status: 410, body: { detail: "Purged.", code: "purged" } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = await drain(client.reviewAndWait({ text: DRAFT }).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(LenzGoneError);
  });

  const failures: Array<[string, ReviewFull, boolean]> = [
    ["no_claim", NO_CLAIM, false],
    ["insufficient_credits", NO_CREDITS, false],
  ];
  for (const [code, body, retryable] of failures) {
    it(`a failed review (${code}) throws ReviewFailedError with the review`, async () => {
      const { fetch } = makeFetch([
        { status: 202, body: { review_id: body.review_id, status: "queued" } },
        { body },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const err = await drain(client.reviewAndWait({ text: DRAFT }).catch((e: unknown) => e));
      expect(err).toBeInstanceOf(ReviewFailedError);
      expect(err).toBeInstanceOf(LenzPipelineError);
      const f = err as ReviewFailedError;
      expect(f.reviewId).toBe(body.review_id);
      expect(f.errorCode).toBe(code);
      expect(f.hint).toBe(body.failure!.hint);
      expect(f.retryable).toBe(retryable);
      expect(f.failureClass).toBe("invalid_input");
      expect(f.review.outcome).toBe("unchecked");
    });
  }
});

// ── the docs are the acceptance test ─────────────────────────────────────

describe("the quickstart TypeScript tab", () => {
  it("runs as printed", async () => {
    const { fetch } = makeFetch([
      { status: 202, body: ACCEPTED },
      { body: COMPLETED },
      // verifyBatchAndWait is only called when a row was capped; the
      // recorded review capped nothing.
    ]);
    const client = new Lenz({ apiKey: "lenz_...", fetch });
    const lines: unknown[][] = [];
    const log = (...args: unknown[]) => lines.push(args);

    const draft = `
The EU AI Act entered into force on 1 August 2024, and its obligations for
general-purpose models applied from 2 August 2025. Fines for prohibited
practices reach 7% of global annual turnover. About 40% of European
companies had started compliance work by the end of 2024.
`;

    // One call: extract, assess, and verify the doubtful claims (async, 2–4 min)
    const review = await client.reviewAndWait({ text: draft });
    log(review.outcome); // clean | issues_found | incomplete | unchecked
    for (const i of review.issues) {
      log(i.verdict, i.confidence, i.claim);
      if (i.suggested_rewrite) log("  Suggested rewrite:", i.suggested_rewrite);
    }

    // Past the cap: send the remaining claims to /verify in one batch
    const capped = review.claims
      .filter((c) => c.escalation?.disposition === "cap")
      .map((c) => ({ claim: c.claim }));
    const results = capped.length ? await client.verifyBatchAndWait({ claims: capped }) : [];
    const deep = review.issues.find((i) => i.verification_id); // used in step 4

    expect(lines[0]).toEqual(["issues_found"]);
    expect(lines[2]![0]).toBe("  Suggested rewrite:");
    expect(results).toEqual([]);
    expect(deep?.verification_id).toBe("c9b769e1");
    expect(lines).toHaveLength(4); // outcome, two issues, one rewrite
  });
});

describe("review types", () => {
  it("a review entity's name may be null, as the API documents", () => {
    const completed = fixture<ReviewFull>("review_completed.json");
    const entity = completed.claims[3]!.verification!.entities[0]!;
    // Compile-time check: `name` is nullable, so this must narrow first.
    const name: string = entity.name ?? "";
    expect(name).toBe("EU AI Act");
    const nullable: ReviewEntity = { name: null, qid: null };
    expect(nullable.name).toBeNull();
  });
});
