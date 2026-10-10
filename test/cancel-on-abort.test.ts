/**
 * `cancelOnAbort`: a wait whose signal fires after the run was accepted
 * sends the matching server cancel (best effort, one attempt each, inside
 * one 5 s budget), reports a cancel that failed or did not cancel to
 * `logger.warn` with the id only, and then throws the same `LenzAbortError`
 * it throws without the flag. Off by default.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Lenz,
  LenzAbortError,
  LenzError,
  LenzTimeoutError,
  ReviewTimeoutError,
} from "../src/index.js";
import { settle } from "./support/recorder.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]): Record<string, unknown> =>
  JSON.parse(readFileSync(join(HERE, "fixtures", ...parts), "utf-8")) as Record<string, unknown>;
const recorded = (name: string): Record<string, unknown> =>
  read("shapes", "canonical", `${name}.json`)["body"] as Record<string, unknown>;

const SECRET = "the claim text that must never reach a log";
const PROCESSING = { status: "processing", progress: { step: "research" } };
const COMPLETED = {
  status: "completed",
  result: { verification_id: "v1", verdict: { label: "True", score: 9, confidence: "high" } },
};
const REVIEW_ACCEPTED = read("contract", "review_accepted.json");
const REVIEW_ID = String(REVIEW_ACCEPTED["review_id"]);
const REVIEW_VERIFYING = { ...read("contract", "review_verifying.json"), poll_after_seconds: 5 };
const CITECHECK_ACCEPTED = read("contract", "citecheck_accepted.json");
const CITECHECK_ID = String(CITECHECK_ACCEPTED["citecheck_id"]);
const CITECHECK_CHECKING = {
  ...read("contract", "citecheck_completed.json"),
  status: "checking",
  poll_after_seconds: 5,
};

const taskCancelled = (id: string) => ({ task_id: id, cancelled: true, status: "cancelled" });
const taskCompleted = (id: string) => ({ task_id: id, cancelled: false, status: "completed" });
const reviewCancel = (status: "cancelled" | "completed") => ({
  ...recorded(`review__cancel_200_${status}`),
  review_id: REVIEW_ID,
});
const citecheckCancel = () => ({
  ...recorded("citecheck__cancel_200_cancelled"),
  citecheck_id: CITECHECK_ID,
});

type Answer =
  | { status?: number; body?: unknown }
  /** Never answers, whatever the signal says (a fetch that ignores it). */
  | "hang"
  /** Answers only when its signal aborts (rejecting). */
  | "hang-until-abort";

interface Seen {
  method: string;
  path: string;
  at: number;
  headers: Record<string, string>;
}

/**
 * A fetch routed by `METHOD /path`: each route answers its queue in turn and
 * then its last answer again. A route not listed fails the test.
 */
function router(routes: Record<string, readonly Answer[]>) {
  const seen: Seen[] = [];
  const t0 = Date.now();
  const left = new Map(Object.entries(routes).map(([k, v]) => [k, [...v]]));
  const impl = (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, "");
    const key = `${String(init.method)} ${path}`;
    seen.push({
      method: String(init.method),
      path,
      at: Date.now() - t0,
      headers: { ...(init.headers as Record<string, string>) },
    });
    const queue = left.get(key);
    if (!queue) return Promise.reject(new Error(`unexpected request ${key}`));
    const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (answer === "hang") return new Promise<Response>(() => {});
    if (answer === "hang-until-abort") {
      return new Promise<Response>((_res, rej) => {
        const fail = () => rej(new DOMException("This operation was aborted", "AbortError"));
        if (init.signal?.aborted) fail();
        init.signal?.addEventListener("abort", fail);
      });
    }
    return Promise.resolve(
      new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const cancels = () => seen.filter((s) => s.method === "POST" && s.path.endsWith("/cancel"));
  return { fetch: impl as unknown as typeof fetch, seen, cancels };
}

function client(fetch: typeof globalThis.fetch) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { c: new Lenz({ apiKey: "lenz_t", fetch, logger }), logger };
}

