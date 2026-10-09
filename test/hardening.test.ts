/**
 * Poll loops surface programming errors, review and citation-check keys are
 * never empty, and cancel answers are checked like the reads they mirror.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Lenz, LenzAPIError, type GetStatusOptions, type TaskStatus } from "../src/index.js";
import { countedController, header, recorder, settle } from "./support/recorder.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(HERE, "fixtures", "contract", name), "utf-8")) as Record<
    string,
    unknown
  >;

const REVIEW_ACCEPTED = fixture("review_accepted.json");
const REVIEW_ID = String(REVIEW_ACCEPTED["review_id"]);
const REVIEW_COMPLETED = fixture("review_completed.json");
const CITECHECK_ACCEPTED = fixture("citecheck_accepted.json");
const CITECHECK_ID = String(CITECHECK_ACCEPTED["citecheck_id"]);
const CITECHECK_COMPLETED = fixture("citecheck_completed.json");
const BATCH = {
  batch_id: "b1",
  items: [
    { task_id: "t1", claim: "a" },
    { task_id: "t2", claim: "b" },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a poll's programming error ends the wait at once", () => {
  class Broken extends Lenz {
    override async getStatus(): Promise<TaskStatus> {
      throw new TypeError(
        "Cannot read private member from an object whose class did not declare it",
      );
    }
  }

  it("wait", async () => {
    const c = new Broken({ apiKey: "lenz_t", fetch: vi.fn() as unknown as typeof fetch });
    const pending = settle(c.wait("t1", { timeoutMs: 600_000 }));
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(err).toBeInstanceOf(TypeError);
  });

  it("verifyBatchAndWait", async () => {
    const { fetch } = recorder([{ status: 202, body: BATCH }]);
    const c = new Broken({ apiKey: "lenz_t", fetch });
    const pending = settle(
      c.verifyBatchAndWait({ claims: [{ claim: "a" }, { claim: "b" }] }, { timeoutMs: 600_000 }),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeInstanceOf(TypeError);
  });

  it("reviewAndWait", async () => {
    const { fetch } = recorder([{ status: 202, body: REVIEW_ACCEPTED }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    (c as unknown as { _getReview: () => Promise<never> })._getReview = async () => {
      throw new TypeError("a bug");
    };
    const pending = settle(c.reviewAndWait({ text: "a" }, { timeoutMs: 600_000 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeInstanceOf(TypeError);
  });

  it("citecheckAndWait", async () => {
    const { fetch } = recorder([{ status: 202, body: CITECHECK_ACCEPTED }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    (c as unknown as { _readCitecheck: () => Promise<never> })._readCitecheck = async () => {
      throw new TypeError("a bug");
    };
    const pending = settle(c.citecheckAndWait({ text: "a" }, { timeoutMs: 600_000 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeInstanceOf(TypeError);
  });

  it("a body that breaks off or does not decode is still a failed poll", async () => {
    const dropped = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    const queue: Array<() => Response> = [
      () => new Response(JSON.stringify(REVIEW_ACCEPTED), { status: 202 }),
      () => new Response(dropped, { status: 200 }),
      () => new Response('{"review_id": "442b', { status: 200 }),
      () => new Response(JSON.stringify(REVIEW_COMPLETED), { status: 200 }),
    ];
    const fetch = vi.fn(async () => queue.shift()!()) as unknown as typeof globalThis.fetch;
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = settle(c.reviewAndWait({ text: "a" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ status: "completed" });
  });

  it("a verification poll whose body does not decode is still a failed poll", async () => {
    const queue: Array<() => Response> = [
      () => new Response("<html>502</html>", { status: 200 }),
      () =>
        new Response(JSON.stringify({ status: "completed", result: { verification_id: "v1" } }), {
          status: 200,
        }),
    ];
    const fetch = vi.fn(async () => queue.shift()!()) as unknown as typeof globalThis.fetch;
    const c = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const pending = settle(c.wait("t1"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ verification_id: "v1" });
  });
});

describe("an empty idempotencyKey on a review or citation check", () => {
  for (const [name, run, accepted] of [
    ["review", (c: Lenz) => c.review({ text: "a", idempotencyKey: "" }), REVIEW_ACCEPTED],
    ["citecheck", (c: Lenz) => c.citecheck({ text: "a", idempotencyKey: "" }), CITECHECK_ACCEPTED],
  ] as const) {
    it(`${name}: a key is minted, never an empty header`, async () => {
      const { fetch, sent } = recorder([{ status: 202, body: accepted }]);
      await run(new Lenz({ apiKey: "lenz_t", fetch }));
      expect(header(sent[0]!, "Idempotency-Key")).toMatch(/^[0-9a-f]{32}$/);
    });
  }
});

describe("cancel answers are checked", () => {
  it("cancel: another task's result is refused", async () => {
    const { fetch } = recorder([
      { body: { task_id: "other", cancelled: true, status: "cancelled" } },
    ]);
    const err = await settle(new Lenz({ apiKey: "lenz_t", fetch }).cancel("t1"));
    expect(err).toBeInstanceOf(LenzAPIError);
  });

  it("cancel: a result with no status is refused", async () => {
    const { fetch } = recorder([{ body: { task_id: "t1", cancelled: true } }]);
    const err = await settle(new Lenz({ apiKey: "lenz_t", fetch }).cancel("t1"));
    expect(err).toBeInstanceOf(LenzAPIError);
  });

  for (const [label, body] of [
    ["another review", { ...REVIEW_COMPLETED, review_id: "other" }],
    ["a body without its lists", { review_id: REVIEW_ID, status: "cancelled" }],
    ["a proxy page", {}],
  ] as const) {
    it(`cancelReview: ${label} is refused`, async () => {
      const { fetch } = recorder([{ body }]);
      const err = await settle(new Lenz({ apiKey: "lenz_t", fetch }).cancelReview(REVIEW_ID));
      expect(err).toBeInstanceOf(LenzAPIError);
    });
  }

  for (const [label, body] of [
    ["another check", { ...CITECHECK_COMPLETED, citecheck_id: "other" }],
    ["a body without its lists", { citecheck_id: CITECHECK_ID, status: "cancelled" }],
  ] as const) {
    it(`cancelCitecheck: ${label} is refused`, async () => {
      const { fetch } = recorder([{ body }]);
      const err = await settle(new Lenz({ apiKey: "lenz_t", fetch }).cancelCitecheck(CITECHECK_ID));
      expect(err).toBeInstanceOf(LenzAPIError);
    });
  }

  it("the full review and check are returned as before", async () => {
    const { fetch } = recorder([{ body: REVIEW_COMPLETED }, { body: CITECHECK_COMPLETED }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    expect((await c.cancelReview(REVIEW_ID)).review_id).toBe(REVIEW_ID);
    expect((await c.cancelCitecheck(CITECHECK_ID)).citecheck_id).toBe(CITECHECK_ID);
  });
});

describe("a transport failure that cannot be marked is still a failed poll", () => {
  const failing = (reason: unknown) => () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(reason);
        },
      }),
      { status: 200 },
    );

  for (const [label, reason] of [
    ["a frozen error", Object.freeze(new TypeError("terminated"))],
    ["a primitive", "boom"],
  ] as const) {
    it(`wait: a body that rejects with ${label}`, async () => {
      const queue: Array<() => Response> = [
        failing(reason),
        () =>
          new Response(JSON.stringify({ status: "completed", result: { verification_id: "v1" } }), {
            status: 200,
          }),
      ];
      const fetch = vi.fn(async () => queue.shift()!()) as unknown as typeof globalThis.fetch;
      const c = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const pending = settle(c.wait("t1"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await pending).toMatchObject({ verification_id: "v1" });
    });

    it(`reviewAndWait: a body that rejects with ${label}`, async () => {
      const queue: Array<() => Response> = [
        () => new Response(JSON.stringify(REVIEW_ACCEPTED), { status: 202 }),
        failing(reason),
        () => new Response(JSON.stringify(REVIEW_COMPLETED), { status: 200 }),
      ];
      const fetch = vi.fn(async () => queue.shift()!()) as unknown as typeof globalThis.fetch;
      const c = new Lenz({ apiKey: "lenz_t", fetch });
      const pending = settle(c.reviewAndWait({ text: "a" }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await pending).toMatchObject({ status: "completed" });
    });

    it(`a plain call still throws ${label} as it is`, async () => {
      const fetch = vi.fn(async () => failing(reason)()) as unknown as typeof globalThis.fetch;
      const c = new Lenz({ apiKey: "lenz_t", fetch });
      expect(await settle(c.usage())).toBe(reason);
    });
  }
});

describe("a batch wait ends on the first poll's programming error", () => {
  class OneBroken extends Lenz {
    override getStatus(taskId: string): Promise<TaskStatus> {
      if (taskId === "t1") return Promise.reject(new TypeError("a bug"));
      return new Promise(() => {}); // t2 never answers
    }
  }

  for (const timeoutMs of [200, 600_000]) {
    it(`with a ${timeoutMs} ms budget: the TypeError at once, nothing left behind`, async () => {
      const { fetch } = recorder([{ status: 202, body: BATCH }]);
      const c = new OneBroken({ apiKey: "lenz_t", fetch });
      const { controller, live } = countedController();
      let settled: unknown = "pending";
      const pending = c
        .verifyBatchAndWait(
          { claims: [{ claim: "a" }, { claim: "b" }] },
          { timeoutMs, signal: controller.signal },
        )
        .then(
          (v) => (settled = v),
          (e: unknown) => (settled = e),
        );
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBeInstanceOf(TypeError);
      await pending;
      expect(vi.getTimerCount()).toBe(0);
      expect(live()).toBe(0);
    });
  }
});

describe("a stated wait is capped at the longest a timer can hold", () => {
  for (const [label, reply] of [
    ["a 503's Retry-After header", { status: 503, headers: { "Retry-After": "1e300" } }],
    [
      "a 503's body",
      { status: 503, body: { detail: "busy", code: "capacity", retry_after: 1e300 } },
    ],
    ["a 429's Retry-After header", { status: 429, headers: { "Retry-After": "1e300" } }],
    ["a 429's body", { status: 429, body: { detail: "slow", reset_in_seconds: 1e300 } }],
  ] as const) {
    it(`${label}: retryAfter is 2,147,483 s`, async () => {
      const { fetch } = recorder([reply]);
      const c = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const err = (await settle(c.usage())) as { retryAfter: number | null };
      expect(err.retryAfter).toBe(2_147_483);
    });
  }

  it("a wait under the cap is kept as stated", async () => {
    const { fetch } = recorder([{ status: 503, headers: { "Retry-After": "120" } }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    expect(((await settle(c.usage())) as { retryAfter: number }).retryAfter).toBe(120);
  });

  it("a 503 stating no usable wait keeps null; a 429 keeps 0", async () => {
    const { fetch } = recorder([
      { status: 503, headers: { "Retry-After": "soon" } },
      { status: 429, headers: { "Retry-After": "soon" } },
    ]);
    const c = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    expect(((await settle(c.usage())) as { retryAfter: unknown }).retryAfter).toBeNull();
    expect(((await settle(c.usage())) as { retryAfter: unknown }).retryAfter).toBe(0);
  });
});

describe("a wait's poll context reaches getStatus through overrides that copy options", () => {
  const html = () => new Response("<html>502</html>", { status: 200 });
  const done = () =>
    new Response(JSON.stringify({ status: "completed", result: { verification_id: "v1" } }), {
      status: 200,
    });

  class Forwarding extends Lenz {
    seen: unknown[] = [];
    override getStatus(taskId: string, options?: GetStatusOptions): Promise<TaskStatus> {
      this.seen.push(Object.getOwnPropertySymbols(options ?? {}));
      return super.getStatus(taskId, { ...options });
    }
  }

  it("an override forwarding { ...options }: a malformed poll is still retried", async () => {
    const queue = [html, done];
    const fetch = vi.fn(async () => queue.shift()!()) as unknown as typeof globalThis.fetch;
    const c = new Forwarding({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const pending = settle(c.wait("t1"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ verification_id: "v1" });
  });

  it("an override finds no hidden symbol on the options", async () => {
    const fetch = vi.fn(async () => done()) as unknown as typeof globalThis.fetch;
    const c = new Forwarding({ apiKey: "lenz_t", fetch });
    await c.wait("t1");
    expect(c.seen).toEqual([[]]);
  });

  it("a plain getStatus during a wait still throws the runtime's own error", async () => {
    let n = 0;
    const fetch = vi.fn(async (u: string | URL | Request) => {
      if (String(u).endsWith("/plain")) return html();
      return n++ === 0 ? html() : done();
    }) as unknown as typeof globalThis.fetch;
    const c = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const waiting = settle(c.wait("t1"));
    const plain = await settle(c.getStatus("plain"));
    expect(plain).toBeInstanceOf(SyntaxError);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await waiting).toMatchObject({ verification_id: "v1" });
  });

  it("a batch's fatal poll stops the others through a copying override", async () => {
    class Copying extends Lenz {
      override getStatus(taskId: string, options?: GetStatusOptions): Promise<TaskStatus> {
        if (taskId === "t1") return Promise.reject(new TypeError("a bug"));
        return super.getStatus(taskId, { ...options });
      }
    }
    const { fetch, aborts } = recorder([{ status: 202, body: BATCH }], { hang: true });
    const c = new Copying({ apiKey: "lenz_t", fetch });
    let settled: unknown = "pending";
    const pending = c
      .verifyBatchAndWait({ claims: [{ claim: "a" }, { claim: "b" }] }, { timeoutMs: 600_000 })
      .then(
        (v) => (settled = v),
        (e: unknown) => (settled = e),
      );
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBeInstanceOf(TypeError);
    await pending;
    // t2's request was aborted, not left to its 30 s timer.
    expect(aborts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
