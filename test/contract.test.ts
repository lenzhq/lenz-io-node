/**
 * Strict-deserialization contract test.
 *
 * The SDK's TypeScript types are erased at runtime, so we maintain a
 * parallel runtime keyset per interface and walk each captured server
 * response against it. Any key the server emits that isn't in the SDK
 * keyset fails CI with a precise location — catches rename misses that
 * the permissive `?` field types would silently absorb.
 *
 * Fixtures are frozen JSON in `test/fixtures/contract/` — the SAME
 * files the Python SDK validates against. Cross-language parity is the
 * point. When you rename a field in the SDK, you also rename it in the
 * keysets here; when the server adds a field, you add it to both
 * SDKs' keysets.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LenzAPIError,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzUpstreamUnavailableError,
  mapResponseToError,
} from "../src/index.js";
import { LenzWebhooks } from "../src/webhooks.js";
import type { VerificationFailed } from "../src/webhooks.js";
import { createHmac } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "contract");

function loadFixture(name: string): Record<string, unknown> {
  const raw = readFileSync(join(FIXTURES, name), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

// Runtime keysets — parallel to `src/types.ts`. Keep in sync.
// Each entry is the set of top-level keys defined on that interface.
const KEYSETS: Record<string, ReadonlySet<string>> = {
  ExtractedClaims: new Set([
    "status",
    "claim",
    "identified_claims",
    "candidate_claims",
    "domain",
    "key_entities",
    "presumed_intent",
    "original_input",
  ]),
  ExtractedEntity: new Set(["name", "type"]),
  AssessResponse: new Set(["claims", "error", "error_code", "candidate_claims"]),
  AssessClaim: new Set(["claim", "verdict", "confidence", "verification_url", "language"]),
  TaskStatus: new Set([
    "status",
    "reason",
    "progress",
    "result",
    "claims",
    "candidates",
    "similar_claims",
    "error",
    "failure_reason",
    "failure_detail",
    "failure_class",
    "retryable",
  ]),
  CandidateClaim: new Set(["text", "domain"]),
  Verification: new Set([
    "verification_id",
    "claim",
    "domain",
    "entities",
    "presumed_intent",
    "verdict",
    "confidence",
    "lenz_score",
    "key_finding",
    "executive_summary",
    "warnings",
    "sources",
    "audit",
    "created_at",
    "modified_at",
    "language",
    "visibility",
  ]),
  VerificationListItem: new Set([
    "verification_id",
    "claim",
    "domain",
    "entities",
    "verdict",
    "confidence",
    "lenz_score",
    "key_finding",
    "executive_summary",
    "created_at",
    "modified_at",
    "language",
  ]),
  EntityRef: new Set(["name", "qid"]),
  Source: new Set(["source_name", "title", "url", "snippet", "date"]),
  Audit: new Set([
    "adjudication_summary",
    "assessments",
    "debate_pro",
    "debate_con",
    "panel_agreement",
  ]),
  Assessment: new Set(["panelist_name", "focus_area", "score", "reasoning", "warnings"]),
  DebateSide: new Set(["role", "argument", "rebuttal"]),
  Usage: new Set([
    "plan",
    "quota_resets_at",
    "credits",
    "costs",
    "verify",
    "ask",
    "assess",
    "extract",
    "has_webhook_secret",
  ]),
  UsageCredits: new Set(["total", "used", "remaining", "bonus", "resets_at"]),
  // The block's `credits` is the deprecated alias of `bonus`; the server
  // stops sending it on 2026-11-29 and this entry goes with it.
  UsageCapacity: new Set([
    "quota_used",
    "quota_total",
    "quota_remaining",
    "bonus",
    "credits",
    "remaining",
  ]),
  UsageExtract: new Set(["calls_today", "daily_limit", "unlimited"]),
};

// For each parent interface + field name, which child interface (if any)
// should be walked? Maps to the nested-type relationships you'd see in
// `src/types.ts`. `null` means "treat as opaque" (e.g. dict bag fields).
const NESTED: Record<string, Record<string, string | null>> = {
  ExtractedClaims: { key_entities: "ExtractedEntity" },
  AssessResponse: { claims: "AssessClaim" },
  TaskStatus: {
    result: "Verification",
    claims: "CandidateClaim",
    progress: null, // dict bag
  },
  Verification: {
    entities: "EntityRef",
    sources: "Source",
    audit: "Audit",
  },
  Audit: {
    assessments: "Assessment",
    debate_pro: "DebateSide",
    debate_con: "DebateSide",
  },
  Usage: {
    credits: "UsageCredits",
    costs: null, // capability → credits map; keys are the server's, verbatim
    verify: "UsageCapacity",
    ask: "UsageCapacity",
    assess: "UsageCapacity",
    extract: "UsageExtract",
  },
};

function walk(payload: unknown, ifaceName: string, path: string): string[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const keyset = KEYSETS[ifaceName];
  if (!keyset) {
    throw new Error(`No keyset for interface '${ifaceName}' — add it to KEYSETS`);
  }
  const errors: string[] = [];
  const obj = payload as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!keyset.has(key)) {
      errors.push(`${path || ifaceName}: unknown server field '${key}' (interface=${ifaceName})`);
    }
  }
  const nested = NESTED[ifaceName] ?? {};
  for (const [key, value] of Object.entries(obj)) {
    if (!keyset.has(key)) continue;
    const childIface = nested[key];
    if (childIface === undefined || childIface === null) continue;
    const childPath = path ? `${path}.${key}` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        errors.push(...walk(item, childIface, `${childPath}[${i}]`));
      });
    } else if (value && typeof value === "object") {
      errors.push(...walk(value, childIface, childPath));
    }
  }
  return errors;
}

describe("contract", () => {
  const cases: Array<[string, string]> = [
    ["extract_response.json", "ExtractedClaims"],
    ["assess_single_claim.json", "AssessResponse"],
    ["assess_multiclaim.json", "AssessResponse"],
    ["verify_status_completed.json", "TaskStatus"],
    ["verify_status_failed.json", "TaskStatus"],
    ["verifications_detail.json", "Verification"],
    ["usage.json", "Usage"],
  ];

  for (const [fixture, iface] of cases) {
    it(`${fixture} → ${iface} has no unknown fields`, () => {
      const payload = loadFixture(fixture);
      const errors = walk(payload, iface, "");
      if (errors.length > 0) {
        throw new Error(
          `${fixture} → ${iface}:\n${errors.join("\n")}\n\n` +
            `Either add these to src/types.ts + the KEYSETS in this file, ` +
            `or update the fixture if this is stale capture.`,
        );
      }
    });
  }

  it("webhook payload result block matches Verification", () => {
    // The webhook `result` is typed as Record<string, unknown> on the
    // dataclass side, but its server contents match `Verification`
    // exactly. Walk it to catch verdict-block shape drift.
    const payload = loadFixture("webhook_payload_completed.json");
    const result = (payload["result"] as Record<string, unknown>) ?? {};
    const errors = walk(result, "Verification", "result");
    if (errors.length > 0) {
      throw new Error(
        `webhook_payload_completed.json → Verification (via .result):\n${errors.join("\n")}`,
      );
    }
  });

  it("assess multiclaim parses to typed entries", () => {
    const payload = loadFixture("assess_multiclaim.json");
    const claims = payload["claims"] as Array<Record<string, unknown>>;
    expect(claims).toHaveLength(3);
    expect(claims[0]!["verdict"]).toBe("True");
    expect(claims[0]!["confidence"]).toBe("high");
    expect(claims[0]!["verification_url"]).toBeTruthy();
  });

  // The error envelopes are part of the wire contract too, and drift between
  // the two SDKs' error mapping is exactly what this file exists to catch.
  // Both SDKs validate the SAME fixture files.
  it("402 envelope maps every field onto LenzQuotaExceededError", () => {
    const fixture = loadFixture("error_quota_402.json");
    const err = mapResponseToError(402, JSON.stringify(fixture), {}) as LenzQuotaExceededError;

    expect(err).toBeInstanceOf(LenzQuotaExceededError);
    expect(err.message).toBe(fixture["detail"]);
    expect(err.code).toBe(fixture["code"]);
    expect(err.upgradeUrl).toBe(fixture["upgrade_url"]);
    expect(err.remaining).toBe(fixture["remaining"]);
    expect(err.resetsAt).toBe(fixture["resets_at"]);
    // Pool units, alongside the capability-unit `remaining`/`requested`.
    expect(err.creditBalance).toBe(fixture["credits_remaining"]);
    expect(err.cost).toBe(fixture["cost"]);

    // Every key the server sends must be consumed by a typed field or
    // deliberately skipped — an unhandled key means the mapper drifted.
    const handled = new Set([
      "detail",
      "code",
      "upgrade_url",
      "remaining",
      "resets_at",
      "requested",
      "credits_remaining",
      "cost",
    ]);
    // `doc_url` is intentionally not mapped: the SDK sets its own docUrl from
    // the status table so the link is right even on an older server.
    handled.add("doc_url");
    const unhandled = Object.keys(fixture).filter((k) => !handled.has(k));
    expect(unhandled).toEqual([]);
  });

  it("429 envelope maps every field onto LenzRateLimitError", () => {
    const fixture = loadFixture("error_rate_limit_429.json");
    const err = mapResponseToError(429, JSON.stringify(fixture), {}) as LenzRateLimitError;

    expect(err).toBeInstanceOf(LenzRateLimitError);
    expect(err.message).toBe(fixture["detail"]);
    expect(err.code).toBe(fixture["code"]);
    expect(err.limit).toBe(fixture["limit"]);
    expect(err.resetInSeconds).toBe(fixture["reset_in_seconds"]);
    expect(err.retryAfter).toBe(fixture["reset_in_seconds"]);
    // upgrade_url is on 429 too — the daily /extract cap is lifted by a plan.
    expect(err.upgradeUrl).toBe(fixture["upgrade_url"]);

    const handled = new Set([
      "detail",
      "code",
      "limit",
      "reset_in_seconds",
      "upgrade_url",
      "doc_url",
    ]);
    const unhandled = Object.keys(fixture).filter((k) => !handled.has(k));
    expect(unhandled).toEqual([]);
  });

  // The two 503 shapes (provider exhaustion on the sync endpoints; the
  // admission-control shed on /verify) map to LenzUpstreamUnavailableError —
  // a LenzAPIError subclass so existing handlers keep catching it.
  for (const [fixtureName, expectedCode, expectedRetryAfter] of [
    ["error_upstream_unavailable_503.json", "upstream_unavailable", 90],
    ["error_capacity_503.json", "capacity", 105],
  ] as Array<[string, string, number]>) {
    it(`503 envelope ${fixtureName} maps every field onto LenzUpstreamUnavailableError`, () => {
      const fixture = loadFixture(fixtureName);
      const err = mapResponseToError(
        503,
        JSON.stringify(fixture),
        {},
      ) as LenzUpstreamUnavailableError;

      expect(err).toBeInstanceOf(LenzUpstreamUnavailableError);
      expect(err).toBeInstanceOf(LenzAPIError);
      expect(err.message).toBe(fixture["detail"]);
      expect(err.code).toBe(expectedCode);
      expect(err.retryAfter).toBe(expectedRetryAfter);
      expect(err.body).toEqual(fixture);

      const handled = new Set(["detail", "code", "retry_after", "doc_url"]);
      const unhandled = Object.keys(fixture).filter((k) => !handled.has(k));
      expect(unhandled).toEqual([]);
    });
  }

  it("webhook failed payload maps every field onto VerificationFailed", () => {
    const payload = loadFixture("webhook_payload_failed.json");
    // Fresh delivered_at so the fixture (frozen in time) clears the replay
    // window; the key SET under test is unchanged.
    payload["delivered_at"] = new Date().toISOString();
    const secret = "whsec_test";
    const body = JSON.stringify(payload);
    const signature = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
    const webhooks = new LenzWebhooks({ secret });
    const event = webhooks.parse(body, { "X-Lenz-Signature": signature }) as VerificationFailed;

    expect(event.event).toBe("verification.failed");
    expect(event.error).toBe(payload["error"]);
    expect(event.failureClass).toBe(payload["failure_class"]);
    expect(event.retryable).toBe(payload["retryable"]);
    expect(event.status).toBe("failed");

    // Every payload key is consumed by a typed camelCase attribute (or is one
    // of the always-present-but-null slots that belong to the other events).
    const handled = new Set([
      "event",
      "task_id",
      "attempt",
      "delivered_at",
      "verification_id",
      "batch_id",
      "status",
      "error",
      "failure_class",
      "retryable",
      "result",
      "needs_input",
    ]);
    const unhandled = Object.keys(payload).filter((k) => !handled.has(k));
    expect(unhandled).toEqual([]);
  });
});