/** Runs `run`, aborts after `abortAt` ms of fake time, and returns the error. */
async function abortAfter(
  run: (signal: AbortSignal) => Promise<unknown>,
  abortAt: number,
  settleFor = 1,
): Promise<{ err: unknown; abortedAt: number }> {
  const controller = new AbortController();
  const t0 = Date.now();
  let done = false;
  let doneAt = 0;
  const pending = settle(run(controller.signal)).then((e) => {
    done = true;
    doneAt = Date.now() - t0;
    return e;
  });
  await vi.advanceTimersByTimeAsync(abortAt);
  controller.abort(new Error("caller went away"));
  await vi.advanceTimersByTimeAsync(settleFor);
  expect(done).toBe(true);
  const err = await pending;
  return { err, abortedAt: doneAt };
}

function expectAbort(err: unknown): asserts err is LenzAbortError {
  expect(err).toBeInstanceOf(LenzAbortError);
  expect(err).not.toBeInstanceOf(LenzError);
  expect((err as Error).name).toBe("AbortError");
  expect(((err as Error).cause as Error).message).toBe("caller went away");
}

function warnings(logger: { warn: ReturnType<typeof vi.fn> }): string[] {
  return logger.warn.mock.calls.map((args) => String(args[0]));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("off by default", () => {
  it.each([undefined, false])("cancelOnAbort %s: an abort sends no cancel", async (flag) => {
    const { fetch, cancels } = router({
      "POST /verify": [{ status: 202, body: { task_id: "t1", status: "queued" } }],
      "GET /verify/status/t1": [{ body: PROCESSING }],
    });
    const { c, logger } = client(fetch);
    const { err } = await abortAfter(
      (signal) =>
        c.verifyAndWait(
          { claim: SECRET },
          flag === undefined ? { signal } : { signal, cancelOnAbort: flag },
        ),
      1_000,
    );
    expectAbort(err);
    expect(cancels()).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("on: an abort after the run was accepted cancels it", () => {
  it("verifyAndWait: one cancel (the nested wait does not send a second), then the abort", async () => {
    const { fetch, cancels } = router({
      "POST /verify": [{ status: 202, body: { task_id: "t1", status: "queued" } }],
      "GET /verify/status/t1": [{ body: PROCESSING }],
      "POST /verify/t1/cancel": [{ body: taskCancelled("t1") }],
    });
    const { c, logger } = client(fetch);
    const { err } = await abortAfter(
      (signal) =>
        c.verifyAndWait(
          { claim: SECRET, idempotencyKey: "k1" },
          { signal, cancelOnAbort: true, headers: { "X-Trace-Id": "tr1" } },
        ),
      1_000,
    );
    expectAbort(err);
    expect(err.taskId).toBe("t1");
    expect(err.idempotencyKey).toBe("k1");
    expect(cancels()).toHaveLength(1);
    // The call's headers ride along; the cancel sends no key.
    expect(cancels()[0]!.headers["X-Trace-Id"]).toBe("tr1");
    expect(Object.keys(cancels()[0]!.headers)).not.toContain("Idempotency-Key");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("wait: one cancel of the task it follows", async () => {
    const { fetch, cancels } = router({
      "GET /verify/status/t1": [{ body: PROCESSING }],
      "POST /verify/t1/cancel": [{ body: taskCancelled("t1") }],
    });
    const { c } = client(fetch);
    const { err } = await abortAfter(
      (signal) => c.wait("t1", { signal, cancelOnAbort: true }),
      1_000,
    );
    expectAbort(err);
    expect(cancels().map((s) => s.path)).toEqual(["/verify/t1/cancel"]);
  });

  it("reviewAndWait: one cancelReview", async () => {
    const { fetch, cancels } = router({
      "POST /review": [{ status: 202, body: REVIEW_ACCEPTED }],
      [`GET /reviews/${REVIEW_ID}`]: [{ body: REVIEW_VERIFYING }],
      [`POST /reviews/${REVIEW_ID}/cancel`]: [{ body: reviewCancel("cancelled") }],
    });
    const { c, logger } = client(fetch);
    const { err } = await abortAfter(
      (signal) => c.reviewAndWait({ text: SECRET }, { signal, cancelOnAbort: true }),
      1_000,
    );
    expectAbort(err);
    expect(err.reviewId).toBe(REVIEW_ID);
    expect(cancels().map((s) => s.path)).toEqual([`/reviews/${REVIEW_ID}/cancel`]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("citecheckAndWait: one cancelCitecheck", async () => {
    const { fetch, cancels } = router({
      "POST /citecheck": [{ status: 202, body: CITECHECK_ACCEPTED }],
      [`GET /citechecks/${CITECHECK_ID}`]: [{ body: CITECHECK_CHECKING }],
      [`POST /citechecks/${CITECHECK_ID}/cancel`]: [{ body: citecheckCancel() }],
    });
    const { c, logger } = client(fetch);
    const { err } = await abortAfter(
      (signal) => c.citecheckAndWait({ text: SECRET }, { signal, cancelOnAbort: true }),
      1_000,
    );
    expectAbort(err);
    expect(err.citecheckId).toBe(CITECHECK_ID);
    expect(cancels().map((s) => s.path)).toEqual([`/citechecks/${CITECHECK_ID}/cancel`]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("an abort during a poll (the request in flight) cancels too", async () => {
    const { fetch, cancels } = router({
      "POST /verify": [{ status: 202, body: { task_id: "t1", status: "queued" } }],
      "GET /verify/status/t1": ["hang-until-abort"],
      "POST /verify/t1/cancel": [{ body: taskCancelled("t1") }],
    });
    const { c } = client(fetch);
    const { err } = await abortAfter(
      (signal) => c.verifyAndWait({ claim: SECRET }, { signal, cancelOnAbort: true }),
      500,
    );
    expectAbort(err);
    expect(cancels()).toHaveLength(1);
  });

  it("a dead withOptions copy's signal cancels too, and the cancel is still sent", async () => {
    const { fetch, cancels } = router({
      "GET /verify/status/t1": [{ body: PROCESSING }],
      "POST /verify/t1/cancel": [{ body: taskCancelled("t1") }],
    });
    const { c } = client(fetch);
    const { err } = await abortAfter(
      (signal) => c.withOptions({ signal }).wait("t1", { cancelOnAbort: true }),
      1_000,
    );
    expectAbort(err);
    expect(cancels()).toHaveLength(1);
  });
});

describe("nothing to cancel", () => {
  it("an abort during the submit cancels nothing; the key is there to resend", async () => {
    for (const [name, routes, run] of [
      [
        "verifyAndWait",
        { "POST /verify": ["hang-until-abort"] },
        (c: Lenz, signal: AbortSignal) =>
          c.verifyAndWait({ claim: SECRET, idempotencyKey: "k1" }, { signal, cancelOnAbort: true }),
      ],
      [
        "verifyBatchAndWait",
        { "POST /verify/batch": ["hang-until-abort"] },
        (c: Lenz, signal: AbortSignal) =>
          c.verifyBatchAndWait(
            { claims: [{ claim: SECRET }], idempotencyKey: "k1" },
            { signal, cancelOnAbort: true },
          ),
      ],
      [
        "reviewAndWait",
        { "POST /review": ["hang-until-abort"] },
        (c: Lenz, signal: AbortSignal) =>
          c.reviewAndWait({ text: SECRET, idempotencyKey: "k1" }, { signal, cancelOnAbort: true }),
      ],
      [
        "citecheckAndWait",
        { "POST /citecheck": ["hang-until-abort"] },
        (c: Lenz, signal: AbortSignal) =>
          c.citecheckAndWait(
            { text: SECRET, idempotencyKey: "k1" },
            { signal, cancelOnAbort: true },
          ),
      ],
    ] as const) {
      const { fetch, cancels } = router(routes as unknown as Record<string, Answer[]>);
      const { c, logger } = client(fetch);
      const { err } = await abortAfter((signal) => run(c, signal), 100);
      expectAbort(err);
      expect(err.idempotencyKey, name).toBe("k1");
      expect(cancels(), name).toHaveLength(0);
      expect(logger.warn, name).not.toHaveBeenCalled();
    }
  });

  it("a signal already fired when the wait is called sends nothing at all", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const { c } = client(fetch);
    const signal = AbortSignal.abort(new Error("gone"));
    const err = await settle(c.wait("t1", { signal, cancelOnAbort: true }));
    expect(err).toBeInstanceOf(LenzAbortError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a review seen to end in the round the abort came in is not cancelled", async () => {
    const controller = new AbortController();
    const { fetch, cancels } = router({
      "POST /review": [{ status: 202, body: REVIEW_ACCEPTED }],
      [`GET /reviews/${REVIEW_ID}`]: [{ body: read("contract", "review_completed.json") }],
    });
    const { c } = client(fetch);
    const err = await settle(
      c.reviewAndWait(
        { text: SECRET },
        {
          signal: controller.signal,
          cancelOnAbort: true,
          onUpdate: () => controller.abort(new Error("caller went away")),
        },
      ),
    );
    expectAbort(err);
    expect(cancels()).toHaveLength(0);
  });
});

describe("the SDK's own deadline is not an abort", () => {
  it("verifyAndWait: timeoutMs running out throws LenzTimeoutError and sends no cancel", async () => {
    const { fetch, cancels } = router({
      "POST /verify": [{ status: 202, body: { task_id: "t1", status: "queued" } }],
      "GET /verify/status/t1": [{ body: PROCESSING }],
    });
    const { c } = client(fetch);
    const controller = new AbortController();
    const pending = settle(
      c.verifyAndWait(
        { claim: SECRET },
        { signal: controller.signal, cancelOnAbort: true, timeoutMs: 3_000 },
      ),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await pending;
    expect(err).toBeInstanceOf(LenzTimeoutError);
    expect(cancels()).toHaveLength(0);
  });

  it("reviewAndWait: timeoutMs running out throws ReviewTimeoutError and sends no cancel", async () => {
    const { fetch, cancels } = router({
      "POST /review": [{ status: 202, body: REVIEW_ACCEPTED }],
      [`GET /reviews/${REVIEW_ID}`]: [{ body: REVIEW_VERIFYING }],
    });
    const { c } = client(fetch);
    const pending = settle(
      c.reviewAndWait({ text: SECRET }, { cancelOnAbort: true, timeoutMs: 6_000 }),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBeInstanceOf(ReviewTimeoutError);
    expect(cancels()).toHaveLength(0);
  });
});

describe("a cancel that does not cancel is logged, never thrown", () => {
  it("the run finished first (cancelled: false): a warning with the id, then the abort", async () => {
    const { fetch, cancels } = router({
      "POST /verify": [{ status: 202, body: { task_id: "t1", status: "queued" } }],
      "GET /verify/status/t1": [{ body: PROCESSING }],
      "POST /verify/t1/cancel": [{ body: taskCompleted("t1") }],
    });
    const { c, logger } = client(fetch);
    const { err } = await abortAfter(
      (signal) => c.verifyAndWait({ claim: SECRET }, { signal, cancelOnAbort: true }),
      1_000,
    );
    expectAbort(err);
    expect(cancels()).toHaveLength(1);
    expect(warnings(logger)).toEqual([
      "[lenz-io] cancelOnAbort: task t1 was not cancelled: it had already ended " +
        "(status completed), and a run that finished is charged as usual.",
    ]);
  });

  it("a review that completed first: the warning names the review", async () => {
    const { fetch } = router({
      "POST /review": [{ status: 202, body: REVIEW_ACCEPTED }],
      [`GET /reviews/${REVIEW_ID}`]: [{ body: REVIEW_VERIFYING }],
      [`POST /reviews/${REVIEW_ID}/cancel`]: [{ body: reviewCancel("completed") }],
    });
    const { c, logger } = client(fetch);
    const { err } = await abortAfter(
      (signal) => c.reviewAndWait({ text: SECRET }, { signal, cancelOnAbort: true }),
      1_000,
    );
    expectAbort(err);
    expect(warnings(logger)).toHaveLength(1);
    expect(warnings(logger)[0]).toContain(`review ${REVIEW_ID} was not cancelled`);
  });

  it("a 503 is one attempt: no retry, no Retry-After wait, a warning, then the abort", async () => {
    const { fetch, cancels } = router({
      "GET /verify/status/t1": [{ body: PROCESSING }],
      "POST /verify/t1/cancel": [
        { status: 503, body: { error: { code: "upstream_unavailable", message: "x" } } },
      ],
    });
    const { c, logger } = client(fetch);
    const { err } = await abortAfter(
      (signal) => c.wait("t1", { signal, cancelOnAbort: true }),
      1_000,
    );
    expectAbort(err);
    expect(cancels()).toHaveLength(1);
    expect(warnings(logger)).toHaveLength(1);
    expect(warnings(logger)[0]).toMatch(
      /^\[lenz-io\] cancelOnAbort: could not cancel task t1 \(HTTP 503.*\); it may still run and be charged\.$/,
    );
  });

  it.each(["hang", "hang-until-abort"] as const)(
    "a cancel that never answers (%s): the abort is thrown when the 5 s budget runs out",
    async (answer) => {
      const { fetch, cancels } = router({
        "GET /verify/status/t1": [{ body: PROCESSING }],
        "POST /verify/t1/cancel": [answer],
      });
      const { c, logger } = client(fetch);
      const controller = new AbortController();
      let settledAt: number | undefined;
      const t0 = Date.now();
      const pending = settle(c.wait("t1", { signal: controller.signal, cancelOnAbort: true })).then(
        (e) => {
          settledAt = Date.now() - t0;
          return e;
        },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort(new Error("caller went away"));
      await vi.advanceTimersByTimeAsync(4_900);
      expect(settledAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(200);
      const err = await pending;
      expectAbort(err);
      expect(settledAt).toBeLessThanOrEqual(1_000 + 5_000 + 1);
      expect(cancels()).toHaveLength(1);
      expect(warnings(logger)).toEqual([
        "[lenz-io] cancelOnAbort: could not cancel task t1 (no answer within 5000 ms); " +
          "it may still run and be charged.",
      ]);
    },
  );

  it("no warning ever carries the submitted text", async () => {
    const { fetch } = router({
      "POST /verify": [{ status: 202, body: { task_id: "t1", status: "queued" } }],
      "GET /verify/status/t1": [{ body: PROCESSING }],
      "POST /verify/t1/cancel": [{ status: 400, body: { error: { code: "x", message: SECRET } } }],
    });
    const { c, logger } = client(fetch);
    await abortAfter(
      (signal) => c.verifyAndWait({ claim: SECRET }, { signal, cancelOnAbort: true }),
      1_000,
    );
    expect(warnings(logger)).toHaveLength(1);
    for (const line of warnings(logger)) expect(line).not.toContain(SECRET);
  });
});

describe("a batch cancels each task still running, independently", () => {
  it("distinct ids, the finished one skipped, one failure does not stop the others", async () => {
    const { fetch, cancels } = router({
      "POST /verify/batch": [
        {
          status: 202,
          body: {
            batch_id: "b1",
            items: [
              { task_id: "t1", claim: "a" },
              { task_id: "t2", claim: "b" },
              { task_id: "t3", claim: "c" },
              { task_id: "t1", claim: "a again" },
            ],
          },
        },
      ],
      "GET /verify/status/t1": [{ body: PROCESSING }],
      "GET /verify/status/t2": [{ body: COMPLETED }],
      "GET /verify/status/t3": [{ body: PROCESSING }],
      "POST /verify/t1/cancel": [{ status: 500, body: {} }],
      "POST /verify/t3/cancel": ["hang-until-abort"],
    });
    const { c, logger } = client(fetch);
    const { err } = await abortAfter(
      (signal) =>
        c.verifyBatchAndWait(
          { claims: [{ claim: "a" }, { claim: "b" }, { claim: "c" }, { claim: "a again" }] },
          { signal, cancelOnAbort: true },
        ),
      1_000,
      6_000,
    );
    expectAbort(err);
    expect(err.batchId).toBe("b1");
    // t2 finished: not cancelled. t1 once though accepted twice. Both sent
    // at once (concurrently), each failing on its own.
    expect(
      cancels()
        .map((s) => s.path)
        .sort(),
    ).toEqual(["/verify/t1/cancel", "/verify/t3/cancel"]);
    expect(new Set(cancels().map((s) => s.at)).size).toBe(1);
    expect(warnings(logger).sort()).toEqual([
      "[lenz-io] cancelOnAbort: could not cancel task t1 (HTTP 500); it may still run and be charged.",
      "[lenz-io] cancelOnAbort: could not cancel task t3 (no answer within 5000 ms); " +
        "it may still run and be charged.",
    ]);
  });

  it("a task whose poll answered in another API version is still cancelled", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const fetch = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, "");
      seen.push(path);
      if (path === "/verify/batch") {
        return Response.json(
          {
            batch_id: "b1",
            items: [
              { task_id: "t1", claim: "a" },
              { task_id: "t2", claim: "b" },
            ],
          },
          { status: 202 },
        );
      }
      if (path === "/verify/status/t1") {
        return Response.json(PROCESSING, { headers: { "X-Lenz-API-Version": "2026-01-01" } });
      }
      if (path === "/verify/status/t2") return Response.json(PROCESSING);
      const id = path.split("/").at(-2)!;
      return Response.json(taskCancelled(id));
    }) as typeof globalThis.fetch;
    const { c } = client(fetch);
    const err = await settle(
      c.verifyBatchAndWait(
        { claims: [{ claim: "a" }, { claim: "b" }] },
        {
          signal: controller.signal,
          cancelOnAbort: true,
          onProgress: () => controller.abort(new Error("caller went away")),
        },
      ),
    );
    expectAbort(err);
    expect(seen.filter((p) => p.endsWith("/cancel")).sort()).toEqual([
      "/verify/t1/cancel",
      "/verify/t2/cancel",
    ]);
  });

  it("every task cancelled: no warning", async () => {
    const { fetch, cancels } = router({
      "POST /verify/batch": [
        {
          status: 202,
          body: {
            batch_id: "b1",
            items: [
              { task_id: "t1", claim: "a" },
              { task_id: "t2", claim: "b" },
            ],
          },
        },
      ],
      "GET /verify/status/t1": [{ body: PROCESSING }],
      "GET /verify/status/t2": [{ body: PROCESSING }],
      "POST /verify/t1/cancel": [{ body: taskCancelled("t1") }],
      "POST /verify/t2/cancel": [{ body: taskCancelled("t2") }],
    });
    const { c, logger } = client(fetch);
    const { err } = await abortAfter(
      (signal) =>
        c.verifyBatchAndWait(
          { claims: [{ claim: "a" }, { claim: "b" }] },
          { signal, cancelOnAbort: true },
        ),
      1_000,
    );
    expectAbort(err);
    expect(cancels()).toHaveLength(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("where the option is taken", () => {
  it("a value that is not a boolean throws before any request", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const { c } = client(fetch);
    const bad = { cancelOnAbort: "yes" } as unknown as { cancelOnAbort: boolean };
    for (const run of [
      () => c.wait("t1", bad),
      () => c.verifyAndWait({ claim: "a" }, bad),
      () => c.verifyBatchAndWait({ claims: [{ claim: "a" }] }, bad),
      () => c.reviewAndWait({ text: "a" }, bad),
      () => c.citecheckAndWait({ text: "a" }, bad),
    ]) {
      const err = await settle(run());
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/cancelOnAbort must be true or false/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("withOptions and the plain calls refuse it: it belongs to one wait", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const { c } = client(fetch);
    const opts = { cancelOnAbort: true } as unknown as Record<string, never>;
    expect(() => c.withOptions(opts)).toThrow(/cancelOnAbort is an option of one wait/);
    const err = await settle(c.verify({ claim: "a" }, opts));
    expect((err as Error).message).toMatch(/cancelOnAbort is an option of one wait/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("AbortSignal.timeout() is an abort", () => {
  it("passed as the signal, it cancels the run", async () => {
    vi.useRealTimers();
    const { fetch, cancels } = router({
      "GET /verify/status/t1": [{ body: PROCESSING }],
      "POST /verify/t1/cancel": [{ body: taskCancelled("t1") }],
    });
    const { c } = client(fetch);
    const err = await settle(
      c.wait("t1", { signal: AbortSignal.timeout(50), cancelOnAbort: true }),
    );
    expect(err).toBeInstanceOf(LenzAbortError);
    expect(((err as Error).cause as Error).name).toBe("TimeoutError");
    expect(cancels()).toHaveLength(1);
    vi.useFakeTimers();
  });
});
