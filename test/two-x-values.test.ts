/**
 * 2.x code reads the same values from the 2026-10-11 response shape.
 *
 * Each recording in `fixtures/shapes/canonical/` is a response of the API's
 * own contract recordings (`scripts/import-shapes.mjs`), in the shape this
 * release asks for.
 *
 * `fixtures/shapes/oracle/` is what the last 2.x release (2.21.0) handed a
 * caller for the same call (`scenarios.ts`, run once against that release and
 * frozen: `shapes/make-oracles.test.ts`). This release must hand over exactly
 * the same:
 *
 * - every field the 2.x release returned, with the same value (deep, strict
 *   equality: `[]` is not `null`, absent is not `undefined`), in every method
 *   result, error and webhook event;
 * - plus only the newer names (`NEW_NAMES`), which 2.x did not have.
 *
 * The allowances are what the SERVER sends differently in the newer shape and
 * no client can rebuild (`SERVER_DIFFERS`, each with its reason): its own
 * wording and a value it no longer sends.
 *
 * Webhooks are the one place the original shape is still read: a receiver is
 * sent events for work started by any client on the account, so each webhook
 * recording also runs in its original form (`fixtures/shapes/legacy/`, and
 * `older/` for sparser bodies of older servers) and must give the same.
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
  "retryable", // every error (3.0); a failed run's keeps its 2.x value
  "eventId", // every webhook event that carries an event_id (3.0)
  "idempotencyKey", // every error of a call that sent one (3.0)
]);

/**
 * Per recording, the paths (dotted, `*` for an index) the server sends
 * differently in the newer shape, which no client could rebuild from it.
 * Skipped for the newer shape only; the original shape is compared in full.
 * Every entry must still be needed (checked below), so the list cannot hide
 * a difference the SDK could close.
 */
const STATUS_SENTENCE = ["getStatus.value.error", "wait.error.message", "wait.error.cause_"];
const CHAIN_ID = ["value.chain_id"];
const TASK_ID = ["value.taskId"];
const MESSAGE = ["error.message", "error.cause_"];
/**
 * A task cancelled elsewhere. The original shape says `failed` with failure
 * class `cancelled`; the newer shape gives `cancelled` its own status and a
 * failure block only on the nested rows. Waits end the same way (the error is
 * the oracle's, field for field), so what differs is the status object a
 * plain read returns (it states the status and nothing else) and the nested
 * rows' own `failure.detail` sentence.
 */
const CANCELLED_TASK = ["getStatus.value.status"];
const rows = (at: string, ...lists: string[]) => [
  `${at}.status`,
  `${at}.failure`,
  ...lists.map((list) => `${at}.${list}`),
];
const REVIEW_ROWS = ["issues.*.failure.detail", "claims.*.verification.failure.detail"];
const CITECHECK_ROWS = ["citations.*.check.failure.detail", "citation_failures.*.failure.detail"];
const CANCELLED_REVIEW = [
  ...rows("getReview.value", ...REVIEW_ROWS),
  ...rows("getReviewIssues.value", ...REVIEW_ROWS),
  ...rows("reviewAndWait.error.review", ...REVIEW_ROWS),
];
const CANCELLED_CITECHECK = [
  ...rows("getCitecheck.value", ...CITECHECK_ROWS),
  ...rows("citecheckAndWait.error.citecheck", ...CITECHECK_ROWS),
];
// The event is named `*.cancelled`; the original `*.failed` states `failed`.
const CANCELLED_EVENT = ["value.event", "value.status"];
const FAILED_EVENT = [
  "value.failure.detail",
  "value.failure.docs_url",
  "value.verification.failure.detail",
  "value.verification.failure.docs_url",
  "value.verification.error",
  "value.verification.docs_url",
];

