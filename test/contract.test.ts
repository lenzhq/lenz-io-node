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
  AssessResponse: new Set(["claims", "error"]),
  AssessClaim: new Set(["claim", "verdict", "confidence", "verification_url"]),
  TaskStatus: new Set([
    "status",
    "reason",
    "progress",
    "result",
    "claims",
    "candidates",
    "similar_claims",
    "failure_reason",
    "failure_detail",
  ]),
  CandidateClaim: new Set(["text", "domain"]),
  Verification: new Set([
    "verification_id",
    "url",
    "claim",
    "domain",
    "entities",
    "presumed_intent",
    "verdict",
    "confidence",
    "confidence_score",
    "lenz_score",
    "executive_summary",
    "warnings",
    "sources",
    "audit",
    "created_at",
    "modified_at",
    "visibility",
  ]),
  EntityRef: new Set(["name", "qid"]),
  Source: new Set(["source_name", "title", "url", "snippet", "stance", "date"]),
  Audit: new Set([
    "adjudication_summary",
    "assessments",
    "debate_pro",
    "debate_con",
    "panel_agreement",
  ]),
  Assessment: new Set([
    "panelist_name",
    "focus_area",
    "score",
    "confidence_score",
    "reasoning",
    "warnings",
  ]),
  DebateSide: new Set(["role", "argument", "rebuttal"]),
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
      errors.push(
        `${path || ifaceName}: unknown server field '${key}' (interface=${ifaceName})`,
      );
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
    ["verifications_detail.json", "Verification"],
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
});
