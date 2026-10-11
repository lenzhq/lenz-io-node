/**
 * One failure vocabulary on the 2026-10-11 shape, and what the transport does
 * with a failure that will not change.
 *
 * `/extract` answers an unreadable link with 422 `page_unreadable` (it used to
 * be a 502), work that failed on our side with 502 `internal`; a 5xx of the
 * current version that says it will not succeed on a retry is not retried.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  Lenz,
  LenzAPIError,
  LenzValidationError,
  mapResponseToError,
  type LenzError,
} from "../src/index.js";

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "contract");
const CANONICAL = { "x-lenz-api-version": "2026-10-11" };
const LEGACY = { "x-lenz-api-version": "2026-05-13" };
const USAGE = { plan: "free", credits_used: 0, credits_total: 10 };

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONTRACT, name), "utf-8")) as Record<string, unknown>;
}

interface Step {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** A fetch answering the steps in order; `calls` counts what was sent. */
function scripted(...steps: Step[]): { fetch: typeof globalThis.fetch; calls: () => number } {
  let n = 0;
  const fetch = (async () => {
    const step = steps[Math.min(n, steps.length - 1)]!;
    n += 1;
    return new Response(step.text ?? JSON.stringify(step.body ?? USAGE), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json", ...(step.headers ?? {}) },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => n };
}

async function thrown(p: Promise<unknown>): Promise<LenzError> {
  try {
    await p;
  } catch (e) {
    return e as LenzError;
  }
  throw new Error("expected the call to throw");
}

describe("/extract: an unreadable link and work that failed on our side", () => {
  it("a 422 page_unreadable is a validation error that says what to send", () => {
    const body = JSON.stringify(fixture("error_extract_page_unreadable_422.json"));
    const err = mapResponseToError(422, body, CANONICAL, { method: "POST", path: "/extract" });
    expect(err).toBeInstanceOf(LenzValidationError);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("page_unreadable");
    expect(err.message).toBe("The page at the link could not be read.");
    expect(err.fix).toBe("Paste the page's text instead.");
    expect(err.retryable).toBe(false);
  });

  it("any other 422 keeps the generic advice", () => {
    const err = mapResponseToError(
      422,
      JSON.stringify({ detail: "bad", code: "validation_error" }),
    );
    expect(err.fix).toBe("Check the request body against the OpenAPI spec.");
  });

  it("extract stops at the first 422 page_unreadable", async () => {
    const { fetch, calls } = scripted({
      status: 422,
      body: fixture("error_extract_page_unreadable_422.json"),
      headers: CANONICAL,
    });
    const err = await thrown(
      new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 3 }).extract({
        text: "https://example.com/a",
      }),
    );
    expect(calls()).toBe(1);
    expect(err.code).toBe("page_unreadable");
  });

  it("a 502 internal will not help again", () => {
    const body = JSON.stringify(fixture("error_extract_internal_502.json"));
    const err = mapResponseToError(502, body, CANONICAL, { method: "POST", path: "/extract" });
    expect(err).toBeInstanceOf(LenzAPIError);
    expect([err.statusCode, err.code, err.message]).toEqual([502, "internal", "Extraction failed"]);
    expect(err.retryable).toBe(false);
    expect(err.fix).toMatch(/will not help/);
  });

  it("a 5xx with no signal keeps the generic advice and stays retryable", () => {
    const err = mapResponseToError(502, JSON.stringify({ detail: "bad gateway" }));
    expect(err.retryable).toBe(true);
    expect(err.fix).toBe("Retry; if the error persists, file an issue with the Request ID.");
  });
});

describe("a canonical 5xx that will not succeed on a retry is sent once", () => {
  const stops: Array<[string, unknown]> = [
    ["code internal", { detail: "Extraction failed", code: "internal" }],
    ["retryable false", { detail: "Failed.", code: "something_new", retryable: false }],
    ["failure block", { detail: "Failed.", failure: { code: "internal", retryable: false } }],
  ];
  for (const [label, body] of stops) {
    it(`${label}`, async () => {
      const { fetch, calls } = scripted({ status: 502, body, headers: CANONICAL });
      const err = await thrown(new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 3 }).usage());
      expect(calls()).toBe(1);
      expect(err.statusCode).toBe(502);
      expect(err.retryable).toBe(false);
    });
  }

  const retried: Array<[string, Step]> = [
    ["a legacy-version body", { status: 502, body: { code: "internal" }, headers: LEGACY }],
    [
      "a legacy-version retryable false",
      { status: 502, body: { code: "extraction_failed", retryable: false }, headers: LEGACY },
    ],
    ["a gateway body with no version", { status: 502, body: { code: "internal" } }],
    ["a gateway page", { status: 502, text: "<html>Bad Gateway</html>" }],
    [
      "a canonical body with no code",
      { status: 502, body: { detail: "bad gateway" }, headers: CANONICAL },
    ],
    [
      "a canonical html page",
      { status: 502, text: "<html>Bad Gateway</html>", headers: CANONICAL },
    ],
    [
      "the generic 500",
      { status: 500, body: { detail: "x", code: "internal_error" }, headers: CANONICAL },
    ],
    [
      "a canonical retryable true",
      { status: 502, body: { code: "something_new", retryable: true }, headers: CANONICAL },
    ],
  ];
  for (const [label, step] of retried) {
    it(`${label} keeps its retries`, async () => {
      const { fetch, calls } = scripted(step, { headers: CANONICAL });
      const usage = await new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 1 }).usage();
      expect(usage.plan).toBe("free");
      expect(calls()).toBe(2);
    }, 10_000);
  }

  it("a 503 upstream_unavailable still raises at once with its wait", async () => {
    const { fetch, calls } = scripted({
      status: 503,
      body: { detail: "down", code: "upstream_unavailable", retry_after: 90 },
      headers: { ...CANONICAL, "retry-after": "90" },
    });
    const err = await thrown(new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 3 }).usage());
    expect(calls()).toBe(1);
    expect(err.retryable).toBe(true);
  });
});