const SERVER_DIFFERS: Record<string, string[]> = {
  // A failed check read back from storage said "Pipeline stopped: <code>."
  // (a running one said "Pipeline stopped at: <code>", which is what the SDK
  // rebuilds); the newer shape no longer tells the two apart.
  verify__status_failed_durable: STATUS_SENTENCE,
  verify__status_failed_durable_framing: STATUS_SENTENCE,
  // ... and a stored not-a-claim failure carries its hint, which the
  // original left out.
  verify__status_not_a_claim_durable: [
    ...STATUS_SENTENCE,
    "getStatus.value.hint",
    "wait.error.hint",
  ],
  // The server words the durable not-a-claim hint anew.
  verify__verification_failed_409_not_a_claim_durable: ["error.hint", "error.fix"],
  // A 4xx sentence the server words anew.
  errors__validation_malformed_json: MESSAGE,
  // A failed review's hint the server words anew.
  review__get_failed_every_assessment_failed: [
    "getReview.value.failure.hint",
    "getReviewIssues.value.failure.hint",
    "reviewAndWait.error.fix",
    "reviewAndWait.error.hint",
    "reviewAndWait.error.review.failure.hint",
  ],
  // A row hint the server stored with the review; the newer shape has none.
  review__get_assessment_rows_full_fields: [
    "getReview.value.claims.*.assessment.hint",
    "getReviewIssues.value.claims.*.assessment.hint",
    "reviewAndWait.value.claims.*.assessment.hint",
  ],
  // An extraction the server first read as not a claim, then found one in:
  // the original kept `not_a_claim`, the newer shape says `ready`.
  extract__not_a_claim_beside_claims: ["value.status"],
  // An internal id the newer shape no longer sends (never accepted anywhere).
  verify__submit_202: CHAIN_ID,
  verify__submit_202_options: CHAIN_ID,
  verify__submit_202_text_alias: CHAIN_ID,
  verify__idempotency_key_replay: CHAIN_ID,
  verify__implicit_repeat_replay: CHAIN_ID,
  // Cancelled elsewhere: see CANCELLED_TASK above. The live one's wait also
  // states the original shape's live sentence, which the newer shape no
  // longer tells apart from the stored one.
  verify__status_cancelled_durable: CANCELLED_TASK,
  verify__status_cancelled_live: [
    ...CANCELLED_TASK,
    ...STATUS_SENTENCE,
    // The failure block 3.0 fills states the stored sentence.
    "getStatus.value.failure.detail",
  ],
  review__get_cancelled: CANCELLED_REVIEW,
  citecheck__get_cancelled: CANCELLED_CITECHECK,
  webhook__verification_cancelled: [
    ...CANCELLED_EVENT,
    "value.error",
    "value.failureClass",
    "value.retryable",
    "value.failure",
    "value.verification.status",
    "value.verification.error",
    "value.verification.docs_url",
    "value.verification.failure.detail",
    "value.verification.failure.docs_url",
  ],
  webhook__review_cancelled: [
    ...CANCELLED_EVENT,
    ...rows("value.review", "issues.*.failure.detail", "claims.*.verification.failure.detail"),
    "value.taskId",
  ],
  webhook__citecheck_cancelled: [
    ...CANCELLED_EVENT,
    ...rows("value.citecheck", ...CITECHECK_ROWS),
    "value.taskId",
  ],
  // The delivery id the newer review / citation-check events no longer carry
  // (never pollable; dedupe on `eventId`): `taskId` reads the review /
  // citation-check id instead.
  webhook__review_completed: TASK_ID,
  webhook__review_completed_key_default_url: TASK_ID,
  webhook__review_completed_oversized_rebuilt: TASK_ID,
  webhook__citecheck_completed: TASK_ID,
  // The failure block of a failed event: 2.21 built it from the original
  // flat payload, which carries no sentence, docs link or hint (all null);
  // the newer event carries the server's own, and a run with no failure code
  // says "" where 2.21 said null. A verification event's `verification` is a
  // task status, so it also carries the flat fields a `getStatus` read
  // derives from that block.
  webhook__citecheck_failed: [...TASK_ID, "value.citecheck.failure.detail"],
  webhook__review_failed: [...TASK_ID, "value.review.failure.detail"],
  webhook__verification_failed_error_none: [
    "value.failure.code",
    "value.failure.failure_reason",
    "value.verification.failure.code",
    "value.verification.failure.failure_reason",
    "value.verification.failure_reason",
    ...FAILED_EVENT,
  ],
  webhook__verification_failed_insufficient_evidence: FAILED_EVENT,
  webhook__verification_failed_not_a_claim: [
    ...FAILED_EVENT,
    "value.failure.hint",
    "value.verification.failure.hint",
    "value.verification.hint",
  ],
  webhook__verification_failed_upstream_unavailable: FAILED_EVENT,
};

