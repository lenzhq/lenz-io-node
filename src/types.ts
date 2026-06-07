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
 *   - verdict     : string         — "True" | "Mostly True" | "Misleading" | "False" | "Error"
 *   - confidence  : string         — "high" | "medium" | "low" (categorical)
 *   - lenz_score  : number | null  — integer 0–10 (deep / list; /assess omits)
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
   * (logical fallacies, missing context, or weakest sources); the kind
   * is implicit in `focus_area`.
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
 */
export interface Verification {
  verification_id?: string;
  claim?: string;
  domain?: string;
  entities?: EntityRef[];
  presumed_intent?: string;
  // Verdict block (flat)
  verdict?: string; // "True" | "Mostly True" | "Misleading" | "False" | "Error"
  confidence?: string; // "high" | "medium" | "low"
  lenz_score?: number | null; // integer 0–10
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
  verdict?: string; // "True" | "Mostly True" | "Misleading" | "False" | "Error"
  confidence?: string; // "high" | "medium" | "low"
  verification_url?: string | null;
}

/**
 * Output of `POST /assess`.
 *
 * `claims` is one entry per atomic_claim that framing identified in the
 * input. Multiclaim inputs return N entries. `error` is set when
 * framing returns zero claims.
 */
export interface AssessResponse {
  claims: AssessClaim[];
  error?: string | null;
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
}

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

export interface Usage {
  plan?: string;
  credits_used: number;
  credits_total: number;
  credits_resets_at?: string | null;
  extract_calls_today?: number;
  extract_daily_limit?: number;
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
}

export interface VerifyBatchInput {
  claims: VerifyBatchItem[];
  /** Batch-wide webhook URL; per-item value (if set) overrides. */
  webhookUrl?: string;
  /** Batch-wide output-language default; per-item `language` overrides. */
  language?: string;
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
  text?: string;
  claimIndex?: number;
}

export interface LibraryListInput {
  page?: number;
  sort?: "recent" | "popular" | "most_true" | "most_untrue" | "relevance";
  search?: string;
  domain?: string;
  entity?: string;
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
