/**
 * Browser entry point for `lenz-io`.
 *
 * Identical to the main entry (`./index.ts`) EXCEPT it omits the webhook
 * signature *value* exports (`LenzWebhooks`, `verifySignature`, …); the
 * `isEvent` guard, which needs no crypto, is exported here too. Those live in
 * `./webhooks.ts`, which imports `node:crypto` / `node:buffer` — Node-only
 * modules that break a browser bundle. Webhook signature verification is a
 * server-only concern, so browser consumers never need it.
 *
 * Bundlers targeting the browser (Vite, webpack, Rollup with the browser
 * condition) resolve `lenz-io` to this file via the `"browser"` export
 * condition in package.json. Node keeps the full `./index.ts`, so
 * `import { LenzWebhooks } from "lenz-io"` still works server-side — this is
 * additive, not a breaking change.
 *
 * Webhook *types* are still re-exported here (they erase at compile time and
 * carry no runtime `node:` imports), so `import type { WebhookEvent }` works
 * in browser code too.
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

// `isEvent` and the event types live in `./events.ts`, which needs no crypto.
export { isEvent } from "./events.js";
export type { LenzWebhooksOptions } from "./webhooks.js";
export type {
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
} from "./events.js";

export type {
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
  DebateSide,
  EntityRef,
  ExtractInput,
  ExtractStatus,
  ExtractedClaim,
  ExtractedClaims,
  ExtractedEntity,
  LibraryItem,
  LibraryList,
  LibraryListInput,
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

export { VERSION } from "./_version.js";
