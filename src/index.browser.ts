/**
 * Browser entry point for `lenz-io`.
 *
 * Identical to the main entry (`./index.ts`) EXCEPT it omits the webhook
 * *value* exports (`LenzWebhooks`, `verifySignature`, …). Those live in
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
  DebateSide,
  EntityRef,
  ExtractInput,
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
