/**
 * Typed webhook events and the `isEvent` guard.
 *
 * Kept apart from `webhooks.ts` (which verifies signatures with
 * `node:crypto`) so the browser entry can export `isEvent` and the event
 * types without pulling in a Node-only module.
 */

import type {
  Citecheck,
  Coverage,
  FailureClass,
  ReviewFailureBlock,
  ReviewFull,
  TaskStatus,
  Verification,
} from "./types.js";

// ── Typed events ─────────────────────────────────────────────────────────

export type WebhookEventKind =
  | "verification.completed"
  | "verification.failed"
  | "verification.cancelled"
  | "verification.needs_input"
  | "certificate.timestamped"
  | "review.completed"
  | "review.failed"
  | "review.cancelled"
  | "citecheck.completed"
  | "citecheck.failed"
  | "citecheck.cancelled"
  // The `string & NonNullable<unknown>` trick preserves the autocomplete
  // hints from the literal union while still permitting any future
  // event-kind string the server adds. `(string & {})` reads cleaner but
  // trips @typescript-eslint/ban-types.
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
  /**
   * The delivery's stable id (`event_id`): the same on every retry of one
   * event, so dedupe on it. Absent when the payload carries none (the
   * original shape of `verification.*` events).
   */
  eventId?: string;
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
  /** @deprecated Read `verification.result`. */
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
  /**
   * WHY it failed — the closed `FailureClass` set; "" when an older server omits it.
   *
   * @deprecated Read `failure.failure_class`.
   */
  failureClass: FailureClass;
  /**
   * true iff `upstream_unavailable` — resubmit the same claim after a short wait.
   *
   * @deprecated Read `failure.retryable`.
   */
  retryable: boolean | null;
}

/**
 * `event=verification.cancelled` — the run was cancelled elsewhere (the
 * website's Stop button, another process). Sent only for work submitted under
 * API version 2026-10-11; a cancellation submitted under the original version
 * keeps arriving as `verification.failed` with failure class `cancelled`.
 * `verification` is the cancelled status, as `client.getStatus` returns it.
 */
