/**
 * The 2.x names, computed from the API's response.
 *
 * This SDK sends `X-Lenz-API-Version: 2026-10-11`, so every response to its
 * own calls is in that version's shape: one name for each field across every
 * endpoint. Each function here adds the names 2.x releases returned, with the
 * value they had (a failed `/assess` row reads `verdict: "Error"`,
 * `confidence: "low"`; `not_a_claim` / `no_claim` where the response says
 * `no_checkable_claim`; `modified_at` by its later-calendar-day rule;
 * extract's `status` reads `not_a_claim`), and replaces nothing else.
 *
 * The exception is webhooks: a receiver is sent events for work started by
 * any client on the account, including older ones, so the webhook readers
 * (`normalizeWebhookStatus`, `normalizeOptions`, `webhookResultDefaults`)
 * read both the event shape of 3.0 and the original one.
 *
 * The review and citation-check readers below also read both shapes,
 * because the same code builds the bodies of `review.*` / `citecheck.*`
 * webhook events. `legacyErrorBody` is not old-shape parsing: it turns the
 * newer error body into the values 2.x error classes carried.
 *
 * Nothing here throws: a value of an unexpected type is passed through.
 */

type Obj = Record<string, unknown>;

/** The newer shape's one code for "nothing in the input can be checked". */
export const NO_CHECKABLE_CLAIM = "no_checkable_claim";

/** The original `/assess` body's `error` when nothing in it could be checked. */
const LEGACY_NO_CLAIM_ERROR = "No verifiable claim detected";

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

// ── /assess ──

/** One `/assess` row. */
/**
 * The fields of `o` (a copy) whose 3.x type has no `null`, read as not sent
 * when the API sends `null` (a stored replay, a value it has none of), so the
 * 3.x default (absent, or the 2.x value filled below) applies. Only on the
 * default (2.x-named) reading of a call's result; with `legacyAliases: false`
 * the `null` stays, as sent, and webhook events keep it as 2.21 delivered it.
 * Matches the Python SDK for call results.
 */
function nullAsUnsent(o: Obj, names: readonly string[]): Obj {
  for (const name of names) if (o[name] === null) delete o[name];
  return o;
}

