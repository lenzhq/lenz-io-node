/**
 * TypeScript types mirroring the public Lenz API response surface.
 *
 * Hand-written to match `lenz/api/schemas/public_api.py` server-side;
 * cross-language invariant — the Python SDK has equivalent Pydantic
 * models, and `test/contract.test.ts` validates both against the same
 * frozen JSON fixtures.
 *
 * Types are intentionally permissive (`?` on most fields, no
 * `noUncheckedIndexedAccess`-tight discriminated unions) so a minor
 * server addition doesn't break customer deserialisation.
 *
 * Vocabulary (applies across every claim-shaped response):
 *   - claim       : string         — the framed claim text
 *   - verdict     : string         — "True" | "Mostly True" | "Mixed" | "Mostly False" | "False" | "Error"
 *   - confidence  : string         — "high" | "medium" | "low" (categorical)
 *   - lenz_score  : number | null  — integer 1–10 (deep / list; /assess omits)
 */

export interface Source {
  source_name?: string;
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
}

export interface DebateSide {
  role?: string;
  argument?: string;
  rebuttal?: string;
}

export interface Assessment {
  panelist_name?: string;
  focus_area?: string;
  score?: number | null;
  reasoning?: string;
  /**
   * Per-panelist warnings. Each panelist emits exactly one category
   * (logical fallacies, precision issues, or weakest sources; verifications
   * from before 2026-06 carry missing context from the retired Context
   * Analyst); the kind is implicit in `focus_area`.
   */
  warnings?: string[];
}

export interface Audit {
  adjudication_summary?: string;
  assessments?: Assessment[];
  debate_pro?: DebateSide | null;
  debate_con?: DebateSide | null;
  panel_agreement?: string;
}

export interface CandidateClaim {
  text?: string;
  domain?: string;
}

/**
 * An entity (person, place, organization, concept) referenced in the
 * claim. `qid` is the Wikidata Q identifier (e.g. `Q42`) when the entity
 * was resolved against Lenz's internal catalog; `null` otherwise.
 */
export interface EntityRef {
  name: string;
  qid: string | null;
}

/**
 * An existing public verification that semantically resembles the
 * submitted text. Same vocabulary as `Verification` — flat
 * `verdict` / `confidence` / `lenz_score`, no nested object.
 */
export interface SimilarVerification {
  verification_id?: string;
  claim?: string;
  verdict?: string;
  confidence?: string;
  lenz_score?: number | null;
  url?: string;
  distance?: number;
}

/**
 * Full verification report — returned by `verifyAndWait`,
 * `verifications.get`, the `/verify/status/{task_id}` polling endpoint,
 * and the webhook payload.
 *
 * The verdict block is FLAT at top level (was nested `Verdict` object
 * pre-unify). `created_at` + `modified_at` are the only timestamp
 * fields on the API surface — editorial `published_at` is internal-only.
 *
 * 1.1.0: dropped `url` and `visibility`. API claims are private by
 * default and referenced by `verification_id` only. Cache-hit on
 * another customer's claim is transparent — the customer always sees
 * their own `verification_id`.
 *
 * Later: `visibility` returns — "private" | "unlisted" | "public". It
 * echoes what you set on submit ("private"/"unlisted" are settable;
 * "public" can only be read, for listed claims). `url` stays dropped.
 */
export interface Verification {
  verification_id?: string;
  claim?: string;
  /** "private" | "unlisted" | "public". Read-back of the claim's visibility. */
  visibility?: string;
  domain?: string;
  entities?: EntityRef[];
  presumed_intent?: string;
  // Verdict block (flat)
  verdict?: string; // "True" | "Mostly True" | "Mixed" | "Mostly False" | "False" | "Error"
  confidence?: string; // "high" | "medium" | "low"
  lenz_score?: number | null; // integer 1–10
  /**
   * The analysis's key finding: one declarative sentence stating the
   * most important fact it established (2.6.0). "" on legacy claims
   * that were never backfilled.
   */
  key_finding?: string;
  executive_summary?: string;
  warnings?: string[];
  sources?: Source[];
  audit?: Audit;
  created_at?: string | null;
  modified_at?: string | null;
  /**
   * Output language (ISO 639-1). Always populated when the SDK is
   * current; `?` is kept for resilience against older / mocked payloads
   * that may omit the field. Verdict / domain / status enums stay
   * English regardless of language.
   */
  language?: string;
}

