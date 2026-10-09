/**
 * Stopping a run: `cancel`, `cancelReview` and `cancelCitecheck`.
 *
 * Responses are the API's own recordings (`fixtures/shapes/canonical/`,
 * imported by `scripts/import-shapes.mjs`). None of the three sends a body or
 * an Idempotency-Key: cancelling is idempotent by nature, and a second cancel
 * of a run that already ended answers with the run as it stands.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  Lenz,
  LenzApiVersionError,
  LenzAuthError,
  LenzError,
  LenzNotFoundError,
  type CancelResult,
  type Citecheck,
  type ReviewFull,
  type TaskStatus,
} from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shapes", "canonical");

function recorded(name: string): { status: number; body: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(ROOT, `${name}.json`), "utf-8")) as {
    status: number;
    body: Record<string, unknown>;
  };
}

interface Call {
  url: URL;
  init: RequestInit;
}

/** A fetch that answers each call in turn with a recording, and keeps the calls. */
function serving(...answers: Array<Response | (() => Response)>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init: init ?? {} });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return typeof next === "function" ? next() : next.clone();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function reply(name: string, headers: Record<string, string> = {}): Response {
  const r = recorded(name);
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const make = (fetch: typeof globalThis.fetch, maxRetries = 0) =>
  new Lenz({ apiKey: "lenz_test", fetch, maxRetries });

describe("cancel(taskId)", () => {
  it("POSTs /verify/{task_id}/cancel with no body, no Idempotency-Key and no Content-Type", async () => {
    const { fetch, calls } = serving(reply("verify__cancel_200_cancelled"));
    await make(fetch).cancel("t1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/api/v1/verify/t1/cancel");
    expect(calls[0]!.url.search).toBe("");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBeNull();
    expect(headers.get("Content-Type")).toBeNull();
    expect(headers.get("Authorization")).toBe("Bearer lenz_test");
  });

  it("a run it stopped: cancelled true, status cancelled", async () => {
    const { fetch } = serving(reply("verify__cancel_200_cancelled"));
    const out = await make(fetch).cancel("t1");
    expect(out).toEqual(recorded("verify__cancel_200_cancelled").body);
    expect(out).toEqual({
      task_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      cancelled: true,
      status: "cancelled",
    });
  });

  it("a run that had already finished: cancelled false with its final status", async () => {
    const { fetch } = serving(reply("verify__cancel_200_completed"));
    const out = await make(fetch).cancel("t1");
    expect(out.cancelled).toBe(false);
    expect(out.status).toBe("completed");
    expect(out.task_id).toBe(recorded("verify__cancel_200_completed").body["task_id"]);
  });

  it("encodes the id and refuses an empty one before any request", async () => {
    const { fetch, calls } = serving(reply("verify__cancel_200_cancelled"));
    const client = make(fetch);
    await client.cancel("a/b c");
    expect(calls[0]!.url.pathname).toBe("/api/v1/verify/a%2Fb%20c/cancel");
    await expect(client.cancel("")).rejects.toThrow("cancel() requires a non-empty task_id.");
    expect(calls).toHaveLength(1);
  });

  it.each(["verify__cancel_404", "verify__cancel_not_yours_404"])(
    "%s: LenzNotFoundError with the server's code",
    async (name) => {
      const { fetch, calls } = serving(reply(name));
      const err = (await make(fetch, 2)
        .cancel("t1")
        .catch((e: unknown) => e)) as LenzNotFoundError;
      expect(err).toBeInstanceOf(LenzNotFoundError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("Task not found.");
      expect(calls).toHaveLength(1);
    },
  );

  it("the 409 use_review_cancel is a LenzError with that code, sent once and never waited on", async () => {
    // Default retries, and a Retry-After the retry ladder would honour for a
    // 5xx: the only 409s the client waits on are an in-flight Idempotency-Key.
    const { fetch, calls } = serving(
      reply("verify__cancel_review_child_409", { "Retry-After": "1" }),
    );
    const started = Date.now();
    const err = (await new Lenz({ apiKey: "lenz_test", fetch })
      .cancel("t1")
      .catch((e: unknown) => e)) as LenzError;
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(LenzError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("use_review_cancel");
    expect(err.message).toBe("This task is a review's deep check. Cancel the review to cancel it.");
    expect(err.retryable).toBe(false);
  });

  it("a 409 idempotency_conflict is not retried either: this call has no key", async () => {
    const conflict = () =>
      new Response(JSON.stringify({ detail: "In flight.", code: "idempotency_conflict" }), {
        status: 409,
      });
    const { fetch, calls } = serving(conflict);
    const err = (await new Lenz({ apiKey: "lenz_test", fetch })
      .cancel("t1")
      .catch((e: unknown) => e)) as LenzError;
    expect(calls).toHaveLength(1);
    expect(err.statusCode).toBe(409);
  });

  it("answers in another API version: LenzApiVersionError, one request", async () => {
    const { fetch, calls } = serving(
      new Response(JSON.stringify({ task_id: "t1", cancelled: true, status: "cancelled" }), {
        status: 200,
        headers: { "X-Lenz-API-Version": "2026-05-13" },
      }),
    );
    const err = await new Lenz({ apiKey: "lenz_test", fetch })
      .cancel("t1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect(calls).toHaveLength(1);
  });

  it("a 401 is the auth error", async () => {
    const { fetch } = serving(
      new Response(JSON.stringify({ detail: "Bad key.", code: "not_authenticated" }), {
        status: 401,
      }),
    );
    const err = await make(fetch, 2)
      .cancel("t1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzAuthError);
  });

  it("a 5xx or a dropped connection is retried on the client's ladder, still without a key", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const calls: Array<Headers> = [];
      const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
        calls.push(new Headers(init?.headers));
        n += 1;
        if (n === 1) return new Response(JSON.stringify({ detail: "boom" }), { status: 500 });
        if (n === 2) throw new TypeError("fetch failed");
        return reply("verify__cancel_200_cancelled");
      }) as typeof fetch;
      const pending = new Lenz({ apiKey: "lenz_test", fetch: fetchImpl }).cancel("t1");
      await vi.advanceTimersByTimeAsync(10_000);
      const out = await pending;
      expect(out.cancelled).toBe(true);
      expect(calls).toHaveLength(3);
      for (const h of calls) expect(h.get("Idempotency-Key")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the result type", () => {
    expectTypeOf<CancelResult>().toEqualTypeOf<{
      task_id: string;
      cancelled: boolean;
      status: TaskStatus["status"];
    }>();
  });
});

describe("cancelReview(reviewId)", () => {
  const CASES = [
    "review__cancel_200_cancelled",
    "review__cancel_200_already_cancelled",
    "review__cancel_200_completed",
  ] as const;

  it("POSTs /reviews/{review_id}/cancel with no body and no Idempotency-Key", async () => {
    const { fetch, calls } = serving(reply(CASES[0]));
    await make(fetch).cancelReview("r1");
    expect(calls[0]!.url.pathname).toBe("/api/v1/reviews/r1/cancel");
    expect(calls[0]!.url.search).toBe("");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBeNull();
    expect(headers.get("Content-Type")).toBeNull();
  });

  it.each(CASES)("%s: the full view, read the way getReview reads it", async (name) => {
    const { fetch } = serving(reply(name));
    const cancelled = await make(fetch).cancelReview("r1");
    const read = await make(serving(reply(name)).fetch).getReview("r1");
    expect(cancelled).toEqual(read);
    expect(cancelled.status).toBe(String(recorded(name).body["status"]));
    expectTypeOf(cancelled).toEqualTypeOf<ReviewFull>();
  });

  it("a review it stopped reads cancelled, and one that had finished is returned as it was", async () => {
    const stopped = await make(serving(reply(CASES[0])).fetch).cancelReview("r1");
    expect(stopped.status).toBe("cancelled");
    expect(stopped.outcome).toBe("incomplete");
    const done = await make(serving(reply(CASES[2])).fetch).cancelReview("r1");
    expect(done.status).toBe("completed");
    expect(done.outcome).toBe("clean");
  });

  it("encodes the id and refuses an empty one before any request", async () => {
    const { fetch, calls } = serving(reply(CASES[0]));
    const client = make(fetch);
    await client.cancelReview("a/b");
    expect(calls[0]!.url.pathname).toBe("/api/v1/reviews/a%2Fb/cancel");
    await expect(client.cancelReview("")).rejects.toThrow(
      "cancelReview() requires a non-empty review_id.",
    );
    expect(calls).toHaveLength(1);
  });

  it.each(["review__cancel_404_not_found", "review__cancel_404_other_account"])(
    "%s: LenzNotFoundError",
    async (name) => {
      const { fetch, calls } = serving(reply(name));
      const err = (await make(fetch, 2)
        .cancelReview("r1")
        .catch((e: unknown) => e)) as LenzNotFoundError;
      expect(err).toBeInstanceOf(LenzNotFoundError);
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("Review not found.");
      expect(calls).toHaveLength(1);
    },
  );

  it("answers in another API version: LenzApiVersionError", async () => {
    const { fetch } = serving(
      new Response("{}", { status: 404, headers: { "X-Lenz-API-Version": "2026-05-13" } }),
    );
    const err = await make(fetch)
      .cancelReview("r1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzApiVersionError);
  });
});

describe("cancelCitecheck(citecheckId)", () => {
  const CASES = [
    "citecheck__cancel_200_cancelled",
    "citecheck__cancel_200_already_cancelled",
    "citecheck__cancel_200_completed",
  ] as const;

  it("POSTs /citechecks/{citecheck_id}/cancel with no body and no Idempotency-Key", async () => {
    const { fetch, calls } = serving(reply(CASES[0]));
    await make(fetch).cancelCitecheck("c1");
    expect(calls[0]!.url.pathname).toBe("/api/v1/citechecks/c1/cancel");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBeNull();
    expect(headers.get("Content-Type")).toBeNull();
  });

  it.each(CASES)("%s: the check, read the way getCitecheck reads it", async (name) => {
    const cancelled = await make(serving(reply(name)).fetch).cancelCitecheck("c1");
    const read = await make(serving(reply(name)).fetch).getCitecheck("c1");
    expect(cancelled).toEqual(read);
    expect(cancelled.status).toBe(String(recorded(name).body["status"]));
    expectTypeOf(cancelled).toEqualTypeOf<Citecheck>();
  });

  it("encodes the id and refuses an empty one before any request", async () => {
    const { fetch, calls } = serving(reply(CASES[0]));
    const client = make(fetch);
    await client.cancelCitecheck("a/b");
    expect(calls[0]!.url.pathname).toBe("/api/v1/citechecks/a%2Fb/cancel");
    await expect(client.cancelCitecheck("")).rejects.toThrow(
      "cancelCitecheck() requires a non-empty citecheck_id.",
    );
    expect(calls).toHaveLength(1);
  });

  it.each(["citecheck__cancel_404_not_found", "citecheck__cancel_404_review_id"])(
    "%s: LenzNotFoundError",
    async (name) => {
      const { fetch, calls } = serving(reply(name));
      const err = (await make(fetch, 2)
        .cancelCitecheck("c1")
        .catch((e: unknown) => e)) as LenzNotFoundError;
      expect(err).toBeInstanceOf(LenzNotFoundError);
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("Citation check not found.");
      expect(calls).toHaveLength(1);
    },
  );
});
