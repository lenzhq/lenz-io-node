/**
 * 3.0: `verifyAndWait` and `verifyBatchAndWait` take their wait options as a
 * second argument, like `wait`, `reviewAndWait` and `citecheckAndWait`. The
 * 2.x in-input fields still work; the second argument wins per field. The
 * requests are the ones the 2.x form makes (`frozen-inputs.test.ts`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Lenz, LenzTimeoutError } from "../src/index.js";
import type { BatchItemResult, Progress, Verification, WaitOptions } from "../src/index.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(responses: Iterable<{ status?: number; body?: unknown }>) {
  const queue = Array.from(responses);
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("No more mocked responses");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

const ACCEPTED = { task_id: "t1", status: "queued" };
const BATCH_ACCEPTED = { batch_id: "b", items: [{ task_id: "t1", claim: "a" }] };
const PROCESSING = { status: "processing", progress: { step: "research" } };
const COMPLETED = {
  status: "completed",
  result: {
    verification_id: "v1",
    verdict: { label: "True", score: 9, confidence: "high" },
  },
};

/** What a run sent and saw: every request's URL, key and raw body. */
function trace(calls: FetchCall[]) {
  return calls.map((c) => [
    c.url,
    new Headers(c.init.headers).get("Idempotency-Key"),
    c.init.body === undefined ? null : String(c.init.body),
  ]);
}

afterEach(() => {
  vi.useRealTimers();
});

type Run<T> = (client: Lenz, seen: Array<[string, Progress]>) => Promise<T>;

async function run<T>(responses: Array<{ status?: number; body?: unknown }>, fn: Run<T>) {
  vi.useFakeTimers();
  const { fetch, calls } = makeFetch(responses);
  const seen: Array<[string, Progress]> = [];
  const p = fn(new Lenz({ apiKey: "lenz_t", fetch }), seen).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await p;
  vi.useRealTimers();
  return { result, calls: trace(calls), seen };
}

describe("verifyAndWait(input, opts)", () => {
  const responses = () => [
    { status: 202, body: ACCEPTED },
    { body: PROCESSING },
    { body: COMPLETED },
  ];

  it("the second argument does what the in-input fields did", async () => {
    const old = await run(responses(), (client, seen) =>
      client.verifyAndWait({
        claim: "a",
        idempotencyKey: "k",
        timeoutMs: 60_000,
        onProgress: (id, p) => seen.push([id, p]),
      }),
    );
    const now = await run(responses(), (client, seen) =>
      client.verifyAndWait(
        { claim: "a", idempotencyKey: "k" },
        { timeoutMs: 60_000, onProgress: (id, p) => seen.push([id, p]) },
      ),
    );
    expect((now.result as Verification).verification_id).toBe("v1");
    expect(now.result).toEqual(old.result);
    expect(now.calls).toEqual(old.calls);
    expect(now.calls[0]![2]).toBe('{"text":"a"}');
    expect(now.seen).toEqual([["t1", { step: "research" }]]);
    expect(now.seen).toEqual(old.seen);
  });

  it("the second argument wins per field: its onProgress, the input's timeoutMs", async () => {
    const fromInput: unknown[] = [];
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }, { body: PROCESSING }]);
    const seen: Array<[string, Progress]> = [];
    const err = await new Lenz({ apiKey: "lenz_t", fetch })
      .verifyAndWait(
        { claim: "a", timeoutMs: 0, onProgress: (id) => fromInput.push(id) },
        { onProgress: (id, p) => seen.push([id, p]) },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzTimeoutError);
    expect((err as Error).message).toBe("wait timed out after 0ms");
    expect(calls).toHaveLength(2);
    expect(seen).toEqual([["t1", { step: "research" }]]);
    expect(fromInput).toEqual([]);
  });

  it("the second argument's timeoutMs wins over the input's", async () => {
    const fromInput: unknown[] = [];
    const seen: unknown[] = [];
    const r = await run(responses(), (client) =>
      client.verifyAndWait(
        { claim: "a", timeoutMs: 0, onProgress: (id) => fromInput.push(id) },
        { timeoutMs: 60_000 },
      ),
    );
    expect((r.result as Verification).verification_id).toBe("v1");
    // The input's onProgress still fires: the second argument named no callback.
    expect(fromInput).toEqual(["t1"]);
    expect(seen).toEqual([]);
  });

  it("timeoutMs: 0 in the second argument polls once", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }, { body: PROCESSING }]);
    const err = await new Lenz({ apiKey: "lenz_t", fetch })
      .verifyAndWait({ claim: "a" }, { timeoutMs: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzTimeoutError);
    expect(calls).toHaveLength(2);
  });

  it("the wait options are never sent", async () => {
    const r = await run(responses(), (client) =>
      client.verifyAndWait({ claim: "a", idempotencyKey: "k" }, { timeoutMs: 5, onProgress() {} }),
    );
    expect(r.calls[0]![2]).toBe('{"text":"a"}');
  });
});

