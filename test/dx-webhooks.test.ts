/**
 * 3.0 webhook typing (B7): `eventId` on every event, from both payload
 * shapes, and the `isEvent` guard, which narrows only when the event name
 * AND the parsed member it promises are both there.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  LenzWebhooks,
  isEvent,
  type Citecheck,
  type Coverage,
  type ReviewFull,
  type TaskStatus,
  type Verification,
  type WebhookEvent,
} from "../src/index.js";

const SECRET = "whsec_test_abc123";
const hooks = new LenzWebhooks({ secret: SECRET, replayWindowSeconds: 1e12 });
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shapes");

function parse(payload: unknown): WebhookEvent {
  const body = Buffer.from(JSON.stringify(payload));
  const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return hooks.parse(body, { "X-Lenz-Signature": sig });
}

function recorded(shape: "canonical" | "legacy", name: string): Record<string, unknown> {
  const file = JSON.parse(readFileSync(join(ROOT, shape, `${name}.json`), "utf-8")) as {
    payload: Record<string, unknown>;
  };
  return file.payload;
}

const KINDS = [
  ["webhook__verification_completed", "verification.completed"],
  ["webhook__verification_failed_not_a_claim", "verification.failed"],
  ["webhook__verification_needs_input_multi_claim", "verification.needs_input"],
  ["webhook__review_completed", "review.completed"],
  ["webhook__review_failed", "review.failed"],
  ["webhook__citecheck_completed", "citecheck.completed"],
  ["webhook__citecheck_failed", "citecheck.failed"],
] as const;

describe("B7: eventId", () => {
  it.each(KINDS)("%s: from the newer shape's event_id", (name) => {
    const payload = recorded("canonical", name);
    expect(parse(payload).eventId).toBe(payload["event_id"]);
    expect(parse(payload).eventId).toMatch(/^evt_/);
  });

  it.each(KINDS)("%s: from the original shape, when it carries one", (name) => {
    const payload = recorded("legacy", name);
    expect(parse(payload).eventId).toBe(payload["event_id"] ?? undefined);
  });

  it("certificate.timestamped and unknown events carry it too", () => {
    const cert = recorded("canonical", "webhook__certificate_timestamped");
    expect(parse(cert).eventId).toBe(cert["event_id"]);
    expect(parse({ event: "something.new", event_id: "evt_1" }).eventId).toBe("evt_1");
    expect("eventId" in parse({ event: "something.new" })).toBe(false);
    expect(parse({ event: "something.new", event_id: 42 }).eventId).toBeUndefined();
  });

  it("is typed optional on the base event", () => {
    expectTypeOf<WebhookEvent["eventId"]>().toEqualTypeOf<string | undefined>();
  });
});

describe("B7: isEvent", () => {
  it.each(KINDS)("%s narrows on both payload shapes", (name, kind) => {
    for (const shape of ["canonical", "legacy"] as const) {
      const event = parse(recorded(shape, name));
      expect(isEvent(event, kind)).toBe(true);
      for (const [, other] of KINDS) {
        if (other !== kind) expect(isEvent(event, other)).toBe(false);
      }
    }
  });

  it("certificate.timestamped narrows", () => {
    const event = parse(recorded("canonical", "webhook__certificate_timestamped"));
    expect(isEvent(event, "certificate.timestamped")).toBe(true);
    if (isEvent(event, "certificate.timestamped")) {
      expectTypeOf(event.coverage).toEqualTypeOf<Coverage>();
    }
  });

  it("narrows the types, with the promised member present", () => {
    const event = parse(recorded("canonical", "webhook__verification_completed"));
    if (isEvent(event, "verification.completed")) {
      expectTypeOf(event.verification).toEqualTypeOf<TaskStatus & { result: Verification }>();
      expect(event.verification.result.verdict).toBe("False");
    } else {
      throw new Error("expected a verification.completed event");
    }
    const review = parse(recorded("canonical", "webhook__review_completed"));
    if (isEvent(review, "review.completed"))
      expectTypeOf(review.review).toEqualTypeOf<ReviewFull>();
    const check = parse(recorded("canonical", "webhook__citecheck_failed"));
    if (isEvent(check, "citecheck.failed"))
      expectTypeOf(check.citecheck).toEqualTypeOf<Citecheck>();
  });

  it.each([
    [{ event: "verification.completed" }, "verification.completed"],
    [{ event: "verification.completed", verification: "x" }, "verification.completed"],
    [{ event: "verification.completed", result: [] }, "verification.completed"],
    [{ event: "verification.failed", verification: null }, "verification.failed"],
    [{ event: "verification.needs_input", needs_input: "x" }, "verification.needs_input"],
    [{ event: "review.completed", review: "x" }, "review.completed"],
    [{ event: "review.failed" }, "review.failed"],
    [{ event: "citecheck.completed", citecheck: [] }, "citecheck.completed"],
    [{ event: "certificate.timestamped" }, "certificate.timestamped"],
    [{ event: "certificate.timestamped", coverage: "x" }, "certificate.timestamped"],
  ] as const)("a malformed recognised event never narrows: %j", (payload, kind) => {
    expect(isEvent(parse(payload), kind)).toBe(false);
  });

  it("an unknown event never narrows to a known kind", () => {
    const event = parse({ event: "something.new", verification: { status: "completed" } });
    for (const [, kind] of KINDS) expect(isEvent(event, kind)).toBe(false);
  });
});

describe("N2: isEvent narrows only when the narrowed type's members are there", () => {
  const ALL = [...KINDS.map(([, k]) => k), "certificate.timestamped"] as const;

  it("an empty object never narrows", () => {
    const event = parse({});
    for (const kind of ALL) expect(isEvent(event, kind)).toBe(false);
  });

  const V = { task_id: "t1" };
  it.each([
    // wrong nested status for the kind
    [
      "verification.completed",
      { verification: { ...V, status: "failed", result: { verdict: "True" } } },
    ],
    ["verification.completed", { verification: { ...V, status: "processing", result: {} } }],
    ["verification.failed", { verification: { ...V, status: "completed" } }],
    ["verification.needs_input", { verification: { ...V, status: "failed" } }],
    // wrong types
    ["verification.completed", { verification: { ...V, status: 7, result: {} } }],
    ["verification.completed", { verification: { status: "completed", task_id: 7, result: {} } }],
    ["verification.completed", { verification: { status: "completed", result: {} } }],
    ["verification.completed", { verification: { ...V, status: "completed", result: "x" } }],
    ["verification.completed", { verification: { ...V, status: "completed" } }],
    ["verification.failed", { verification: { ...V } }],
    // a review without the members ReviewFull requires
    ["review.completed", { review: {} }],
    ["review.completed", { review: { review_id: "r", status: "completed", issues: "x" } }],
    [
      "review.failed",
      {
        review: {
          review_id: "r",
          status: 3,
          issues: [],
          failures: [],
          claims: [],
          summary: {},
          credits: {},
        },
      },
    ],
    // a citation check without the members Citecheck requires
    ["citecheck.completed", { citecheck: {} }],
    ["citecheck.failed", { citecheck: { citecheck_id: "c", status: "failed" } }],
  ] as const)("%s with %j does not narrow", (kind, extra) => {
    expect(isEvent(parse({ event: kind, ...extra }), kind)).toBe(false);
  });

  it("a minimal well-formed event of each kind narrows", () => {
    expect(
      isEvent(
        parse({
          event: "verification.completed",
          verification: { ...V, status: "completed", result: {} },
        }),
        "verification.completed",
      ),
    ).toBe(true);
    expect(
      isEvent(
        parse({ event: "verification.failed", verification: { ...V, status: "failed" } }),
        "verification.failed",
      ),
    ).toBe(true);
    const review = {
      review_id: "r",
      status: "completed",
      issues: [],
      failures: [],
      claims: [],
      summary: {},
      credits: {},
    };
    expect(isEvent(parse({ event: "review.completed", review }), "review.completed")).toBe(true);
    const citecheck = { citecheck_id: "c", status: "completed", summary: {}, credits: {} };
    const check = parse({ event: "citecheck.completed", citecheck });
    expect(isEvent(check, "citecheck.completed")).toBe(true);
    if (isEvent(check, "citecheck.completed")) expect(check.citecheck.citation_issues).toEqual([]);
  });

  it("the README receiver never throws on a minimal payload", () => {
    const handle = (event: WebhookEvent): number => {
      let seen = 0;
      if (isEvent(event, "verification.completed")) {
        seen += event.verification.result.verdict ? 1 : 0;
      } else if (isEvent(event, "verification.failed")) {
        seen += event.failure?.retryable ? 1 : 0;
      } else if (isEvent(event, "review.completed")) {
        for (const i of event.review.issues) seen += i.claim ? 1 : 0;
      } else if (isEvent(event, "citecheck.completed")) {
        seen += event.citecheck.citation_issues.length;
      }
      return seen;
    };
    for (const kind of ALL) {
      for (const member of [{}, { review: {} }, { citecheck: {} }, { verification: {} }]) {
        expect(() => handle(parse({ event: kind, ...member }))).not.toThrow();
      }
    }
  });
});
