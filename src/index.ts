/**
 * Official Node SDK for the Lenz Fact Checking API for AI Product Teams.
 *
 *     npm install lenz-io
 *
 * The fact-check API for AI products. Six API calls: `extract`, `assess`,
 * `verify` and `ask` form a research-depth ladder (find claims, judge them
 * fast, prove them deep, follow up); `review` runs it on a whole draft and
 * `citecheck` checks a draft's citations on their own.
 *
 * ```ts
 * import { Lenz, type AssessClaim } from 'lenz-io';
 * const client = new Lenz(); // reads LENZ_API_KEY
 *
 * // 1. extract — pull verifiable claims out of text (free, 1000 calls a day)
 * const out = await client.extract({ text: llmOutput });
 * const claims = (out.claims ?? []).map((c) => c.claim);
 *
 * // 2. assess — a quick verdict per claim: up to 20 claims a call, one row per
 * //    claim in the same order. A row with status 'failed' has no verdict
 * //    (`failure` says why); a compound item lists the rest in more_claims.
 * const quick: AssessClaim[] = [];
 * for (let i = 0; i < claims.length; i += 20) {
 *   quick.push(...(await client.assess({ claims: claims.slice(i, i + 20) })).claims);
 * }
 *
 * // 3. verify — deep-check the low-confidence rows (~90s, paid, 20 a call)
 * const doubtful = quick
 *   .filter((c) => c.status !== 'failed' && c.confidence === 'low' && c.claim)
 *   .map((c) => ({ claim: c.claim! }))
 *   .slice(0, 20);
 * const results = doubtful.length ? await client.verifyBatchAndWait({ claims: doubtful }) : [];
 *
 * // 4. ask — a follow-up question on a completed deep check, when there is one
 * const deep = results.find((r) => r.status === 'completed')?.verification;
 * if (deep?.verification_id) {
 *   const reply = await client.ask.send(deep.verification_id, {
 *     message: 'Which source is strongest?',
 *   });
 *   console.log(reply.content);
 * }
 * ```
 *
 * See https://lenz.io/api/v1/docs/ for the full API reference.
 */

export { API_VERSION, DEFAULT_BASE_URL, Lenz } from "./client.js";
export type { LenzLogger, LenzOptions } from "./client.js";

export {
  LenzAPIError,
  LenzApiVersionError,
  LenzAuthError,
  LenzConnectionError,
  LenzError,
  LenzGoneError,
  LenzNeedsInputError,
  LenzNotFoundError,
  LenzPipelineError,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzRequestTimeoutError,
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
  isEvent,
} from "./webhooks.js";
export type {
  LenzWebhooksOptions,
  CertificateTimestamped,
  CitecheckCancelled,
  CitecheckCompleted,
  CitecheckEvent,
  CitecheckEventBase,
  CitecheckFailed,
  ReviewCancelled,
  ReviewCompleted,
  ReviewEvent,
  ReviewEventBase,
  ReviewFailed,
  VerificationCancelled,
  VerificationCompleted,
  VerificationFailed,
  VerificationNeedsInput,
  WebhookEvent,
  WebhookEventBase,
  WebhookEventKind,
  WebhookEventMap,
} from "./webhooks.js";

export type {
  CancelResult,
  ConfidenceBand,
  Confidence,
  Depth,
  Verdict,
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
  ExtractedClaim,
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
  VerifyBatchItem,
  VerifyInput,
  WaitOptions,
} from "./types.js";

// VERSION is generated at build time from package.json#version by
// scripts/sync-version.mjs (runs as `prebuild`). _version.ts is
// gitignored; the release workflow updates package.json from the git
// tag before `npm run build` fires, so the bundled VERSION matches the
// published npm package exactly.
export { VERSION } from "./_version.js";
