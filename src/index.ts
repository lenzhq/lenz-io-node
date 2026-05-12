/**
 * Official Node SDK for the Lenz Hallucination Verification API.
 *
 *     npm install lenz-io
 *
 * ```ts
 * import { Lenz } from 'lenz-io';
 *
 * const client = new Lenz({ apiKey: 'lenz_...' });
 * const v = await client.verifyAndWait({ claim: "Sharks don't get cancer" });
 * console.log(v.verdict?.label, v.verdict?.score);
 * // false 2.0
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
  LenzNeedsInputError,
  LenzPipelineError,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzTimeoutError,
  LenzValidationError,
  LenzWebhookSignatureError,
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
  VerificationCompleted,
  VerificationFailed,
  VerificationNeedsInput,
  WebhookEvent,
  WebhookEventBase,
  WebhookEventKind,
} from "./webhooks.js";

export type {
  Assessment,
  Audit,
  BatchAccepted,
  CandidateClaim,
  DebateSide,
  ExtractInput,
  ExtractedClaims,
  FollowupHistory,
  FollowupReply,
  LibraryItem,
  LibraryList,
  LibraryListInput,
  SelectInput,
  SimilarVerification,
  Source,
  TaskAccepted,
  TaskStatus,
  Usage,
  Verdict,
  Verification,
  VerificationList,
  VerificationListItem,
  VerifyAndWaitInput,
  VerifyBatchInput,
  VerifyInput,
} from "./types.js";

export const VERSION = "1.0.0-rc.1";