function normalizeAssessRow(row: unknown): unknown {
  if (!isObj(row)) return row;
  const out: Obj = nullAsUnsent({ ...row }, ["verdict", "confidence"]);
  const failed = row["status"] === "failed";
  const failure = normalizeFailureBlock(row["failure"], "no_claim");
  if (has(row, "failure")) out["failure"] = failure;
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

/** The `POST /assess` body. */
export function normalizeAssess(body: unknown): unknown {
  if (!isObj(body)) return body;
  const out: Obj = nullAsUnsent({ ...body }, ["error_code"]);
  if (Array.isArray(body["claims"])) out["claims"] = body["claims"].map(normalizeAssessRow);
  const rows = (Array.isArray(out["claims"]) ? out["claims"] : []).filter(isObj);
  const failure = normalizeFailureBlock(body["failure"], "no_claim");
  if (has(body, "failure")) out["failure"] = failure;
  if (isObj(failure)) {
    // The 2.x sentence, whatever `detail` says.
    fill(out, "error", LEGACY_NO_CLAIM_ERROR);
    fill(out, "error_code", legacyCode(failure["code"], "no_claim") ?? "");
    fill(out, "candidate_claims", []);
  } else {
    fill(out, "error", null);
  }
  // `ok` when a row has a verdict; `no_checkable_claim` for nothing checkable;
  // else `error`. The server's own value wins when it sends one.
  fill(
    out,
    "status",
    rows.some((r) => r["status"] !== "failed")
      ? "ok"
      : isObj(failure) && failure["code"] === NO_CHECKABLE_CLAIM
        ? NO_CHECKABLE_CLAIM
        : "error",
  );
  return out;
}

// ── /extract ──

/**
 * The `POST /extract` body. `locate` is what the request asked for: the 2.x
 * `locations` is `[]` (not `null`) when a located call returns no claim.
 */
export function normalizeExtract(body: unknown, locate?: boolean): unknown {
  if (!isObj(body)) return body;
  const out: Obj = { ...body };
  const claims = (Array.isArray(body["claims"]) ? body["claims"] : []).filter(isObj);
  if (body["status"] === NO_CHECKABLE_CLAIM) out["status"] = "not_a_claim";
  fill(out, "claim", str(claims[0]?.["claim"]) ?? "");
  fill(out, "identified_claims", claims.length > 1 ? claims.map((c) => c["claim"]) : []);
  fill(out, "candidate_claims", []);
  // A list only when every claim was located, as 2.x built it.
  const located = claims.length > 0 && claims.every((c) => Array.isArray(c["positions"]));
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

// ── Receipts and options ──

/** The `/verify/batch` and `/select` receipt: each item's `claim` beside `claim_text`. */
export function normalizeBatchAccepted(body: unknown): unknown {
  if (!isObj(body) || !Array.isArray(body["items"])) return body;
  const items = body["items"].map((it) => {
    if (!isObj(it)) return it;
    const out: Obj = { ...it };
    fill(out, "claim_text", it["claim"]);
    return out;
  });
  return { ...body, items };
}

/**
 * The options of a `needs_input` pause, under both names: `claim` and the 2.x
 * `text`. Webhooks only: an event can arrive in either shape, so this fills
 * whichever name is missing.
 */
export function normalizeOptions(claims: unknown, unsent = true): unknown {
  if (!Array.isArray(claims)) return claims;
  return claims.map((c) => {
    if (!isObj(c)) return c;
    const out: Obj = unsent ? nullAsUnsent({ ...c }, ["text"]) : { ...c };
    if (has(c, "claim")) fill(out, "text", c["claim"]);
    else if (has(c, "text")) fill(out, "claim", c["text"]);
    return out;
  });
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
  const named = entityNames(v);
  if (!isNewVerification(named)) return named;
  return { ...named, modified_at: legacyModifiedAt(named["created_at"], named["completed_at"]) };
}

/** `v` with an entity's `name` sent as `null` read as `""`, its 3.x default (Python's too). */
function entityNames(v: unknown): unknown {
  if (!isObj(v) || !Array.isArray(v["entities"])) return v;
  const entities = v["entities"] as unknown[];
  if (!entities.some((e) => isObj(e) && e["name"] === null)) return v;
  return {
    ...v,
    entities: entities.map((e) => (isObj(e) && e["name"] === null ? { ...e, name: "" } : e)),
  };
}

/** `o` with every missing key of `defaults` (each a fresh copy). */
function withDefaults(o: Obj, defaults: Obj): Obj {
  const out: Obj = { ...o };
  for (const [key, value] of Object.entries(defaults)) {
    if (!has(out, key))
      out[key] = value !== null && typeof value === "object" ? structuredClone(value) : value;
  }
  return out;
}

const DEBATE_SIDE = { role: "", argument: "", rebuttal: "" };
const SOURCE = {
  source_name: "",
  title: "",
  url: "",
  snippet: "",
  date: "",
};
const ASSESSMENT = {
  panelist_name: "",
  focus_area: "",
  score: null,
  reasoning: "",
  warnings: [],
};
const COVERAGE = {
  status: "uncovered",
  reasons: [],
  certificate_id: null,
  certificate_url: null,
  as_of: null,
  currency: "",
  cap: 0,
  aggregate: 0,
  terms_version: "",
};
const AUDIT = {
  adjudication_summary: "",
  assessments: [],
  debate_pro: DEBATE_SIDE,
  debate_con: DEBATE_SIDE,
  panel_agreement: "",
};
const VERIFICATION = {
  visibility: "private",
  depth: "standard",
  domain: "",
  entities: [],
  presumed_intent: "",
  verdict: "",
  confidence: "low",
  lenz_score: null,
  key_finding: "",
  executive_summary: "",
  warnings: [],
  suggested_rewrite: null,
  created_at: "",
  sources: [],
  audit: AUDIT,
  coverage: null,
};

const eachObj = (v: unknown, fn: (o: Obj) => Obj): unknown =>
  Array.isArray(v) ? v.map((item) => (isObj(item) ? fn(item) : item)) : v;

/**
 * A `verification.completed` webhook's result with every field the original
 * event carried, filled with its default where the newer event leaves it out
 * (the newer event sends the result as stored; the original one sent every
 * field), and `modified_at` by its original rule.
 */
export function webhookResultDefaults(result: unknown): unknown {
  const normalized = normalizeVerification(result);
  if (!isObj(normalized)) return normalized;
  const out = withDefaults(normalized, { ...VERIFICATION, modified_at: null });
  out["entities"] = eachObj(out["entities"], (e) => withDefaults(e, { qid: null }));
  out["sources"] = eachObj(out["sources"], (src) => withDefaults(src, SOURCE));
  if (isObj(out["audit"])) {
    const audit = withDefaults(out["audit"], AUDIT);
    audit["assessments"] = eachObj(audit["assessments"], (a) => withDefaults(a, ASSESSMENT));
    for (const side of ["debate_pro", "debate_con"]) {
      if (isObj(audit[side])) audit[side] = withDefaults(audit[side] as Obj, DEBATE_SIDE);
    }
    out["audit"] = audit;
  }
  if (isObj(out["coverage"])) out["coverage"] = withDefaults(out["coverage"], COVERAGE);
  return out;
}

/** A page of verifications (`verifications.list`, `library.list`). */
export function normalizeVerificationList(body: unknown): unknown {
  if (!isObj(body) || !Array.isArray(body["items"])) return body;
  if (!body["items"].some(isNewVerification)) return body;
  return { ...body, items: body["items"].map(normalizeVerification) };
}

// ── /verify/status ──

/** The original poll's fixed `error` sentences, by failure code. */
const LEGACY_STATUS_ERROR: Record<string, string> = {
  cancelled: "Cancelled.",
  task_stuck: "The task was never completed and has been marked failed.",
  task_error: "Pipeline failed.",
  not_a_claim: "Not a verifiable claim.",
};

/**
 * A failed poll's original `error`: its fixed sentence for the codes that had
 * one, else "Pipeline stopped at: <code>" (the form a running check's failure
 * took; a failure read back from storage said "Pipeline stopped: <code>.").
 * The newer shape's sentence when there is no code.
 */
function legacyStatusError(code: unknown, detail: unknown): string | null {
  if (typeof code === "string" && code) {
    return has(LEGACY_STATUS_ERROR, code)
      ? LEGACY_STATUS_ERROR[code]!
      : `Pipeline stopped at: ${code}`;
  }
  return str(detail);
}

/** The sentence of a task cancelled elsewhere (the stored original's `error`). */
export const CANCELLED_SENTENCE = "Cancelled.";
export const CANCELLED_DOCS_URL = "https://lenz.io/docs/errors#cancelled";

/** A `GET /verify/status/{task_id}` body (and the body a 3.0 verification webhook carries). */
export function normalizeTaskStatus(body: unknown, unsent = true): unknown {
  if (!isObj(body)) return body;
  const out: Obj = nullAsUnsent(
    { ...body },
    !unsent
      ? []
      : [
          "reason",
          "hint",
          "progress",
          "claims",
          "docs_url",
          "error",
          "failure_class",
          "failure_reason",
        ],
  );
  if (has(body, "result")) out["result"] = normalizeVerification(body["result"]);
  if (Array.isArray(out["claims"])) out["claims"] = normalizeOptions(out["claims"], unsent);
  if (body["status"] === "cancelled") {
    // The newer shape's own status for a task cancelled elsewhere; the
    // original said `failed` with failure class `cancelled`. The 2.x flat
    // fields stay readable, so code that branches on `retryable` or
    // `failure_class` sees what it saw.
    fill(out, "error", CANCELLED_SENTENCE);
    fill(out, "failure_reason", "cancelled");
    fill(out, "failure_class", "cancelled");
    fill(out, "retryable", false);
    fill(out, "docs_url", CANCELLED_DOCS_URL);
    // And the failure block 2.x code reads (`status_detail.failure.code`),
    // as 2.21 built it for a run cancelled while it was running.
    if (!isObj(out["failure"])) {
      out["failure"] = {
        code: "cancelled",
        detail: CANCELLED_SENTENCE,
        hint: null,
        failure_class: "cancelled",
        retryable: false,
        docs_url: CANCELLED_DOCS_URL,
        failure_reason: "cancelled",
      };
    }
    return out;
  }
  if (body["status"] !== "failed") return out;
  if (isObj(body["failure"])) {
    const failure = normalizeFailureBlock(body["failure"], "not_a_claim") as Obj;
    out["failure"] = failure;
    const sentence = legacyStatusError(failure["failure_reason"], failure["detail"]);
    if (sentence !== null) fill(out, "error", sentence);
    if (typeof failure["failure_reason"] === "string") {
      fill(out, "failure_reason", failure["failure_reason"]);
    }
    for (const key of ["failure_class", "docs_url", "hint"]) {
      if (typeof failure[key] === "string") fill(out, key, failure[key]);
    }
    if (typeof failure["retryable"] === "boolean") fill(out, "retryable", failure["retryable"]);
    return out;
  }
  return out;
}

/**
 * A verification webhook's status body, in either shape: the original event
 * carries the failure flat (`error`, `failure_reason`, ...), so the nested
 * `failure` is built from it; a body in the 3.0 shape reads as
 * {@link normalizeTaskStatus}.
 */
export function normalizeWebhookStatus(body: unknown): unknown {
  // Webhook events keep a `null` as 2.21 delivered it (no unsent reading).
  const out = normalizeTaskStatus(body, false);
  if (!isObj(out) || out["status"] !== "failed" || isObj(out["failure"])) return out;
  fill(out, "failure", {
    code: canonicalCode(out["failure_reason"]),
    detail: str(out["error"]) ?? str(out["failure_detail"]),
    hint: str(out["hint"]),
    failure_class: str(out["failure_class"]),
    retryable: typeof out["retryable"] === "boolean" ? out["retryable"] : null,
    docs_url: str(out["docs_url"]),
    failure_reason: str(out["failure_reason"]),
  });
  return out;
}

// ── /me/usage ──

/** The capabilities `/me/usage` projects the pool into. */
const PROJECTED = ["verify", "ask", "assess"] as const;

/** The `GET /me/usage` body: the per-capability blocks and `quota_resets_at` of 2.x, from `credits` and `costs`. */
export function normalizeUsage(body: unknown): unknown {
  if (!isObj(body)) return body;
  const credits = body["credits"];
  const out: Obj = nullAsUnsent({ ...body }, ["verify", "ask", "assess"]);
  const c: Obj = isObj(credits) ? { ...credits } : {};
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

// ── Error bodies ──

/** The call an error answered: its method and path (below the base URL). */
export interface RequestContext {
  method: string;
  path: string;
  /**
   * `false` when the client was made with `legacyAliases: false`: the error's
   * `code` is then the body's own, never the 2.x reading of it.
   */
  legacyAliases?: boolean;
}

/** `/review`, `/citecheck` and their reads keep their own error envelope. */
function isReviewFamily(path: string): boolean {
  return (
    path === "/review" ||
    path.startsWith("/reviews/") ||
    path === "/citecheck" ||
    path.startsWith("/citechecks/")
  );
}

/**
 * Codes the newer shape sends where the original error carried no `code`
 * (outside `/review` and `/citecheck`, which always sent one).
 */
const CODELESS = new Set([
  "not_authenticated",
  "not_found",
  "idempotency_body_mismatch",
  "idempotency_conflict",
  "malformed_body",
  "method_not_allowed",
  "validation_error",
  "blank_input",
  "unsupported_language",
  "too_many_items",
  // The fallbacks for an error raised without its own code: an unhandled
  // server error, and any other 4xx.
  "internal_error",
  "invalid_request",
]);

/** A field validation item in the original order: `type`, `loc`, `msg`, then the rest. */
function validationItem(item: unknown): unknown {
  if (!isObj(item)) return item;
  const out: Obj = {};
  for (const key of ["type", "loc", "msg"]) if (has(item, key)) out[key] = item[key];
  for (const [key, value] of Object.entries(item)) if (!has(out, key)) out[key] = value;
  return out;
}

/** `old` renamed to `new` when only the newer name is there. */
function renameKey(o: Obj, from: string, to: string): void {
  if (has(o, from) && !has(o, to)) {
    o[to] = o[from];
    delete o[from];
  }
}

/** The original names of a wait and a docs link. */
function legacyWaitAndLink(o: Obj, status: number): void {
  const code = o["code"];
  if (status === 429 && code === "extract_daily_limit")
    renameKey(o, "retry_after", "reset_in_seconds");
  if (status === 429 && (code === "review_in_flight" || code === "citecheck_in_flight")) {
    renameKey(o, "retry_after", "retry_after_seconds");
  }
  if (status === 402 || status === 429 || status === 503) renameKey(o, "docs_url", "doc_url");
}

/**
 * A 2026-10-11 error body turned into the one 2.x callers saw: what the error
 * classes are built from, so every field they carry keeps its 2.x value and
 * meaning. (`LenzError.body` stays the body as sent.)
 *
 * - outside `/review` and `/citecheck`: no `errors` list; no `code` where the
 *   original had none; a schema error's `detail` is the list of field items;
 *   `/assess`'s blank list item is `blank_item`;
 * - `/review` and `/citecheck`: field items `{loc, msg}`, the schema error's
 *   `detail` spelled from the field's path, a blank text or an unsupported
 *   language on `/review` is `validation_error`;
 * - waits and links by their original names (`reset_in_seconds`,
 *   `retry_after_seconds`, `doc_url`); a citation check's 402 states its
 *   pool balance (`credits_remaining`, one credit per citation).
 */
export function legacyErrorBody(status: number, body: unknown, req: RequestContext): unknown {
  if (!isObj(body)) return body;
  const out: Obj = { ...body };
  const code = typeof out["code"] === "string" ? (out["code"] as string) : "";
  const errors = Array.isArray(out["errors"]) ? (out["errors"] as unknown[]) : null;
  const path = req.path.split("?")[0] ?? "";
  // The three cancel calls are new in 3.0: there is no 2.x reading of their
  // errors, so the body is read as sent (a 404 keeps its `not_found`). On
  // purpose this also keeps a 401's `not_authenticated` code, which the
  // /review family drops, and skips `legacyWaitAndLink`: no 2.x error has
  // names to keep for these calls.
  if (req.method === "POST" && /^\/(verify|reviews|citechecks)\/[^/]+\/cancel$/.test(path)) {
    return out;
  }
  if (isReviewFamily(path)) {
    // A missing or unknown credential is refused before the endpoint runs.
    if (code === "not_authenticated") delete out["code"];
    if (status === 422) {
      const detail = out["detail"];
      if (req.method === "POST" && path === "/review" && typeof detail === "string") {
        if (code === "blank_input" || code === "unsupported_language") {
          out["code"] = "validation_error";
          if (code === "unsupported_language" && !detail.startsWith("language: ")) {
            out["detail"] = `language: ${detail}`;
          }
        }
      }
      if (errors) {
        const first = errors.find(isObj);
        const loc = first?.["loc"];
        if (Array.isArray(loc) && loc[1] === "payload" && typeof first?.["msg"] === "string") {
          out["detail"] = `${loc.slice(1).join(".")}: ${first["msg"]}`;
        }
        out["errors"] = errors.map((item) => {
          if (!isObj(item)) return item;
          const o: Obj = {};
          if (has(item, "loc")) o["loc"] = item["loc"];
          if (has(item, "msg")) {
            o["msg"] =
              item["msg"] === detail && out["detail"] !== detail ? out["detail"] : item["msg"];
          }
          return o;
        });
      } else if (code === "idempotency_body_mismatch") {
        out["errors"] = [{ loc: ["header"], msg: out["detail"] }];
      }
    }
    if (
      status === 402 &&
      req.method === "POST" &&
      path === "/citecheck" &&
      !has(out, "credits_remaining") &&
      typeof out["remaining"] === "number"
    ) {
      out["credits_remaining"] = out["remaining"];
    }
    legacyWaitAndLink(out, status);
    return out;
  }
  // A blank input said "Text is required." (or its item, or `texts`), where
  // the newer sentence names `claim` / `claims`. Found by endpoint and field.
  if (status === 422 && code === "blank_input" && typeof out["detail"] === "string") {
    const loc = isObj(errors?.[0]) ? (errors[0] as Obj)["loc"] : null;
    if (Array.isArray(loc) && loc[0] === "body") {
      if (req.method === "POST" && (path === "/verify" || path === "/assess")) {
        if (loc.length === 2 && loc[1] === "claim") out["detail"] = "Text is required.";
      } else if (req.method === "POST" && path === "/verify/batch") {
        if (loc.length === 4 && loc[1] === "claims" && typeof loc[2] === "number") {
          out["detail"] = `claims[${loc[2]}].text is required.`;
        }
      } else if (req.method === "POST" && /^\/verify\/[^/]+\/select$/.test(path)) {
        if (loc.length === 2 && loc[1] === "claims") {
          out["detail"] = "texts is required and must be non-empty.";
        }
      }
    }
  }
  if (status === 422 && code === "blank_input" && path === "/assess") {
    const loc = isObj(errors?.[0]) ? (errors[0] as Obj)["loc"] : null;
    if (Array.isArray(loc) && loc.includes("claims")) {
      out["code"] = "blank_item";
      delete out["errors"];
      return out;
    }
  }
  // A batch item's unsupported language named its item in `detail`.
  if (status === 422 && code === "unsupported_language" && path === "/verify/batch") {
    const loc = isObj(errors?.[0]) ? (errors[0] as Obj)["loc"] : null;
    const detail = out["detail"];
    if (Array.isArray(loc) && loc[1] === "claims" && typeof loc[2] === "number") {
      const prefix = `claims[${loc[2]}].`;
      if (typeof detail === "string" && !detail.startsWith(prefix)) out["detail"] = prefix + detail;
    }
  }
  const schemaItems =
    status === 422 &&
    code === "validation_error" &&
    errors !== null &&
    errors.length > 0 &&
    errors.every((e) => isObj(e) && typeof e["type"] === "string" && e["type"] !== code);
  if (schemaItems) {
    const legacy: Obj = { detail: errors.map(validationItem) };
    for (const [key, value] of Object.entries(out)) {
      if (key === "detail" || key === "code" || key === "errors") continue;
      legacy[key === "docs_url" ? "doc_url" : key] = value;
    }
    return legacy;
  }
  // `/assess` sent `too_many_items`; `/ask` sent no code for an unfinished
  // verification (GET /verifications/{id} still sends `verification_not_ready`).
  const codeless =
    (CODELESS.has(code) && !(code === "too_many_items" && path === "/assess")) ||
    (code === "verification_not_ready" && path.startsWith("/ask/"));
  if (codeless) {
    delete out["code"];
  }
  delete out["errors"];
  legacyWaitAndLink(out, status);
  return out;
}

// ── Reviews and citation checks ──
//
// A review or citation-check body is also what a `review.*` / `citecheck.*`
// webhook event carries, in either shape, so these read both: a part in the
// 3.0 shape gains the 2.x names, a part in the original shape the newer ones.

/** Replace `obj[key]` with `fn(obj[key])`, only when the key is there. */
function update(obj: Obj, key: string, fn: (v: unknown) => unknown): void {
  if (has(obj, key)) obj[key] = fn(obj[key]);
}

function mapList(fn: (item: unknown) => unknown): (v: unknown) => unknown {
  return (v) => (Array.isArray(v) ? v.map((item) => fn(item)) : v);
}

/**
 * `v.failure` in both readings. `word`: the original word for "nothing
 * checkable" (`not_a_claim` on a verification, `no_claim` elsewhere).
 */
function withFailure(v: unknown, word: "not_a_claim" | "no_claim" = "no_claim"): unknown {
  if (!isObj(v) || !has(v, "failure")) return v;
  return { ...v, failure: normalizeFailureBlock(v["failure"], word) };
}

const withVerificationFailure = (v: unknown): unknown => withFailure(v, "not_a_claim");

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
  update(
    b,
    "failures",
    mapList((f) =>
      isObj(f) && f["stage"] === "verification" ? withVerificationFailure(f) : withFailure(f),
    ),
  );
  // Issues are what the deep checks found.
  update(b, "issues", mapList(withVerificationFailure));
  update(
    b,
    "claims",
    mapList((row) => {
      if (!isObj(row)) return row;
      const r: Obj = { ...row };
      update(r, "assessment", normalizeReviewAssessment);
      if (isObj(r["verification"])) {
        r["verification"] = withVerificationFailure(normalizeVerification(r["verification"]));
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
