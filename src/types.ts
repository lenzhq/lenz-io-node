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
  weakest_sources?: string[];
  logical_fallacies?: string[];
  missing_context?: string[];
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
  entities?: string[];
  presumed_intent?: string;
  verdict?: Verdict;
  executive_summary?: string;
  warnings?: string[];
  is_time_dependent?: boolean;
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

export interface LibraryList {
  items: LibraryItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface ExtractedClaims {
  status?: string;
  atomic_claim?: string;
  identified_claims?: string[];
  candidate_claims?: string[];
  domain?: string;
  key_entities?: string[];
  presumed_intent?: string;
  is_time_dependent?: boolean;
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
  webhookUrl?: string;
  idempotencyKey?: string;
}

export interface ExtractInput {
  text: string;
  country?: string;
  city?: string;
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