export interface VerificationCancelled extends WebhookEventBase, VerificationEventBody {
  event: "verification.cancelled";
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
 * `event=review.completed` / `review.failed` / `review.cancelled` — a review ended.
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
  event: "review.completed" | "review.failed" | "review.cancelled";
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

/**
 * The review was cancelled elsewhere. Sent only for work submitted under API
 * version 2026-10-11; under the original version it arrives as `review.failed`
 * with failure class `cancelled`.
 */
export interface ReviewCancelled extends ReviewEventBase {
  event: "review.cancelled";
}

/** Any review event. */
export type ReviewEvent = ReviewCompleted | ReviewFailed | ReviewCancelled;

/**
 * `event=citecheck.completed` / `citecheck.failed` / `citecheck.cancelled` — a
 * citation check ended.
 * `citecheck` is the whole check, as `client.getCitecheck` returns it.
 * **Dedupe on `eventId`**: it is stable across every retry, while `attempt`
 * changes. `taskId` is the delivery's identity, not pollable (the
 * `citecheckId` in the API's newer payload shape, which sends no `task_id`).
 */
export interface CitecheckEventBase extends WebhookEventBase {
  event: "citecheck.completed" | "citecheck.failed" | "citecheck.cancelled";
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

/**
 * The check was cancelled elsewhere. Sent only for work submitted under API
 * version 2026-10-11; under the original version it arrives as
 * `citecheck.failed` with failure class `cancelled`.
 */
export interface CitecheckCancelled extends CitecheckEventBase {
  event: "citecheck.cancelled";
}

/** Any citation-check event. */
export type CitecheckEvent = CitecheckCompleted | CitecheckFailed | CitecheckCancelled;

/**
 * Every event `parse` returns, discriminated on `event`. Ignore an event you
 * do not recognise: new kinds are added without a major release and arrive
 * as the base shape.
 */
export type WebhookEvent =
  | ReviewCompleted
  | ReviewFailed
  | ReviewCancelled
  | CitecheckCompleted
  | CitecheckFailed
  | CitecheckCancelled
  | VerificationCompleted
  | VerificationFailed
  | VerificationCancelled
  | VerificationNeedsInput
  | CertificateTimestamped
  | WebhookEventBase; // catch-all for forward compatibility

export function has(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

export function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Each known event kind, as {@link isEvent} narrows it: the member the kind
 * promises is present (a `verification.*` event's `verification`, with its
 * `result` on `completed`).
 */
export interface WebhookEventMap {
  "verification.completed": VerificationCompleted & {
    verification: TaskStatus & { result: Verification };
  };
  "verification.failed": VerificationFailed & { verification: TaskStatus };
  "verification.cancelled": VerificationCancelled & { verification: TaskStatus };
  "verification.needs_input": VerificationNeedsInput & { verification: TaskStatus };
  "certificate.timestamped": CertificateTimestamped;
  "review.completed": ReviewCompleted;
  "review.failed": ReviewFailed;
  "review.cancelled": ReviewCancelled;
  "citecheck.completed": CitecheckCompleted;
  "citecheck.failed": CitecheckFailed;
  "citecheck.cancelled": CitecheckCancelled;
}

/** Whether the payload carries a `verification.*` event's verification, in either shape. */
function carriesVerification(raw: Record<string, unknown>, kind: string): boolean {
  if (has(raw, "verification")) return asObject(raw["verification"]) !== null;
  // Only the 2026-10-11 payload has a cancelled event, and it nests.
  if (kind === "verification.cancelled") return false;
  // The original shape: flat fields beside the task id.
  if (typeof raw["task_id"] !== "string" || raw["task_id"] === "") return false;
  if (kind === "verification.completed") return asObject(raw["result"]) !== null;
  if (kind === "verification.failed") return has(raw, "error");
  return asObject(raw["needs_input"]) !== null;
}

/** The status each `verification.*` kind's verification must have. */
const VERIFICATION_STATUS: Record<string, string> = {
  "verification.completed": "completed",
  "verification.failed": "failed",
  "verification.cancelled": "cancelled",
  "verification.needs_input": "needs_input",
};

function isArray(v: unknown): boolean {
  return Array.isArray(v);
}

/** The members a `ReviewFull` cannot be read without (the rest are filled when parsed). */
function isReviewShape(v: unknown): boolean {
  const r = asObject(v);
  return (
    !!r &&
    typeof r["review_id"] === "string" &&
    typeof r["status"] === "string" &&
    isArray(r["issues"]) &&
    isArray(r["failures"]) &&
    isArray(r["claims"]) &&
    isArray(r["citations"]) &&
    isArray(r["citation_issues"]) &&
    isArray(r["citation_failures"]) &&
    asObject(r["summary"]) !== null &&
    asObject(r["credits"]) !== null
  );
}

/** The members a `Citecheck` cannot be read without (the lists are filled when parsed). */
function isCitecheckShape(v: unknown): boolean {
  const c = asObject(v);
  return (
    !!c &&
    typeof c["citecheck_id"] === "string" &&
    typeof c["status"] === "string" &&
    isArray(c["citations"]) &&
    isArray(c["citation_issues"]) &&
    isArray(c["citation_failures"]) &&
    asObject(c["summary"]) !== null &&
    asObject(c["credits"]) !== null
  );
}

/**
 * Narrow a parsed event to one kind, without a cast:
 *
 * ```ts
 * const event = hooks.parse(rawBody, req.headers);
 * if (isEvent(event, "verification.completed")) {
 *   console.log(event.verification.result.verdict);
 * }
 * ```
 *
 * True only when the event's name is `kind` AND the members the narrowed
 * type requires were parsed: a `verification.*` event's `verification` with
 * a string `task_id` and the kind's own `status` (`"completed"` with an
 * object `result` on `verification.completed`); a review's or citation
 * check's id, `status`, lists, `summary` and `credits`; a certificate's
 * `coverage`. A malformed event under a known name never narrows.
 *
 * Needs no crypto, so the browser entry exports it too.
 */
export function isEvent<K extends keyof WebhookEventMap>(
  event: WebhookEvent,
  kind: K,
): event is WebhookEventMap[K] {
  if (!event || event.event !== kind) return false;
  const e = event as unknown as Record<string, unknown>;
  const raw = asObject(e["raw"]) ?? {};
  if (kind.startsWith("verification.")) {
    const verification = asObject(e["verification"]);
    if (!verification || !carriesVerification(raw, kind)) return false;
    if (verification["status"] !== VERIFICATION_STATUS[kind]) return false;
    if (typeof verification["task_id"] !== "string") return false;
    return kind !== "verification.completed" || asObject(verification["result"]) !== null;
  }
  if (kind === "certificate.timestamped") return asObject(raw["coverage"]) !== null;
  if (kind.startsWith("review.")) return isReviewShape(e["review"]);
  if (kind.startsWith("citecheck.")) return isCitecheckShape(e["citecheck"]);
  return false;
}
