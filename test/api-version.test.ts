/**
 * 3.0 asks for the newer response shape; the cases the recorded responses
 * (`read-both-shapes.test.ts`) do not reach.
 */

import { describe, expect, it } from "vitest";

import {
  Lenz,
  LenzError,
  LenzRateLimitError,
  LenzValidationError,
  mapResponseToError,
} from "../src/index.js";
import { legacyErrorBody, normalizeReview } from "../src/compat.js";

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

  it("an original-shape body comes back unchanged", () => {
    const req = { method: "POST", path: "/assess" };
    const legacy = { detail: "claims[1] is blank.", code: "blank_item" };
    expect(legacyErrorBody(422, legacy, req)).toEqual(legacy);
    const review = {
      detail: "payload.text: Field required",
      code: "validation_error",
      errors: [{ loc: ["body", "payload", "text"], msg: "Field required" }],
    };
    expect(legacyErrorBody(422, review, { method: "POST", path: "/review" })).toEqual(review);
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