describe("verifyBatchAndWait(input, opts)", () => {
  const responses = () => [
    { status: 202, body: BATCH_ACCEPTED },
    { body: PROCESSING },
    { body: COMPLETED },
  ];

  it("the second argument does what the in-input fields did", async () => {
    const old = await run(responses(), (client, seen) =>
      client.verifyBatchAndWait({
        claims: [{ claim: "a" }],
        idempotencyKey: "k",
        timeoutMs: 60_000,
        onProgress: (id, p) => seen.push([id, p]),
      }),
    );
    const now = await run(responses(), (client, seen) =>
      client.verifyBatchAndWait(
        { claims: [{ claim: "a" }], idempotencyKey: "k" },
        { timeoutMs: 60_000, onProgress: (id, p) => seen.push([id, p]) },
      ),
    );
    expect((now.result as BatchItemResult[]).map((r) => r.status)).toEqual(["completed"]);
    expect(now.result).toEqual(old.result);
    expect(now.calls).toEqual(old.calls);
    expect(now.calls[0]![2]).toBe('{"claims":[{"text":"a"}]}');
    expect(now.seen).toEqual([["t1", { step: "research" }]]);
    expect(now.seen).toEqual(old.seen);
  });

  it("the second argument wins per field", async () => {
    const fromInput: unknown[] = [];
    const seen: unknown[] = [];
    const { fetch, calls } = makeFetch([
      { status: 202, body: BATCH_ACCEPTED },
      { body: PROCESSING },
    ]);
    const rows = await new Lenz({ apiKey: "lenz_t", fetch }).verifyBatchAndWait(
      { claims: [{ claim: "a" }], timeoutMs: 60_000, onProgress: (id) => fromInput.push(id) },
      { timeoutMs: 0, onProgress: (id) => seen.push(id) },
    );
    expect(rows.map((r) => r.status)).toEqual(["timeout"]);
    expect(calls).toHaveLength(2);
    expect(seen).toEqual(["t1"]);
    expect(fromInput).toEqual([]);
  });

  it("still submits through this.verifyBatch, handing it the input as given", async () => {
    const handed: unknown[] = [];
    class Fake extends Lenz {
      override async verifyBatch(input: Parameters<Lenz["verifyBatch"]>[0]) {
        handed.push(input);
        return super.verifyBatch(input);
      }
    }
    const { fetch } = makeFetch([{ status: 202, body: BATCH_ACCEPTED }, { body: COMPLETED }]);
    const input = { claims: [{ claim: "a" }], idempotencyKey: "k" };
    await new Fake({ apiKey: "lenz_t", fetch }).verifyBatchAndWait(input, { timeoutMs: 60_000 });
    expect(handed).toEqual([input]);
  });
});

describe("types", () => {
  it("WaitOptions is the second argument of every verification wait", () => {
    const opts: WaitOptions = { timeoutMs: 1, onProgress: () => undefined };
    const client = new Lenz({
      apiKey: "lenz_t",
      fetch: (() => undefined) as unknown as typeof fetch,
    });
    // Compile-time only: never called.
    const calls = [
      () => client.wait("t", opts),
      () => client.verifyAndWait({ claim: "a" }, opts),
      () => client.verifyBatchAndWait({ claims: [] }, opts),
      // The 2.x forms still compile.
      () => client.verifyAndWait({ claim: "a", timeoutMs: 1, onProgress: () => undefined }),
      () => client.verifyBatchAndWait({ claims: [], timeoutMs: 1, onProgress: () => undefined }),
    ];
    expect(calls).toHaveLength(5);
  });
});
