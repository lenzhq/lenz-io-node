/**
 * Reads both shapes of the API's responses.
 *
 * The API serves each response in one of two shapes, chosen per request by
 * the `X-Lenz-API-Version` header: the original one (`2026-05-13`, the
 * version this SDK sends) and a newer one with one name for each field across
 * every endpoint.
 *
 * Every function here recognises the newer shape only by what that shape
 * alone carries (per response type, below). Then:
 *
 * - a body in the NEWER shape gains the original names with their original
 *   meaning (a failed `/assess` row reads `verdict: "Error"`,
 *   `confidence: "low"`; `not_a_claim` / `no_claim` where the newer shape
 *   says `no_checkable_claim`; `modified_at` by its later-calendar-day rule;
 *   extract's `status` reads `not_a_claim`). These are the only values ever
 *   replaced, and only on a body in the newer shape;
 * - a body in the ORIGINAL shape keeps every key and value as the server
 *   sent it, and only gains the newer names it lacks (`claims` on extract,
 *   `status` / `failure` / `more_claims` on an assess row, ...).
 *
 * Nothing here throws: a value of an unexpected type is passed through.
 */

type Obj = Record<string, unknown>;

/** The newer shape's one code for "nothing in the input can be checked". */
export const NO_CHECKABLE_CLAIM = "no_checkable_claim";

