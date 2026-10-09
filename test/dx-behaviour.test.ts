/**
 * 3.0 developer-experience behaviour: automatic idempotency on batch submit
 * and ask (A1), the transport / not-found error classes and `retryable` (A2),
 * waits that stop on a permanent error (A2b) and the silent-by-default
 * `logger` option (A5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Lenz,
  LenzAPIError,
  LenzApiVersionError,
  LenzAuthError,
  LenzConnectionError,
  LenzError,
  LenzNotFoundError,
  LenzPipelineError,
  LenzQuotaExceededError,
  LenzRequestTimeoutError,
  LenzTimeoutError,
  LenzUpstreamUnavailableError,
  mapResponseToError,
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
const sent = (c: FetchCall) => JSON.parse(String(c.init.body)) as unknown;

const BATCH_BODY = { batch_id: "b", items: [{ task_id: "t1", claim: "a" }] };
const ASK_BODY = { role: "expert", content: "Because.", created_at: "2026-10-11T00:00:00Z" };
const COMPLETED = {
  status: "completed",
  result: {
    verification_id: "v1",
    verdict: { label: "True", score: 9, confidence: "high" },
  },
};
const IN_FLIGHT_409 = {
  status: 409,
  body: { detail: "A request with this key is still running.", code: "idempotency_conflict" },
};

async function settle(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (v) => v,
    (e: unknown) => e,
  );
}

// ── A1 ────────────────────────────────────────────────────────────────────

describe("A1: verifyBatch and ask.send send an Idempotency-Key by default", () => {
  const cases = [
    {
      name: "verifyBatch",
      body: BATCH_BODY,
      call: (client: Lenz, extra: Record<string, unknown> = {}) =>
        client.verifyBatch({ claims: [{ claim: "a" }], ...extra }),
      wire: { claims: [{ text: "a", source_url: "" }] },
    },
    {
      name: "ask.send",
      body: ASK_BODY,
      call: (client: Lenz, extra: Record<string, unknown> = {}) =>
        client.ask.send("vid_1", { message: "Why?", ...extra }),
      wire: { message: "Why?" },
    },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: a fresh random key per call, the body unchanged`, async () => {
      const { fetch, calls } = makeFetch([{ body: c.body }, { body: c.body }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await c.call(client);
      await c.call(client);
      expect(key(calls[0]!)).toMatch(/^[0-9a-f]{32}$/);
      expect(key(calls[1]!)).toMatch(/^[0-9a-f]{32}$/);
      expect(key(calls[1]!)).not.toBe(key(calls[0]!));
      expect(sent(calls[0]!)).toEqual(c.wire);
      expect(sent(calls[1]!)).toEqual(c.wire);
    });

    it(`${c.name}: the same key on every retry attempt, and the replay is returned`, async () => {
      const { fetch, calls } = makeFetch([
        { status: 500, body: { detail: "boom" } },
        { status: 503, body: { detail: "down" } },
        { body: c.body },
      ]);
      vi.useFakeTimers();
      try {
        const client = new Lenz({ apiKey: "lenz_t", fetch });
        const pending = c.call(client);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await pending).toMatchObject(c.name === "ask.send" ? ASK_BODY : { batch_id: "b" });
      } finally {
        vi.useRealTimers();
      }
      expect(calls).toHaveLength(3);
      expect(key(calls[0]!)).toBeTruthy();
      expect(key(calls[1]!)).toBe(key(calls[0]!));
      expect(key(calls[2]!)).toBe(key(calls[0]!));
    });

    it(`${c.name}: an in-flight 409 keeps the key (never a second one), then the same key succeeds`, async () => {
      const { fetch, calls } = makeFetch([
        { status: 500, body: { detail: "boom" } },
        IN_FLIGHT_409,
        { body: c.body },
      ]);
      vi.useFakeTimers();
      let err: unknown;
      try {
        const client = new Lenz({ apiKey: "lenz_t", fetch });
        const pending = settle(c.call(client, { idempotencyKey: "caller-key" }));
        await vi.advanceTimersByTimeAsync(10_000);
        err = await pending;
        await c.call(client, { idempotencyKey: "caller-key" });
      } finally {
        vi.useRealTimers();
      }
      expect(err).toBeInstanceOf(LenzError);
      expect((err as LenzError).statusCode).toBe(409);
      expect((err as LenzError).body?.["code"]).toBe("idempotency_conflict");
      expect(calls.map(key)).toEqual(["caller-key", "caller-key", "caller-key"]);
    });

    it(`${c.name}: a caller key passes through; idempotency: false sends none`, async () => {
      const { fetch, calls } = makeFetch([{ body: c.body }, { body: c.body }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await c.call(client, { idempotencyKey: "pinned-1" });
      await c.call(client, { idempotency: false });
      expect(key(calls[0]!)).toBe("pinned-1");
      expect(key(calls[1]!)).toBeNull();
      expect(sent(calls[0]!)).toEqual(c.wire);
      expect(sent(calls[1]!)).toEqual(c.wire);
    });
  }

  it("verifyBatchAndWait sends one key for the submit", async () => {
    const { fetch, calls } = makeFetch([{ body: BATCH_BODY }, { body: COMPLETED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatchAndWait({ claims: [{ claim: "a" }] });
    expect(key(calls[0]!)).toMatch(/^[0-9a-f]{32}$/);
    expect(key(calls[1]!)).toBeNull();
  });

  it("a per-item idempotency_key is still not sent (it never was)", async () => {
    const { fetch, calls } = makeFetch([{ body: BATCH_BODY }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({ claims: [{ claim: "a", idempotency_key: "item" }] });
    expect(sent(calls[0]!)).toEqual({ claims: [{ text: "a", source_url: "" }] });
    expect(key(calls[0]!)).not.toBe("item");
  });
});

// ── A2 ────────────────────────────────────────────────────────────────────

describe("A2: error classes", () => {
  it("404 → LenzNotFoundError, a LenzError (not an API error), fix says check the id", () => {
    const err = mapResponseToError(404, JSON.stringify({ detail: "Not found." }), {
      "X-Request-ID": "rq",
    });
    expect(err).toBeInstanceOf(LenzNotFoundError);
    expect(err).toBeInstanceOf(LenzError);
    expect(err).not.toBeInstanceOf(LenzAPIError);
    expect(err.name).toBe("LenzNotFoundError");
    expect(err.message).toBe("Not found.");
    expect(err.statusCode).toBe(404);
    expect(err.fix).toBe(
      "Check the id or key the call names: nothing with it is visible to this credential. Retrying will not help.",
    );
    expect(err.retryable).toBe(false);
  });

  it("a 404 with no detail keeps its 2.x message", () => {
    expect(mapResponseToError(404, "", {}).message).toBe("HTTP 404");
  });

  it("a network failure → LenzConnectionError (a LenzAPIError), native cause kept", async () => {
    const boom = new TypeError("fetch failed");
    const fetch = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof globalThis.fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await settle(client.getStatus("t"))) as LenzConnectionError;
    expect(err).toBeInstanceOf(LenzConnectionError);
    expect(err).toBeInstanceOf(LenzAPIError);
    expect(err).not.toBeInstanceOf(LenzRequestTimeoutError);
    expect(err.name).toBe("LenzConnectionError");
    expect(err.cause).toBe(boom);
    expect(err.cause_).toBe("TypeError: fetch failed");
    expect(err.message).toBe(
      "GET /verify/status/t failed after 1 attempts: TypeError: fetch failed",
    );
    expect(err.retryable).toBe(true);
  });

  it("a transport timeout → LenzRequestTimeoutError with a readable message", async () => {
    const fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("This operation was aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof globalThis.fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, timeoutMs: 20 });
    const err = (await settle(client.getStatus("t"))) as LenzRequestTimeoutError;
    expect(err).toBeInstanceOf(LenzRequestTimeoutError);
    expect(err).toBeInstanceOf(LenzConnectionError);
    expect(err).toBeInstanceOf(LenzAPIError);
    expect(err).not.toBeInstanceOf(LenzTimeoutError);
    expect(err.message).toBe("GET /verify/status/t timed out after 20ms (1 attempt).");
    expect(err.message).not.toContain("AbortError");
    expect((err.cause as Error).name).toBe("AbortError");
    expect(err.retryable).toBe(true);
  });

  it("a body that stalls past the timeout → LenzRequestTimeoutError", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, timeoutMs: 20 });
    const err = await settle(client.getStatus("t"));
    expect(err).toBeInstanceOf(LenzRequestTimeoutError);
    expect((err as LenzError).message).toBe(
      "GET /verify/status/t timed out reading the response body",
    );
  });

  it.each([
    [429, {}, true],
    [500, {}, true],
    [502, {}, true],
    [503, { code: "upstream_unavailable" }, true],
    [400, {}, false],
    [401, {}, false],
    [402, { code: "no_credits" }, false],
    [403, {}, false],
    [404, {}, false],
    [409, { code: "idempotency_conflict" }, false],
    [422, { detail: [] }, false],
  ])("retryable is derived from the status: %i → %s", (status, extra, expected) => {
    const err = mapResponseToError(status, JSON.stringify({ detail: "x", ...extra }), {});
    expect(err.retryable).toBe(expected);
  });

  it("a boolean retryable in the body's failure block wins", () => {
    const failure = { code: "x", retryable: false };
    expect(mapResponseToError(503, JSON.stringify({ detail: "x", failure }), {}).retryable).toBe(
      false,
    );
    expect(
      mapResponseToError(400, JSON.stringify({ detail: "x", retryable: true }), {}).retryable,
    ).toBe(true);
    expect(
      mapResponseToError(400, JSON.stringify({ detail: "x", retryable: "yes" }), {}).retryable,
    ).toBe(false);
  });

  it("a pipeline failure keeps the server's value: null when unstated", () => {
    expect(new LenzPipelineError().retryable).toBeNull();
    const failed = mapResponseToError(
      409,
      JSON.stringify({ detail: "x", code: "verification_failed", failure_reason: "x" }),
      {},
    );
    expect(failed).toBeInstanceOf(LenzPipelineError);
    expect(failed.retryable).toBeNull();
  });

  it("retryable is a plain field: null with no status, settable, set at construction", () => {
    expect(new LenzError().retryable).toBeNull();
    expect(new LenzTimeoutError().retryable).toBeNull();
    expect(new LenzError({ statusCode: 500 }).retryable).toBe(true);
    expect(new LenzError({ statusCode: 418 }).retryable).toBe(false);
    expect(new LenzError({ statusCode: 500, retryable: false }).retryable).toBe(false);
    const err = new LenzError();
    err.retryable = true;
    expect(err.retryable).toBe(true);
    expect(Object.getOwnPropertyDescriptor(err, "retryable")).toMatchObject({ value: true });
  });

  it("subclasses keep their own derivation", () => {
    expect(new LenzQuotaExceededError({ statusCode: 402 }).retryable).toBe(false);
    expect(new LenzUpstreamUnavailableError({ statusCode: 503 }).retryable).toBe(true);
    expect(new LenzConnectionError().retryable).toBe(true);
    expect(new LenzRequestTimeoutError().retryable).toBe(true);
    expect(new LenzApiVersionError({ statusCode: 200 }).retryable).toBe(false);
    expect(new LenzApiVersionError({ statusCode: 503 }).retryable).toBe(false);
  });

  it("an answer in another API version is not retryable", async () => {
    const { fetch } = makeFetch([
      { status: 500, body: { detail: "x" }, headers: { "X-Lenz-API-Version": "2026-05-13" } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = await settle(client.getStatus("t"));
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect((err as LenzError).retryable).toBe(false);
  });
});

// ── A2b ───────────────────────────────────────────────────────────────────

describe("A2b: waits stop at once on a permanent error", () => {
  const PROCESSING = { body: { status: "processing", progress: {} } };

  it.each([
    [401, LenzAuthError],
    [403, LenzAuthError],
    [404, LenzNotFoundError],
  ])("wait: a %i mid-wait throws at once", async (status, cls) => {
    const { fetch, calls } = makeFetch([
      PROCESSING,
      { status, body: { detail: "no" } },
      { body: COMPLETED },
    ]);
    vi.useFakeTimers();
    try {
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const pending = settle(client.wait("t", { timeoutMs: 60_000 }));
      await vi.advanceTimersByTimeAsync(5_000);
      const err = await pending;
      expect(err).toBeInstanceOf(cls);
      expect(err).not.toBeInstanceOf(LenzTimeoutError);
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toHaveLength(2);
  });

  it("verifyAndWait: a 404 on the first poll throws it", async () => {
    const { fetch, calls } = makeFetch([
      { body: { task_id: "t", claim: "a" } },
      { status: 404, body: { detail: "Not found." } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = await settle(client.verifyAndWait({ claim: "a", timeoutMs: 60_000 }));
    expect(err).toBeInstanceOf(LenzNotFoundError);
    expect(calls).toHaveLength(2);
  });

  it("wait keeps polling through a 5xx and a network drop", async () => {
    let n = 0;
    const fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new TypeError("fetch failed");
      if (n === 2) {
        return new Response(JSON.stringify({ detail: "x" }), { status: 500 });
      }
      return new Response(JSON.stringify(COMPLETED), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    vi.useFakeTimers();
    try {
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const pending = client.wait("t", { timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await pending).verification_id).toBe("v1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("batch: an item that answers 404 fails at once, the others continue", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (u.endsWith("/verify/batch")) {
        return json(200, {
          batch_id: "b",
          items: [
            { task_id: "gone1", claim: "a" },
            { task_id: "ok1", claim: "b" },
          ],
        });
      }
      if (u.endsWith("/gone1")) return json(404, { detail: "Not found." });
      return json(200, COMPLETED);
    }) as unknown as typeof globalThis.fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.verifyBatchAndWait({
      claims: [{ claim: "a" }, { claim: "b" }],
      timeoutMs: 60_000,
    });
    expect(out.map((r) => [r.task_id, r.status])).toEqual([
      ["gone1", "failed"],
      ["ok1", "completed"],
    ]);
    expect(out[0]!.status_detail).toBeUndefined();
    const polls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) =>
      String(c[0]).endsWith("/gone1"),
    );
    expect(polls).toHaveLength(1);
  });

  it("a slow final poll is cut at the deadline, not the client's 30s timeout", async () => {
    let polls = 0;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      polls += 1;
      if (polls === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: "processing", progress: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof globalThis.fetch;
    vi.useFakeTimers();
    try {
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      let settled = false;
      const pending = settle(client.wait("t", { timeoutMs: 10_000 })).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(16_000);
      expect(settled).toBe(true);
      const err = await pending;
      expect(err).toBeInstanceOf(LenzTimeoutError);
      expect((err as LenzTimeoutError).taskId).toBe("t");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── A5 ────────────────────────────────────────────────────────────────────

describe("A5: no console output unless a logger is given", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verifyAndWait prints nothing by default", async () => {
    const { fetch } = makeFetch([{ body: { task_id: "t9", claim: "a" } }, { body: COMPLETED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyAndWait({ claim: "a" });
    expect(info).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("the submitted task id goes to logger.info", async () => {
    const { fetch } = makeFetch([{ body: { task_id: "t9", claim: "a" } }, { body: COMPLETED }]);
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    const client = new Lenz({ apiKey: "lenz_t", fetch, logger });
    await client.verifyAndWait({ claim: "a" });
    expect(logger.info).toHaveBeenCalledWith("[lenz-io] Submitted task: t9");
    expect(info).not.toHaveBeenCalled();
  });

  it("a logger without info is fine; console stays quiet", async () => {
    const { fetch } = makeFetch([{ body: { task_id: "t9", claim: "a" } }, { body: COMPLETED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch, logger: { warn: vi.fn() } });
    await client.verifyAndWait({ claim: "a" });
    expect(info).not.toHaveBeenCalled();
  });

  it("a retry is told to logger.debug", async () => {
    const { fetch } = makeFetch([{ status: 500, body: { detail: "x" } }, { body: COMPLETED }]);
    const logger = { debug: vi.fn() };
    vi.useFakeTimers();
    try {
      const client = new Lenz({ apiKey: "lenz_t", fetch, logger });
      const pending = client.getStatus("t");
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(logger.debug).toHaveBeenCalledWith(
      "[lenz-io] Retrying GET /verify/status/t after HTTP 500 in 1000ms (attempt 2 of 4)",
    );
  });

  it("a logger that throws never breaks the call", async () => {
    const { fetch } = makeFetch([{ body: { task_id: "t9", claim: "a" } }, { body: COMPLETED }]);
    const logger = {
      info: () => {
        throw new Error("logger bug");
      },
    };
    const client = new Lenz({ apiKey: "lenz_t", fetch, logger });
    expect((await client.verifyAndWait({ claim: "a" })).verification_id).toBe("v1");
  });
});
