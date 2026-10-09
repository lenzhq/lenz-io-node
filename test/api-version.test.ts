/**
 * 3.0 asks for the newer response shape; the cases the recorded responses
 * (`two-x-values.test.ts`) do not reach.
 */

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  API_VERSION,
  Lenz,
  LenzError,
  LenzWebhooks,
  LenzRateLimitError,
  LenzValidationError,
  mapResponseToError,
} from "../src/index.js";
import { normalizeReview } from "../src/compat.js";

function client(status: number, body: unknown): Lenz {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  return new Lenz({ apiKey: "lenz_test", fetch: fetchImpl, maxRetries: 0 });
}

async function thrown(call: () => Promise<unknown>): Promise<LenzError> {
  try {
    await call();
  } catch (exc) {
    return exc as LenzError;
  }
  throw new Error("expected an error");
}

describe("errors keep their 2.x fields", () => {
  it("a code the 2.x error did not carry reads as empty; the body is as sent", async () => {
    const body = { detail: "Not found.", code: "not_found" };
    const err = await thrown(() => client(404, body).verifications.get("v"));
    expect(err.code).toBe("");
    expect(err.body).toEqual(body);
  });

  it("the same code on /reviews/{id} is kept: 2.x had it there", async () => {
    const err = await thrown(() =>
      client(404, { detail: "Not found.", code: "not_found" }).getReview("r"),
    );
    expect(err.code).toBe("not_found");
  });

  it("a schema error reads as 2.x did: the field items, 'Validation failed'", async () => {
    const item = { loc: ["body", "payload", "text"], msg: "Field required", type: "missing" };
    const err = await thrown(() =>
      client(422, {
        detail: "text: Field required",
        code: "validation_error",
        errors: [item],
      }).verify({ claim: "x" }),
    );
    expect(err).toBeInstanceOf(LenzValidationError);
    expect(err.message).toBe("Validation failed");
    expect(err.code).toBe("");
    expect((err as LenzValidationError).errors).toEqual([
      { type: "missing", loc: ["body", "payload", "text"], msg: "Field required" },
    ]);
  });

  it.each([
    [500, "internal_error"],
    [400, "invalid_request"],
  ])("a %s with the fallback code %s reads code '' (2.x had none)", async (status, code) => {
    const body = { detail: "Something went wrong.", code };
    const err = await thrown(() => client(status, body).verify({ claim: "x" }));
    expect(err.code).toBe("");
    expect(err.body).toEqual(body);
  });

  it("a batch item's unsupported language names its item, as 2.x did", async () => {
    const msg = "Unsupported language 'xx'. Supported: en, es.";
    const err = await thrown(() =>
      client(422, {
        detail: msg,
        code: "unsupported_language",
        errors: [{ loc: ["body", "claims", 1, "language"], msg, type: "unsupported_language" }],
      }).verifyBatch({ claims: [{ claim: "a" }, { claim: "b", language: "xx" }] }),
    );
    expect(err.message).toBe(`claims[1].${msg}`);
    expect(err.code).toBe("");
    expect((err as LenzValidationError).errors).toEqual([]);
  });

  it("the daily /extract limit's wait reads as resetInSeconds", async () => {
    const err = await thrown(() =>
      client(429, {
        detail: "Daily limit.",
        code: "extract_daily_limit",
        limit: 1000,
        retry_after: 3600,
        docs_url: "https://lenz.io/docs/errors#rate-limits",
      }).extract({ text: "x" }),
    );
    expect(err).toBeInstanceOf(LenzRateLimitError);
    expect((err as LenzRateLimitError).resetInSeconds).toBe(3600);
    expect((err as LenzRateLimitError).retryAfter).toBe(3600);
  });

  it("without the call it answered, a body is read as sent (as 2.x read it)", () => {
    const err = mapResponseToError(404, JSON.stringify({ detail: "x", code: "not_found" }));
    expect(err.code).toBe("not_found");
  });
});

describe("a review's failed deep check", () => {
  it("reads not_a_claim, the word verifications used", () => {
    const failure = {
      code: "no_checkable_claim",
      detail: "No claim in the input could be checked.",
      hint: null,
      failure_class: "invalid_input",
      retryable: false,
      docs_url: "https://lenz.io/docs/errors#invalid-input",
    };
    const out = normalizeReview({
      claims: [{ index: 0, verification: { status: "failed", failure } }],
      issues: [{ claim_index: 0, failure }],
      failures: [
        { stage: "verification", claim_index: 0, failure },
        { stage: "assessment", claim_index: 0, failure },
      ],
    }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out["claims"][0].verification.failure.failure_reason).toBe("not_a_claim");
    expect(out["issues"][0].failure.failure_reason).toBe("not_a_claim");
    expect(out["failures"][0].failure.failure_reason).toBe("not_a_claim");
    expect(out["failures"][1].failure.failure_reason).toBe("no_claim");
  });
});

describe("2.x values outside the recordings", () => {
  it("a failed poll reads one fixed 2.x sentence per code", async () => {
    const status = await client(200, {
      status: "failed",
      task_id: "t",
      failure: {
        code: "task_error",
        detail: "The check stopped on an error on our side.",
        hint: null,
        failure_class: "upstream_unavailable",
        retryable: true,
        docs_url: "https://lenz.io/docs/errors",
      },
    }).getStatus("t");
    expect(status.error).toBe("Pipeline failed.");
    expect(status.failure_reason).toBe("task_error");
  });

  it("API_VERSION is typed string", () => {
    const v: string = API_VERSION;
    expect(v).toBe("2026-10-11");
  });

  it("verification.completed with result: null gives {}, as 2.20 did", () => {
    const raw = JSON.stringify({
      event: "verification.completed",
      task_id: "t",
      status: "completed",
      result: null,
      attempt: 1,
    });
    const sig = "sha256=" + createHmac("sha256", "s").update(raw).digest("hex");
    const ev = new LenzWebhooks({ secret: "s" }).parse(raw, { "X-Lenz-Signature": sig });
    expect((ev as { result?: unknown }).result).toEqual({});
  });
});
