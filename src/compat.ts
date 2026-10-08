/**
 * Reads both shapes of the API's responses.
 *
 * The API serves each response in one of two shapes, chosen per request by
 * the `X-Lenz-API-Version` header: the original one (`2026-05-13`, the
 * version this SDK sends) and a newer one with one name for each field across
 * every endpoint. Every function here takes a body in EITHER shape and
 * returns a copy that carries both sets of names:
 *
 * - the newer names (`claim`, `more_claims`, `completed_at`, `failure`, the
 *   row `status`, `claim_limit_exceeded`, ...), filled from the original
 *   fields when the original shape arrived;
 * - the original names, kept with their original meaning (a failed `/assess`
 *   row reads `verdict: "Error"`, `confidence: "low"`; `not_a_claim` /
 *   `no_claim` where the newer shape says `no_checkable_claim`; `modified_at`
 *   by its later-calendar-day rule), filled from the newer fields when the
 *   newer shape arrived.
 *
 * A key the server sent is never overwritten. Nothing here throws: a value
 * of an unexpected type is passed through untouched.
 */

type Obj = Record<string, unknown>;

/** The newer shape's one code for "nothing in the input can be checked". */
export const NO_CHECKABLE_CLAIM = "no_checkable_claim";

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** The original word for `no_checkable_claim`: `not_a_claim` or `no_claim`, by endpoint. */
function legacyCode(code: unknown, word: "not_a_claim" | "no_claim"): string | null {
  if (typeof code !== "string") return null;
  return code === NO_CHECKABLE_CLAIM ? word : code;
}

/** The newer word for an original `not_a_claim` / `no_claim`. */
function canonicalCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  return code === "not_a_claim" || code === "no_claim" ? NO_CHECKABLE_CLAIM : code;
}

/**
 * A failure block in either shape, with both `code` (newer) and
 * `failure_reason` (original), and `detail` (`null` when the original shape
 * carried no sentence).
 */
export function normalizeFailureBlock(
  block: unknown,
  word: "not_a_claim" | "no_claim" = "no_claim",
): unknown {
  if (!isObj(block)) return block;
  const out: Obj = { ...block };
  if (out["code"] === undefined) out["code"] = canonicalCode(out["failure_reason"]);
  if (out["failure_reason"] === undefined) out["failure_reason"] = legacyCode(out["code"], word);
  if (out["detail"] === undefined) out["detail"] = null;
  return out;
}

/** The original `/assess` row's hint on a compound item, assessed on its main claim. */
const COMPOUND_HINT =
  "Assessed the main claim only. Send identified_claims as their own items to check the rest.";

// What the original /assess row says about each of its documented causes.
const ASSESS_CAUSES: Record<string, { failure_class: string; retryable: boolean }> = {
  no_claim: { failure_class: "invalid_input", retryable: false },
  framing_failed: { failure_class: "invalid_input", retryable: false },
  upstream_unavailable: { failure_class: "upstream_unavailable", retryable: true },
  timeout: { failure_class: "upstream_unavailable", retryable: true },
};

function assessFailureFromLegacy(errorCode: unknown, detail: unknown, hint: unknown): Obj {
  const cause = typeof errorCode === "string" ? ASSESS_CAUSES[errorCode] : undefined;
  return {
    code: canonicalCode(errorCode),
    detail: str(detail),
    hint: str(hint),
    failure_class: cause?.failure_class ?? null,
    retryable: cause?.retryable ?? null,
    docs_url: null,
  };
}

/** One `/assess` row. */
export function normalizeAssessRow(row: unknown): unknown {
  if (!isObj(row)) return row;
  const out: Obj = { ...row };
  const failed = out["status"] === "failed" || out["verdict"] === "Error";
  if (
    out["status"] === undefined &&
    (out["verdict"] !== undefined || out["failure"] !== undefined)
  ) {
    out["status"] = failed ? "failed" : "completed";
  }
  if (out["failure"] === undefined) {
    out["failure"] = failed ? assessFailureFromLegacy(out["error_code"], null, out["hint"]) : null;
  }
  out["failure"] = normalizeFailureBlock(out["failure"], "no_claim");
  const failure = isObj(out["failure"]) ? out["failure"] : null;
  if (failed) {
    // The original meaning: a row without a verdict reads "Error", "low".
    if (out["verdict"] === null || out["verdict"] === undefined) out["verdict"] = "Error";
    if (out["confidence"] === null || out["confidence"] === undefined) out["confidence"] = "low";
  }
  if (out["error_code"] === undefined) {
    out["error_code"] = failed ? legacyCode(failure?.["code"], "no_claim") : null;
  }
  if (out["hint"] === undefined) {
    const more = out["more_claims"];
    out["hint"] = failed
      ? (str(failure?.["hint"]) ?? null)
      : Array.isArray(more) && more.length > 0
        ? COMPOUND_HINT
        : null;
  }
  if (out["more_claims"] === undefined) {
    out["more_claims"] = Array.isArray(out["identified_claims"]) ? out["identified_claims"] : [];
  }
  if (out["identified_claims"] === undefined) {
    out["identified_claims"] = Array.isArray(out["more_claims"]) ? out["more_claims"] : [];
  }
  if (out["candidate_claims"] === undefined) out["candidate_claims"] = [];
  return out;
}

