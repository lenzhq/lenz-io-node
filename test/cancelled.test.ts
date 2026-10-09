/**
 * A task cancelled elsewhere (the website's Stop button, another process).
 *
 * In API version 2026-10-11 `cancelled` is its own terminal status; in the
 * original shape the same thing is `failed` with `failure_class: "cancelled"`.
 * Every wait must end on it the way it ends on the original `failed` (the same
 * errors, with failure class `cancelled`), instead of polling to its deadline,
 * and the three `*.cancelled` webhook events are typed.
 *
 * Responses are the API's own recordings (`fixtures/shapes/canonical/`,
 * imported by `scripts/import-shapes.mjs`).
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  CitecheckFailedError,
  Lenz,
  LenzPipelineError,
  LenzTimeoutError,
  LenzWebhooks,
  ReviewFailedError,
  isEvent,
  type Citecheck,
  type CitecheckStatus,
  type ReviewFull,
  type ReviewStatus,
  type TaskStatus,
  type WebhookEvent,
} from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shapes");

function recorded(shape: "canonical" | "legacy", name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, shape, `${name}.json`), "utf-8")) as Record<
    string,
    unknown
  >;
}

function bodyOf(name: string): Record<string, unknown> {
  return recorded("canonical", name)["body"] as Record<string, unknown>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers by path: the submit with `accepted`, every poll with `poll`. */
