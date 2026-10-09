/**
 * `signal` and `LenzAbortError`: one row per phase of a call and per catch a
 * caller's abort passes through. An abort is never retried, never a request
 * timeout, an API-version error or a job timeout, and it carries what the
 * call knew when it stopped.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Lenz,
  LenzAbortError,
  LenzError,
  type BatchAccepted,
  type TaskStatus,
  type VerifyBatchInput,
} from "../src/index.js";
import { recorder, settle, type Reply } from "./support/recorder.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(HERE, "fixtures", "contract", name), "utf-8")) as Record<
    string,
    unknown
  >;

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
const REVIEW_VERIFYING = { ...fixture("review_verifying.json"), poll_after_seconds: 5 };
const CITECHECK_ACCEPTED = fixture("citecheck_accepted.json");
const CITECHECK_ID = String(CITECHECK_ACCEPTED["citecheck_id"]);
const CITECHECK_CHECKING = {
  ...fixture("citecheck_completed.json"),
  status: "checking",
  poll_after_seconds: 5,
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Runs `run` against a recording fetch, aborts `controller` after `abortAt`
 * ms of fake time (or when `when` says so), and returns the error and what
 * was sent.
 */
async function aborted(
  replies: Reply[],
  run: (c: Lenz, signal: AbortSignal) => Promise<unknown>,
  abortAt: number,
  opts: { fallback?: Reply; maxRetries?: number; reason?: unknown } = {},
) {
  const { fetch, sent } = recorder(replies, opts.fallback);
  const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: opts.maxRetries ?? 3 });
  const controller = new AbortController();
  const pending = settle(run(client, controller.signal));
  await vi.advanceTimersByTimeAsync(abortAt);
  controller.abort(opts.reason ?? new Error("stop"));
  await vi.advanceTimersByTimeAsync(1);
  const err = await pending;
  return { err: err as LenzAbortError, sent, client };
}

function expectAbort(err: unknown): asserts err is LenzAbortError {
  expect(err).toBeInstanceOf(LenzAbortError);
  expect(err).not.toBeInstanceOf(LenzError);
  expect((err as Error).name).toBe("AbortError");
}