/** The original `/assess` row's hint on a compound item, assessed on its main claim. */
const COMPOUND_HINT =
  "Assessed the main claim only. Send identified_claims as their own items to check the rest.";

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function has(o: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** Set `o[key]` only when the key is not there. */
function fill(o: Obj, key: string, value: unknown): void {
  if (!has(o, key)) o[key] = value;
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

// ── Failure blocks ──

/** The newer shape names the cause `code`; the original, `failure_reason`. */
function isNewFailureBlock(f: Obj): boolean {
  return has(f, "code") && !has(f, "failure_reason");
}

/**
 * A failure block with both `code` and `failure_reason`. The newer shape
 * gains `failure_reason` (original words); the original gains `code` and
 * `detail` (`null`: it carried no sentence).
 */
export function normalizeFailureBlock(
  block: unknown,
  word: "not_a_claim" | "no_claim" = "no_claim",
): unknown {
  if (!isObj(block)) return block;
  const out: Obj = { ...block };
  if (isNewFailureBlock(block)) {
    out["failure_reason"] = legacyCode(block["code"], word);
  } else {
    fill(out, "code", canonicalCode(block["failure_reason"]));
    fill(out, "detail", null);
  }
  return out;
}

// What the original /assess row says about each of its documented causes.
const ASSESS_CAUSES: Record<string, { failure_class: string; retryable: boolean }> = {
  no_claim: { failure_class: "invalid_input", retryable: false },
  framing_failed: { failure_class: "invalid_input", retryable: false },
  upstream_unavailable: { failure_class: "upstream_unavailable", retryable: true },
  timeout: { failure_class: "upstream_unavailable", retryable: true },
};

/** A newer-shape failure block built from an original `/assess` row or body. */
function assessFailureFromLegacy(errorCode: unknown, detail: unknown, hint: unknown): Obj {
  const cause = typeof errorCode === "string" ? ASSESS_CAUSES[errorCode] : undefined;
  return {
    code: canonicalCode(errorCode),
    detail: str(detail),
    hint: str(hint),
    failure_class: cause?.failure_class ?? null,
    retryable: cause?.retryable ?? null,
    docs_url: null,
    failure_reason: str(errorCode),
  };
}

// ── /assess ──

/** A newer-shape row carries `failure` (and no `error_code`). */
function isNewAssessRow(row: Obj): boolean {
  return has(row, "failure") && !has(row, "error_code");
}

/** One `/assess` row. */
export function normalizeAssessRow(row: unknown): unknown {
  if (!isObj(row)) return row;
  const out: Obj = { ...row };
  if (isNewAssessRow(row)) {
    const failed = row["status"] === "failed";
    const failure = normalizeFailureBlock(row["failure"], "no_claim");
    out["failure"] = failure;
    const f = isObj(failure) ? failure : null;
    if (failed) {
      if (row["verdict"] === null || row["verdict"] === undefined) out["verdict"] = "Error";
      if (row["confidence"] === null || row["confidence"] === undefined) out["confidence"] = "low";
    }
    const more = Array.isArray(row["more_claims"]) ? row["more_claims"] : [];
    fill(out, "error_code", failed ? legacyCode(f?.["code"], "no_claim") : null);
    fill(out, "hint", failed ? (str(f?.["hint"]) ?? null) : more.length > 0 ? COMPOUND_HINT : null);
    fill(out, "identified_claims", more);
    fill(out, "candidate_claims", []);
    return out;
  }
  // The original shape: only the newer names are added.
  const failed = row["verdict"] === "Error";
  fill(out, "status", failed ? "failed" : "completed");
  fill(
    out,
    "failure",
    failed ? assessFailureFromLegacy(row["error_code"], null, row["hint"]) : null,
  );
  if (Array.isArray(row["identified_claims"])) fill(out, "more_claims", row["identified_claims"]);
  return out;
}

/** A newer-shape `/assess` body carries `failure` (and no `error`). */
function isNewAssess(body: Obj): boolean {
  return has(body, "failure") && !has(body, "error");
}

/** The `POST /assess` body. */
export function normalizeAssess(body: unknown): unknown {
  if (!isObj(body)) return body;
  const out: Obj = { ...body };
  if (Array.isArray(body["claims"])) out["claims"] = body["claims"].map(normalizeAssessRow);
  const rows = (Array.isArray(out["claims"]) ? out["claims"] : []).filter(isObj);
  if (isNewAssess(body)) {
    const failure = normalizeFailureBlock(body["failure"], "no_claim");
    out["failure"] = failure;
    if (isObj(failure)) {
      fill(out, "error", str(failure["detail"]));
      fill(out, "error_code", legacyCode(failure["code"], "no_claim") ?? "");
      fill(out, "candidate_claims", []);
    } else {
      fill(out, "error", null);
    }
  } else {
    const errorCode = body["error_code"];
    const error = body["error"];
    const hasCode = typeof errorCode === "string" && errorCode !== "";
    const hasError = typeof error === "string" && error !== "";
    fill(
      out,
      "failure",
      hasCode || hasError ? assessFailureFromLegacy(errorCode, error, null) : null,
    );
  }
  // `ok` when a row has a verdict; `no_checkable_claim` for nothing checkable;
  // else `error`. The server's own value wins when it sends one.
  const failure = isObj(out["failure"]) ? out["failure"] : null;
  fill(
    out,
    "status",
    rows.some((r) => r["status"] !== "failed")
      ? "ok"
      : failure?.["code"] === NO_CHECKABLE_CLAIM
        ? NO_CHECKABLE_CLAIM
        : "error",
  );
  return out;
}

// ── /extract ──

/** A newer-shape `/extract` body carries `claims` (and none of the original names). */
function isNewExtract(body: Obj): boolean {
  return Array.isArray(body["claims"]) && !has(body, "identified_claims") && !has(body, "claim");
}

/**
 * The `POST /extract` body. `locate` is what the request asked for: the
 * original `locations` is `[]` (not `null`) when a located call returns no
 * claim.
 */
export function normalizeExtract(body: unknown, locate?: boolean): unknown {
  if (!isObj(body)) return body;
  const out: Obj = { ...body };
  if (isNewExtract(body)) {
    const claims = (body["claims"] as unknown[]).filter(isObj);
    if (body["status"] === NO_CHECKABLE_CLAIM) out["status"] = "not_a_claim";
    fill(out, "claim", str(claims[0]?.["claim"]) ?? "");
    fill(out, "identified_claims", claims.length > 1 ? claims.map((c) => c["claim"]) : []);
    fill(out, "candidate_claims", []);
    const located = claims.some((c) => c["positions"] !== null && c["positions"] !== undefined);
    fill(
      out,
      "locations",
      located
        ? claims.map((c) => ({ claim: c["claim"], positions: c["positions"] ?? null }))
        : locate === true && claims.length === 0
          ? []
          : null,
    );
    return out;
  }
  if (!has(body, "claims")) {
    const identified = Array.isArray(body["identified_claims"]) ? body["identified_claims"] : [];
    const claim = str(body["claim"]);
    const texts: unknown[] = identified.length > 0 ? identified : claim ? [claim] : [];
    const locations = Array.isArray(body["locations"]) ? body["locations"] : null;
    out["claims"] = texts.map((text, i) => {
      const at = locations?.[i];
      const positions = isObj(at) && Array.isArray(at["positions"]) ? at["positions"] : null;
      return { claim: text, positions };
    });
  }
  return out;
}

// ── Receipts and options ──

/** `claim` beside its original name (`claim_text` / `text`), by which one is there. */
function withClaimAndAlias(item: unknown, alias: "claim_text" | "text"): unknown {
  if (!isObj(item)) return item;
  const out: Obj = { ...item };
  if (has(item, "claim") && !has(item, alias)) out[alias] = item["claim"];
  else if (has(item, alias)) fill(out, "claim", item[alias]);
  return out;
}

/** The `/verify/batch` and `/select` receipt. */
export function normalizeBatchAccepted(body: unknown): unknown {
  if (!isObj(body) || !Array.isArray(body["items"])) return body;
  return { ...body, items: body["items"].map((it) => withClaimAndAlias(it, "claim_text")) };
}

/** The options of a `needs_input` pause. */
export function normalizeOptions(claims: unknown): unknown {
  return Array.isArray(claims) ? claims.map((c) => withClaimAndAlias(c, "text")) : claims;
}

// ── Verifications ──

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

/** A newer-shape verification carries `completed_at` (and no `modified_at`). */
function isNewVerification(v: unknown): v is Obj {
  return isObj(v) && has(v, "completed_at") && !has(v, "modified_at");
}

/** A verification (detail, list item, a review's deep check, a webhook result). */
export function normalizeVerification(v: unknown): unknown {
  if (!isNewVerification(v)) return v;
  return { ...v, modified_at: legacyModifiedAt(v["created_at"], v["completed_at"]) };
}

/** A page of verifications (`verifications.list`, `library.list`). */
export function normalizeVerificationList(body: unknown): unknown {
  if (!isObj(body) || !Array.isArray(body["items"])) return body;
  if (!body["items"].some(isNewVerification)) return body;
  return { ...body, items: body["items"].map(normalizeVerification) };
}

// ── /verify/status ──

/** A newer-shape failed status carries `failure` (and none of the flat fields). */
function isNewFailedStatus(body: Obj): boolean {
  return isObj(body["failure"]) && !has(body, "failure_reason") && !has(body, "error");
}

/** A `GET /verify/status/{task_id}` body (and the body a verification webhook carries). */
export function normalizeTaskStatus(body: unknown): unknown {
  if (!isObj(body)) return body;
  const out: Obj = { ...body };
  if (has(body, "result")) out["result"] = normalizeVerification(body["result"]);
  if (Array.isArray(body["claims"])) out["claims"] = normalizeOptions(body["claims"]);
  if (body["status"] !== "failed") return out;
  if (isNewFailedStatus(body)) {
    const failure = normalizeFailureBlock(body["failure"], "not_a_claim") as Obj;
    out["failure"] = failure;
    if (typeof failure["detail"] === "string") fill(out, "error", failure["detail"]);
    if (typeof failure["failure_reason"] === "string") {
      fill(out, "failure_reason", failure["failure_reason"]);
    }
    for (const key of ["failure_class", "docs_url", "hint"]) {
      if (typeof failure[key] === "string") fill(out, key, failure[key]);
    }
    if (typeof failure["retryable"] === "boolean") fill(out, "retryable", failure["retryable"]);
    return out;
  }
  fill(out, "failure", {
    code: canonicalCode(body["failure_reason"]),
    detail: str(body["error"]) ?? str(body["failure_detail"]),
    hint: str(body["hint"]),
    failure_class: str(body["failure_class"]),
    retryable: typeof body["retryable"] === "boolean" ? body["retryable"] : null,
    docs_url: str(body["docs_url"]),
    failure_reason: str(body["failure_reason"]),
  });
  return out;
}

// ── /me/usage ──

/** The capabilities `/me/usage` projects the pool into. */
const PROJECTED = ["verify", "ask", "assess"] as const;

/** A newer-shape `/me/usage` body has the pool but none of the original projections. */
function isNewUsage(body: Obj): boolean {
  return (
    isObj(body["credits"]) &&
    !has(body, "quota_resets_at") &&
    PROJECTED.every((cap) => !has(body, cap))
  );
}

/**
 * The `GET /me/usage` body. The original shape is handled exactly as this
 * SDK always has (`credits.extra` and `credits.bonus` filled from each
 * other, in place).
 */
export function normalizeUsage(body: unknown): unknown {
  if (!isObj(body)) return body;
  const credits = body["credits"];
  if (!isNewUsage(body)) {
    if (isObj(credits)) {
      if (credits["extra"] == null && credits["bonus"] != null) {
        credits["extra"] = credits["bonus"];
      } else if (credits["bonus"] == null && credits["extra"] != null) {
        credits["bonus"] = credits["extra"];
      }
    }
    return body;
  }
  const out: Obj = { ...body };
  const c: Obj = { ...(credits as Obj) };
  if (c["bonus"] == null && c["extra"] != null) c["bonus"] = c["extra"];
  out["credits"] = c;
  out["quota_resets_at"] = c["resets_at"] ?? null;
  const costs = isObj(body["costs"]) ? body["costs"] : {};
  for (const cap of PROJECTED) {
    const cost = costs[cap];
    const total = c["total"];
    const remaining = c["remaining"];
    const extra = c["extra"];
    if (typeof cost !== "number" || cost <= 0) continue;
    if (typeof total !== "number" || typeof remaining !== "number") continue;
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
  return out;
}

// ── Reviews and citation checks ──

/** Replace `obj[key]` with `fn(obj[key])`, only when the key is there. */
function update(obj: Obj, key: string, fn: (v: unknown) => unknown): void {
  if (has(obj, key)) obj[key] = fn(obj[key]);
}

function mapList(fn: (item: unknown) => unknown): (v: unknown) => unknown {
  return (v) => (Array.isArray(v) ? v.map(fn) : v);
}

function withFailure(v: unknown): unknown {
  if (!isObj(v) || !has(v, "failure")) return v;
  return { ...v, failure: normalizeFailureBlock(v["failure"]) };
}

/** `citation_limit_reached` and `citation_limit_exceeded`: one rule, two names. */
function citationLimitBothNames(s: Obj): void {
  if (has(s, "citation_limit_exceeded")) {
    fill(s, "citation_limit_reached", s["citation_limit_exceeded"]);
  } else if (has(s, "citation_limit_reached")) {
    fill(s, "citation_limit_exceeded", s["citation_limit_reached"]);
  }
}

/** A review's summary: `claims_found` and `claim_limit_*` in both readings. */
function normalizeReviewSummary(summary: unknown, moreClaims: unknown): unknown {
  if (!isObj(summary)) return summary;
  const s: Obj = { ...summary };
  const limit = s["claim_limit"];
  const isNew = has(summary, "claim_limit_exceeded") || has(summary, "claims_found");
  if (!isNew) {
    // What was selected plus what was left out.
    const selected = s["claims_selected"];
    fill(
      s,
      "claims_found",
      typeof selected === "number" && Array.isArray(moreClaims)
        ? selected + moreClaims.length
        : null,
    );
  }
  const found = s["claims_found"];
  const counted = typeof found === "number" && typeof limit === "number";
  if (isNew) {
    // The original rule: the draft held at least `claim_limit` claims.
    fill(
      s,
      "claim_limit_reached",
      counted
        ? (found as number) >= (limit as number)
        : s["claim_limit_exceeded"] === true
          ? true
          : null,
    );
  } else if (has(summary, "claim_limit_reached")) {
    // Some claims were left out: more than `claim_limit` were found.
    fill(
      s,
      "claim_limit_exceeded",
      counted
        ? (found as number) > (limit as number)
        : s["claim_limit_reached"] === false
          ? false
          : null,
    );
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

/** A review's quick check on one claim. */
function normalizeReviewAssessment(a: unknown): unknown {
  if (!isObj(a)) return a;
  const out = withFailure(a) as Obj;
  if (has(a, "more_claims") && !has(a, "identified_claims")) {
    const more = Array.isArray(a["more_claims"]) ? a["more_claims"] : [];
    const failed = a["status"] === "failed";
    const failure = out["failure"];
    fill(out, "identified_claims", more);
    fill(out, "error_code", isObj(failure) ? legacyCode(failure["code"], "no_claim") : null);
    // As on an /assess row: the fixed sentence on a compound row with a verdict.
    fill(out, "hint", !failed && more.length > 0 ? COMPOUND_HINT : null);
  } else if (Array.isArray(a["identified_claims"])) {
    fill(out, "more_claims", a["identified_claims"]);
  }
  return out;
}

/**
 * A review body (either view): a newer-shape part gains the original names;
 * an original-shape part only the newer names. Run before the defaults.
 */
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

/** A citation check body: both names, no defaults. */
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
