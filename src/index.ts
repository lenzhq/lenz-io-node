/**
 * Official Node SDK for the Lenz Claim Verification API for AI Product Teams.
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
 *
 * // 2. /assess — fast 3-model verdict on each (~5-10s, paid)
 * const quick = await client.assess({ text: llmOutput });
 *
 * // 3. /verify — escalate low-confidence to the full pipeline (~90s, paid)
 * for (const c of quick.claims) {
 *   if (c.confidence === 'low') {
 *     const deep = await client.verifyAndWait({ claim: c.claim! });
 *     console.log(deep.verdict, deep.lenz_score);
 *   }
 * }
 *
 * // 4. /ask — follow-up questions grounded on a verification
 * const reply = await client.ask.send(deep.verification_id!, {
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
  Verification,
  VerificationList,
  VerificationListItem,
  VerifyAndWaitInput,
  VerifyBatchAndWaitInput,
  VerifyBatchInput,
  VerifyInput,
  WaitOptions,
} from "./types.js";

// VERSION is generated at build time from package.json#version by
// scripts/sync-version.mjs (runs as `prebuild`). _version.ts is
// gitignored; the release workflow updates package.json from the git
// tag before `npm run build` fires, so the bundled VERSION matches the
// published npm package exactly.
export { VERSION } from "./_version.js";
