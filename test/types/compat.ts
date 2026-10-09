/**
 * Type compatibility with the previous release (2.21.0).
 *
 * `release-2.21.0/` holds that release's published declarations. Every type
 * it exported must stay assignable BOTH ways: a value typed with the old
 * type must fit the new one (code that builds objects, e.g. test mocks), and
 * a value typed with the new one must fit the old (code that reads fields:
 * no field may narrow, widen to include `null`, turn optional, or disappear).
 * A new member may only be optional. Compiled by `npm run type` and by
 * `type-compat.test.ts` with `tsc --strict`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type * as Old from "./release-2.21.0/index.js";
import type * as New from "../../src/index.js";

/** A value of type `T`, for assignment checks only (never evaluated). */
declare function value<T>(): T;

export const new_LenzOptions: New.LenzOptions = value<Old.LenzOptions>();
export const old_LenzOptions: Old.LenzOptions = value<New.LenzOptions>();
export const new_LenzWebhooksOptions: New.LenzWebhooksOptions = value<Old.LenzWebhooksOptions>();
export const old_LenzWebhooksOptions: Old.LenzWebhooksOptions = value<New.LenzWebhooksOptions>();
export const new_CertificateTimestamped: New.CertificateTimestamped =
  value<Old.CertificateTimestamped>();
export const old_CertificateTimestamped: Old.CertificateTimestamped =
  value<New.CertificateTimestamped>();
export const new_CitecheckCompleted: New.CitecheckCompleted = value<Old.CitecheckCompleted>();
export const old_CitecheckCompleted: Old.CitecheckCompleted = value<New.CitecheckCompleted>();
export const new_CitecheckEvent: New.CitecheckEvent = value<Old.CitecheckEvent>();
export const old_CitecheckEvent: Old.CitecheckEvent = value<New.CitecheckEvent>();
export const new_CitecheckEventBase: New.CitecheckEventBase = value<Old.CitecheckEventBase>();
export const old_CitecheckEventBase: Old.CitecheckEventBase = value<New.CitecheckEventBase>();
export const new_CitecheckFailed: New.CitecheckFailed = value<Old.CitecheckFailed>();
export const old_CitecheckFailed: Old.CitecheckFailed = value<New.CitecheckFailed>();
export const new_ReviewCompleted: New.ReviewCompleted = value<Old.ReviewCompleted>();
export const old_ReviewCompleted: Old.ReviewCompleted = value<New.ReviewCompleted>();
export const new_ReviewEvent: New.ReviewEvent = value<Old.ReviewEvent>();
export const old_ReviewEvent: Old.ReviewEvent = value<New.ReviewEvent>();
export const new_ReviewEventBase: New.ReviewEventBase = value<Old.ReviewEventBase>();
export const old_ReviewEventBase: Old.ReviewEventBase = value<New.ReviewEventBase>();
export const new_ReviewFailed: New.ReviewFailed = value<Old.ReviewFailed>();
export const old_ReviewFailed: Old.ReviewFailed = value<New.ReviewFailed>();
export const new_VerificationCompleted: New.VerificationCompleted =
  value<Old.VerificationCompleted>();
export const old_VerificationCompleted: Old.VerificationCompleted =
  value<New.VerificationCompleted>();
export const new_VerificationFailed: New.VerificationFailed = value<Old.VerificationFailed>();
export const old_VerificationFailed: Old.VerificationFailed = value<New.VerificationFailed>();
export const new_VerificationNeedsInput: New.VerificationNeedsInput =
  value<Old.VerificationNeedsInput>();
export const old_VerificationNeedsInput: Old.VerificationNeedsInput =
  value<New.VerificationNeedsInput>();
export const new_WebhookEvent: New.WebhookEvent = value<Old.WebhookEvent>();
export const old_WebhookEvent: Old.WebhookEvent = value<New.WebhookEvent>();
export const new_WebhookEventBase: New.WebhookEventBase = value<Old.WebhookEventBase>();
export const old_WebhookEventBase: Old.WebhookEventBase = value<New.WebhookEventBase>();
export const new_WebhookEventKind: New.WebhookEventKind = value<Old.WebhookEventKind>();
export const old_WebhookEventKind: Old.WebhookEventKind = value<New.WebhookEventKind>();
export const new_ConfidenceBand: New.ConfidenceBand = value<Old.ConfidenceBand>();
export const old_ConfidenceBand: Old.ConfidenceBand = value<New.ConfidenceBand>();
export const new_Escalation: New.Escalation = value<Old.Escalation>();
export const old_Escalation: Old.Escalation = value<New.Escalation>();
export const new_EscalationDisposition: New.EscalationDisposition =
  value<Old.EscalationDisposition>();
