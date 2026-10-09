/**
 * The newer field names read off a recording of the response shape this
 * release asks for (`2026-10-11`), and the request bodies say what they must
 * about `webhook_url`.
 *
 * `two-x-values.test.ts` pins the ORIGINAL names to what the previous release
 * returned. This file reads the NEWER names (`claims`, `claim`, `more_claims`,
 * `status`, `failure`, `completed_at`, `claim_limit_exceeded`,
 * `citation_limit_exceeded`, ...). Webhook events still arrive in either
 * shape, so their tests run on both.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";
import { mapResponseToError } from "../src/index.js";
import type {
  AssessResponse,
  BatchAccepted,
  ExtractedClaims,
  ReviewFull,
  TaskStatus,
  Usage,
  Verification,
} from "../src/index.js";
import {
  reviewRequestBodies,
  runScenario,
  type Recorded,
  type SdkUnderTest,
} from "./shapes/scenarios.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shapes");
const SHAPES = ["legacy", "canonical"] as const;
const SHAPE = "canonical";
const SDK = sdk as unknown as SdkUnderTest;

function recorded(shape: string, name: string): Recorded {
  return JSON.parse(readFileSync(join(ROOT, shape, `${name}.json`), "utf-8")) as Recorded;
}

/** The value a scenario returned (`key` picks one call of a multi-call scenario). */
async function value<T>(shape: string, name: string, key?: string): Promise<T> {
  const out = (await runScenario(SDK, name, recorded(shape, name))) as Record<string, unknown>;
  const picked = (key ? out[key] : out) as { value?: unknown; error?: unknown };
  if (!("value" in picked)) throw new Error(`${name} (${shape}) threw: ${JSON.stringify(picked)}`);
  return picked.value as T;
}

async function thrown(shape: string, name: string, key?: string): Promise<Record<string, unknown>> {
  const out = (await runScenario(SDK, name, recorded(shape, name))) as Record<string, unknown>;
  const picked = (key ? out[key] : out) as { error?: unknown };
  return picked.error as Record<string, unknown>;
}

