/**
 * A quick check that finds "No Public Record": an /assess row and a review's
 * quick check carry it with a confidence band (never "high") and no score, a
 * final one is a review issue, and an unresolved panel is a free failed row.
 * Failed rows and failed reviews speak the one failure vocabulary.
 *
 * The bodies are `test/fixtures/contract/` (the same files as the Python SDK)
 * and the API's own recordings.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  Lenz,
  type AssessClaim,
  type AssessResponse,
  type EscalationPolicy,
  type ReviewAssessment,
  type ReviewFull,
  type ReviewInput,
  type Verdict,
  type VerdictLabel,
  type VerificationVerdict,
} from "../src/index.js";
import * as Browser from "../src/index.browser.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function contract(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, "contract", name), "utf-8"));
}

function recorded(name: string): unknown {
  return (
    JSON.parse(readFileSync(join(FIXTURES, "shapes", "canonical", `${name}.json`), "utf-8")) as {
      body: unknown;
    }
  ).body;
}

function clientAnswering(body: unknown, legacyAliases = true): Lenz {
  const fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "x-lenz-api-version": "2026-10-11" },
    })) as typeof globalThis.fetch;
  return new Lenz({ apiKey: "lenz_test", fetch, maxRetries: 0, legacyAliases });
}

describe("No Public Record on a quick check: types", () => {
  it("Verdict lists it beside the five labels and the deprecated Error", () => {
    expectTypeOf<Verdict>().toEqualTypeOf<VerdictLabel | "No Public Record" | "Error">();
    expectTypeOf<Verdict>().toEqualTypeOf<VerificationVerdict | "Error">();
    expectTypeOf<Browser.Verdict>().toEqualTypeOf<Verdict>();
  });

  it("a review's quick check, the policy and the request take it", () => {
    expectTypeOf<ReviewAssessment["verdict"]>().toEqualTypeOf<
      VerificationVerdict | "Error" | null
    >();
    expectTypeOf<EscalationPolicy["verdicts"]>().toEqualTypeOf<VerificationVerdict[]>();
    expectTypeOf<NonNullable<ReviewInput["verdicts"]>>().toEqualTypeOf<VerificationVerdict[]>();
    const input: ReviewInput = { text: "x", verdicts: ["False", "No Public Record"] };
    expect(input.verdicts).toHaveLength(2);
  });
});

describe("No Public Record on a quick check: bodies", () => {
  for (const legacyAliases of [true, false]) {
    it(`an assess row reads it (legacyAliases ${legacyAliases})`, async () => {
      const out = await clientAnswering(
        contract("assess_no_public_record.json"),
        legacyAliases,
      ).assess({
        claim: "x",
      });
      const row = out.claims[0] as AssessClaim;
      expect([row.status, row.verdict, row.confidence]).toEqual([
        "completed",
        "No Public Record",
        "medium",
      ]);
      expect(row.failure).toBeNull();
      expect(row.suggested_rewrite).toBeNull();
    });
  }

  it("the recorded rows read the same", async () => {
    for (const name of ["assess__single_no_public_record", "assess__list_no_public_record"]) {
      const out: AssessResponse = await clientAnswering(recorded(name)).assess({ claim: "x" });
      const rows = out.claims.filter((r) => r.verdict === "No Public Record");
      expect(rows.length, name).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.confidence !== "high"),
        name,
      ).toBe(true);
    }
  });

  it("an unresolved row is a free, retryable failure, not a No Public Record row", async () => {
    const out = await clientAnswering(contract("assess_no_public_record.json")).assess({
      claim: "x",
    });
    const row = out.claims[4]!;
    expect(row.status).toBe("failed");
    expect(row.failure).toMatchObject({
      code: "upstream_unavailable",
      detail: "The reviewers did not reach an answer.",
      failure_class: "upstream_unavailable",
      retryable: true,
    });
    expect(row.verdict).not.toBe("No Public Record");
  });

  it("failed rows share one vocabulary; resend on `retryable`", async () => {
    const out = await clientAnswering(contract("assess_no_public_record.json")).assess({
      claim: "x",
    });
    const failed = out.claims.filter((r) => r.failure);
    expect(failed.map((r) => [r.failure!.code, r.failure!.retryable])).toEqual([
      ["upstream_unavailable", true],
      ["internal", false],
      ["upstream_unavailable", true],
    ]);
    // The deprecated field carries the same code.
    expect(failed.map((r) => r.error_code)).toEqual([
      "upstream_unavailable",
      "internal",
      "upstream_unavailable",
    ]);
  });

  it("a final quick No Public Record is a review issue", async () => {
    const review: ReviewFull = await clientAnswering(
      contract("review_completed_quick_no_public_record.json"),
    ).getReview("c41d7e02");
    expect(review.outcome).toBe("issues_found");
    expect(review.claims[0]!.assessment.verdict).toBe("No Public Record");
    expect(review.claims[0]!.result).toMatchObject({ is_issue: true, source: "assessment" });
    expect(review.claims[1]!.result).toMatchObject({ is_issue: false });
    expect(review.issues[0]).toMatchObject({ verdict: "No Public Record", source: "assessment" });
    expect(review.issues[0]!.suggested_rewrite).toBeNull();
  });

  it("the default escalation list names it", async () => {
    const review = await clientAnswering(
      contract("review_completed_quick_no_public_record.json"),
    ).getReview("c41d7e02");
    expect(review.policy.verdicts).toContain("No Public Record");
  });

  it("a review of a link that could not be read fails as page_unreadable", async () => {
    const review = await clientAnswering(contract("review_failed_page_unreadable.json")).getReview(
      "7e0a93bd",
    );
    expect(review.status).toBe("failed");
    expect(review.failure).toMatchObject({
      code: "page_unreadable",
      failure_class: "invalid_input",
      retryable: false,
    });
  });
});