/**
 * What 3.0 adds on purpose, in any shape (CHANGELOG): a `verification.completed`
 * event's `verification.result` has the same defaults as `result`.
 */
const THREE_X_ADDS: Record<string, string[]> = {
  webhook__older_webhook_payload_completed: [
    "value.verification.result.visibility",
    "value.verification.result.depth",
    "value.verification.result.coverage",
  ],
};

/**
 * 3.0's intentional changes (CHANGELOG "Changed"), applied to the 2.x oracle
 * before it is compared, so nothing else may differ:
 *
 * - a 404 is a `LenzNotFoundError` (a `LenzError`, as before), whose fix says
 *   to check the id instead of to retry;
 * - a wait whose poll answers 404 throws that error at once instead of
 *   polling to its deadline.
 */
const NOT_FOUND_FIX =
  "Check the id or key the call names: nothing with it is visible to this credential. Retrying will not help.";

function intended(oracle: unknown): unknown {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = visit(v);
    if (out["class"] === "LenzError" && out["statusCode"] === 404) {
      out["class"] = "LenzNotFoundError";
      out["name"] = "LenzNotFoundError";
      out["fix"] = NOT_FOUND_FIX;
    }
    return out;
  };
  const o = visit(oracle) as Record<string, Record<string, Record<string, unknown>> | undefined>;
  const polled = o["getStatus"]?.["error"];
  if (o["wait"]?.["error"]?.["class"] === "LenzTimeoutError" && polled?.["statusCode"] === 404) {
    o["wait"]["error"] = polled;
  }
  return o;
}

function pattern(p: string): RegExp {
  // Escape every regex metacharacter, then let `*` stand for an array index.
  const escaped = p.replace(/[\\^$.|?+()[\]{}]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, "\\d+") + "$");
}

function differs(name: string, path: string): boolean {
  return (SERVER_DIFFERS[name] ?? []).some((p) => pattern(p).test(path));
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
      if (
        !(key in o) &&
        !NEW_NAMES.has(key) &&
        !(canonical && differs(name, here(key))) &&
        !(THREE_X_ADDS[name] ?? []).includes(here(key))
      ) {
        out.push(`${here(key)}: unexpected new field`);
      }
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

/** Webhook recordings of older servers (sparser bodies), original shape only. */
const OLDER = new Set(readdirSync(join(ROOT, "older")).map((f) => f.replace(/\.json$/, "")));

describe("both response shapes give what the previous release gave", () => {
  it("every recording has an oracle, and every webhook one has both shapes", () => {
    expect(NAMES.length).toBeGreaterThan(80);
    for (const name of NAMES) {
      if (OLDER.has(name)) continue;
      expect(() => load("canonical", `${name}.json`)).not.toThrow();
      if (name.startsWith("webhook__")) {
        expect(() => load("legacy", `${name}.json`)).not.toThrow();
      }
    }
  });

  for (const name of NAMES) {
    const shapes = OLDER.has(name)
      ? (["older"] as const)
      : name.startsWith("webhook__")
        ? (["legacy", "canonical"] as const)
        : (["canonical"] as const);
    it.each(shapes)(`${name} (%s)`, async (shape) => {
      const recorded = load(shape, `${name}.json`) as Recorded;
      const actual = await runScenario(sdk as unknown as SdkUnderTest, name, recorded);
      const oracle = intended(load("oracle", `${name}.json`));
      expect(differences(actual, oracle, name, shape === "canonical").join("\n")).toBe("");
    });
  }

  it.each(Object.keys(SERVER_DIFFERS))("every allowance for %s is still needed", async (name) => {
    const recorded = load("canonical", `${name}.json`) as Recorded;
    const actual = await runScenario(sdk as unknown as SdkUnderTest, name, recorded);
    const paths = differences(actual, intended(load("oracle", `${name}.json`)), name, false).map(
      (line) => line.slice(0, line.indexOf(": ")),
    );
    const unused = SERVER_DIFFERS[name]!.filter((p) => !paths.some((at) => pattern(p).test(at)));
    expect(unused).toEqual([]);
  });
});