describe("newer names", () => {
  const shape = SHAPE;
  it("assess rows: status, failure and more_claims", async () => {
    const mixed = await value<AssessResponse>(shape, "assess__list_mixed_rows");
    expect(mixed.claims.map((r) => r.status)).toEqual(["completed", "failed", "failed", "failed"]);
    expect(mixed.claims.map((r) => r.failure?.code ?? null)).toEqual([
      null,
      "no_checkable_claim",
      "upstream_unavailable",
      "framing_failed",
    ]);
    expect(mixed.claims[2]!.failure).toMatchObject({
      failure_class: "upstream_unavailable",
      retryable: true,
    });
    expect(mixed.claims[1]!.failure!.hint).toMatch(/greeting/);
    const compound = await value<AssessResponse>(shape, "assess__list_compound_item");
    expect(compound.claims[0]!.more_claims).toEqual(["Second claim.", "Third claim."]);
    expect(compound.claims[1]!.more_claims).toEqual([]);
  });

  it("assess with nothing checkable: failure on the body", async () => {
    const out = await value<AssessResponse>(shape, "assess__single_no_claim");
    expect(out.claims).toEqual([]);
    expect(out.failure).toMatchObject({ code: "no_checkable_claim" });
    expect(typeof out.failure!.detail).toBe("string");
    expect(out.more_claims).toEqual([]);
  });

  it("extract: claims is always the full list, with positions", async () => {
    const one = await value<ExtractedClaims>(shape, "extract__ready_one_claim");
    expect(one.claims).toEqual([{ claim: "Alpha rose 5% in 2024.", positions: null }]);
    const several = await value<ExtractedClaims>(shape, "extract__ready_several_claims");
    expect(several.claims!.map((c) => c.claim)).toEqual([
      "Alpha rose 5% in 2024.",
      "Beta fell 3% last year.",
    ]);
    const located = await value<ExtractedClaims>(shape, "extract__locate_true");
    expect(located.claims![1]!.positions).toEqual([
      { start: 23, end: 46, text: "Beta fell 3% last year." },
    ]);
    const none = await value<ExtractedClaims>(shape, "extract__not_a_claim");
    expect(none.claims).toEqual([]);
    // Code written against the original value keeps working on both shapes.
    expect(none.status).toBe("not_a_claim");
  });

  it("receipts: claim on every item", async () => {
    for (const name of ["verify__batch_202", "verify__select_202"]) {
      const out = await value<BatchAccepted>(shape, name);
      expect(out.items.map((i) => i.claim)).toEqual([
        "The Earth is round.",
        "Water boils at 100C at sea level.",
      ]);
    }
  });

  it("failed task: failure carries the code and a sentence", async () => {
    const st = await value<TaskStatus>(shape, "verify__status_not_a_claim", "getStatus");
    expect(st.failure).toMatchObject({
      code: "no_checkable_claim",
      failure_class: "invalid_input",
      retryable: false,
      docs_url: "https://lenz.io/docs/errors#invalid-input",
    });
    expect(typeof st.failure!.detail).toBe("string");
  });

  it("needs_input: each option carries claim", async () => {
    const st = await value<TaskStatus>(shape, "verify__status_needs_input", "getStatus");
    expect(st.claims!.map((c) => c.claim)).toEqual([
      "The Earth is round.",
      "Water boils at 100C at sea level.",
    ]);
  });

  it("verification: modified_at keeps its later-day rule", async () => {
    const crossed = await value<Verification>(
      shape,
      "verify__verification_200_modified_at_crosses_midnight_by_minutes",
    );
    expect(crossed.modified_at).toBe("2026-03-15T00:03:02.234567+00:00");
    const sameDay = await value<TaskStatus>(
      shape,
      "verify__status_completed_live_modified_at_same_day_hours_apart",
      "getStatus",
    );
    expect(sameDay.result!.modified_at).toBeNull();
    if (shape === "canonical") {
      expect(sameDay.result!.completed_at).toBe("2026-03-14T17:30:02.234567+00:00");
    }
  });

  it("usage: the per-capability blocks and quota_resets_at are there", async () => {
    const u = await value<Usage>(shape, "account__me_usage_extra_only");
    expect(u.verify).toEqual({
      quota_used: 10,
      quota_total: 13,
      quota_remaining: 3,
      bonus: 3,
      credits: 3,
      remaining: 3,
    });
    expect(u.credits.bonus).toBe(u.credits.extra);
    expect(u.quota_resets_at).toBe(u.credits.resets_at);
  });

  it("review: limit flags under both names, failure codes, more_claims", async () => {
    const exact = await value<ReviewFull>(
      shape,
      "review__get_claim_limit_reached_exact",
      "getReview",
    );
    expect(exact.summary).toMatchObject({
      claims_found: 2,
      claim_limit_exceeded: false,
      claim_limit_reached: true,
    });
    const more = await value<ReviewFull>(shape, "review__get_more_claims", "getReview");
    expect(more.summary).toMatchObject({ claim_limit_exceeded: true, claim_limit_reached: true });
    const cited = await value<ReviewFull>(
      shape,
      "review__get_citations_limit_reached",
      "getReview",
    );
    expect(cited.summary.citation_limit_exceeded).toBe(true);
    expect(cited.summary.citation_limit_reached).toBe(true);
    const failed = await value<ReviewFull>(shape, "review__get_failed_no_claim", "getReview");
    expect(failed.failure!.code).toBe("no_checkable_claim");
    expect(failed.failure!.failure_reason).toBe("no_claim");
    const rows = await value<ReviewFull>(
      shape,
      "review__get_assessment_rows_full_fields",
      "getReview",
    );
    expect(rows.claims[0]!.assessment.more_claims).toEqual([
      "The EU AI Act took effect in 2024.",
      "It took effect in March.",
    ]);
    expect(rows.claims[1]!.assessment.failure!.code).toBe("timeout");
  });

  it("a failed review throws with the original error code", async () => {
    const err = await thrown(shape, "review__get_failed_no_claim", "reviewAndWait");
    expect(err).toMatchObject({ class: "ReviewFailedError", errorCode: "no_claim" });
  });
});

describe.each(SHAPES)("newer names on webhook events, %s shape", (shape) => {
  it("verification.failed webhook: failure and the original error", async () => {
    const ev = await value<Record<string, unknown>>(
      shape,
      "webhook__verification_failed_not_a_claim",
    );
    expect(ev["error"]).toBe("not_a_claim");
    expect(ev["failure"]).toMatchObject({ code: "no_checkable_claim", retryable: false });
    expect((ev["verification"] as TaskStatus).status).toBe("failed");
  });

  it("verification.needs_input webhook: the options under both names", async () => {
    const ev = await value<Record<string, unknown>>(
      shape,
      "webhook__verification_needs_input_multi_claim",
    );
    const needsInput = ev["needsInput"] as { claims: Array<{ claim: string; text: string }> };
    expect(needsInput.claims.map((c) => [c.claim, c.text])).toEqual([
      ["The Earth is round.", "The Earth is round."],
      ["The Moon is made of cheese.", "The Moon is made of cheese."],
    ]);
  });

  it("verification.completed webhook: result and verification", async () => {
    const ev = await value<Record<string, unknown>>(
      shape,
      "webhook__verification_completed_modified_at_crosses_midnight_by_minutes",
    );
    const result = ev["result"] as Verification;
    expect(result.modified_at).toBe("2026-03-15T00:03:02.234567+00:00");
    expect((ev["verification"] as TaskStatus).result!.verification_id).toBe(result.verification_id);
  });
});

