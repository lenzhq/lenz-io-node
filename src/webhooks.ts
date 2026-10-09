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

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

import { LenzWebhookSignatureError } from "./errors.js";
import { withCitecheckDefaults, withReviewDefaults } from "./reviewDefaults.js";
import {
  normalizeOptions,
  normalizeWebhookStatus,
  normalizeVerification,
  webhookResultDefaults,
} from "./compat.js";
import type {
  Citecheck,
  Coverage,
  FailureClass,
  ReviewFailureBlock,
  ReviewFull,
  TaskStatus,
} from "./types.js";

export const SIGNATURE_HEADER = "X-Lenz-Signature";
const SIGNATURE_PREFIX = "sha256=";
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

type RawBody = string | Buffer | Uint8Array;

function toBuffer(body: RawBody): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  // String — encode as UTF-8 bytes. WARNING: only safe if the original
  // body was ASCII / valid UTF-8 and no proxy mangled it. Prefer Buffer.
  return Buffer.from(body, "utf-8");
}

function sign(body: Buffer, secret: string): string {
  const mac = createHmac("sha256", secret).update(body).digest("hex");
  return `${SIGNATURE_PREFIX}${mac}`;
}

export function verifySignature(rawBody: RawBody, signature: string, secret: string): true {
  if (!signature) {
    throw new LenzWebhookSignatureError({
      message: "Missing webhook signature",
      cause: `No ${SIGNATURE_HEADER} header on the request.`,
      fix: "Inspect the webhook delivery in /api-credentials to confirm the secret is set.",
      docUrl: "https://lenz.io/docs/webhooks",
    });
  }

  const buf = toBuffer(rawBody);
  const expected = sign(buf, secret);

  // timingSafeEqual requires equal-length buffers; pad if needed.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new LenzWebhookSignatureError({
      message: "Webhook signature mismatch",
      cause: "HMAC of the raw body using your secret does not match X-Lenz-Signature.",
      fix: "Verify the secret in /api-credentials matches the one you configured here.",
      docUrl: "https://lenz.io/docs/webhooks",
    });
  }
  return true;
}

// ── Typed events ─────────────────────────────────────────────────────────

export type WebhookEventKind =
  | "verification.completed"
  | "verification.failed"
  | "verification.needs_input"
  | "certificate.timestamped"
  | "review.completed"
  | "review.failed"
  | "citecheck.completed"
  | "citecheck.failed"
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
  | WebhookEventBase; // catch-all for forward compatibility

