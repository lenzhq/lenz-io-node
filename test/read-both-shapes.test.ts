/**
 * Both response shapes read the same.
 *
 * The API answers each request in one of two shapes (the original one, which
 * this SDK asks for, and a newer one with one name for each field). Each
 * recording in `fixtures/shapes/legacy/` has its counterpart in
 * `fixtures/shapes/canonical/`, the same response in the newer shape.
 *
 * `fixtures/shapes/oracle/` is what the PREVIOUS release of this SDK handed a
 * caller for each `legacy/` recording (`scenarios.ts`, run once against that
 * release and frozen). This release must hand over exactly the same, from
 * either shape:
 *
 * - every field the previous release returned, with the same value (deep,
 *   strict equality: `[]` is not `null`, `0` is not absent);
 * - plus only the newer names (`NEW_NAMES`), which the previous release did
 *   not have.
 *
 * The one allowance is what the SERVER sends differently in the newer shape
 * and the SDK cannot rebuild (`SERVER_DIFFERS`, newer shape only, each with
 * its reason): its own wording, a code it renamed, an internal id it no
 * longer sends.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";
import { runScenario, type Recorded, type SdkUnderTest } from "./shapes/scenarios.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shapes");

function load(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, dir, file), "utf-8"));
}

/** Keys this release adds beside the ones the previous release returned. */
const NEW_NAMES = new Set([
  "claims", // extract
  "claim", // receipt items, needs_input options, batch results
  "status", // assess rows
  "failure", // assess body and rows, failed task status, verification.failed
  "more_claims", // assess and review rows
  "code", // failure blocks
  "detail", // failure blocks
  "claims_found", // review summary
  "claim_limit_exceeded", // review summary
  "citation_limit_exceeded", // review and citation check summary
  "verification", // verification.* webhook events
  "completed_at", // verifications from the newer shape
]);

/**
 * Per recording, the paths (dotted, `*` for an index) the server sends
 * differently in the newer shape, which no client could rebuild. Skipped for
 * the newer shape only; the original shape is compared in full.
 */
const SERVER_DIFFERS: Record<string, string[]> = {
  // The server's sentence for "nothing checkable" (was a short label).
  assess__single_no_claim: ["value.error"],
  // The failure sentence (was "Pipeline stopped at: <code>").
  verify__status_failed_live: ["getStatus.value.error", "wait.error.message", "wait.error.cause_"],
  verify__status_not_a_claim: ["getStatus.value.error", "wait.error.message", "wait.error.cause_"],
  // The server words the durable not-a-claim hint anew.
  verify__verification_failed_409_not_a_claim_durable: ["error.hint", "error.fix"],
  // A 422 is `{detail: string, code, errors[]}`: the message is the server's
  // sentence (a list `detail` read as "Validation failed"), and `code` /
  // `errors` are what the server now sends.
  errors__validation_missing_field_hint: ["error.message", "error.cause_", "error.code"],
  assess__422_blank_item: ["error.code", "error.errors"],
  // A row hint the server stored with the review; the newer shape has none.
  review__get_assessment_rows_full_fields: [
    "getReview.value.claims.*.assessment.hint",
    "getReviewIssues.value.claims.*.assessment.hint",
    "reviewAndWait.value.claims.*.assessment.hint",
  ],
  // An internal id the newer shape no longer sends (never accepted anywhere).
  verify__submit_202: ["value.chain_id"],
  // The delivery id the newer review / citation-check events no longer carry
  // (never pollable; dedupe on `eventId`): `taskId` reads the review /
  // citation-check id instead.
  webhook__review_failed: ["value.taskId"],
  webhook__review_completed: ["value.taskId"],
  webhook__citecheck_failed: ["value.taskId"],
  webhook__citecheck_completed: ["value.taskId"],
};

function differs(name: string, path: string): boolean {
  return (SERVER_DIFFERS[name] ?? []).some((p) => {
    const re = new RegExp("^" + p.replace(/\./g, "\\.").replace(/\*/g, "\\d+") + "$");
    return re.test(path);
  });
}

/** Every difference from the oracle, as `path: what` lines. */
function differences(
  actual: unknown,
  oracle: unknown,
  name: string,
  canonical: boolean,
  path = "",
): string[] {
  const here = (p: string) => (path ? `${path}.${p}` : p);
  if (canonical && differs(name, path)) return [];
  if (Array.isArray(oracle)) {
    if (!Array.isArray(actual)) return [`${path}: expected a list, got ${JSON.stringify(actual)}`];
    if (actual.length !== oracle.length) {
      return [`${path}: expected ${oracle.length} items, got ${actual.length}`];
    }
    return oracle.flatMap((o, i) => differences(actual[i], o, name, canonical, here(String(i))));
  }
  if (oracle && typeof oracle === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      return [`${path}: expected an object, got ${JSON.stringify(actual)}`];
    }
    const a = actual as Record<string, unknown>;
    const o = oracle as Record<string, unknown>;
    const out: string[] = [];
    for (const key of Object.keys(o)) {
      if (!(key in a) && !(canonical && differs(name, here(key))))
        out.push(`${here(key)}: missing (was ${JSON.stringify(o[key])})`);
      else if (key in a) out.push(...differences(a[key], o[key], name, canonical, here(key)));
    }
    for (const key of Object.keys(a)) {
      if (!(key in o) && !NEW_NAMES.has(key)) out.push(`${here(key)}: unexpected new field`);
    }
    return out;
  }
  if (Object.is(actual, oracle)) return [];
  return [`${path}: expected ${JSON.stringify(oracle)}, got ${JSON.stringify(actual)}`];
}

const NAMES = readdirSync(join(ROOT, "oracle"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

/** Recordings of older servers (sparser bodies), original shape only. */
const OLDER = new Set(readdirSync(join(ROOT, "older")).map((f) => f.replace(/\.json$/, "")));

describe("both response shapes give what the previous release gave", () => {
  it("every recording has an oracle, and both shapes unless it is an older one", () => {
    expect(NAMES.length).toBeGreaterThan(80);
    for (const name of NAMES) {
      if (OLDER.has(name)) continue;
      expect(() => load("legacy", `${name}.json`)).not.toThrow();
      expect(() => load("canonical", `${name}.json`)).not.toThrow();
    }
  });

  for (const name of NAMES) {
    const shapes = OLDER.has(name) ? (["older"] as const) : (["legacy", "canonical"] as const);
    it.each(shapes)(`${name} (%s)`, async (shape) => {
      const recorded = load(shape, `${name}.json`) as Recorded;
      const actual = await runScenario(sdk as unknown as SdkUnderTest, name, recorded);
      const oracle = load("oracle", `${name}.json`);
      expect(differences(actual, oracle, name, shape === "canonical").join("\n")).toBe("");
    });
  }
});
