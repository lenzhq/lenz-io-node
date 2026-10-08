/**
 * Official Node SDK for the Lenz Fact Checking API for AI Product Teams.
 *
 *     npm install lenz-io
 *
 * The fact-check API for AI products. Four primitives form a research-depth
 * ladder — find claims, judge them fast, prove them deep, follow up:
 *
 * ```ts
 * import { Lenz } from 'lenz-io';
 * const client = new Lenz({ apiKey: 'lenz_...' });
 *
 * // 1. /extract — pull verifiable claims out of text (free, 1000/day)
 * const out = await client.extract({ text: llmOutput });
 * const claims = out.identified_claims?.length ? out.identified_claims : [out.claim!];
 *
 * // 2. /assess — one call per 20 claims (extract finds up to 100), one
 * //    row per claim in the same order. A row with verdict 'Error' has
 * //    error_code + hint; a compound item lists the rest in identified_claims.
 * const quick: AssessClaim[] = [];
 * for (let i = 0; i < claims.length; i += 20) {
 *   quick.push(...(await client.assess({ claims: claims.slice(i, i + 20) })).claims);
 * }
 *
 * // 3. /verify — escalate the low-confidence rows to the full pipeline (~90s, paid)
 * // verifyBatchAndWait takes up to 20 claims a call: the first 20 here
 * const doubtful = quick
 *   .filter((c) => c.verdict !== 'Error' && c.confidence === 'low')
 *   .map((c) => ({ claim: c.claim! }))
 *   .slice(0, 20);
 * const results = doubtful.length ? await client.verifyBatchAndWait({ claims: doubtful }) : [];
 *
 * // 4. /ask — follow-up questions grounded on a verification
 * const deep = results.find((r) => r.status === 'completed')?.verification;
 * const reply = await client.ask.send(deep!.verification_id!, {
 *   message: 'Which source is strongest?',
 * });
 * ```
 *
 * See https://lenz.io/api/v1/docs/ for the full API reference.
 */
export { API_VERSION, DEFAULT_BASE_URL, Lenz } from "./client.js";
export type { LenzOptions } from "./client.js";
export {
  LenzAPIError,
  LenzAuthError,
  LenzError,
  LenzGoneError,
  LenzNeedsInputError,
  LenzPipelineError,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzTimeoutError,
  LenzUpstreamUnavailableError,
  LenzValidationError,
  LenzVerificationNotReadyError,
  LenzWebhookSignatureError,
  MAX_RETRY_AFTER_SLEEP,
  CitecheckFailedError,
  CitecheckTimeoutError,
  ReviewFailedError,
  ReviewTimeoutError,
  mapResponseToError,
} from "./errors.js";
export {
  LenzWebhooks,
  SIGNATURE_HEADER,
  DEFAULT_REPLAY_WINDOW_SECONDS,
  verifySignature,
} from "./webhooks.js";
export type {
  LenzWebhooksOptions,
  CertificateTimestamped,
  CitecheckCompleted,
  CitecheckEvent,
  CitecheckEventBase,
  CitecheckFailed,
  ReviewCompleted,
  ReviewEvent,
  ReviewEventBase,
  ReviewFailed,
  VerificationCompleted,
  VerificationFailed,
  VerificationNeedsInput,
  WebhookEvent,
  WebhookEventBase,
  WebhookEventKind,
} from "./webhooks.js";
export type {
  ConfidenceBand,
  Escalation,
  EscalationDisposition,
  EscalationPolicy,
  CitationPair,
  Citecheck,
  CitecheckAndWaitOptions,
  CitecheckInput,
  CitecheckPolicy,
  CitecheckStarted,
  CitecheckStatus,
  CitecheckSummary,
  GetReviewOptions,
  ReviewAndWaitOptions,
  ReviewAssessment,
  ReviewAssessmentCounts,
  ReviewCitation,
  ReviewCitationCheck,
  ReviewCitationCheckCounts,
  ReviewCitationDifference,
  ReviewCitationFailure,
  ReviewCitationFinding,
  ReviewCitationIssue,
  ReviewCitationRecord,
  ReviewCitationResult,
  ReviewCitationSource,
  ReviewCitationUncheckedReason,
  ReviewMoreCitation,
  ReviewClaim,
  ReviewCredits,
  ReviewEntity,
  ReviewEnvelope,
  ReviewFailure,
  ReviewFailureBlock,
  ReviewFull,
  ReviewInput,
  ReviewIssue,
  ReviewIssues,
  ReviewOutcome,
  ReviewResult,
  ReviewStarted,
  ReviewStatus,
  ReviewSummary,
  ReviewVerification,
  ReviewVerificationCounts,
  VerdictLabel,
  AskHistory,
  AskMessage,
  AskReply,
  AssessClaim,
  AssessInput,
  AssessResponse,
  Assessment,
  Audit,
  BatchAccepted,
  BatchItemResult,
  CandidateClaim,
  ClaimLocation,
  Position,
  SuggestedEdit,
  SuggestedEdits,
  Certificate,
  Coverage,
  CoverageReason,
  CoverageStatus,
  DebateSide,
  EntityRef,
  ExtractInput,
  ExtractStatus,
  ExtractedClaims,
  ExtractedEntity,
  FailureClass,
  LibraryItem,
  LibraryList,
  LibraryListInput,
  OnProgress,
  Progress,
  RelatedVerifications,
  SelectInput,
  SimilarVerification,
  Source,
  TaskAccepted,
  TaskStatus,
  Usage,
  UsageCapacity,
  UsageCredits,
  UsageExtract,
  Verification,
  VerificationList,
  VerificationListItem,
  VerifyAndWaitInput,
  VerifyBatchAndWaitInput,
  VerifyBatchInput,
  VerifyInput,
  WaitOptions,
} from "./types.js";
export { VERSION } from "./_version.js";