export const old_EscalationDisposition: Old.EscalationDisposition =
  value<New.EscalationDisposition>();
export const new_EscalationPolicy: New.EscalationPolicy = value<Old.EscalationPolicy>();
export const old_EscalationPolicy: Old.EscalationPolicy = value<New.EscalationPolicy>();
export const new_CitationPair: New.CitationPair = value<Old.CitationPair>();
export const old_CitationPair: Old.CitationPair = value<New.CitationPair>();
export const new_Citecheck: New.Citecheck = value<Old.Citecheck>();
export const old_Citecheck: Old.Citecheck = value<New.Citecheck>();
export const new_CitecheckAndWaitOptions: New.CitecheckAndWaitOptions =
  value<Old.CitecheckAndWaitOptions>();
export const old_CitecheckAndWaitOptions: Old.CitecheckAndWaitOptions =
  value<New.CitecheckAndWaitOptions>();
export const new_CitecheckInput: New.CitecheckInput = value<Old.CitecheckInput>();
export const old_CitecheckInput: Old.CitecheckInput = value<New.CitecheckInput>();
export const new_CitecheckPolicy: New.CitecheckPolicy = value<Old.CitecheckPolicy>();
export const old_CitecheckPolicy: Old.CitecheckPolicy = value<New.CitecheckPolicy>();
export const new_CitecheckStarted: New.CitecheckStarted = value<Old.CitecheckStarted>();
export const old_CitecheckStarted: Old.CitecheckStarted = value<New.CitecheckStarted>();
export const new_CitecheckStatus: New.CitecheckStatus = value<Old.CitecheckStatus>();
export const old_CitecheckStatus: Old.CitecheckStatus = value<New.CitecheckStatus>();
export const new_CitecheckSummary: New.CitecheckSummary = value<Old.CitecheckSummary>();
export const old_CitecheckSummary: Old.CitecheckSummary = value<New.CitecheckSummary>();
export const new_GetReviewOptions: New.GetReviewOptions = value<Old.GetReviewOptions>();
export const old_GetReviewOptions: Old.GetReviewOptions = value<New.GetReviewOptions>();
export const new_ReviewAndWaitOptions: New.ReviewAndWaitOptions = value<Old.ReviewAndWaitOptions>();
export const old_ReviewAndWaitOptions: Old.ReviewAndWaitOptions = value<New.ReviewAndWaitOptions>();
export const new_ReviewAssessment: New.ReviewAssessment = value<Old.ReviewAssessment>();
export const old_ReviewAssessment: Old.ReviewAssessment = value<New.ReviewAssessment>();
export const new_ReviewAssessmentCounts: New.ReviewAssessmentCounts =
  value<Old.ReviewAssessmentCounts>();
export const old_ReviewAssessmentCounts: Old.ReviewAssessmentCounts =
  value<New.ReviewAssessmentCounts>();
export const new_ReviewCitation: New.ReviewCitation = value<Old.ReviewCitation>();
export const old_ReviewCitation: Old.ReviewCitation = value<New.ReviewCitation>();
export const new_ReviewCitationCheck: New.ReviewCitationCheck = value<Old.ReviewCitationCheck>();
export const old_ReviewCitationCheck: Old.ReviewCitationCheck = value<New.ReviewCitationCheck>();
export const new_ReviewCitationCheckCounts: New.ReviewCitationCheckCounts =
  value<Old.ReviewCitationCheckCounts>();
export const old_ReviewCitationCheckCounts: Old.ReviewCitationCheckCounts =
  value<New.ReviewCitationCheckCounts>();
export const new_ReviewCitationDifference: New.ReviewCitationDifference =
  value<Old.ReviewCitationDifference>();
export const old_ReviewCitationDifference: Old.ReviewCitationDifference =
  value<New.ReviewCitationDifference>();
export const new_ReviewCitationFailure: New.ReviewCitationFailure =
  value<Old.ReviewCitationFailure>();
export const old_ReviewCitationFailure: Old.ReviewCitationFailure =
  value<New.ReviewCitationFailure>();
