/**
 * The "No Public Record" outcome: a completed deep check whose sources do not
 * settle the claim. `verdict: "No Public Record"`, `lenz_score: null`, and a
 * `confidence` band string. `VerdictLabel` stays the five labels; the new
 * `VerificationVerdict` names the six. Failed runs read one of the collapsed
 * `failure.code` values. The bodies are constructed fixtures with the keys
 * of the recorded ones.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  Lenz,
  hasScore,
  isNoPublicRecord,
  type FailureClass,
  type ReviewFull,
  type ReviewIssue,
  type ReviewResult,
  type ReviewVerification,
  type TaskStatus,
  type VerdictLabel,
  type VerificationVerdict,
} from "../src/index.js";
import * as Browser from "../src/index.browser.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "contract");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DIR, name), "utf-8")) as Record<string, unknown>;
}

function clientAnswering(body: unknown): Lenz {
  const fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "x-lenz-api-version": "2026-10-11" },
    })) as typeof globalThis.fetch;
  return new Lenz({ apiKey: "lenz_test", fetch, maxRetries: 0 });
}

describe("No Public Record: types", () => {
  it("VerificationVerdict is the five labels plus the new one; VerdictLabel is untouched", () => {
    expectTypeOf<VerificationVerdict>().toEqualTypeOf<VerdictLabel | "No Public Record">();
    expectTypeOf<VerdictLabel>().toEqualTypeOf<
      "True" | "Mostly True" | "Mixed" | "Mostly False" | "False"
    >();
    expectTypeOf<Browser.VerificationVerdict>().toEqualTypeOf<VerificationVerdict>();
  });

  it("a review's deep check, result and issue can read it", () => {
    expectTypeOf<ReviewVerification["verdict"]>().toEqualTypeOf<VerificationVerdict | null>();
    expectTypeOf<ReviewResult["verdict"]>().toEqualTypeOf<VerificationVerdict | "Error">();
    expectTypeOf<ReviewIssue["verdict"]>().toEqualTypeOf<VerificationVerdict>();
  });

  it("FailureClass still names the canonical set and tolerates the old value", () => {
    const canonical: FailureClass[] = [
      "upstream_unavailable",
      "invalid_input",
      "cancelled",
      "internal",
    ];
    const old: FailureClass = "insufficient_evidence";
    expect(canonical).toHaveLength(4);
    expect(old).toBe("insufficient_evidence");
  });
});

describe("No Public Record: helpers", () => {
  it("isNoPublicRecord reads the verdict", () => {
    expect(isNoPublicRecord({ verdict: "No Public Record" })).toBe(true);
    expect(isNoPublicRecord({ verdict: "False" })).toBe(false);
    expect(isNoPublicRecord({ verdict: null })).toBe(false);
    expect(isNoPublicRecord({})).toBe(false);
    expect(isNoPublicRecord(null)).toBe(false);
    expect(isNoPublicRecord(undefined)).toBe(false);
  });

  it("hasScore narrows to a number", () => {
    const v: { lenz_score?: number | null } = { lenz_score: 7 };
    if (hasScore(v)) expectTypeOf(v.lenz_score).toEqualTypeOf<number>();
    expect(hasScore(v)).toBe(true);
    expect(hasScore({ lenz_score: null })).toBe(false);
    expect(hasScore({})).toBe(false);
    expect(hasScore(null)).toBe(false);
  });

  it("the browser entry exports them too", () => {
    expect(Browser.isNoPublicRecord).toBe(isNoPublicRecord);
    expect(Browser.hasScore).toBe(hasScore);
  });
});

describe("No Public Record: results", () => {
  it("a completed status carries the verdict, no score and a confidence band", async () => {
    const status: TaskStatus = await clientAnswering(
      fixture("verify_status_no_public_record.json"),
    ).getStatus("tsk_abc123");
    expect(status.status).toBe("completed");
    const result = status.result!;
    expect(result.verdict).toBe("No Public Record");
    expect(result.lenz_score).toBeNull();
    expect(result.confidence).toBe("medium");
    expect(isNoPublicRecord(result)).toBe(true);
    expect(hasScore(result)).toBe(false);
  });

  it("a scored verdict is not No Public Record", async () => {
    const status = await clientAnswering(fixture("verify_status_completed.json")).getStatus("t");
    expect(isNoPublicRecord(status.result)).toBe(false);
    expect(hasScore(status.result)).toBe(true);
  });

  it("a failed run reads a collapsed failure code", async () => {
    const status = await clientAnswering(
      fixture("verify_status_failed_collapsed_code.json"),
    ).getStatus("tsk_abc123");
    expect(status.status).toBe("failed");
    expect(status.failure?.code).toBe("upstream_unavailable");
    expect(status.failure?.failure_class).toBe("upstream_unavailable");
    expect(status.failure?.retryable).toBe(true);
  });

  it("a review holding one is issues_found, with an issue row and no rewrite", async () => {
    const review = (await clientAnswering(
      fixture("review_completed_no_public_record.json"),
    ).getReview("442b6aa9")) as ReviewFull;
    expect(review.outcome).toBe("issues_found");
    expect(review.issues).toHaveLength(1);
    const issue = review.issues[0]!;
    expect(issue.verdict).toBe("No Public Record");
    expect(issue.source).toBe("verification");
    expect(issue.suggested_rewrite).toBeNull();
    const claim = review.claims[0]!;
    expect(claim.result?.verdict).toBe("No Public Record");
    expect(claim.result?.is_issue).toBe(true);
    expect(claim.suggested_edits).toBeNull();
    expect(claim.verification?.verdict).toBe("No Public Record");
    expect(claim.verification?.lenz_score).toBeNull();
    expect(isNoPublicRecord(claim.verification)).toBe(true);
  });
});
