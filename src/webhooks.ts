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

export function verifySignature(
  rawBody: RawBody,
  signature: string,
  secret: string,
): true {
  if (!signature) {
    throw new LenzWebhookSignatureError({
      message: "Missing webhook signature",
      cause: `No ${SIGNATURE_HEADER} header on the request.`,
      fix: "Inspect the webhook delivery in /api-integration to confirm the secret is set.",
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
      fix: "Verify the secret in /api-integration matches the one you configured here.",
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
  | (string & {}); // permit forward-compatible unknown events

export interface WebhookEventBase {
  event: WebhookEventKind;
  taskId: string;
  attempt: number;
  deliveredAt: string;
  verificationId: string | null;
  batchId: string | null;
  status: string;
  raw: Record<string, unknown>;
}

export interface VerificationCompleted extends WebhookEventBase {
  event: "verification.completed";
  result: Record<string, unknown>;
}

export interface VerificationFailed extends WebhookEventBase {
  event: "verification.failed";
  error: string;
}

export interface VerificationNeedsInput extends WebhookEventBase {
  event: "verification.needs_input";
  needsInput: Record<string, unknown>;
}

export type WebhookEvent =
  | VerificationCompleted
  | VerificationFailed
  | VerificationNeedsInput
  | WebhookEventBase; // catch-all for forward compatibility

function buildEvent(payload: Record<string, unknown>): WebhookEvent {
  const event = String(payload["event"] ?? "");
  const base: WebhookEventBase = {
    event,
    taskId: String(payload["task_id"] ?? ""),
    attempt: Number(payload["attempt"] ?? 1) || 1,
    deliveredAt: String(payload["delivered_at"] ?? ""),
    verificationId: (payload["verification_id"] as string | null) ?? null,
    batchId: (payload["batch_id"] as string | null) ?? null,
    status: String(payload["status"] ?? ""),
    raw: payload,
  };
  if (event === "verification.completed") {
    return {
      ...base,
      event: "verification.completed",
      result: (payload["result"] as Record<string, unknown>) ?? {},
    };
  }
  if (event === "verification.failed") {
    return {
      ...base,
      event: "verification.failed",
      error: String(payload["error"] ?? ""),
    };
  }
  if (event === "verification.needs_input") {
    return {
      ...base,
      event: "verification.needs_input",
      needsInput: (payload["needs_input"] as Record<string, unknown>) ?? {},
    };
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
      throw new Error("LenzWebhooks requires a non-empty secret. Get it from /api-integration.");
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
