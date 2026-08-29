import { describe, expect, it, vi } from "vitest";

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
    expect(mapResponseToError(403, body({ detail: "forbidden" }), {})).toBeInstanceOf(
      LenzAuthError,
    );
  });

  it("402 → LenzQuotaExceededError with the full envelope", () => {
    const e = mapResponseToError(
      402,
      body({
        detail: "No remaining claim checks.",
        code: "no_credits",
        upgrade_url: "https://lenz.io/plans",
        remaining: 0,
        resets_at: "2026-09-01T00:00:00+00:00",
      }),
      {},
    ) as LenzQuotaExceededError;
    expect(e).toBeInstanceOf(LenzQuotaExceededError);
    expect(e.code).toBe("no_credits");
    expect(e.upgradeUrl).toBe("https://lenz.io/plans");
    expect(e.remaining).toBe(0);
    expect(e.resetsAt).toBe("2026-09-01T00:00:00+00:00");
    // Not an auth error — the whole point of the 402 migration.
    expect(e).not.toBeInstanceOf(LenzAuthError);
  });

  it("402 remaining is null when the server omits it", () => {
    // null, not 0. The server omits rather than nulls precisely so "unknown"
    // stays distinguishable from "empty".
    const e = mapResponseToError(
      402,
      body({ detail: "out", code: "no_credits" }),
      {},
    ) as LenzQuotaExceededError;
    expect(e.remaining).toBeNull();
    expect(e.resetsAt).toBeNull();
    expect(e.requested).toBeNull();
    expect(e.creditBalance).toBeNull();
    expect(e.cost).toBeNull();
  });

  it("402 reports the pool balance and the call's cost in credits", () => {
    // The point of the pair: "you hold 4 credits, this costs 10" is a
    // different message from "you hold nothing".
    const e = mapResponseToError(
      402,
      body({
        detail: "out",
        code: "no_credits",
        remaining: 0,
        credits_remaining: 4,
        cost: 10,
      }),
      {},
    ) as LenzQuotaExceededError;
    expect(e.creditBalance).toBe(4);
    expect(e.cost).toBe(10);
    // `remaining` stays in the capability's own unit — 4 credits is zero
    // verifications — and the deprecated `creditsRemaining` keeps aliasing
    // THAT, not the pool. Same-named wire field, different quantity: wiring
    // `credits_remaining` into the alias would have changed its unit under
    // everyone still reading it.
    expect(e.remaining).toBe(0);
    // Reset the once-per-process latch so the warning is observable here
    // regardless of which test touched the alias first.
    (LenzQuotaExceededError as unknown as { warnedCreditsRemaining: boolean })[
      "warnedCreditsRemaining"
    ] = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(e.creditsRemaining).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain("deprecated");
    } finally {
      warn.mockRestore();
    }
  });

  it("402 cost scales with a rejected batch", () => {
    const e = mapResponseToError(
      402,
      body({
        detail: "batch too big",
        code: "no_credits",
        remaining: 3,
        requested: 5,
        credits_remaining: 30,
        cost: 50,
      }),
      {},
    ) as LenzQuotaExceededError;
    expect(e.remaining).toBe(3); // verifications
    expect(e.requested).toBe(5); // verifications
    expect(e.creditBalance).toBe(30); // credits
    expect(e.cost).toBe(50); // credits
  });

  it("402 cost is depth-aware for a rejected low-depth verify", () => {
    // A rejected `depth: "low"` verify reports 5, not the standard 10. `cost`
    // is what the server would actually have charged, so a client must read
    // it rather than multiplying `requested` by a price it assumed. The
    // charge follows the depth REQUESTED — a `low` request the server could
    // have answered from a cached `standard` verdict is still priced at low.
    const e = mapResponseToError(
      402,
      body({
        detail: "out",
        code: "no_credits",
        remaining: 0,
        requested: 1,
        credits_remaining: 4,
        cost: 5,
      }),
      {},
    ) as LenzQuotaExceededError;
    expect(e.cost).toBe(5);
    expect(e.creditBalance).toBe(4);
    // 4 credits cannot buy even the half-price call — the whole point of
    // publishing both numbers.
    expect(e.cost!).toBeGreaterThan(e.creditBalance!);
  });

  it("402 cost for a mixed-depth batch is the real summed total", () => {
    // Three standard (30) + two low (10) = 40, which is neither 5 * 10 nor
    // 5 * 5. Deriving the cost from `requested` is wrong in both directions.
    const e = mapResponseToError(
      402,
      body({
        detail: "batch too big",
        code: "no_credits",
        remaining: 2,
        requested: 5,
        credits_remaining: 25,
        cost: 40,
      }),
      {},
    ) as LenzQuotaExceededError;
    expect(e.cost).toBe(40);
    expect(e.cost).not.toBe(e.requested! * 10);
    expect(e.cost).not.toBe(e.requested! * 5);
  });

  it("402 echoes requested for a batch shortfall", () => {
    const e = mapResponseToError(
      402,
      body({ detail: "batch too big", code: "no_credits", requested: 5, remaining: 2 }),
      {},
    ) as LenzQuotaExceededError;
    expect(e.requested).toBe(5);
    expect(e.remaining).toBe(2);
  });

  it("creditsRemaining still reads, flattening unknown to 0", () => {
    const e = mapResponseToError(402, body({ detail: "out" }), {}) as LenzQuotaExceededError;
    expect(e.remaining).toBeNull();
    expect(e.creditsRemaining).toBe(0); // documents the ambiguity `remaining` fixes
  });

  it("creditsRemaining is still writable", () => {
    // 2.7.0 is a MINOR. ESM is always strict, so a getter with no setter
    // makes `err.creditsRemaining = 5` throw TypeError on upgrade.
    const e = mapResponseToError(402, body({ detail: "out" }), {}) as LenzQuotaExceededError;
    expect(() => {
      e.creditsRemaining = 5;
    }).not.toThrow();
    expect(e.remaining).toBe(5);
  });

  it("blank strings are unknown, not zero", () => {
    // Number(" ") === 0 in JS — an untrimmed check would report a
    // whitespace-only balance as "empty" rather than "unreported".
    const e = mapResponseToError(
      402,
      body({ detail: "out", remaining: "  " }),
      {},
    ) as LenzQuotaExceededError;
    expect(e.remaining).toBeNull();
  });

  it("malformed code and upgrade_url do not stringify", () => {
    const e = mapResponseToError(
      402,
      body({ detail: "out", code: 42, upgrade_url: { a: 1 } }),
      {},
    ) as LenzQuotaExceededError;
    expect(e.code).toBe("");
    expect(e.upgradeUrl).toBe("");
  });

  it("403 stays an auth error even carrying a quota code", () => {
    // Quota is 402 and only 402 — there is deliberately no 403 fallback.
    const e = mapResponseToError(403, body({ detail: "out", code: "no_credits" }), {});
    expect(e).toBeInstanceOf(LenzAuthError);
    expect(e).not.toBeInstanceOf(LenzQuotaExceededError);
    expect(e.code).toBe("no_credits"); // still surfaced for inspection
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

  it("429 reads reset_in_seconds — the key the server actually sends", () => {
    // `retry_after` in the body was an SDK invention the server never emitted.
    const e = mapResponseToError(
      429,
      body({
        detail: "capped",
        code: "extract_daily_limit",
        limit: 1000,
        reset_in_seconds: 7200,
      }),
      {},
    ) as LenzRateLimitError;
    expect(e.retryAfter).toBe(7200);
    expect(e.resetInSeconds).toBe(7200);
    expect(e.limit).toBe(1000);
    expect(e.code).toBe("extract_daily_limit");
  });

  it("429 with an empty Retry-After does not coerce to 0", () => {
    // Number("") === 0 in JS, which would read as "retry immediately".
    const e = mapResponseToError(429, body({ detail: "slow", reset_in_seconds: 42 }), {
      "Retry-After": "",
    }) as LenzRateLimitError;
    expect(e.retryAfter).toBe(42);
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
