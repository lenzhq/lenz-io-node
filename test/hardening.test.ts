/**
 * Poll loops surface programming errors, review and citation-check keys are
 * never empty, and cancel answers are checked like the reads they mirror.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Lenz, LenzAPIError, type TaskStatus } from "../src/index.js";
import { header, recorder, settle } from "./support/recorder.js";

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
