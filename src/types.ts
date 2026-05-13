/**
 * TypeScript types mirroring the public Lenz API response surface.
 *
 * Hand-written to match `lenz/api/schemas/public_api.py` server-side.
 * Cross-language invariant; the Python SDK has equivalent Pydantic models.
 *
 * Types are intentionally permissive (`?` on most fields, no
 * `noUncheckedIndexedAccess`-tight discriminated unions) so a minor
 * server addition doesn't break customer deserialisation.
 */

export interface Verdict {
  label?: string;
  score?: number | null;
  confidence?: number | null;
}

export interface Source {
  title?: string;
  url?: string;
  snippet?: string;
  stance?: string;
}

export interface DebateSide {
  role?: string;
  arguments?: string[];
}

export interface Assessment {
  panelist_name?: string;
  focus_area?: string;
  score?: number | null;
  confidence?: number | null;
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

export interface SimilarVerification {
  verification_id?: string;
  claim?: string;
  verdict_label?: string;
  score?: number | null;
  url?: string;
  distance?: number;
}

export interface Verification {
  verification_id?: string;
  url?: string;
  claim?: string;
  domain?: string;
  entities?: EntityRef[];
  presumed_intent?: string;
  verdict?: Verdict;
  executive_summary?: string;
  warnings?: string[];
  sources?: Source[];
  audit?: Audit;
  created_at?: string | null;
  published_at?: string | null;
  modified_at?: string | null;
  visibility?: string | null;
}

export interface VerificationListItem {
  verification_id?: string;
  url?: string;
  claim?: string;
  domain?: string;
  verdict?: Verdict;
  executive_summary?: string;
  created_at?: string | null;
  visibility?: string;
}

export interface VerificationList {
  items: VerificationListItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface LibraryItem extends VerificationListItem {}

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
  atomic_claim?: string;
  identified_claims?: string[];
  candidate_claims?: string[];
  domain?: string;
  key_entities?: ExtractedEntity[];
  presumed_intent?: string;
  original_input?: string;
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
  candidate_claims?: string[];
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

export interface FollowupHistory {
  messages: Array<Record<string, unknown>>;
  exchanges_used: number;
  exchange_limit: number;
  can_send: boolean;
}

export interface FollowupReply {
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
