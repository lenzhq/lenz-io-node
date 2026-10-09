/**
 * 3.0 waits: every poll goes through the public `getStatus` (N1), no poll
 * runs past the wait's deadline (S3), and in a batch a per-item answer stays
 * that item's while an account-wide one throws (S4).
 */

import { describe, expect, it, vi } from "vitest";

import {
  API_VERSION,
  Lenz,
  LenzApiVersionError,
  LenzAuthError,
  LenzNotFoundError,
  LenzTimeoutError,
  type TaskStatus,
} from "../src/index.js";

const COMPLETED = {
  status: "completed",
  result: {
    verification_id: "v1",
    verdict: { label: "True", score: 9, confidence: "high" },
  },
};
const PROCESSING = { status: "processing", progress: {} };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function settle(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (v) => v,
    (e: unknown) => e,
  );
}

const noFetch = (() => {
  throw new Error("the network must not be used");
}) as unknown as typeof fetch;

describe("N1: waits poll through the public getStatus", () => {
  class Fake extends Lenz {
    seen: Array<[string, unknown]> = [];
    override async getStatus(taskId: string, ...rest: unknown[]): Promise<TaskStatus> {
      this.seen.push([taskId, rest[0]]);
      return COMPLETED as unknown as TaskStatus;
    }
  }

  it("wait uses the override, and hands it the wait's budget", async () => {
    const client = new Fake({ apiKey: "lenz_t", fetch: noFetch });
    const v = await client.wait("t1", { timeoutMs: 60_000 });
    expect(v.verification_id).toBe("v1");
    expect(client.seen).toHaveLength(1);
    expect(client.seen[0]![0]).toBe("t1");
    const budget = client.seen[0]![1] as { timeoutMs: number; deadlineAt: number };
    expect(budget.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(budget.deadlineAt).toBeGreaterThan(Date.now());
    expect(budget.deadlineAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("verifyBatchAndWait uses the override for every item", async () => {
    const fetch = vi.fn(async () =>
      json(200, { batch_id: "b", items: [{ task_id: "a" }, { task_id: "b" }] }),
    ) as unknown as typeof globalThis.fetch;
    const client = new Fake({ apiKey: "lenz_t", fetch });
    const out = await client.verifyBatchAndWait({ claims: [{ claim: "a" }, { claim: "b" }] });
    expect(out.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(client.seen.map(([id]) => id).sort()).toEqual(["a", "b"]);
  });

  it("an override that never answers still ends at the wait's deadline", async () => {
    class Hangs extends Lenz {
      override getStatus(): Promise<TaskStatus> {
        return new Promise(() => {});
      }
    }
    vi.useFakeTimers();
    try {
      const client = new Hangs({ apiKey: "lenz_t", fetch: noFetch });
      let settled = false;
      const pending = settle(client.wait("t", { timeoutMs: 3_000 })).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(settled).toBe(true);
      expect(await pending).toBeInstanceOf(LenzTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("S3: no poll runs past the wait's deadline", () => {
  it("a hanging poll is cut at the deadline (no 5s floor past it)", async () => {
    let polls = 0;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      polls += 1;
      if (polls === 1) return Promise.resolve(json(200, PROCESSING));
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof globalThis.fetch;
    vi.useFakeTimers();
    try {
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      let settled = false;
      const pending = settle(client.wait("t", { timeoutMs: 3_000 })).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(settled).toBe(true);
      expect(await pending).toBeInstanceOf(LenzTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("once the budget is spent it stops polling and times the items out", async () => {
    const fetch = vi.fn(async () => json(200, PROCESSING)) as unknown as typeof globalThis.fetch;
    vi.useFakeTimers();
    try {
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const pending = settle(client.wait("t", { timeoutMs: 2_000 }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBeInstanceOf(LenzTimeoutError);
    } finally {
      vi.useRealTimers();
    }
    // One poll at 0; the 2 s sleep spends the budget, so none at 2 s.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("S4: per-item answers in a batch wait; account-wide ones throw", () => {
  function batchFetch(answer: (id: string) => Response) {
    return vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/verify/batch")) {
        return json(200, {
          batch_id: "b",
          items: [
            { task_id: "bad1", claim: "a" },
            { task_id: "ok1", claim: "b" },
          ],
        });
      }
      if (u.endsWith("/bad1")) return answer("bad1");
      return json(200, COMPLETED);
    }) as unknown as typeof globalThis.fetch;
  }

  it("another API version for one item: that item failed, the others continue", async () => {
    const fetch = batchFetch(() => json(200, PROCESSING, { "X-Lenz-API-Version": "2026-05-13" }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.verifyBatchAndWait({
      claims: [{ claim: "a" }, { claim: "b" }],
      timeoutMs: 60_000,
    });
    expect(out.map((r) => [r.task_id, r.status])).toEqual([
      ["bad1", "failed"],
      ["ok1", "completed"],
    ]);
    expect(API_VERSION).not.toBe("2026-05-13");
  });

  it("a 404 for one item: that item failed, the others continue", async () => {
    const client = new Lenz({
      apiKey: "lenz_t",
      fetch: batchFetch(() => json(404, { detail: "Not found." })),
    });
    const out = await client.verifyBatchAndWait({ claims: [{ claim: "a" }, { claim: "b" }] });
    expect(out.map((r) => r.status)).toEqual(["failed", "completed"]);
  });

  it.each([401, 403])("a %i throws from the batch wait", async (status) => {
    const client = new Lenz({
      apiKey: "lenz_t",
      fetch: batchFetch(() => json(status, { detail: "no" })),
    });
    const err = await settle(
      client.verifyBatchAndWait({ claims: [{ claim: "a" }, { claim: "b" }], timeoutMs: 60_000 }),
    );
    expect(err).toBeInstanceOf(LenzAuthError);
  });

  it("a single wait still throws a version error and a 404", async () => {
    const versioned = new Lenz({
      apiKey: "lenz_t",
      fetch: (async () =>
        json(200, PROCESSING, {
          "X-Lenz-API-Version": "2026-05-13",
        })) as unknown as typeof globalThis.fetch,
    });
    expect(await settle(versioned.wait("t", { timeoutMs: 60_000 }))).toBeInstanceOf(
      LenzApiVersionError,
    );
    const missing = new Lenz({
      apiKey: "lenz_t",
      fetch: (async () => json(404, { detail: "x" })) as unknown as typeof globalThis.fetch,
    });
    expect(await settle(missing.wait("t", { timeoutMs: 60_000 }))).toBeInstanceOf(
      LenzNotFoundError,
    );
  });
});