export const new_ReviewCitationFinding: New.ReviewCitationFinding =
  value<Old.ReviewCitationFinding>();
export const old_ReviewCitationFinding: Old.ReviewCitationFinding =
  value<New.ReviewCitationFinding>();
export const new_ReviewCitationIssue: New.ReviewCitationIssue = value<Old.ReviewCitationIssue>();
export const old_ReviewCitationIssue: Old.ReviewCitationIssue = value<New.ReviewCitationIssue>();
export const new_ReviewCitationRecord: New.ReviewCitationRecord = value<Old.ReviewCitationRecord>();
export const old_ReviewCitationRecord: Old.ReviewCitationRecord = value<New.ReviewCitationRecord>();
export const new_ReviewCitationResult: New.ReviewCitationResult = value<Old.ReviewCitationResult>();
export const old_ReviewCitationResult: Old.ReviewCitationResult = value<New.ReviewCitationResult>();
export const new_ReviewCitationSource: New.ReviewCitationSource = value<Old.ReviewCitationSource>();
export const old_ReviewCitationSource: Old.ReviewCitationSource = value<New.ReviewCitationSource>();
export const new_ReviewCitationUncheckedReason: New.ReviewCitationUncheckedReason =
  value<Old.ReviewCitationUncheckedReason>();
export const old_ReviewCitationUncheckedReason: Old.ReviewCitationUncheckedReason =
  value<New.ReviewCitationUncheckedReason>();
export const new_ReviewMoreCitation: New.ReviewMoreCitation = value<Old.ReviewMoreCitation>();
export const old_ReviewMoreCitation: Old.ReviewMoreCitation = value<New.ReviewMoreCitation>();
export const new_ReviewClaim: New.ReviewClaim = value<Old.ReviewClaim>();
export const old_ReviewClaim: Old.ReviewClaim = value<New.ReviewClaim>();
export const new_ReviewCredits: New.ReviewCredits = value<Old.ReviewCredits>();
export const old_ReviewCredits: Old.ReviewCredits = value<New.ReviewCredits>();
export const new_ReviewEntity: New.ReviewEntity = value<Old.ReviewEntity>();
export const old_ReviewEntity: Old.ReviewEntity = value<New.ReviewEntity>();
export const new_ReviewEnvelope: New.ReviewEnvelope = value<Old.ReviewEnvelope>();
export const old_ReviewEnvelope: Old.ReviewEnvelope = value<New.ReviewEnvelope>();
export const new_ReviewFailure: New.ReviewFailure = value<Old.ReviewFailure>();
export const old_ReviewFailure: Old.ReviewFailure = value<New.ReviewFailure>();
export const new_ReviewFailureBlock: New.ReviewFailureBlock = value<Old.ReviewFailureBlock>();
export const old_ReviewFailureBlock: Old.ReviewFailureBlock = value<New.ReviewFailureBlock>();
export const new_ReviewFull: New.ReviewFull = value<Old.ReviewFull>();
export const old_ReviewFull: Old.ReviewFull = value<New.ReviewFull>();
export const new_ReviewInput: New.ReviewInput = value<Old.ReviewInput>();
export const old_ReviewInput: Old.ReviewInput = value<New.ReviewInput>();
export const new_ReviewIssue: New.ReviewIssue = value<Old.ReviewIssue>();
export const old_ReviewIssue: Old.ReviewIssue = value<New.ReviewIssue>();
export const new_ReviewIssues: New.ReviewIssues = value<Old.ReviewIssues>();
export const old_ReviewIssues: Old.ReviewIssues = value<New.ReviewIssues>();
export const new_ReviewOutcome: New.ReviewOutcome = value<Old.ReviewOutcome>();
export const old_ReviewOutcome: Old.ReviewOutcome = value<New.ReviewOutcome>();
export const new_ReviewResult: New.ReviewResult = value<Old.ReviewResult>();
export const old_ReviewResult: Old.ReviewResult = value<New.ReviewResult>();
export const new_ReviewStarted: New.ReviewStarted = value<Old.ReviewStarted>();
export const old_ReviewStarted: Old.ReviewStarted = value<New.ReviewStarted>();
export const new_ReviewStatus: New.ReviewStatus = value<Old.ReviewStatus>();
export const old_ReviewStatus: Old.ReviewStatus = value<New.ReviewStatus>();
export const new_ReviewSummary: New.ReviewSummary = value<Old.ReviewSummary>();
export const old_ReviewSummary: Old.ReviewSummary = value<New.ReviewSummary>();
export const new_ReviewVerification: New.ReviewVerification = value<Old.ReviewVerification>();
export const old_ReviewVerification: Old.ReviewVerification = value<New.ReviewVerification>();
export const new_ReviewVerificationCounts: New.ReviewVerificationCounts =
  value<Old.ReviewVerificationCounts>();