describe("before the call", () => {
  it("an aborted signal sends nothing and mints no key", async () => {
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID");
    try {
      const fetch = vi.fn() as unknown as typeof globalThis.fetch;
      const c = new Lenz({ apiKey: "lenz_t", fetch });
      const reason = new Error("gone");
      const signal = AbortSignal.abort(reason);
      for (const run of [
        () => c.verify({ claim: "a" }, { signal }),
        () => c.assess({ claim: "a" }, { signal }),
        () => c.reviewAndWait({ text: "a" }, { signal }),
        () => c.citecheckAndWait({ text: "a" }, { signal }),
        () => c.verifyAndWait({ claim: "a" }, { signal }),
        () => c.verifyBatchAndWait({ claims: [{ claim: "a" }] }, { signal }),
        () => c.wait("t1", { signal }),
        () => c.getReview("r1", { signal }),
        () => c.ask.send("v1", { message: "m" }, { signal }),
      ]) {
        const err = await settle(run());
        expectAbort(err);
        expect(err.cause).toBe(reason);
        expect(err.idempotencyKey).toBeUndefined();
        expect(err.taskId).toBeUndefined();
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(uuid).not.toHaveBeenCalled();
    } finally {
      uuid.mockRestore();
    }
  });

  it("listAll with an aborted signal throws on the first next(), sending nothing", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const it = c.verifications.listAll({ signal: AbortSignal.abort() });
    const err = await settle(it[Symbol.asyncIterator]().next());
    expectAbort(err);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("during a plain call", () => {
  it("during the fetch: the key, not retried, not a request timeout", async () => {
    const reason = new Error("user left");
    const { err, sent } = await aborted(
      [],
      (c, signal) => c.assess({ claim: "a", idempotencyKey: "k1" }, { signal }),
      1_000,
      { fallback: { hang: true }, reason },
    );
    expectAbort(err);
    expect(err.idempotencyKey).toBe("k1");
    expect(err.cause).toBe(reason);
    expect(sent).toHaveLength(1);
  });

  it("during the fetch with no retry left: still the abort, never a request timeout", async () => {
    const { err } = await aborted([], (c, signal) => c.usage({ signal }), 1_000, {
      fallback: { hang: true },
      maxRetries: 0,
    });
    expectAbort(err);
  });

  it("during the fetch of an unkeyed call: no key", async () => {
    const { err } = await aborted(
      [],
      (c, signal) => c.verify({ claim: "a", idempotency: false }, { signal }),
      1_000,
      { fallback: { hang: true } },
    );
    expectAbort(err);
    expect(err.idempotencyKey).toBeUndefined();
  });

  it("during the fetch of a call that sends no key (a read)", async () => {
    const { err } = await aborted([], (c, signal) => c.usage({ signal }), 1_000, {
      fallback: { hang: true },
    });
    expectAbort(err);
    expect(err.idempotencyKey).toBeUndefined();
  });

  it("during a 2xx body read", async () => {
    const { err, sent } = await aborted(
      [{ stallBody: true }],
      (c, signal) => c.verify({ claim: "a", idempotencyKey: "k1" }, { signal }),
      1_000,
    );
    expectAbort(err);
    expect(err.idempotencyKey).toBe("k1");
    expect(sent).toHaveLength(1);
  });

  it("during an error body read: the abort, not the mapped error", async () => {
    const { err } = await aborted(
      [{ status: 404, stallBody: true }],
      (c, signal) => c.usage({ signal }),
      1_000,
    );
    expectAbort(err);
  });

  it("during a version-mismatch body read: never LenzApiVersionError", async () => {
    const { err } = await aborted(
      [{ status: 200, stallBody: true, headers: { "X-Lenz-API-Version": "2026-05-13" } }],
      (c, signal) => c.usage({ signal }),
      1_000,
    );
    expectAbort(err);
  });

  it("during the code read of a keyed 409", async () => {
    const { err, sent } = await aborted(
      [{ status: 409, stallBody: true }],
      (c, signal) => c.verify({ claim: "a", idempotencyKey: "k1" }, { signal }),
      1_000,
    );
    expectAbort(err);
    expect(err.idempotencyKey).toBe("k1");
    expect(sent).toHaveLength(1);
  });

  it("during the code read of a 429", async () => {
    const { err, sent } = await aborted(
      [{ status: 429, stallBody: true }],
      (c, signal) => c.usage({ signal }),
      1_000,
    );
    expectAbort(err);
    expect(sent).toHaveLength(1);
  });

  it("during the Retry-After read of a 503", async () => {
    const { err, sent } = await aborted(
      [{ status: 503, stallBody: true }],
      (c, signal) => c.usage({ signal }),
      1_000,
    );
    expectAbort(err);
    expect(sent).toHaveLength(1);
  });

  it("during a retry sleep: no further request", async () => {
    const { err, sent } = await aborted(
      [{ status: 503 }],
      (c, signal) => c.verify({ claim: "a", idempotencyKey: "k1" }, { signal }),
      500,
      { fallback: { status: 202, body: TASK } },
    );
    expectAbort(err);
    expect(err.idempotencyKey).toBe("k1");
    expect(sent).toHaveLength(1);
    // The sleep's timer is gone with it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
  });

  it("AbortSignal.timeout(): its TimeoutError is the cause", async () => {
    vi.useRealTimers();
    const { fetch } = recorder([], { hang: true });
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const err = await settle(c.usage({ signal: AbortSignal.timeout(20) }));
    expectAbort(err);
    expect((err.cause as Error).name).toBe("TimeoutError");
  });

  it("a signal that fires after the body was read does not undo the result", async () => {
    const controller = new AbortController();
    const { fetch } = recorder([{ body: { credits: {} } }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await c.usage({ signal: controller.signal });
    controller.abort();
    expect(out).toBeTruthy();
  });
});

describe("during a wait", () => {
  for (const [name, run] of [
    [
      "verifyAndWait",
      (c: Lenz, signal: AbortSignal) =>
        c.verifyAndWait({ claim: "a", idempotencyKey: "k1" }, { signal }),
    ],
    [
      "verifyBatchAndWait",
      (c: Lenz, signal: AbortSignal) =>
        c.verifyBatchAndWait({ claims: [{ claim: "a" }], idempotencyKey: "k1" }, { signal }),
    ],
    [
      "reviewAndWait",
      (c: Lenz, signal: AbortSignal) =>
        c.reviewAndWait({ text: "a", idempotencyKey: "k1" }, { signal }),
    ],
    [
      "citecheckAndWait",
      (c: Lenz, signal: AbortSignal) =>
        c.citecheckAndWait({ text: "a", idempotencyKey: "k1" }, { signal }),
    ],
  ] as const) {
    it(`${name}: during the submit, the key and no id`, async () => {
      const { err, sent } = await aborted([], run, 1_000, { fallback: { hang: true } });
      expectAbort(err);
      expect(err.idempotencyKey).toBe("k1");
      expect(err.taskId ?? err.batchId ?? err.reviewId ?? err.citecheckId).toBeUndefined();
      expect(sent).toHaveLength(1);
    });
  }

  it("verifyAndWait unkeyed, during the submit: nothing to resend with", async () => {
    const { err } = await aborted(
      [],
      (c, signal) => c.verifyAndWait({ claim: "a", idempotency: false }, { signal }),
      1_000,
      { fallback: { hang: true } },
    );
    expectAbort(err);
    expect(err.idempotencyKey).toBeUndefined();
  });

  it("verifyAndWait between polls: the taskId and the key", async () => {
    const { err, sent } = await aborted(
      [{ status: 202, body: TASK }, { body: PROCESSING }],
      (c, signal) => c.verifyAndWait({ claim: "a", idempotencyKey: "k1" }, { signal }),
      1_000,
    );
    expectAbort(err);
    expect(err.taskId).toBe("t1");
    expect(err.idempotencyKey).toBe("k1");
    expect(sent).toHaveLength(2);
  });

  it("verifyAndWait during a poll: the taskId", async () => {
    const { err } = await aborted(
      [{ status: 202, body: TASK }],
      (c, signal) => c.verifyAndWait({ claim: "a" }, { signal }),
      1_000,
      { fallback: { hang: true } },
    );
    expectAbort(err);
    expect(err.taskId).toBe("t1");
    expect(err.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("a standalone wait: the taskId, no key", async () => {
    const { err } = await aborted(
      [{ body: PROCESSING }],
      (c, signal) => c.wait("t1", { signal }),
      1_000,
    );
    expectAbort(err);
    expect(err.taskId).toBe("t1");
    expect(err.idempotencyKey).toBeUndefined();
  });

  it("a poll through a getStatus override that ignores the signal still stops", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    c.getStatus = (() => new Promise<TaskStatus>(() => {})) as typeof c.getStatus;
    const controller = new AbortController();
    const pending = settle(c.wait("t1", { signal: controller.signal, timeoutMs: 600_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expectAbort(err);
    expect(err.taskId).toBe("t1");
  });

  it("the batch, between polls: batchId and every taskId, no spin to the deadline", async () => {
    const { err, sent } = await aborted(
      [{ status: 202, body: BATCH }, { body: PROCESSING }, { body: PROCESSING }],
      (c, signal) =>
        c.verifyBatchAndWait(
          { claims: [{ claim: "a" }, { claim: "b" }], idempotencyKey: "k1" },
          { signal, timeoutMs: 600_000 },
        ),
      1_000,
    );
    expectAbort(err);
    expect(err.batchId).toBe("b1");
    expect(err.taskIds).toEqual(["t1", "t2"]);
    expect(err.idempotencyKey).toBe("k1");
    expect(sent).toHaveLength(3);
  });

  it("the batch, during its polls (the allSettled path)", async () => {
    const { err } = await aborted(
      [{ status: 202, body: BATCH }],
      (c, signal) => c.verifyBatchAndWait({ claims: [{ claim: "a" }, { claim: "b" }] }, { signal }),
      1_000,
      { fallback: { hang: true } },
    );
    expectAbort(err);
    expect(err.taskIds).toEqual(["t1", "t2"]);
  });

  it("the batch submit through a verifyBatch override that ignores the options", async () => {
    class Hangs extends Lenz {
      override verifyBatch(_input: VerifyBatchInput): Promise<BatchAccepted> {
        return new Promise(() => {});
      }
    }
    const c = new Hangs({ apiKey: "lenz_t", fetch: vi.fn() as unknown as typeof fetch });
    const controller = new AbortController();
    const pending = settle(
      c.verifyBatchAndWait(
        { claims: [{ claim: "a" }], idempotencyKey: "k1" },
        { signal: controller.signal },
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expectAbort(err);
    expect(err.idempotencyKey).toBe("k1");
  });

  it("reviewAndWait between polls: the reviewId and the key", async () => {
    const { err } = await aborted(
      [{ status: 202, body: REVIEW_ACCEPTED }, { body: REVIEW_VERIFYING }],
      (c, signal) => c.reviewAndWait({ text: "a", idempotencyKey: "k1" }, { signal }),
      1_000,
    );
    expectAbort(err);
    expect(err.reviewId).toBe(REVIEW_ID);
    expect(err.idempotencyKey).toBe("k1");
  });

  it("reviewAndWait during a poll: never a transient poll failure", async () => {
    const { err, sent } = await aborted(
      [{ status: 202, body: REVIEW_ACCEPTED }],
      (c, signal) => c.reviewAndWait({ text: "a" }, { signal }),
      1_000,
      { fallback: { hang: true } },
    );
    expectAbort(err);
    expect(err.reviewId).toBe(REVIEW_ID);
    expect(sent).toHaveLength(2);
  });

  it("citecheckAndWait between polls: the citecheckId", async () => {
    const { err } = await aborted(
      [{ status: 202, body: CITECHECK_ACCEPTED }, { body: CITECHECK_CHECKING }],
      (c, signal) => c.citecheckAndWait({ text: "a" }, { signal }),
      1_000,
    );
    expectAbort(err);
    expect(err.citecheckId).toBe(CITECHECK_ID);
  });

  it("an abort at the deadline is an abort, not a ReviewTimeoutError", async () => {
    const { fetch } = recorder([
      { status: 202, body: REVIEW_ACCEPTED },
      { body: REVIEW_VERIFYING },
    ]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const controller = new AbortController();
    // A budget of 0: the one poll ends past the deadline, and the abort
    // comes with it (fired from the update callback).
    const err = await settle(
      c.reviewAndWait(
        { text: "a" },
        { timeoutMs: 0, signal: controller.signal, onUpdate: () => controller.abort() },
      ),
    );
    expectAbort(err);
    expect(err.reviewId).toBe(REVIEW_ID);
  });
});

describe("copies and listeners", () => {
  it("a copy's signal and a call's signal: whichever fires aborts", async () => {
    const { fetch } = recorder([], { hang: true });
    const root = new Lenz({ apiKey: "lenz_t", fetch });
    const copyCtl = new AbortController();
    const callCtl = new AbortController();
    const copy = root.withOptions({ signal: copyCtl.signal });

    const viaCall = settle(copy.usage({ signal: callCtl.signal }));
    await vi.advanceTimersByTimeAsync(10);
    callCtl.abort("call");
    await vi.advanceTimersByTimeAsync(1);
    expect(((await viaCall) as LenzAbortError).cause).toBe("call");

    const viaCopy = settle(copy.usage({ signal: new AbortController().signal }));
    await vi.advanceTimersByTimeAsync(10);
    copyCtl.abort("copy");
    await vi.advanceTimersByTimeAsync(1);
    expect(((await viaCopy) as LenzAbortError).cause).toBe("copy");
  });

  it("a dead copy refuses at entry; the root it came from still cancels", async () => {
    const { fetch, sent } = recorder([
      { body: { task_id: "t1", cancelled: true, status: "cancelled" } },
    ]);
    const root = new Lenz({ apiKey: "lenz_t", fetch });
    const controller = new AbortController();
    const copy = root.withOptions({ signal: controller.signal });
    controller.abort();
    expectAbort(await settle(copy.getStatus("t1")));
    expectAbort(await settle(copy.verifications.get("v1")));
    expect(sent).toHaveLength(0);
    expect((await root.cancel("t1")).cancelled).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("every listener is removed after the call: none gathers on a reused signal", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    let live = 0;
    type Listener = Parameters<AbortSignal["addEventListener"]>[1];
    type ListenerOptions = Parameters<AbortSignal["addEventListener"]>[2];
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    const added = new Set<unknown>();
    signal.addEventListener = ((type: "abort", fn: Listener, o?: ListenerOptions) => {
      if (!added.has(fn)) live += 1;
      added.add(fn);
      add(type, fn, o);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: "abort", fn: Listener) => {
      if (added.delete(fn)) live -= 1;
      remove(type, fn);
    }) as typeof signal.removeEventListener;

    const { fetch } = recorder(
      [
        { status: 503 },
        { body: {} },
        { status: 202, body: TASK },
        { body: PROCESSING },
        { body: COMPLETED },
        { body: {} },
      ],
      { body: {} },
    );
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const p1 = settle(c.usage({ signal }));
    await vi.advanceTimersByTimeAsync(10_000);
    await p1;
    const p2 = settle(c.verifyAndWait({ claim: "a" }, { signal }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p2).toMatchObject({ verification_id: "v1" });
    for (let i = 0; i < 20; i++) await c.usage({ signal });
    expect(live).toBe(0);
  });

  it("listAll: an abort after the first item of a page stops delivery", async () => {
    const { fetch, sent } = recorder([
      {
        body: {
          items: [{ verification_id: "a" }, { verification_id: "b" }],
          total: 4,
          page: 1,
          page_size: 2,
        },
      },
    ]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const controller = new AbortController();
    const it = c.verifications.listAll({ signal: controller.signal })[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ verification_id: "a" });
    controller.abort();
    expectAbort(await settle(it.next()));
    expect(sent).toHaveLength(1);
  });

  it("library.listAll: an abort between pages ends before the next page", async () => {
    const { fetch, sent } = recorder([
      { body: { items: [{ verification_id: "a" }], total: 4, page: 1, page_size: 1 } },
    ]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const controller = new AbortController();
    const it = c.library.listAll({}, { signal: controller.signal })[Symbol.asyncIterator]();
    await it.next();
    controller.abort();
    expectAbort(await settle(it.next()));
    expect(sent).toHaveLength(1);
  });
});
