/**
 * Webhook signature verification + typed event parsing.
 *
 * The Lenz Public API delivers verification lifecycle events as
 * HMAC-SHA256-signed JSON POSTs to a customer-supplied `webhook_url`.
 * This module exposes:
 *
 *   - `LenzWebhooks(secret).parse(rawBody, headers) -> WebhookEvent` —
 *     framework-agnostic high-level entry. Verifies signature, checks
 *     timestamp replay window, deserialises into a typed event union.
 *
 *   - `verifySignature(rawBody, signature, secret) -> true` — low-level
 *     escape hatch for callers who want only the signature check.
 *
 * Server-side signing lives in `lenz/api/webhook_signing.py` in the main
 * Lenz repo; both sides MUST produce byte-identical signatures.
 */
import { Buffer } from "node:buffer";
import type {
  Citecheck,
  Coverage,
  FailureClass,
  ReviewFailureBlock,
  ReviewFull,
  TaskStatus,
} from "./types.js";
export declare const SIGNATURE_HEADER = "X-Lenz-Signature";
export declare const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
type RawBody = string | Buffer | Uint8Array;
export declare function verifySignature(rawBody: RawBody, signature: string, secret: string): true;
export type WebhookEventKind =
  | "verification.completed"
  | "verification.failed"
  | "verification.needs_input"
  | "certificate.timestamped"
  | "review.completed"
  | "review.failed"
  | "citecheck.completed"
  | "citecheck.failed"
  | (string & NonNullable<unknown>);
export interface WebhookEventBase {
  event: WebhookEventKind;
  /**
   * The verification's `task_id`. On `review.*` / `citecheck.*` it is the
   * delivery's identity, not pollable, and `""` when the payload carries none.
   */
  taskId: string;
  attempt: number;
  deliveredAt: string;
  verificationId: string | null;
  batchId: string | null;
  status: string;
  /** The payload exactly as delivered, in whichever shape the server sent. */
  raw: Record<string, unknown>;
}
/**
 * The verification as `client.getStatus` returns it: on the newer payload
 * shape the event carries it as `verification`; on the original shape it is
 * built from the flat fields. `undefined` only when neither is there.
 */
interface VerificationEventBody {
  verification?: TaskStatus;
}
export interface VerificationCompleted extends WebhookEventBase, VerificationEventBody {
  event: "verification.completed";
  result: Record<string, unknown>;
}
export interface VerificationFailed extends WebhookEventBase, VerificationEventBody {
  event: "verification.failed";
  /**
   * @deprecated Read `failure.code`. The failure code, with its original
   * words (`not_a_claim` where `failure.code` says `no_checkable_claim`).
   */
  error: string;
  /** Why it failed: `code`, `detail`, `hint`, `failure_class`, `retryable`, `docs_url`. */
  failure?: ReviewFailureBlock | null;
  /** WHY it failed — the closed `FailureClass` set; "" when an older server omits it. */
  failureClass: FailureClass;
  /** true iff `upstream_unavailable` — resubmit the same claim after a short wait. */
  retryable: boolean | null;
}
export interface VerificationNeedsInput extends WebhookEventBase, VerificationEventBody {
  event: "verification.needs_input";
  needsInput: Record<string, unknown>;
  /**
   * One sentence on what was unclear and how `select` resolves it (on a
   * `multi_claim` pause); "" when the server sent none.
   */
  hint: string;
}
/**
 * `event=certificate.timestamped` — the qualified timestamp landed.
 *
 * **This is the event to publish on, not `verification.completed`.** The
 * warranty requires the certificate's timestamp to PRECEDE what you publish
 * or send, so a pipeline that publishes on `completed` races the anchor and
 * can put the statement out before cover exists. `completed` says a verdict
 * was produced; this says the qualified timestamp is in hand and cover is in
 * force.
 *
 * Carries `coverage` INSTEAD of `result`: the event reports that a timestamp
 * landed, not that a verdict was produced, so `result` is null here and
 * reading it will not give you the verification.
 */
export interface CertificateTimestamped extends WebhookEventBase {
  event: "certificate.timestamped";
  coverage: Coverage;
}
/**
 * `event=review.completed` / `review.failed` — a review ended.
 *
 * `review` is the whole review (`view: "full"`), exactly as
 * `client.getReview` returns it. **Dedupe on `eventId`**: it is stable for
 * the review and event across every retry, while `attempt` changes. A
 * review's own deep checks fire no `verification.*` events.
 *
 * `taskId` is the delivery's identity, not a task you can poll on
 * `/verify/status`; read the review with `client.getReview(reviewId)`. In the
 * API's newer payload shape, which sends no `task_id`, it is the `reviewId`.
 */
export interface ReviewEventBase extends WebhookEventBase {
  event: "review.completed" | "review.failed";
  eventId: string;
  reviewId: string;
  review: ReviewFull;
}
export interface ReviewCompleted extends ReviewEventBase {
  event: "review.completed";
}
/** The review's `failure` block says why; `review.outcome` is `unchecked` or `incomplete`. */
export interface ReviewFailed extends ReviewEventBase {
  event: "review.failed";
}
/** Either review event. */
export type ReviewEvent = ReviewCompleted | ReviewFailed;
/**
 * `event=citecheck.completed` / `citecheck.failed` — a citation check ended.
 * `citecheck` is the whole check, as `client.getCitecheck` returns it.
 * **Dedupe on `eventId`**: it is stable across every retry, while `attempt`
 * changes. `taskId` is the delivery's identity, not pollable (the
 * `citecheckId` in the API's newer payload shape, which sends no `task_id`).
 */
export interface CitecheckEventBase extends WebhookEventBase {
  event: "citecheck.completed" | "citecheck.failed";
  eventId: string;
  citecheckId: string;
  citecheck: Citecheck;
}
export interface CitecheckCompleted extends CitecheckEventBase {
  event: "citecheck.completed";
}
/** The check's `failure` block says why. */
export interface CitecheckFailed extends CitecheckEventBase {
  event: "citecheck.failed";
}
/** Either citation-check event. */
export type CitecheckEvent = CitecheckCompleted | CitecheckFailed;
/**
 * Every event `parse` returns, discriminated on `event`. Ignore an event you
 * do not recognise: new kinds are added without a major release and arrive
 * as the base shape.
 */
export type WebhookEvent =
  | ReviewCompleted
  | ReviewFailed
  | CitecheckCompleted
  | CitecheckFailed
  | VerificationCompleted
  | VerificationFailed
  | VerificationNeedsInput
  | CertificateTimestamped
  | WebhookEventBase;
export interface LenzWebhooksOptions {
  secret: string;
  replayWindowSeconds?: number;
}
export declare class LenzWebhooks {
  private secret;
  private replayWindow;
  constructor(opts: LenzWebhooksOptions);
  parse(rawBody: RawBody, headers: Record<string, string> | Headers): WebhookEvent;
  private lookupHeader;
  private checkReplay;
}
export {};