export const old_ReviewVerificationCounts: Old.ReviewVerificationCounts =
  value<New.ReviewVerificationCounts>();
export const new_VerdictLabel: New.VerdictLabel = value<Old.VerdictLabel>();
export const old_VerdictLabel: Old.VerdictLabel = value<New.VerdictLabel>();
export const new_AskHistory: New.AskHistory = value<Old.AskHistory>();
export const old_AskHistory: Old.AskHistory = value<New.AskHistory>();
export const new_AskMessage: New.AskMessage = value<Old.AskMessage>();
export const old_AskMessage: Old.AskMessage = value<New.AskMessage>();
export const new_AskReply: New.AskReply = value<Old.AskReply>();
export const old_AskReply: Old.AskReply = value<New.AskReply>();
export const new_AssessClaim: New.AssessClaim = value<Old.AssessClaim>();
export const old_AssessClaim: Old.AssessClaim = value<New.AssessClaim>();
export const new_AssessInput: New.AssessInput = value<Old.AssessInput>();
export const old_AssessInput: Old.AssessInput = value<New.AssessInput>();
export const new_AssessResponse: New.AssessResponse = value<Old.AssessResponse>();
export const old_AssessResponse: Old.AssessResponse = value<New.AssessResponse>();
export const new_Assessment: New.Assessment = value<Old.Assessment>();
export const old_Assessment: Old.Assessment = value<New.Assessment>();
export const new_Audit: New.Audit = value<Old.Audit>();
export const old_Audit: Old.Audit = value<New.Audit>();
export const new_BatchAccepted: New.BatchAccepted = value<Old.BatchAccepted>();
export const old_BatchAccepted: Old.BatchAccepted = value<New.BatchAccepted>();
export const new_BatchItemResult: New.BatchItemResult = value<Old.BatchItemResult>();
export const old_BatchItemResult: Old.BatchItemResult = value<New.BatchItemResult>();
export const new_CandidateClaim: New.CandidateClaim = value<Old.CandidateClaim>();
export const old_CandidateClaim: Old.CandidateClaim = value<New.CandidateClaim>();
export const new_ClaimLocation: New.ClaimLocation = value<Old.ClaimLocation>();
export const old_ClaimLocation: Old.ClaimLocation = value<New.ClaimLocation>();
export const new_Position: New.Position = value<Old.Position>();
export const old_Position: Old.Position = value<New.Position>();
export const new_SuggestedEdit: New.SuggestedEdit = value<Old.SuggestedEdit>();
export const old_SuggestedEdit: Old.SuggestedEdit = value<New.SuggestedEdit>();
export const new_SuggestedEdits: New.SuggestedEdits = value<Old.SuggestedEdits>();
export const old_SuggestedEdits: Old.SuggestedEdits = value<New.SuggestedEdits>();
export const new_Certificate: New.Certificate = value<Old.Certificate>();
export const old_Certificate: Old.Certificate = value<New.Certificate>();
export const new_Coverage: New.Coverage = value<Old.Coverage>();
export const old_Coverage: Old.Coverage = value<New.Coverage>();
export const new_CoverageReason: New.CoverageReason = value<Old.CoverageReason>();
export const old_CoverageReason: Old.CoverageReason = value<New.CoverageReason>();
export const new_CoverageStatus: New.CoverageStatus = value<Old.CoverageStatus>();
export const old_CoverageStatus: Old.CoverageStatus = value<New.CoverageStatus>();
export const new_DebateSide: New.DebateSide = value<Old.DebateSide>();
export const old_DebateSide: Old.DebateSide = value<New.DebateSide>();
export const new_EntityRef: New.EntityRef = value<Old.EntityRef>();
export const old_EntityRef: Old.EntityRef = value<New.EntityRef>();
export const new_ExtractInput: New.ExtractInput = value<Old.ExtractInput>();
export const old_ExtractInput: Old.ExtractInput = value<New.ExtractInput>();
export const new_ExtractStatus: New.ExtractStatus = value<Old.ExtractStatus>();
export const old_ExtractStatus: Old.ExtractStatus = value<New.ExtractStatus>();
export const new_ExtractedClaims: New.ExtractedClaims = value<Old.ExtractedClaims>();
export const old_ExtractedClaims: Old.ExtractedClaims = value<New.ExtractedClaims>();
export const new_ExtractedClaim: New.ExtractedClaim = value<Old.ExtractedClaim>();
export const old_ExtractedClaim: Old.ExtractedClaim = value<New.ExtractedClaim>();
export const new_ExtractedEntity: New.ExtractedEntity = value<Old.ExtractedEntity>();
export const old_ExtractedEntity: Old.ExtractedEntity = value<New.ExtractedEntity>();
export const new_FailureClass: New.FailureClass = value<Old.FailureClass>();
export const old_FailureClass: Old.FailureClass = value<New.FailureClass>();
export const new_LibraryItem: New.LibraryItem = value<Old.LibraryItem>();
export const old_LibraryItem: Old.LibraryItem = value<New.LibraryItem>();
export const new_LibraryList: New.LibraryList = value<Old.LibraryList>();
export const old_LibraryList: Old.LibraryList = value<New.LibraryList>();
export const new_LibraryListInput: New.LibraryListInput = value<Old.LibraryListInput>();
export const old_LibraryListInput: Old.LibraryListInput = value<New.LibraryListInput>();
export const new_OnProgress: New.OnProgress = value<Old.OnProgress>();
export const old_OnProgress: Old.OnProgress = value<New.OnProgress>();
export const new_Progress: New.Progress = value<Old.Progress>();
export const old_Progress: Old.Progress = value<New.Progress>();
export const new_RelatedVerifications: New.RelatedVerifications = value<Old.RelatedVerifications>();
export const old_RelatedVerifications: Old.RelatedVerifications = value<New.RelatedVerifications>();
export const new_SelectInput: New.SelectInput = value<Old.SelectInput>();
export const old_SelectInput: Old.SelectInput = value<New.SelectInput>();
export const new_SimilarVerification: New.SimilarVerification = value<Old.SimilarVerification>();
export const old_SimilarVerification: Old.SimilarVerification = value<New.SimilarVerification>();
export const new_Source: New.Source = value<Old.Source>();
export const old_Source: Old.Source = value<New.Source>();
export const new_TaskAccepted: New.TaskAccepted = value<Old.TaskAccepted>();
export const old_TaskAccepted: Old.TaskAccepted = value<New.TaskAccepted>();
export const new_TaskStatus: New.TaskStatus = value<Old.TaskStatus>();
export const old_TaskStatus: Old.TaskStatus = value<New.TaskStatus>();
export const new_Usage: New.Usage = value<Old.Usage>();
export const old_Usage: Old.Usage = value<New.Usage>();
export const new_UsageCapacity: New.UsageCapacity = value<Old.UsageCapacity>();
export const old_UsageCapacity: Old.UsageCapacity = value<New.UsageCapacity>();
export const new_UsageCredits: New.UsageCredits = value<Old.UsageCredits>();
export const old_UsageCredits: Old.UsageCredits = value<New.UsageCredits>();
export const new_UsageExtract: New.UsageExtract = value<Old.UsageExtract>();
export const old_UsageExtract: Old.UsageExtract = value<New.UsageExtract>();
export const new_Verification: New.Verification = value<Old.Verification>();
export const old_Verification: Old.Verification = value<New.Verification>();
export const new_VerificationList: New.VerificationList = value<Old.VerificationList>();
export const old_VerificationList: Old.VerificationList = value<New.VerificationList>();
export const new_VerificationListItem: New.VerificationListItem = value<Old.VerificationListItem>();
export const old_VerificationListItem: Old.VerificationListItem = value<New.VerificationListItem>();
export const new_VerifyAndWaitInput: New.VerifyAndWaitInput = value<Old.VerifyAndWaitInput>();
export const old_VerifyAndWaitInput: Old.VerifyAndWaitInput = value<New.VerifyAndWaitInput>();
export const new_VerifyBatchAndWaitInput: New.VerifyBatchAndWaitInput =
  value<Old.VerifyBatchAndWaitInput>();
