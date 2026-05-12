import { describe, expect, it } from "vitest";

import {
  LenzAPIError,
  LenzAuthError,
  LenzError,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzValidationError,
  mapResponseToError,
} from "../src/errors.js";

function body(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("mapResponseToError", () => {
  it("401 → LenzAuthError with requestId", () => {
    const e = mapResponseToError(401, body({ detail: "bad key" }), { "X-Request-ID": "rq1" });
    expect(e).toBeInstanceOf(LenzAuthError);
    expect(e.requestId).toBe("rq1");
    expect(e.docUrl).toContain("/docs/auth");
    expect(e.statusCode).toBe(401);
  });

  it("403 → LenzAuthError", () => {
    expect(mapResponseToError(403, body({ detail: "forbidden" }), {})).toBeInstanceOf(LenzAuthError);
  });

  it("402 → LenzQuotaExceededError with creditsRemaining", () => {
    const e = mapResponseToError(402, body({ detail: "out of credits", credits_remaining: 0 }), {});
    expect(e).toBeInstanceOf(LenzQuotaExceededError);
    expect((e as LenzQuotaExceededError).creditsRemaining).toBe(0);
  });

  it("422 → LenzValidationError with errors", () => {
    const e = mapResponseToError(
      422,
      body({ detail: [{ loc: ["text"], msg: "required", type: "missing" }] }),
      {},
    );
    expect(e).toBeInstanceOf(LenzValidationError);
    expect((e as LenzValidationError).errors).toHaveLength(1);
  });

  it("429 → LenzRateLimitError honors Retry-After header", () => {
    const e = mapResponseToError(429, body({ detail: "slow down" }), { "Retry-After": "30" });
    expect(e).toBeInstanceOf(LenzRateLimitError);
    expect((e as LenzRateLimitError).retryAfter).toBe(30);
  });

  it("429 picks retry_after from body when header absent", () => {
    const e = mapResponseToError(429, body({ detail: "slow", retry_after: 12 }), {});
    expect(e).toBeInstanceOf(LenzRateLimitError);
    expect((e as LenzRateLimitError).retryAfter).toBe(12);
  });

  it("5xx → LenzAPIError", () => {
    expect(mapResponseToError(503, body({ detail: "unavailable" }), {})).toBeInstanceOf(
      LenzAPIError,
    );
  });

  it("unknown status falls through to base LenzError", () => {
    const e = mapResponseToError(418, body({ detail: "teapot" }), {});
    expect(e).toBeInstanceOf(LenzError);
    expect(e).not.toBeInstanceOf(LenzAuthError);
    expect(e).not.toBeInstanceOf(LenzAPIError);
  });

  it("malformed body does not explode", () => {
    const e = mapResponseToError(500, "not json {", {});
    expect(e).toBeInstanceOf(LenzAPIError);
    expect(e.message).toBeTruthy();
  });

  it("toString includes cause + fix + docs + request id", () => {
    const e = mapResponseToError(401, body({ detail: "bad key" }), { "X-Request-ID": "rq_abc" });
    const s = e.toString();
    expect(s).toContain("Cause:");
    expect(s).toContain("Fix:");
    expect(s).toContain("Docs:");
    expect(s).toContain("rq_abc");
  });
});

describe.each([
  [401, LenzAuthError],
  [403, LenzAuthError],
  [402, LenzQuotaExceededError],
  [422, LenzValidationError],
  [429, LenzRateLimitError],
  [500, LenzAPIError],
  [502, LenzAPIError],
  [503, LenzAPIError],
  [504, LenzAPIError],
] as const)("status %d → class", (status, cls) => {
  it(`maps to ${cls.name}`, () => {
    expect(mapResponseToError(status, "{}", {})).toBeInstanceOf(cls);
  });
});