function has(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The verification body of a `verification.*` event: the newer shape's
 * `verification`, else one built from the original flat payload.
 */
function verificationBody(event: string, payload: Record<string, unknown>): TaskStatus | undefined {
  const nested = asObject(payload["verification"]);
  if (nested) return normalizeWebhookStatus(nested) as TaskStatus;
  const taskId = payload["task_id"];
  if (event === "verification.completed") {
    return normalizeWebhookStatus({
      status: "completed",
      task_id: taskId,
      result: payload["result"],
    }) as TaskStatus;
  }
  if (event === "verification.failed") {
    const flat: Record<string, unknown> = { status: "failed", task_id: taskId };
    // The original payload's `error` is the failure code.
    if (typeof payload["error"] === "string") flat["failure_reason"] = payload["error"];
    for (const key of ["failure_class", "retryable"]) {
      if (payload[key] !== undefined) flat[key] = payload[key];
    }
    const status = normalizeWebhookStatus(flat) as Record<string, unknown>;
    // `error` here was never a sentence: drop the copy made from it.
    const failure = asObject(status["failure"]);
    if (failure) status["failure"] = { ...failure, detail: null };
    delete status["error"];
    return status as unknown as TaskStatus;
  }
  if (event === "verification.needs_input") {
    const ni = asObject(payload["needs_input"]) ?? {};
    return normalizeWebhookStatus({ status: "needs_input", task_id: taskId, ...ni }) as TaskStatus;
  }
  return undefined;
}

function buildEvent(payload: Record<string, unknown>): WebhookEvent {
  const event = String(payload["event"] ?? "");
  const verification = event.startsWith("verification.")
    ? verificationBody(event, payload)
    : undefined;
  const base: WebhookEventBase = {
    event,
    // The newer review / citation-check events carry no `task_id`: their
    // `review_id` / `citecheck_id` stands in, so `taskId` is never "".
    taskId: String(
      payload["task_id"] ??
        verification?.task_id ??
        payload["review_id"] ??
        payload["citecheck_id"] ??
        "",
    ),
    attempt: Number(payload["attempt"] ?? 1) || 1,
    deliveredAt: String(payload["delivered_at"] ?? ""),
    verificationId: (payload["verification_id"] as string | null) ?? null,
    batchId: (payload["batch_id"] as string | null) ?? null,
    status: String(payload["status"] ?? ""),
    raw: payload,
  };
  if (event === "verification.completed") {
    // The newer event's result has only the fields stored; the original
    // event carried every field, with its default where none was stored.
    const result = has(payload, "result")
      ? payload["result"]
      : webhookResultDefaults(verification?.result);
    return {
      ...base,
      event: "verification.completed",
      result: (normalizeVerification(result) as Record<string, unknown>) ?? {},
      verification,
    };
  }
  if (event === "verification.failed") {
    const failure = (verification?.failure ?? null) as ReviewFailureBlock | null;
    // The newer payload nests the failure in `verification`; the original's
    // flat fields are read exactly as before.
    const nested = asObject(payload["verification"]) !== null && !("error" in payload);
    const retryable = nested ? failure?.retryable : payload["retryable"];
    return {
      ...base,
      event: "verification.failed",
      error: String((nested ? failure?.failure_reason : payload["error"]) ?? ""),
      failureClass: String((nested ? failure?.failure_class : payload["failure_class"]) ?? ""),
      retryable: typeof retryable === "boolean" ? retryable : null,
      failure,
      verification,
    };
  }
  if (event === "verification.needs_input") {
    let needsInput = (payload["needs_input"] as Record<string, unknown>) ?? null;
    if (needsInput === null && verification) {
      // The newer shape: the same fields, on the verification body.
      const rest: Record<string, unknown> = {
        ...(verification as unknown as Record<string, unknown>),
      };
      delete rest["status"];
      delete rest["task_id"];
      needsInput = rest;
    }
    needsInput ??= {};
    if (Array.isArray(needsInput["claims"])) {
      // Each option under both names: `claim` (newer) and `text` (original).
      needsInput = { ...needsInput, claims: normalizeOptions(needsInput["claims"]) };
    }
    return {
      ...base,
      event: "verification.needs_input",
      needsInput,
      hint: String(needsInput["hint"] ?? ""),
      verification,
    };
  }
  if (event === "certificate.timestamped") {
    return {
      ...base,
      event: "certificate.timestamped",
      coverage: (payload["coverage"] as Coverage) ?? {},
    };
  }
  if (event === "review.completed" || event === "review.failed") {
    const review = payload["review"];
    // A review event without its review is not one we can type; hand it
    // over as the base shape rather than as a half-built event.
    if (review && typeof review === "object" && !Array.isArray(review)) {
      return {
        ...base,
        event,
        eventId: String(payload["event_id"] ?? ""),
        reviewId: String(payload["review_id"] ?? ""),
        review: withReviewDefaults(review) as ReviewFull,
      };
    }
  }
  if (event === "citecheck.completed" || event === "citecheck.failed") {
    const check = payload["citecheck"];
    if (check && typeof check === "object" && !Array.isArray(check)) {
      return {
        ...base,
        event,
        eventId: String(payload["event_id"] ?? ""),
        citecheckId: String(payload["citecheck_id"] ?? ""),
        citecheck: withCitecheckDefaults(check) as Citecheck,
      };
    }
  }
  return base;
}

export interface LenzWebhooksOptions {
  secret: string;
  replayWindowSeconds?: number;
}

export class LenzWebhooks {
  private secret: string;
  private replayWindow: number;

  constructor(opts: LenzWebhooksOptions) {
    if (!opts.secret) {
      throw new Error("LenzWebhooks requires a non-empty secret. Get it from /api-credentials.");
    }
    this.secret = opts.secret;
    this.replayWindow = opts.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;
  }

  parse(rawBody: RawBody, headers: Record<string, string> | Headers): WebhookEvent {
    const sig = this.lookupHeader(headers, SIGNATURE_HEADER);
    verifySignature(rawBody, sig, this.secret);

    const text = toBuffer(rawBody).toString("utf-8");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (exc) {
      throw new LenzWebhookSignatureError({
        message: "Webhook body is not valid JSON",
        cause: String(exc),
        fix: "The signature verified but the body is malformed. Check your reverse proxy isn't rewriting payloads.",
        docUrl: "https://lenz.io/docs/webhooks",
      });
    }

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new LenzWebhookSignatureError({
        message: "Webhook body must be a JSON object",
        cause: `Got ${typeof payload}.`,
        fix: "Confirm the request comes from Lenz; an upstream proxy may be wrapping the body.",
        docUrl: "https://lenz.io/docs/webhooks",
      });
    }

    const obj = payload as Record<string, unknown>;
    this.checkReplay(obj);
    return buildEvent(obj);
  }

  // ── helpers ──

  private lookupHeader(headers: Record<string, string> | Headers, name: string): string {
    if (typeof (headers as Headers).get === "function") {
      const v = (headers as Headers).get(name);
      return v ? String(v) : "";
    }
    const h = headers as Record<string, string>;
    return h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()] ?? "";
  }

  private checkReplay(payload: Record<string, unknown>): void {
    const raw = payload["delivered_at"];
    if (!raw) return;
    const ts = new Date(String(raw));
    if (Number.isNaN(ts.getTime())) return;
    const ageSec = (Date.now() - ts.getTime()) / 1000;
    if (ageSec > this.replayWindow) {
      throw new LenzWebhookSignatureError({
        message: "Webhook delivered_at is outside the replay window",
        cause: `Payload is ${Math.round(ageSec)}s old; window is ${this.replayWindow}s.`,
        fix: "Confirm your server clock is in sync; raise replayWindowSeconds if you intentionally batch deliveries.",
        docUrl: "https://lenz.io/docs/webhooks",
      });
    }
  }
}