export const old_VerifyBatchAndWaitInput: Old.VerifyBatchAndWaitInput =
  value<New.VerifyBatchAndWaitInput>();
export const new_VerifyBatchInput: New.VerifyBatchInput = value<Old.VerifyBatchInput>();
export const old_VerifyBatchInput: Old.VerifyBatchInput = value<New.VerifyBatchInput>();
export const new_VerifyInput: New.VerifyInput = value<Old.VerifyInput>();
export const old_VerifyInput: Old.VerifyInput = value<New.VerifyInput>();
export const new_WaitOptions: New.WaitOptions = value<Old.WaitOptions>();
export const old_WaitOptions: Old.WaitOptions = value<New.WaitOptions>();

// Error classes: instance types, both ways.
export const new_LenzAPIError: New.LenzAPIError = value<Old.LenzAPIError>();
export const old_LenzAPIError: Old.LenzAPIError = value<New.LenzAPIError>();
export const new_LenzAuthError: New.LenzAuthError = value<Old.LenzAuthError>();
export const old_LenzAuthError: Old.LenzAuthError = value<New.LenzAuthError>();
export const new_LenzError: New.LenzError = value<Old.LenzError>();
export const old_LenzError: Old.LenzError = value<New.LenzError>();
export const new_LenzGoneError: New.LenzGoneError = value<Old.LenzGoneError>();
export const old_LenzGoneError: Old.LenzGoneError = value<New.LenzGoneError>();
export const new_LenzNeedsInputError: New.LenzNeedsInputError = value<Old.LenzNeedsInputError>();
export const old_LenzNeedsInputError: Old.LenzNeedsInputError = value<New.LenzNeedsInputError>();
export const new_LenzPipelineError: New.LenzPipelineError = value<Old.LenzPipelineError>();
export const old_LenzPipelineError: Old.LenzPipelineError = value<New.LenzPipelineError>();
export const new_LenzQuotaExceededError: New.LenzQuotaExceededError =
  value<Old.LenzQuotaExceededError>();