/** The `POST /assess` body. */
export function normalizeAssess(body: unknown): unknown {
  if (!isObj(body)) return body;
  const out: Obj = { ...body };
  if (Array.isArray(out["claims"])) out["claims"] = out["claims"].map(normalizeAssessRow);
  if (out["failure"] === undefined) {
    const errorCode = out["error_code"];
    const error = out["error"];
    const hasCode = typeof errorCode === "string" && errorCode !== "";
    const hasError = typeof error === "string" && error !== "";
    out["failure"] = hasCode || hasError ? assessFailureFromLegacy(errorCode, error, null) : null;
  }
  out["failure"] = normalizeFailureBlock(out["failure"], "no_claim");
  const failure = isObj(out["failure"]) ? out["failure"] : null;
  if (out["error"] === undefined) out["error"] = failure ? str(failure["detail"]) : null;
  if (out["error_code"] === undefined && failure) {
    out["error_code"] = legacyCode(failure["code"], "no_claim") ?? "";
  }
  // The original body carried it beside the no-claim answer only.
  if (out["candidate_claims"] === undefined && failure) out["candidate_claims"] = [];
  if (out["more_claims"] === undefined) out["more_claims"] = [];
  return out;
}

/**
 * The `POST /extract` body. `locate` is what the request asked for: the
 * original `locations` is `[]` (not `null`) when a located call returns no
 * claim.
 */
export function normalizeExtract(body: unknown, locate?: boolean): unknown {
  if (!isObj(body)) return body;
  const out: Obj = { ...body };
  if (out["status"] === NO_CHECKABLE_CLAIM) out["status"] = "not_a_claim";
  if (!Array.isArray(out["claims"])) {
    const identified = Array.isArray(out["identified_claims"]) ? out["identified_claims"] : [];
    const claim = str(out["claim"]);
    const texts: unknown[] = identified.length > 0 ? identified : claim ? [claim] : [];
    const locations = Array.isArray(out["locations"]) ? out["locations"] : null;
    out["claims"] = texts.map((text, i) => {
      const located = locations?.[i];
      const positions =
        isObj(located) && Array.isArray(located["positions"]) ? located["positions"] : null;
      return { claim: text, positions };
    });
  }
  const claims = (out["claims"] as unknown[]).filter(isObj);
  if (out["claim"] === undefined) out["claim"] = str(claims[0]?.["claim"]) ?? "";
  if (out["identified_claims"] === undefined) {
    out["identified_claims"] = claims.length > 1 ? claims.map((c) => c["claim"]) : [];
  }
  if (out["candidate_claims"] === undefined) out["candidate_claims"] = [];
  if (out["locations"] === undefined) {
    const located = claims.some((c) => c["positions"] !== null && c["positions"] !== undefined);
    out["locations"] = located
      ? claims.map((c) => ({ claim: c["claim"], positions: c["positions"] ?? null }))
      : locate === true && claims.length === 0
        ? []
        : null;
  }
  return out;
}

/** An item of a `/verify/batch` or `/select` receipt, or a `needs_input` option. */
function withClaimAndAlias(item: unknown, alias: "claim_text" | "text"): unknown {
  if (!isObj(item)) return item;
  const out: Obj = { ...item };
  if (out["claim"] === undefined && out[alias] !== undefined) out["claim"] = out[alias];
  if (out[alias] === undefined && out["claim"] !== undefined) out[alias] = out["claim"];
  return out;
}

/** The `/verify/batch` and `/select` receipt. */
export function normalizeBatchAccepted(body: unknown): unknown {
  if (!isObj(body) || !Array.isArray(body["items"])) return body;
  return { ...body, items: body["items"].map((it) => withClaimAndAlias(it, "claim_text")) };
}

/**
 * `modified_at` with its original rule: the completion time when the
 * verification finished on a later UTC calendar day than it was created,
 * else `null`.
 */
