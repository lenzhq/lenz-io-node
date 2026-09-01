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
 *
 * // 2. /assess — fast 3-model verdict on each (~10s, one credit per claim); independent calls
 * const claims = out.identified_claims?.length ? out.identified_claims : [out.claim!];
 * const quick = await Promise.all(
 *   claims.map(async (c) => (await client.assess({ claim: c })).claims[0]),
 * );
 *
 * // 3. /verify — escalate the low-confidence ones to the full pipeline (~90s), in one batch
 * const doubtful = quick.filter((c) => c.confidence === 'low').map((c) => ({ claim: c.claim! }));
 * const results = await client.verifyBatchAndWait({ claims: doubtful });
 * for (const r of results) {
 *   if (r.verification) console.log(r.verification.verdict, r.verification.lenz_score);
 * }
 * const deep = results[0]?.verification;
 *
 * // 4. /ask — follow-up questions grounded on a verification
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
  LenzNeedsInputError,
  LenzPipelineError,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzTimeoutError,
  LenzUpstreamUnavailableError,
  LenzValidationError,
  LenzWebhookSignatureError,
  MAX_RETRY_AFTER_SLEEP,
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
  ExtractStatus,
  ExtractedClaims,
  ExtractedEntity,
  FailureClass,
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
  VerifyInput,
  WaitOptions,
} from "./types.js";

// VERSION is generated at build time from package.json#version by
// scripts/sync-version.mjs (runs as `prebuild`). _version.ts is
// gitignored; the release workflow updates package.json from the git
// tag before `npm run build` fires, so the bundled VERSION matches the
// published npm package exactly.
export { VERSION } from "./_version.js";