export const old_LenzQuotaExceededError: Old.LenzQuotaExceededError =
  value<New.LenzQuotaExceededError>();
export const new_LenzRateLimitError: New.LenzRateLimitError = value<Old.LenzRateLimitError>();
export const old_LenzRateLimitError: Old.LenzRateLimitError = value<New.LenzRateLimitError>();
export const new_LenzTimeoutError: New.LenzTimeoutError = value<Old.LenzTimeoutError>();
export const old_LenzTimeoutError: Old.LenzTimeoutError = value<New.LenzTimeoutError>();
export const new_LenzUpstreamUnavailableError: New.LenzUpstreamUnavailableError =
  value<Old.LenzUpstreamUnavailableError>();
export const old_LenzUpstreamUnavailableError: Old.LenzUpstreamUnavailableError =
  value<New.LenzUpstreamUnavailableError>();
export const new_LenzValidationError: New.LenzValidationError = value<Old.LenzValidationError>();
export const old_LenzValidationError: Old.LenzValidationError = value<New.LenzValidationError>();
export const new_LenzVerificationNotReadyError: New.LenzVerificationNotReadyError =
  value<Old.LenzVerificationNotReadyError>();
export const old_LenzVerificationNotReadyError: Old.LenzVerificationNotReadyError =
  value<New.LenzVerificationNotReadyError>();
export const new_LenzWebhookSignatureError: New.LenzWebhookSignatureError =
  value<Old.LenzWebhookSignatureError>();
export const old_LenzWebhookSignatureError: Old.LenzWebhookSignatureError =
  value<New.LenzWebhookSignatureError>();
export const new_CitecheckFailedError: New.CitecheckFailedError = value<Old.CitecheckFailedError>();
export const old_CitecheckFailedError: Old.CitecheckFailedError = value<New.CitecheckFailedError>();
export const new_CitecheckTimeoutError: New.CitecheckTimeoutError =
  value<Old.CitecheckTimeoutError>();
export const old_CitecheckTimeoutError: Old.CitecheckTimeoutError =
  value<New.CitecheckTimeoutError>();
export const new_ReviewFailedError: New.ReviewFailedError = value<Old.ReviewFailedError>();
export const old_ReviewFailedError: Old.ReviewFailedError = value<New.ReviewFailedError>();
export const new_ReviewTimeoutError: New.ReviewTimeoutError = value<Old.ReviewTimeoutError>();
export const old_ReviewTimeoutError: Old.ReviewTimeoutError = value<New.ReviewTimeoutError>();