export function legacyModifiedAt(createdAt: unknown, completedAt: unknown): string | null {
  if (typeof createdAt !== "string" || typeof completedAt !== "string") return null;
  const created = new Date(createdAt);
  const completed = new Date(completedAt);
  if (Number.isNaN(created.getTime()) || Number.isNaN(completed.getTime())) return null;
  return completed.toISOString().slice(0, 10) > created.toISOString().slice(0, 10)
    ? completedAt
    : null;
}

/** A verification (detail, list item, a review's deep check, a webhook result). */
export function normalizeVerification(v: unknown): unknown {
  if (!isObj(v)) return v;
  if (v["modified_at"] !== undefined || v["completed_at"] === undefined) return v;
  return { ...v, modified_at: legacyModifiedAt(v["created_at"], v["completed_at"]) };
}

/** A page of verifications (`verifications.list`, `library.list`). */
export function normalizeVerificationList(body: unknown): unknown {
  if (!isObj(body) || !Array.isArray(body["items"])) return body;
  return { ...body, items: body["items"].map(normalizeVerification) };
}

/** A `GET /verify/status/{task_id}` body (and the body a verification webhook carries). */
export function normalizeTaskStatus(body: unknown): unknown {
  if (!isObj(body)) return body;
  const out: Obj = { ...body };
  if (out["result"] !== undefined) out["result"] = normalizeVerification(out["result"]);
  if (Array.isArray(out["claims"])) {
    out["claims"] = out["claims"].map((c) => withClaimAndAlias(c, "text"));
  }
  if (out["status"] !== "failed") return out;
  if (out["failure"] === undefined) {
    out["failure"] = {
      code: canonicalCode(out["failure_reason"]),
      detail: str(out["error"]) ?? str(out["failure_detail"]),
      hint: str(out["hint"]),
      failure_class: str(out["failure_class"]),
      retryable: typeof out["retryable"] === "boolean" ? out["retryable"] : null,
      docs_url: str(out["docs_url"]),
    };
  }
  out["failure"] = normalizeFailureBlock(out["failure"], "not_a_claim");
  const failure = out["failure"];
  if (!isObj(failure)) return out;
  if (out["error"] === undefined && typeof failure["detail"] === "string") {
    out["error"] = failure["detail"];
  }
  if (out["failure_reason"] === undefined && typeof failure["failure_reason"] === "string") {
    out["failure_reason"] = failure["failure_reason"];
  }
  for (const key of ["failure_class", "docs_url", "hint"]) {
    if (out[key] === undefined && typeof failure[key] === "string") out[key] = failure[key];
  }
  if (out["retryable"] === undefined && typeof failure["retryable"] === "boolean") {
    out["retryable"] = failure["retryable"];
  }
  return out;
}

/** The capabilities `/me/usage` projects the pool into. */
const PROJECTED = ["verify", "ask", "assess"] as const;

/** The `GET /me/usage` body. */
export function normalizeUsage(body: unknown): unknown {
  if (!isObj(body)) return body;
  const out: Obj = { ...body };
  const credits = isObj(out["credits"]) ? { ...out["credits"] } : null;
  if (credits) {
    // `credits.extra` and its old name `credits.bonus` are the same number.
    if (credits["extra"] == null && credits["bonus"] != null) credits["extra"] = credits["bonus"];
    else if (credits["bonus"] == null && credits["extra"] != null)
      credits["bonus"] = credits["extra"];
    out["credits"] = credits;
    if (out["quota_resets_at"] === undefined) out["quota_resets_at"] = credits["resets_at"] ?? null;
  }
  const costs = isObj(out["costs"]) ? out["costs"] : {};
  for (const cap of PROJECTED) {
    if (out[cap] === undefined && credits) {
      const cost = costs[cap];
      const total = credits["total"];
      const remaining = credits["remaining"];
      const extra = credits["extra"];
      if (
        typeof cost === "number" &&
        cost > 0 &&
        typeof total === "number" &&
        typeof remaining === "number"
      ) {
        // The original projection: each figure divided by the capability's
        // price, floored; `quota_used` derived so used + remaining = total.
        const quotaTotal = Math.floor(total / cost);
        const quotaRemaining = Math.floor(remaining / cost);
        const bonus = typeof extra === "number" ? Math.floor(extra / cost) : 0;
        out[cap] = {
          quota_used: quotaTotal - quotaRemaining,
          quota_total: quotaTotal,
          quota_remaining: quotaRemaining,
          bonus,
          credits: bonus,
          remaining: quotaRemaining,
        };
      }
    }
  }
  return out;
}

/** Replace `obj[key]` with `fn(obj[key])`, only when the key is there. */
function update(obj: Obj, key: string, fn: (v: unknown) => unknown): void {
  if (obj[key] !== undefined) obj[key] = fn(obj[key]);
}