/**
 * Compact item for the verifications list endpoint and the public
 * library list. Slim shape — no `url` (reference by `verification_id`),
 * no `visibility` (1.1.0).
 */
export interface VerificationListItem {
  verification_id?: string;
  claim?: string;
  domain?: string;
  entities?: EntityRef[];
  verdict?: string;
  confidence?: string;
  lenz_score?: number | null;
  /** The analysis's key finding (2.6.0). See `Verification.key_finding`. */
  key_finding?: string;
  executive_summary?: string;
  created_at?: string | null;
  modified_at?: string | null;
  /** Output language (ISO 639-1). See `Verification.language`. */
  language?: string;
}

export interface VerificationList {
  items: VerificationListItem[];
  total: number;
  page: number;
  page_size: number;
}

/** Same shape as `VerificationListItem` on the public Library list. */
export type LibraryItem = VerificationListItem;

/** Wrapper for `GET /verifications/{id}/related`. */
export interface RelatedVerifications {
  items: SimilarVerification[];
}

export interface LibraryList {
  items: LibraryItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface ExtractedEntity {
  /** Full formal entity name as identified by framing. */
  name: string;
  /** One of: `person` | `org` | `place` | `topic`. */
  type: string;
}

export interface ExtractedClaims {
  status?: string;
  claim?: string;
  identified_claims?: string[];
  candidate_claims?: string[];
  domain?: string;
  key_entities?: ExtractedEntity[];
  presumed_intent?: string;
  original_input?: string;
}

/**
 * Per-claim entry in an `AssessResponse.claims` list.
 *
 * Lean shape by design — no model_votes, no panel identity. The
 * `verification_url` (when present) points at the full payload at
 * `GET /api/v1/verifications/{id}` for callers that want citations and
 * the full audit trail.
 */
export interface AssessClaim {
  claim?: string;
  /** Output language (ISO 639-1). Echoes the request's language. */
  language?: string;
  verdict?: string; // "True" | "Mostly True" | "Mixed" | "Mostly False" | "False" | "Error"
  confidence?: string; // "high" | "medium" | "low"
  verification_url?: string | null;
}

/**
 * Output of `POST /assess`.
 *
 * `claims` is one entry per atomic_claim that framing identified in the
 * input. Multiclaim inputs return N entries. `error` is set when
 * framing returns zero claims.
 *
 * When `claims` is empty, `error_code` disambiguates why: `'ambiguous'`
 * → the input was vague but framing produced specific readings in
 * `candidate_claims` (assess one of them); `'no_claim'` → genuinely not a
 * checkable claim. Both fields are optional, so older servers that don't
 * send them degrade to the plain `error` message.
 */
export interface AssessResponse {
  claims: AssessClaim[];
  error?: string | null;
  error_code?: string; // '' | 'ambiguous' | 'no_claim'
  candidate_claims?: string[];
}

export interface TaskAccepted {
  task_id: string;
  claim_text?: string;
}

export interface BatchAccepted {
  batch_id: string;
  items: TaskAccepted[];
}

export interface TaskStatus {
  status: "processing" | "needs_input" | "completed" | "failed";
  reason?: string;
  progress?: Record<string, unknown>;
  result?: Verification | null;
  claims?: CandidateClaim[];
  candidates?: string[];
  similar_claims?: SimilarVerification[];
  /**
   * Diagnostic on a `failed` status. The server's failed response is
   * `{"status": "failed", "error": "..."}` — `error` is the live wire field.
   * `failure_reason` / `failure_detail` are kept for forward/back compat;
   * read precedence is `error || failure_detail || failure_reason`.
   */
  error?: string;
  failure_reason?: string;
  failure_detail?: string;
  /**
   * WHY it failed — closed set (`upstream_unavailable` |
   * `insufficient_evidence` | `invalid_input` | `cancelled` | `internal`) —
   * and the derived retry signal (true iff `upstream_unavailable`). Rows
   * predating 2026-08 omit both.
   */
  failure_class?: FailureClass;
  retryable?: boolean;
}

/**
 * Closed set of failure causes on a `failed` verification. The
 * `string & NonNullable<unknown>` arm preserves autocomplete for the known
 * values while tolerating any future class the server adds (same trick as
 * `WebhookEventKind`).
 */
export type FailureClass =
  | "upstream_unavailable"
  | "insufficient_evidence"
  | "invalid_input"
  | "cancelled"
  | "internal"
  | (string & NonNullable<unknown>);

/**
 * Per-item outcome from `verifyBatchAndWait`.
 *
 * A client-side composition type — NOT a wire shape (the server never emits
 * it, so it has no contract fixture). One entry per task that
 * `POST /verify/batch` returned, in input order. Field names stay snake_case
 * to match the wire-shaped models (`TaskAccepted`, `Verification`).
 *
 * `status` is a client-side rollup:
 * - `completed`   — `verification` is set (and `status_detail` carries the raw poll).
 * - `needs_input` — paused for caller input; inspect `status_detail`.
 * - `failed`      — terminal failure (or completed-without-result); `status_detail` carries the diagnostic.
 * - `timeout`     — the deadline elapsed before this task reached a terminal state; `status_detail` is `undefined`.
 */
export interface BatchItemResult {
  task_id: string;
  claim_text?: string;
  status: "completed" | "needs_input" | "failed" | "timeout";
  verification?: Verification;
  status_detail?: TaskStatus;
}

/**
 * The account's credit balance — the one pool every capability spends from.
 *
 * Two buckets:
 * - the monthly allowance for the current plan, which resets at `resets_at`;
 * - `bonus`, non-expiring credits from grants and top-ups, spent only once
 *   the allowance is gone.
 *
 * `remaining` is the sum of both and is what a call is checked against.
 * `total` and `used` cover the same two buckets, so `used + remaining` can
 * exceed nothing — read `remaining` when you want "can I make this call".
 *
 * Convert to calls with {@link Usage.costs}: `remaining / costs.verify` is
 * how many verifications the balance still buys — or the `depth` prices in
 * that price, for a `depth: "low"` check. The per-capability blocks on
 * {@link Usage} do that division for you, except for the depth prices, which are
 * price with no block of its own.
 */
export interface UsageCredits {
  total: number;
  used: number;
  remaining: number;
  bonus: number;
  resets_at: string | null;
}

/**
 * One capability's share of the pool, projected into that capability's unit
 * (`verify` / `ask` / `assess`).
 *
 * These are **projections, not allowances**. Every billable capability draws
 * on the single balance in {@link Usage.credits}, at the weight in
 * {@link Usage.costs}; this block answers "how many `/verify` calls could I
 * still make if I spent everything on them". Spending on any capability moves
 * every block, and the division floors — a `verify` block at a weight of 10
 * ticks once per 10 credits spent anywhere.
 *
 * - `quota_total` / `quota_remaining`: the pool's `total` / `remaining`
 *   divided by this capability's cost.
 * - `quota_used`: derived as `quota_total - quota_remaining`, so
 *   `used + remaining === total` always holds. It is therefore a ceiling —
 *   one `/ask` credit moves the verify block's `quota_used` from 0 to 1.
 * - `bonus`: the non-expiring bucket in this capability's unit. A user
 *   holding 5 bonus credits sees `verify.bonus === 0` and `assess.bonus === 5`
 *   — 5 credits doesn't buy a verification.
 * - `remaining`: equals `quota_remaining` (it already spans both buckets).
 */
export interface UsageCapacity {
  quota_used: number;
  quota_total: number;
  quota_remaining: number;
  /** The non-expiring bonus bucket, in this capability's unit. */
  bonus: number;
  /**
   * @deprecated Alias of {@link UsageCapacity.bonus}. The server removes it on
   * **2026-11-29**; read `bonus` instead.
   *
   * It never meant the pool — before the single pool existed it meant this
   * capability's one-off top-up balance, which is exactly what `bonus` now
   * reports. Optional because the server stops sending it on that date.
   */
  credits?: number;
  remaining: number;
}

/** Daily `/extract` usage — a per-day rate limit, not credit-based. */
export interface UsageExtract {
  calls_today: number;
  daily_limit: number;
  unlimited: boolean;
}

/**
 * Returned by `GET /me/usage` — the account's credit balance and what it buys.
 *
 * `credits` is the balance and `costs` is the price list (credits per call,
 * keyed by capability name). The `verify` / `ask` / `assess` blocks are
 * projections of that one pool into each capability's unit — read whichever is
 * convenient, they all describe the same money.
 *
 * ```ts
 * const u = await client.usage();
 * u.credits.remaining; // 5070 credits left
 * u.costs["verify"]; // 10 credits per verification
 * u.cost_options.verify?.depth?.low; // 5 — half price at depth: "low"
 * u.verify.remaining; // 507 verifications, the same balance divided
 * ```
 *
 * `extract` is free at the pool (`costs.extract` is 0) and carries a
 * per-account daily fair-use cap instead; it rejects with 429, not 402.
 *
 * The depth prices are **prices, not capabilities** — there is deliberately
 * no `verify_low` block beside `verify`. See {@link Usage.cost_options}.
 */
export interface Usage {
  /**
   * The tier slug — `"free" | "plus" | "developer" | "scale"`. This is the
   * field to branch on; it is stable.
   */
  plan: string;
  /**
   * The same tier as display copy (`"Developer"`). Separate from
   * {@link Usage.plan} on purpose: this one is copy and may be reworded, so
   * comparing against it breaks on a rename that ought to be free. Empty
   * string on servers predating this field — fall back to `plan`.
   */
  plan_label: string;
  quota_resets_at: string | null;
  /**
   * The pool — the authoritative balance every capability spends from.
   * Present since the 2026-08-29 credits release.
   */
  credits: UsageCredits;
  /**
   * Credits per call, keyed by CAPABILITY name (`verify`, `assess`, `ask`,
   * `extract`), at that capability's default price. Keys are the server's
   * own, verbatim — never rewritten by the SDK — and a zero cost means the
   * capability is free at the pool and bounded by a daily cap instead. New
   * keys appear here without an SDK release.
   *
   * Capability names and nothing else. Prices that depend on a request
   * parameter are in {@link Usage.cost_options}.
   */
  costs: Record<string, number>;
  /**
   * Prices that depend on a request PARAMETER, nested capability → parameter
   * → value:
   *
   * ```ts
   * u.cost_options.verify?.depth; // { standard: 10, low: 5 }
   * ```
   *
   * Read as "on `verify`, the `depth` parameter prices like this". `{}` on
   * servers predating this field.
   *
   * Every capability here also appears in {@link Usage.costs} at its default
   * price, so reading only `costs` is imprecise, never wrong.
   *
   * ```ts
   * const low = u.cost_options.verify?.depth?.low ?? u.costs["verify"]!;
   * const lowDepthLeft = Math.floor(u.credits.remaining / low);
   * ```
   *
   * Every level is optional at the type level because every level is
   * genuinely optional at runtime: a server predating this field sends
   * `{}`, and the capability-default in `costs` is the correct fallback.
   *
   * ```ts
   * ```
   *
   * Nested rather than flat so that a future request parameter adds a key
   * under its capability instead of a new top-level entry — `costs` stays a
   * list of capability names, safe to iterate.
   *
   * You are charged for the depth you **requested**, not the one served: a
   * `low` request answered from a cached `standard` verdict still costs the
   * `low` price. The `depth` echoed on a completed verification is what the
   * verdict was PRODUCED with, so it can read `standard` on a `low` request —
   * the echo describes the evidence, the charge follows the request.
   */
  cost_options: Record<string, Record<string, Record<string, number>>>;
  /**
   * @deprecated Removed 2026-11-29. Derive from {@link Usage.credits} and
   * {@link Usage.costs} instead:
   *
   * ```ts
   * const left = Math.floor(u.credits.remaining / u.costs["verify"]!);
   * ```
   */
  verify: UsageCapacity;
  /** @deprecated Removed 2026-11-29. See {@link Usage.verify}. */
  ask: UsageCapacity;
  /** @deprecated Removed 2026-11-29. See {@link Usage.verify}. */
  assess: UsageCapacity;
  extract: UsageExtract;
  /**
   * Whether this key has a webhook signing secret provisioned. `POST /verify`
   * with a `webhook_url` is rejected without one, so callers that rely on
   * webhook delivery can check this up front. Reports existence only — the
   * secret value is never exposed here (shown once at rotation, never again).
   *
   * Optional: absent on servers predating this field, in which case it reads
   * as `undefined` (treat that as "unknown", not `false`).
   */
  has_webhook_secret?: boolean;
}

/** One message in an `/ask` conversation thread. */
export interface AskMessage {
  role?: string; // "user" | "expert"
  content?: string;
  created_at?: string;
}

/** Returned by `GET /ask/{verification_id}`. */
export interface AskHistory {
  messages: AskMessage[];
  exchanges_used: number;
  exchange_limit: number;
  can_send: boolean;
}

/**
 * Returned by `POST /ask/{verification_id}`.
 *
 * `content` is the assistant's reply text in a small markdown subset:
 *
 * - `**bold**` and `*italic*`
 * - `- ` or `* ` bullet lists
 * - Blank-line paragraph breaks; single newlines inside a paragraph
 *   mean line break
 *
 * The model only produces these — no headings, no tables, no code
 * blocks. Pass it through any markdown library or display it
 * verbatim. See https://lenz.io/docs/quickstart#ask-reply-format.
 *
 * Pre-1.0.2 this interface declared a single `reply: string` field
 * that never matched the wire — the server has always returned
 * `{role, content, created_at}`. 1.0.2 aligned the typed surface.
 */
export interface AskReply {
  role?: string; // 'expert' on every reply (the assistant turn)
  content?: string; // markdown-subset prose (see interface docstring)
  created_at?: string;
}

// ── Input shapes ──

export interface VerifyInput {
  claim: string;
  sourceUrl?: string;
  webhookUrl?: string;
  /**
   * "private" (default, owner-only) or "unlisted" (readable by
   * verification_id and at the /c/ URL, but never listed in the Library
   * or search). Omitted from the request body when unset — the server
   * applies its "private" default.
   */
  visibility?: "private" | "unlisted";
  /**
   * Output language (ISO 639-1). Omit for English (default). Supported:
   * en, es, de, fr, it, pt, nl, sv, da, no, fi, bg. Omitted from the
   * request body when empty so existing English callers keep
   * byte-identical wire format.
   */
  language?: string;
  idempotencyKey?: string;
}

/**
 * Per-item shape for `verifyBatch`. All fields optional; the SDK accepts
 * plain objects at runtime — this interface exists purely for IDE
 * autocompletion (mirrors Python's `VerifyBatchItem` TypedDict).
 *
 * Precedence on conflicting language: per-item `language` overrides the
 * batch-wide `language` on `VerifyBatchInput`, which overrides the
 * implicit English default. SDK forwards both verbatim; server is
 * authoritative on the merge.
 */
export interface VerifyBatchItem {
  text?: string;
  language?: string;
  source_url?: string;
  webhook_url?: string;
  idempotency_key?: string;
  /** Per-item "private" | "unlisted"; overrides the batch-wide default. */
  visibility?: "private" | "unlisted";
}

export interface VerifyBatchInput {
  claims: VerifyBatchItem[];
  /** Batch-wide webhook URL; per-item value (if set) overrides. */
  webhookUrl?: string;
  /** Batch-wide output-language default; per-item `language` overrides. */
  language?: string;
  /** Batch-wide "private" | "unlisted" default; per-item `visibility` overrides. */
  visibility?: "private" | "unlisted";
  idempotencyKey?: string;
}

export interface ExtractInput {
  text: string;
  /** Output language (ISO 639-1). See `VerifyInput.language`. */
  language?: string;
}

export interface AssessInput {
  text: string;
  /** Output language (ISO 639-1). See `VerifyInput.language`. */
  language?: string;
}

export interface AskSendInput {
  message: string;
  /**
   * Optional language override (ISO 639-1). When omitted, the server
   * uses the claim's stored language as the default.
   */
  language?: string;
}

export interface SelectInput {
  /**
   * One or more claims chosen from a multi_claim / clarification interrupt.
   * Each must match a claim that was offered in the prior status response.
   * Each selected claim fans out into its own pipeline.
   */
  texts: string[];
}

export interface LibraryListInput {
  page?: number;
  sort?: "recent" | "most_true" | "most_untrue" | "relevance" | "random";
  search?: string;
  domain?: string;
  entity?: string;
  /** Restrict to one or more named curated collections, e.g. `["trivia"]`. */
  curated?: string[];
  /** Comma-separated verdict labels, e.g. "True,False". Others: "Mostly True", "Mixed", "Mostly False". */
  verdict?: string;
}

export interface VerifyAndWaitInput extends VerifyInput {
  timeoutMs?: number;
  idempotency?: boolean;
}

export interface VerifyBatchAndWaitInput extends VerifyBatchInput {
  /** Overall deadline for polling every item to a terminal state. Default 180s. */
  timeoutMs?: number;
}

/** Options for `wait()`. */
export interface WaitOptions {
  /** Deadline before raising `LenzTimeoutError`. Default 120s. */
  timeoutMs?: number;
}