describe("webhook_url in request bodies", () => {
  function capture(): { fetch: typeof fetch; bodies: unknown[] } {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ task_id: "t", status: "queued", batch_id: "b", items: [] }),
        { status: 202 },
      );
    }) as typeof fetch;
    return { fetch: fetchImpl, bodies };
  }

  it("verify omits an unset or empty webhook_url and sends a set one", async () => {
    const { fetch, bodies } = capture();
    const client = new sdk.Lenz({ apiKey: "lenz_t", fetch });
    await client.verify({ claim: "a" });
    await client.verify({ claim: "a", webhookUrl: "" });
    // Blank is omitted too: the API version 3.0 asks for reads it as "no
    // webhook", 2.x's server as the credential's default.
    await client.verify({ claim: "a", webhookUrl: "   " });
    await client.verifyBatch({ claims: [{ claim: "b", webhook_url: " " }], webhookUrl: "\t" });
    await client.verify({ claim: "a", webhookUrl: "https://example.com/h" });
    expect(bodies).toEqual([
      { text: "a", source_url: "" },
      { text: "a", source_url: "" },
      { text: "a", source_url: "" },
      { claims: [{ text: "b", source_url: "" }] },
      { text: "a", source_url: "", webhook_url: "https://example.com/h" },
    ]);
  });

  it("verifyBatch omits an unset or empty webhook_url per item and batch-wide", async () => {
    const { fetch, bodies } = capture();
    const client = new sdk.Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({
      claims: [
        { claim: "a" },
        { claim: "b", webhook_url: "" },
        { claim: "c", webhook_url: "https://x.example/h" },
      ],
      webhookUrl: "",
    });
    expect(bodies).toEqual([
      {
        claims: [
          { text: "a", source_url: "" },
          { text: "b", source_url: "" },
          { text: "c", source_url: "", webhook_url: "https://x.example/h" },
        ],
      },
    ]);
  });

  it("review and citecheck send exactly what the previous release sent", async () => {
    // On these two endpoints "" means "no webhook", so it is still sent.
    const pinned = JSON.parse(
      readFileSync(join(ROOT, "requests", "review_and_citecheck.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(await reviewRequestBodies(SDK)).toEqual(pinned);
    expect(pinned["review: webhookUrl empty"]).toMatchObject({ webhook_url: "" });
    expect(pinned["citecheck: webhookUrl empty"]).toMatchObject({ webhook_url: "" });
  });
});

describe("bodies keep what they had", () => {
  it("a 429 with doc_url and retry_after keeps resetInSeconds null", () => {
    const err = mapResponseToError(
      429,
      JSON.stringify({ code: "rate_limited", doc_url: "https://lenz.io/docs", retry_after: 30 }),
    ) as sdk.LenzRateLimitError;
    expect(err.resetInSeconds).toBeNull();
    expect(err.retryAfter).toBe(30);
  });

  it("a needs_input option with text: null keeps it null", async () => {
    const payload = {
      event: "verification.needs_input",
      task_id: "t",
      status: "needs_input",
      needs_input: { reason: "multi_claim", claims: [{ text: null, domain: "" }], hint: "h" },
      attempt: 1,
      delivered_at: new Date().toISOString(),
    };
    const out = (await runScenario(SDK, "webhook__adhoc", { payload })) as {
      value: { needsInput: { claims: Array<Record<string, unknown>> } };
    };
    expect(out.value.needsInput.claims[0]).toEqual({ text: null, claim: null, domain: "" });
  });

  it("citecheckAndWait does not add more_citations to a body without it", async () => {
    const body = JSON.parse(
      readFileSync(join(ROOT, "canonical", "citecheck__get_completed_clean.json"), "utf-8"),
    ).body as Record<string, unknown>;
    delete body["more_citations"];
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ citecheck_id: body["citecheck_id"], status: "queued" }), {
            status: 202,
          })
        : new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const client = new sdk.Lenz({ apiKey: "lenz_t", fetch: fetchImpl, maxRetries: 0 });
    const check = await client.citecheckAndWait({ text: "x" }, { timeoutMs: 50 });
    expect("more_citations" in check).toBe(false);
  });
});