function mapList(fn: (item: unknown) => unknown): (v: unknown) => unknown {
  return (v) => (Array.isArray(v) ? v.map(fn) : v);
}

function withFailure(v: unknown): unknown {
  if (!isObj(v) || v["failure"] === undefined) return v;
  return { ...v, failure: normalizeFailureBlock(v["failure"]) };
}

/** `citation_limit_reached` and `citation_limit_exceeded`: one rule, two names. */
function citationLimitBothNames(s: Obj): void {
  if (s["citation_limit_exceeded"] === undefined && s["citation_limit_reached"] !== undefined) {
    s["citation_limit_exceeded"] = s["citation_limit_reached"];
  }
  if (s["citation_limit_reached"] === undefined && s["citation_limit_exceeded"] !== undefined) {
    s["citation_limit_reached"] = s["citation_limit_exceeded"];
  }
}

/** A review's summary: `claims_found` and `claim_limit_*` in both readings. */
function normalizeReviewSummary(summary: unknown, moreClaims: unknown): unknown {
  if (!isObj(summary)) return summary;
  const s: Obj = { ...summary };
  const limit = s["claim_limit"];
  if (s["claims_found"] === undefined) {
    // What was selected plus what was left out.
    const selected = s["claims_selected"];
    s["claims_found"] =
      typeof selected === "number" && Array.isArray(moreClaims)
        ? selected + moreClaims.length
        : null;
  }
  const found = s["claims_found"];
  const counted = typeof found === "number" && typeof limit === "number";
  if (s["claim_limit_reached"] === undefined) {
    // The original rule: the draft held at least `claim_limit` claims.
    s["claim_limit_reached"] = counted
      ? (found as number) >= (limit as number)
      : s["claim_limit_exceeded"] === true
        ? true
        : null;
  }
  if (s["claim_limit_exceeded"] === undefined) {
    // Some claims were left out: more than `claim_limit` were found.
    s["claim_limit_exceeded"] = counted
      ? (found as number) > (limit as number)
      : s["claim_limit_reached"] === false
        ? false
        : null;
  }
  citationLimitBothNames(s);
  return s;
}

function normalizeCitationRows(b: Obj): void {
  update(
    b,
    "citations",
    mapList((row) => {
      if (!isObj(row) || !isObj(row["check"])) return row;
      return { ...row, check: withFailure(row["check"]) };
    }),
  );
  update(b, "citation_issues", mapList(withFailure));
  update(b, "citation_failures", mapList(withFailure));
}

function normalizeReviewAssessment(a: unknown): unknown {
  if (!isObj(a)) return a;
  const out = withFailure(a) as Obj;
  if (out["more_claims"] === undefined) {
    out["more_claims"] = Array.isArray(out["identified_claims"]) ? out["identified_claims"] : [];
  }
  if (out["identified_claims"] === undefined) {
    out["identified_claims"] = Array.isArray(out["more_claims"]) ? out["more_claims"] : [];
  }
  if (out["error_code"] === undefined) {
    const failure = out["failure"];
    out["error_code"] = isObj(failure) ? legacyCode(failure["code"], "no_claim") : null;
  }
  if (out["hint"] === undefined) out["hint"] = null;
  return out;
}

/** A review body (either view) in both shapes. Defaults are filled afterwards. */
export function normalizeReview(body: unknown): unknown {
  if (!isObj(body)) return body;
  const b: Obj = { ...body };
  update(b, "summary", (s) => normalizeReviewSummary(s, b["more_claims"]));
  update(b, "failure", (f) => normalizeFailureBlock(f));
  update(b, "failures", mapList(withFailure));
  update(b, "issues", mapList(withFailure));
  update(
    b,
    "claims",
    mapList((row) => {
      if (!isObj(row)) return row;
      const r: Obj = { ...row };
      update(r, "assessment", normalizeReviewAssessment);
      if (isObj(r["verification"])) {
        r["verification"] = withFailure(normalizeVerification(r["verification"]));
      }
      return r;
    }),
  );
  normalizeCitationRows(b);
  return b;
}

/** A citation check body in both shapes. Defaults are filled afterwards. */
export function normalizeCitecheck(body: unknown): unknown {
  if (!isObj(body)) return body;
  const b: Obj = { ...body };
  update(b, "summary", (summary) => {
    if (!isObj(summary)) return summary;
    const s: Obj = { ...summary };
    citationLimitBothNames(s);
    return s;
  });
  update(b, "failure", (f) => normalizeFailureBlock(f));
  normalizeCitationRows(b);
  return b;
}