// Every public method of the client, and of its namespaces: the new one fits where the old one was used.
export const method_verify: Old.Lenz["verify"] = value<New.Lenz["verify"]>();
export const method_verifyBatch: Old.Lenz["verifyBatch"] = value<New.Lenz["verifyBatch"]>();
export const method_extract: Old.Lenz["extract"] = value<New.Lenz["extract"]>();
export const method_assess: Old.Lenz["assess"] = value<New.Lenz["assess"]>();
export const method_select: Old.Lenz["select"] = value<New.Lenz["select"]>();
export const method_getStatus: Old.Lenz["getStatus"] = value<New.Lenz["getStatus"]>();
export const method_usage: Old.Lenz["usage"] = value<New.Lenz["usage"]>();
export const method_review: Old.Lenz["review"] = value<New.Lenz["review"]>();
export const method_getReview: Old.Lenz["getReview"] = value<New.Lenz["getReview"]>();
export const method_citecheck: Old.Lenz["citecheck"] = value<New.Lenz["citecheck"]>();
export const method_getCitecheck: Old.Lenz["getCitecheck"] = value<New.Lenz["getCitecheck"]>();
export const method_citecheckAndWait: Old.Lenz["citecheckAndWait"] =
  value<New.Lenz["citecheckAndWait"]>();
export const method_reviewAndWait: Old.Lenz["reviewAndWait"] = value<New.Lenz["reviewAndWait"]>();
export const method_verifyAndWait: Old.Lenz["verifyAndWait"] = value<New.Lenz["verifyAndWait"]>();
export const method_wait: Old.Lenz["wait"] = value<New.Lenz["wait"]>();
export const method_verifyBatchAndWait: Old.Lenz["verifyBatchAndWait"] =
  value<New.Lenz["verifyBatchAndWait"]>();
export const method_request: Old.Lenz["request"] = value<New.Lenz["request"]>();
export const verifications_list: Old.Lenz["verifications"]["list"] =
  value<New.Lenz["verifications"]["list"]>();
export const verifications_get: Old.Lenz["verifications"]["get"] =
  value<New.Lenz["verifications"]["get"]>();
export const verifications_getCertificate: Old.Lenz["verifications"]["getCertificate"] =
  value<New.Lenz["verifications"]["getCertificate"]>();
export const verifications_delete: Old.Lenz["verifications"]["delete"] =
  value<New.Lenz["verifications"]["delete"]>();
export const verifications_related: Old.Lenz["verifications"]["related"] =
  value<New.Lenz["verifications"]["related"]>();
export const ask_history: Old.Lenz["ask"]["history"] = value<New.Lenz["ask"]["history"]>();
export const ask_send: Old.Lenz["ask"]["send"] = value<New.Lenz["ask"]["send"]>();
export const ask_reset: Old.Lenz["ask"]["reset"] = value<New.Lenz["ask"]["reset"]>();
export const library_list: Old.Lenz["library"]["list"] = value<New.Lenz["library"]["list"]>();

// Literal event mocks written against the old types still type-check.
export const failedMock: New.VerificationFailed = {
  event: "verification.failed",
  taskId: "t",
  attempt: 1,
  deliveredAt: "",
  verificationId: null,
  batchId: null,
  status: "failed",
  raw: {},
  error: "not_a_claim",
  failureClass: "invalid_input",
  retryable: false,
};
export const completedMock: New.VerificationCompleted = {
  event: "verification.completed",
  taskId: "t",
  attempt: 1,
  deliveredAt: "",
  verificationId: "v",
  batchId: null,
  status: "completed",
  raw: {},
  result: {},
};
export const needsInputMock: New.VerificationNeedsInput = {
  event: "verification.needs_input",
  taskId: "t",
  attempt: 1,
  deliveredAt: "",
  verificationId: null,
  batchId: null,
  status: "needs_input",
  raw: {},
  needsInput: {},
  hint: "",
};
export const failureBlockMock: New.ReviewFailureBlock = {
  failure_reason: "no_claim",
  failure_class: "invalid_input",
  retryable: false,
  hint: null,
  docs_url: "https://lenz.io/docs/errors",
};
export const docsUrl: string = value<New.ReviewFailureBlock>().docs_url;
