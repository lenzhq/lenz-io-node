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
 *   - claim            : string         — the framed claim text
 *   - verdict          : string         — "True" | "Mostly True" | "Misleading" | "False" | "Error"
 *   - confidence       : string         — "high" | "medium" | "low" (categorical)
 *   - confidence_score : number | null  — 0–1 numeric (deep / audit only)
 *   - lenz_score       : number | null  — 0–10 (deep / list; /assess omits)
 */

export interface Source {
  source_name?: string;
  title?: string;
  url?: string;
  snippet?: string;
  stance?: string;
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
  confidence_score?: number | null;
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
 */
export interface Verification {
  verification_id?: string;
  url?: string;
  claim?: string;
  domain?: string;
  entities?: EntityRef[];
  presumed_intent?: string;
  // Verdict block (flat)
  verdict?: string; // "True" | "Mostly True" | "Misleading" | "False" | "Error"
  confidence?: string; // "high" | "medium" | "low"
  confidence_score?: number | null; // 0–1 numeric
  lenz_score?: number | null; // 0–10
  executive_summary?: string;
  warnings?: string[];
  sources?: Source[];
  audit?: Audit;
  created_at?: string | null;
  modified_at?: string | null;
  visibility?: string | null;
}

export interface VerificationListItem {
  verification_id?: string;
  url?: string;
  claim?: string;
  domain?: string;
  entities?: EntityRef[];
  verdict?: string;
  confidence?: string;
  lenz_score?: number | null;
  executive_summary?: string;
  created_at?: string | null;
  modified_at?: string | null;
  visibility?: string;
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
  failure_reason?: string;
  failure_detail?: string;
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

/** Returned by `POST /ask/{verification_id}`. */
export interface AskReply {
  reply: string;
}

// ── Input shapes ──

export interface VerifyInput {
  claim: string;
  sourceUrl?: string;
  webhookUrl?: string;
  visibility?: string;
  idempotencyKey?: string;
}

export interface VerifyBatchInput {
  claims: Array<{ text: string; sourceUrl?: string; webhookUrl?: string; visibility?: string }>;
  /** Batch-wide webhook URL; per-item value (if set) overrides. */
  webhookUrl?: string;
  /** Batch-wide visibility default ('public' | 'private'); per-item value overrides. */
  visibility?: string;
  idempotencyKey?: string;
}

export interface ExtractInput {
  text: string;
}

export interface AssessInput {
  text: string;
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
