/**
 * 3.0 idempotency on errors: an in-flight 409 is retried inside the call
 * with the same key and body (S1), every error of a keyed call carries its
 * key (S2), and `retryable` on the in-progress 409s (S6).
 */

import { describe, expect, it, vi } from "vitest";

import {
  Lenz,
  LenzAuthError,
  LenzConnectionError,
  LenzError,
  LenzRequestTimeoutError,
  LenzTimeoutError,
  LenzValidationError,
  mapResponseToError,
  type TaskStatus,
} from "../src/index.js";

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

const key = (c: FetchCall) => new Headers(c.init.headers).get("Idempotency-Key");

const CONFLICT = {
  status: 409,
  body: { detail: "A request with this key is still running.", code: "idempotency_conflict" },
};
const TASK = { task_id: "t1", status: "queued" };

async function settle(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (v) => v,
    (e: unknown) => e,
  );
}

async function withFakeTimers(ms: number, run: () => Promise<unknown>): Promise<unknown> {
  vi.useFakeTimers();
  try {
    const pending = settle(run());
    await vi.advanceTimersByTimeAsync(ms);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

describe("S1: an in-flight 409 is retried with the same key and body", () => {
  it("verify: retried until it answers, the key and body never change", async () => {
    const { fetch, calls } = makeFetch([CONFLICT, CONFLICT, { body: TASK }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await withFakeTimers(20_000, () => client.verify({ claim: "a" }));
    expect(out).toMatchObject({ task_id: "t1" });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(key)).size).toBe(1);
    expect(key(calls[0]!)).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(calls.map((c) => String(c.init.body))).size).toBe(1);
  });

  it("honours the stated Retry-After", async () => {
    const { fetch, calls } = makeFetch([
      { ...CONFLICT, headers: { "Retry-After": "7" } },
      { body: TASK },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    vi.useFakeTimers();
    try {
      const pending = settle(client.verify({ claim: "a" }));
      await vi.advanceTimersByTimeAsync(6_000);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls).toHaveLength(2);
      expect(await pending).toMatchObject({ task_id: "t1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still conflicting after the retries: the 2.x error, now retryable, with its key", async () => {
    const { fetch, calls } = makeFetch([CONFLICT, CONFLICT, CONFLICT, CONFLICT]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = (await withFakeTimers(20_000, () =>
      client.assess({ claim: "a", idempotencyKey: "pinned" }),
    )) as LenzError;
    expect(calls).toHaveLength(4);
    expect(err).toBeInstanceOf(LenzError);
    expect(err.constructor).toBe(LenzError);
    expect(err.statusCode).toBe(409);
    expect(err.body?.["code"]).toBe("idempotency_conflict");
    expect(err.message).toBe("A request with this key is still running.");
    expect(err.retryable).toBe(true);
    expect(err.idempotencyKey).toBe("pinned");
  });

  it("maxRetries bounds it", async () => {
    const { fetch, calls } = makeFetch([CONFLICT, { body: TASK }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await settle(client.verify({ claim: "a" }))) as LenzError;
    expect(calls).toHaveLength(1);
    expect(err.statusCode).toBe(409);
  });

  // Since 3.0 reviewAndWait's budget starts after the submit, so it no
  // longer cuts the submit's 409 retry (re-baselined from "the call's
  // deadline bounds it").
  it("reviewAndWait's submit is not cut by the wait's budget", async () => {
    const { fetch, calls } = makeFetch([
      { ...CONFLICT, headers: { "Retry-After": "30" } },
      { status: 202, body: { review_id: "r1", status: "queued" } },
      {
        body: {
          review_id: "r1",
          status: "completed",
          issues: [],
          failures: [],
          claims: [],
          poll_after_seconds: null,
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = (await withFakeTimers(60_000, () =>
      client.reviewAndWait({ text: "x" }, { timeoutMs: 10_000 }),
    )) as { status: string };
    expect(calls).toHaveLength(3);
    expect(out.status).toBe("completed");
  });

  it("a call that sent no key is not retried on a 409", async () => {
    const { fetch, calls } = makeFetch([CONFLICT, { body: TASK }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = (await settle(client.verify({ claim: "a", idempotency: false }))) as LenzError;
    expect(calls).toHaveLength(1);
    expect(err.statusCode).toBe(409);
    expect(err.idempotencyKey).toBeUndefined();
  });

  it("a review 409 naming its review is the receipt, not a retry", async () => {
    const { fetch, calls } = makeFetch([
      { status: 409, body: { ...CONFLICT.body, review_id: "r1" } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(await client.review({ text: "x" })).toEqual({ review_id: "r1", status: "queued" });
    expect(calls).toHaveLength(1);
  });
});

describe("S2: every error of a keyed call carries its key", () => {
  it("a 4xx on verify carries the generated key it sent", async () => {
    const { fetch, calls } = makeFetch([{ status: 422, body: { detail: "bad" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = (await settle(client.verify({ claim: "a" }))) as LenzError;
    expect(err).toBeInstanceOf(LenzValidationError);
    expect(err.idempotencyKey).toBe(key(calls[0]!));
  });

  it("a connection failure carries it, so the resend can reuse it", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await settle(client.ask.send("v", { message: "why?" }))) as LenzError;
    expect(err).toBeInstanceOf(LenzConnectionError);
    expect(err.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("a transport timeout carries it and says to resend with it", async () => {
    const fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof globalThis.fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, timeoutMs: 20 });
    const err = (await settle(
      client.extract({ text: "x", idempotencyKey: "mine", timeoutMs: 20 }),
    )) as LenzRequestTimeoutError;
    expect(err).toBeInstanceOf(LenzRequestTimeoutError);
    expect(err.idempotencyKey).toBe("mine");
    expect(err.fix).toContain("idempotencyKey: err.idempotencyKey");
  });

  it("a GET carries none", async () => {
    const { fetch } = makeFetch([{ status: 401, body: { detail: "no" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = (await settle(client.getStatus("t"))) as LenzError;
    expect(err).toBeInstanceOf(LenzAuthError);
    expect(err.idempotencyKey).toBeUndefined();
    expect(err.fix).not.toContain("idempotencyKey");
  });

  it("verifyAndWait: the wait's timeout carries the submit's key", async () => {
    const { fetch, calls } = makeFetch([
      { body: TASK },
      ...Array.from({ length: 20 }, () => ({ body: { status: "processing", progress: {} } })),
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = (await withFakeTimers(30_000, () =>
      client.verifyAndWait({ claim: "a", timeoutMs: 5_000 }),
    )) as LenzTimeoutError;
    expect(err).toBeInstanceOf(LenzTimeoutError);
    expect(err.idempotencyKey).toBe(key(calls[0]!));
  });

  it("reviewAndWait and citecheckAndWait: a poll's error carries the submit's key", async () => {
    for (const run of [
      (c: Lenz) => c.reviewAndWait({ text: "x", idempotencyKey: "rk" }),
      (c: Lenz) => c.citecheckAndWait({ text: "x", idempotencyKey: "rk" }),
    ]) {
      const { fetch } = makeFetch([
        { status: 202, body: { review_id: "r1", citecheck_id: "r1", status: "queued" } },
        { status: 404, body: { detail: "gone" } },
      ]);
      const err = (await settle(run(new Lenz({ apiKey: "lenz_t", fetch })))) as LenzError;
      expect(err.statusCode).toBe(404);
      expect(err.idempotencyKey).toBe("rk");
    }
  });

  it("verifyBatchAndWait: an error carries the batch's key", async () => {
    const { fetch, calls } = makeFetch([{ status: 402, body: { detail: "no credits" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = (await settle(
      client.verifyBatchAndWait({ claims: [{ claim: "a" }] }),
    )) as LenzError;
    expect(err.idempotencyKey).toBe(key(calls[0]!));
  });

  it("an error built by hand has none", () => {
    expect(new LenzError().idempotencyKey).toBeUndefined();
    expect(mapResponseToError(500, "{}").idempotencyKey).toBeUndefined();
  });
});

describe("S6: retryable", () => {
  it("true for the two in-progress 409s, false for another", () => {
    const of = (code: string) =>
      mapResponseToError(409, JSON.stringify({ detail: "x", code }), {}).retryable;
    expect(of("verification_not_ready")).toBe(true);
    expect(of("idempotency_conflict")).toBe(true);
    expect(of("nothing_pending")).toBe(false);
  });

  it("connection classes true, other errors with no status null", () => {
    expect(new LenzConnectionError().retryable).toBe(true);
    expect(new LenzRequestTimeoutError().retryable).toBe(true);
    expect(new LenzTimeoutError().retryable).toBeNull();
    expect(new LenzError().retryable).toBeNull();
  });
});

describe("a body that breaks off after the headers keeps the key", () => {
  function brokenBody(status: number) {
    return vi.fn(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"role":'));
          controller.error(new TypeError("terminated"));
        },
      });
      return new Response(stream, { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
  }

  it("a 2xx: the same error as 2.21 (not a LenzError), carrying the key", async () => {
    const client = new Lenz({ apiKey: "lenz_t", fetch: brokenBody(200) });
    const err = (await settle(
      client.ask.send("v", { message: "why?", idempotencyKey: "ask-1" }),
    )) as Error & { idempotencyKey?: string };
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(LenzError);
    expect(err.idempotencyKey).toBe("ask-1");
  });

  it("an error status: the same, carrying the key", async () => {
    const client = new Lenz({ apiKey: "lenz_t", fetch: brokenBody(422) });
    const err = (await settle(client.verify({ claim: "a", idempotencyKey: "v-1" }))) as Error & {
      idempotencyKey?: string;
    };
    expect(err).toBeInstanceOf(TypeError);
    expect(err.idempotencyKey).toBe("v-1");
  });

  it("a GET's broken body carries none", async () => {
    const client = new Lenz({ apiKey: "lenz_t", fetch: brokenBody(200) });
    const err = (await settle(client.getStatus("t"))) as Error & { idempotencyKey?: string };
    expect(err).toBeInstanceOf(TypeError);
    expect("idempotencyKey" in err).toBe(false);
  });
});

describe("verifyBatchAndWait submits through the public verifyBatch, as 2.21 did", () => {
  class Fake extends Lenz {
    inputs: Array<Record<string, unknown>> = [];
    override async verifyBatch(input: Parameters<Lenz["verifyBatch"]>[0]) {
      this.inputs.push(input as unknown as Record<string, unknown>);
      return { batch_id: "b", items: [{ task_id: "t1", claim: "a" }] } as Awaited<
        ReturnType<Lenz["verifyBatch"]>
      >;
    }
    override async getStatus(): Promise<TaskStatus> {
      return { status: "completed", result: { verification_id: "v1" } } as TaskStatus;
    }
  }
  const noFetch = (() => {
    throw new Error("the network must not be used");
  }) as unknown as typeof fetch;

  it("the override is used, with the call's generated key forwarded", async () => {
    const client = new Fake({ apiKey: "lenz_t", fetch: noFetch });
    const out = await client.verifyBatchAndWait({ claims: [{ claim: "a" }] });
    expect(out[0]!.status).toBe("completed");
    expect(client.inputs).toHaveLength(1);
    expect(client.inputs[0]!["idempotencyKey"]).toMatch(/^[0-9a-f]{32}$/);
    expect(client.inputs[0]!["claims"]).toEqual([{ claim: "a" }]);
  });

  it("a caller key and the opt-out reach the override unchanged", async () => {
    const client = new Fake({ apiKey: "lenz_t", fetch: noFetch });
    await client.verifyBatchAndWait({ claims: [{ claim: "a" }], idempotencyKey: "mine" });
    await client.verifyBatchAndWait({ claims: [{ claim: "a" }], idempotency: false });
    expect(client.inputs[0]!["idempotencyKey"]).toBe("mine");
    expect(client.inputs[1]!["idempotency"]).toBe(false);
    expect(client.inputs[1]!["idempotencyKey"]).toBeUndefined();
  });
});

describe("the generated Idempotency-Key without crypto.randomUUID", () => {
  it("falls back to a v4 UUID from getRandomValues", async () => {
    const real = globalThis.crypto;
    const stub = { getRandomValues: real.getRandomValues.bind(real) };
    vi.stubGlobal("crypto", stub);
    try {
      const { fetch, calls } = makeFetch([{ status: 202, body: { task_id: "t1" } }]);
      const client = new Lenz({ apiKey: "lenz_test", fetch, maxRetries: 0 });
      await client.verify({ claim: "x" });
      const k = key(calls[0]!);
      expect(k).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