function serving(routes: Array<[RegExp, () => Response]>): typeof fetch {
  return (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    for (const [re, answer] of routes) if (re.test(path)) return answer();
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;
}

const client = (fetch: typeof globalThis.fetch) =>
  new Lenz({ apiKey: "lenz_test", fetch, maxRetries: 0 });

const STATUS_CASES = ["verify__status_cancelled_live", "verify__status_cancelled_durable"] as const;

describe("a cancelled verification", () => {
  it.each(STATUS_CASES)("%s: getStatus returns the cancelled status, no throw", async (name) => {
    const body = bodyOf(name);
    const status = await client(serving([[/verify\/status/, () => json(200, body)]])).getStatus(
      "t",
    );
    expect(status.status).toBe("cancelled");
    expect(status.task_id).toBe(body["task_id"]);
  });

  it("the cancelled status carries the 2.x flat fields a failed one did (durable)", async () => {
    const body = bodyOf("verify__status_cancelled_durable");
    const oracle = JSON.parse(
      readFileSync(join(ROOT, "oracle", "verify__status_cancelled_durable.json"), "utf-8"),
    ) as { getStatus: { value: Record<string, unknown> } };
    const status = await client(serving([[/verify\/status/, () => json(200, body)]])).getStatus(
      "t",
    );
    // What 2.21 read for the same task, with the status, and the failure
    // block 2.21 built for a run cancelled while it was running.
    expect(status).toEqual({
      ...oracle.getStatus.value,
      status: "cancelled",
      failure: {
        code: "cancelled",
        detail: "Cancelled.",
        hint: null,
        failure_class: "cancelled",
        retryable: false,
        docs_url: "https://lenz.io/docs/errors#cancelled",
        failure_reason: "cancelled",
      },
    });
    expect(status.failure?.code).toBe("cancelled");
    expect(status.retryable).toBe(false);
    expect(status.failure_class).toBe("cancelled");
  });

  it.each(STATUS_CASES)("%s: wait throws the failed error at once", async (name) => {
    const fetch = vi.fn(serving([[/verify\/status/, () => json(200, bodyOf(name))]]));
    const started = Date.now();
    const err = (await client(fetch)
      .wait("t1", { timeoutMs: 60_000 })
      .catch((e: unknown) => e)) as LenzPipelineError;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(LenzPipelineError);
    expect(err).not.toBeInstanceOf(LenzTimeoutError);
    expect(err.taskId).toBe("t1");
    expect(err.failureClass).toBe("cancelled");
    expect(err.failureReason).toBe("cancelled");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("Pipeline failed: Cancelled.");
    expect(err.docUrl).toBe("https://lenz.io/docs/errors");
  });

  it("verifyAndWait ends on a task cancelled after it was accepted", async () => {
    const fetch = serving([
      [/\/verify$/, () => json(202, { task_id: "t9", status: "processing" })],
      [/verify\/status/, () => json(200, bodyOf("verify__status_cancelled_live"))],
    ]);
    const err = (await client(fetch)
      .verifyAndWait({ claim: "x" }, { timeoutMs: 60_000 })
      .catch((e: unknown) => e)) as LenzPipelineError;
    expect(err).toBeInstanceOf(LenzPipelineError);
    expect(err.failureClass).toBe("cancelled");
    expect(err.retryable).toBe(false);
  });

  it("verifyBatchAndWait: the cancelled item is a failed item, the others are untouched", async () => {
    const completed = {
      status: "completed",
      task_id: "b",
      result: { verification_id: "v1", verdict: { label: "True", score: 9, confidence: "high" } },
    };
    const c = client(
      serving([
        [
          /verify\/batch$/,
          () =>
            json(202, {
              batch_id: "bt",
              items: [
                { task_id: "a", claim: "one" },
                { task_id: "b", claim: "two" },
              ],
            }),
        ],
        [/verify\/status\/a$/, () => json(200, bodyOf("verify__status_cancelled_live"))],
        [/verify\/status\/b$/, () => json(200, completed)],
      ]),
    );
    const started = Date.now();
    const out = await c.verifyBatchAndWait(
      { claims: [{ claim: "one" }, { claim: "two" }] },
      { timeoutMs: 60_000 },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.map((r) => r.status)).toEqual(["failed", "completed"]);
    expect(out[0]!.task_id).toBe("a");
    // The full status, so code that resubmits unless `retryable === false` keeps working.
    expect(out[0]!.status_detail).toEqual({
      status: "cancelled",
      task_id: bodyOf("verify__status_cancelled_live")["task_id"],
      error: "Cancelled.",
      failure_reason: "cancelled",
      failure_class: "cancelled",
      retryable: false,
      docs_url: "https://lenz.io/docs/errors#cancelled",
      failure: {
        code: "cancelled",
        detail: "Cancelled.",
        hint: null,
        failure_class: "cancelled",
        retryable: false,
        docs_url: "https://lenz.io/docs/errors#cancelled",
        failure_reason: "cancelled",
      },
    });
    expect(out[0]!.verification).toBeUndefined();
  });

  it("the status type carries cancelled", () => {
    expectTypeOf<TaskStatus["status"]>().toEqualTypeOf<
      "processing" | "needs_input" | "completed" | "failed" | "cancelled"
    >();
  });
});

describe("a cancelled review", () => {
  const body = bodyOf("review__get_cancelled");
  const serve = () =>
    serving([
      [/\/review$/, () => json(202, { review_id: body["review_id"], status: "queued" })],
      [/\/reviews\//, () => json(200, body)],
    ]);

  it("getReview returns it, no throw", async () => {
    const review = await client(serve()).getReview(String(body["review_id"]));
    expect(review.status).toBe("cancelled");
  });

  it("reviewAndWait throws the failed error with failure class cancelled", async () => {
    const started = Date.now();
    const err = (await client(serve())
      .reviewAndWait({ text: "x" }, { timeoutMs: 60_000 })
      .catch((e: unknown) => e)) as ReviewFailedError;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err).toBeInstanceOf(ReviewFailedError);
    expect(err).toBeInstanceOf(LenzPipelineError);
    expect(err.failureClass).toBe("cancelled");
    expect(err.failureReason).toBe("cancelled");
    expect(err.errorCode).toBe("cancelled");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(`Review ${String(body["review_id"])} failed: cancelled`);
    expect(err.review.status).toBe("cancelled");
  });

  it("the status type carries cancelled", () => {
    expectTypeOf<ReviewStatus>().toEqualTypeOf<
      "queued" | "assessing" | "verifying" | "completed" | "failed" | "cancelled"
    >();
    expectTypeOf<ReviewFull["status"]>().toEqualTypeOf<ReviewStatus>();
  });
});

describe("a cancelled citation check", () => {
  const body = bodyOf("citecheck__get_cancelled");
  const serve = () =>
    serving([
      [/\/citecheck$/, () => json(202, { citecheck_id: body["citecheck_id"], status: "queued" })],
      [/\/citechecks\//, () => json(200, body)],
    ]);

  it("getCitecheck returns it, no throw", async () => {
    const check = await client(serve()).getCitecheck(String(body["citecheck_id"]));
    expect(check.status).toBe("cancelled");
  });

  it("citecheckAndWait throws the failed error with failure class cancelled", async () => {
    const started = Date.now();
    const err = (await client(serve())
      .citecheckAndWait({ text: "x" }, { timeoutMs: 60_000 })
      .catch((e: unknown) => e)) as CitecheckFailedError;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err).toBeInstanceOf(CitecheckFailedError);
    expect(err).toBeInstanceOf(LenzPipelineError);
    expect(err.failureClass).toBe("cancelled");
    expect(err.failureReason).toBe("cancelled");
    expect(err.errorCode).toBe("cancelled");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(`Citation check ${String(body["citecheck_id"])} failed: cancelled`);
    expect(err.citecheck.status).toBe("cancelled");
  });

  it("the status type carries cancelled", () => {
    expectTypeOf<CitecheckStatus>().toEqualTypeOf<
      "queued" | "checking" | "completed" | "failed" | "cancelled"
    >();
    expectTypeOf<Citecheck["status"]>().toEqualTypeOf<CitecheckStatus>();
  });
});

const SECRET = "whsec_test_cancelled";
const hooks = new LenzWebhooks({ secret: SECRET, replayWindowSeconds: 1e12 });

function parse(payload: unknown): WebhookEvent {
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  return hooks.parse(raw, { "X-Lenz-Signature": sig });
}

function payloadOf(shape: "canonical" | "legacy", name: string): Record<string, unknown> {
  return recorded(shape, name)["payload"] as Record<string, unknown>;
}

const CANCELLED = [
  ["webhook__verification_cancelled", "verification.cancelled"],
  ["webhook__review_cancelled", "review.cancelled"],
  ["webhook__citecheck_cancelled", "citecheck.cancelled"],
] as const;

const OTHERS = [
  "verification.completed",
  "verification.failed",
  "verification.needs_input",
  "review.completed",
  "review.failed",
  "citecheck.completed",
  "citecheck.failed",
  "certificate.timestamped",
] as const;

describe("*.cancelled webhook events", () => {
  it.each(CANCELLED)("%s parses and narrows as %s", (name, kind) => {
    const payload = payloadOf("canonical", name);
    const event = parse(payload);
    expect(event.event).toBe(kind);
    expect(event.status).toBe("cancelled");
    expect(event.eventId).toBe(payload["event_id"]);
    expect(event.eventId).toMatch(/^evt_/);
    expect(isEvent(event, kind)).toBe(true);
    for (const other of OTHERS) expect(isEvent(event, other)).toBe(false);
  });

  it("a verification.cancelled carries the cancelled verification", () => {
    const payload = payloadOf("canonical", "webhook__verification_cancelled");
    const event = parse(payload);
    if (!isEvent(event, "verification.cancelled")) throw new Error("expected the event");
    expectTypeOf(event.verification).toEqualTypeOf<TaskStatus>();
    expect(event.verification.status).toBe("cancelled");
    expect(event.taskId).toBe(payload["task_id"]);
    expect(event.verification.task_id).toBe(payload["task_id"]);
    expect(event.verification.failure_class).toBe("cancelled");
    expect(event.verification.retryable).toBe(false);
  });

  it("a review.cancelled carries the whole review", () => {
    const payload = payloadOf("canonical", "webhook__review_cancelled");
    const event = parse(payload);
    if (!isEvent(event, "review.cancelled")) throw new Error("expected the event");
    expectTypeOf(event.review).toEqualTypeOf<ReviewFull>();
    expect(event.reviewId).toBe(payload["review_id"]);
    expect(event.review.status).toBe("cancelled");
    expect(event.review.review_id).toBe(payload["review_id"]);
  });

  it("a citecheck.cancelled carries the whole check", () => {
    const payload = payloadOf("canonical", "webhook__citecheck_cancelled");
    const event = parse(payload);
    if (!isEvent(event, "citecheck.cancelled")) throw new Error("expected the event");
    expectTypeOf(event.citecheck).toEqualTypeOf<Citecheck>();
    expect(event.citecheckId).toBe(payload["citecheck_id"]);
    expect(event.citecheck.status).toBe("cancelled");
  });

  it.each([
    [{ event: "verification.cancelled" }, "verification.cancelled"],
    [{ event: "verification.cancelled", verification: "x" }, "verification.cancelled"],
    [{ event: "verification.cancelled", task_id: "t" }, "verification.cancelled"],
    [
      { event: "verification.cancelled", verification: { status: "failed", task_id: "t" } },
      "verification.cancelled",
    ],
    [
      { event: "verification.cancelled", verification: { status: "cancelled" } },
      "verification.cancelled",
    ],
    [{ event: "review.cancelled" }, "review.cancelled"],
    [{ event: "review.cancelled", review: "x" }, "review.cancelled"],
    [
      { event: "review.cancelled", review: { review_id: "r", status: "cancelled" } },
      "review.cancelled",
    ],
    [{ event: "citecheck.cancelled", citecheck: [] }, "citecheck.cancelled"],
    [
      { event: "citecheck.cancelled", citecheck: { citecheck_id: "c", status: "cancelled" } },
      "citecheck.cancelled",
    ],
  ] as const)("a malformed recognised event never narrows: %j", (payload, kind) => {
    expect(isEvent(parse(payload), kind)).toBe(false);
  });

  it.each(CANCELLED)("%s: a nested status that is not the event's never narrows", (name, kind) => {
    const noun = kind.split(".")[0]!;
    if (noun === "verification") return;
    const payload = payloadOf("canonical", name);
    for (const status of ["banana", "completed", "failed", 7]) {
      const nested = { ...(payload[noun] as Record<string, unknown>), status };
      expect(isEvent(parse({ ...payload, [noun]: nested }), kind)).toBe(false);
    }
  });

  it.each([
    ["webhook__review_completed", "review.completed", "review"],
    ["webhook__review_failed", "review.failed", "review"],
    ["webhook__citecheck_completed", "citecheck.completed", "citecheck"],
    ["webhook__citecheck_failed", "citecheck.failed", "citecheck"],
  ] as const)("%s: a mismatched nested status never narrows", (name, kind, noun) => {
    for (const shape of ["canonical", "legacy"] as const) {
      const payload = payloadOf(shape, name);
      expect(isEvent(parse(payload), kind)).toBe(true);
      for (const status of [
        "banana",
        "cancelled",
        kind.endsWith("failed") ? "completed" : "failed",
      ]) {
        const nested = { ...(payload[noun] as Record<string, unknown>), status };
        expect(isEvent(parse({ ...payload, [noun]: nested }), kind)).toBe(false);
      }
    }
  });

  it("a minimal well-formed verification.cancelled narrows", () => {
    const event = parse({
      event: "verification.cancelled",
      verification: { status: "cancelled", task_id: "t1" },
    });
    expect(isEvent(event, "verification.cancelled")).toBe(true);
    expect(event.taskId).toBe("t1");
  });

  it("the original shape's cancellation keeps arriving as *.failed and parses as before", () => {
    for (const [name, kind] of [
      ["webhook__verification_cancelled", "verification.failed"],
      ["webhook__review_cancelled", "review.failed"],
      ["webhook__citecheck_cancelled", "citecheck.failed"],
    ] as const) {
      const event = parse(payloadOf("legacy", name));
      expect(event.event).toBe(kind);
      expect(isEvent(event, kind)).toBe(true);
      expect(isEvent(event, kind.replace("failed", "cancelled") as "review.cancelled")).toBe(false);
    }
    const failed = parse(payloadOf("legacy", "webhook__verification_cancelled"));
    if (!isEvent(failed, "verification.failed")) throw new Error("expected the event");
    expect(failed.failureClass).toBe("cancelled");
    expect(failed.retryable).toBe(false);
  });

  it("an unknown event still parses as the base shape", () => {
    const event = parse({ event: "something.cancelled", event_id: "evt_1" });
    expect(event.event).toBe("something.cancelled");
    expect(event.eventId).toBe("evt_1");
    for (const [, kind] of CANCELLED) expect(isEvent(event, kind)).toBe(false);
  });
});
