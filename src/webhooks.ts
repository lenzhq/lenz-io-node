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

import { LenzValidationError, LenzWebhookSignatureError } from "./errors.js";

/** A bad argument, refused before anything is read: as the client's. */
function argumentError(
  message: string,
  param: string,
  code: "invalid_argument" | "invalid_option" = "invalid_argument",
): LenzValidationError {
  const err = new LenzValidationError({ message, code });
  err.param = param;
  return err;
}
import { withCitecheckDefaults, withReviewDefaults } from "./reviewDefaults.js";
import {
  normalizeOptions,
  normalizeWebhookStatus,
  normalizeVerification,
  webhookResultDefaults,
} from "./compat.js";
import { asObject, has } from "./events.js";
import type { WebhookEvent, WebhookEventBase } from "./events.js";
import type { Citecheck, Coverage, ReviewFailureBlock, ReviewFull, TaskStatus } from "./types.js";

export const SIGNATURE_HEADER = "X-Lenz-Signature";
const SIGNATURE_PREFIX = "sha256=";
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

/**
 * The raw request body: a string (encoded as UTF-8), or bytes. A Node
 * `Buffer` is a `Uint8Array`.
 */
type RawBody = string | Uint8Array;

/** Request headers: a `Headers`, or a plain object (Node's `req.headers`, whose values may be arrays). */
type HeaderBag = Record<string, string | string[] | undefined> | Headers;

/** What the WebCrypto path also takes: the `ArrayBuffer` a `Request` reads. */
type RawBodyAsync = RawBody | ArrayBuffer;

const encoder = new TextEncoder();
// `ignoreBOM: true` keeps a byte-order mark in the text, as Node's
// `Buffer#toString("utf-8")` does, so both paths read the same body.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

const NOT_BYTES =
  "The webhook body must be the raw request body: a string, bytes (a Uint8Array or Node buffer) or an " +
  "ArrayBuffer. A body parser ran before LenzWebhooks and replaced it (an object, null or " +
  "undefined): use express.raw({ type: 'application/json' }) in Express, or " +
  "`await request.arrayBuffer()` (or `unwrap(request)`) with a Request.";

/**
 * A private copy of the body, taken once and before any `await`: the bytes that
 * are verified are the bytes that are parsed, whatever the caller does to its
 * buffer in between. Anything that is not a string or bytes is a `TypeError`.
 */
function snapshot(body: unknown): Uint8Array {
  if (typeof body === "string") {
    // Encoded as UTF-8. WARNING: only safe if the original body was valid
    // UTF-8 and no proxy mangled it. Prefer the bytes (or `unwrap(request)`).
    return encoder.encode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  }
  if (Object.prototype.toString.call(body) === "[object ArrayBuffer]") {
    return new Uint8Array(body as ArrayBuffer).slice();
  }
  throw argumentError(NOT_BYTES, "body");
}

function requireSecret(secret: string): void {
  if (!secret) {
    throw argumentError(
      "Webhook verification requires a non-empty secret. Get it from /api-credentials.",
      "secret",
    );
  }
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** The two errors a bad signature raises, built once for both paths. */
function missingSignature(): LenzWebhookSignatureError {
  return new LenzWebhookSignatureError({
    message: "Missing webhook signature",
    cause: `No ${SIGNATURE_HEADER} header on the request.`,
    fix: "Inspect the webhook delivery in /api-credentials to confirm the secret is set.",
    docUrl: "https://lenz.io/docs/webhooks",
  });
}

function signatureMismatch(): LenzWebhookSignatureError {
  return new LenzWebhookSignatureError({
    message: "Webhook signature mismatch",
    cause: "HMAC of the raw body using your secret does not match X-Lenz-Signature.",
    fix: "Verify the secret in /api-credentials matches the one you configured here.",
    docUrl: "https://lenz.io/docs/webhooks",
  });
}

/**
 * Node's `crypto`, resolved when the synchronous path first needs it. The
 * module is never imported at load, so the package loads on runtimes that have
 * none (Workers without Node compatibility, Deno, edge bundlers).
 * `process.getBuiltinModule` is in every Node the package supports.
 */
type NodeCrypto = Pick<typeof import("node:crypto"), "createHmac" | "timingSafeEqual">;

let nodeCrypto: NodeCrypto | undefined;

function loadNodeCrypto(): NodeCrypto {
  if (nodeCrypto) return nodeCrypto;
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const mod =
    typeof proc?.getBuiltinModule === "function"
      ? (proc.getBuiltinModule("crypto") as NodeCrypto | undefined)
      : undefined;
  if (!mod) {
    throw new Error(
      "LenzWebhooks.parse() is synchronous and needs Node's crypto module, which this " +
        "runtime does not provide (it is there on Node 22.12 or later). Use " +
        "`await webhooks.unwrap(request)` or `await webhooks.parseAsync(rawBody, headers)`, " +
        "which verify with WebCrypto and run anywhere.",
    );
  }
  nodeCrypto = mod;
  return mod;
}

function sign(body: Uint8Array, secret: string): string {
  const mac = loadNodeCrypto().createHmac("sha256", secret).update(body).digest("hex");
  return `${SIGNATURE_PREFIX}${mac}`;
}

function verifyBytes(bytes: Uint8Array, signature: string, secret: string): true {
  const expected = encoder.encode(sign(bytes, secret));
  const given = encoder.encode(signature);
  // timingSafeEqual requires equal-length buffers.
  if (expected.length !== given.length || !loadNodeCrypto().timingSafeEqual(expected, given)) {
    throw signatureMismatch();
  }
  return true;
}

export function verifySignature(rawBody: RawBody, signature: string, secret: string): true {
  requireSecret(secret);
  if (!signature) throw missingSignature();
  return verifyBytes(snapshot(rawBody), signature, secret);
}

/** Equal-length byte strings, compared without stopping at the first difference. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function signAsync(body: Uint8Array, secret: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("LenzWebhooks needs WebCrypto (globalThis.crypto.subtle), which is missing.");
  }
  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await subtle.sign("HMAC", key, new Uint8Array(body)));
  return `${SIGNATURE_PREFIX}${hex(mac)}`;
}

async function verifyBytesAsync(
  bytes: Uint8Array,
  signature: string,
  secret: string,
): Promise<true> {
  const expected = encoder.encode(await signAsync(bytes, secret));
  if (!constantTimeEqual(expected, encoder.encode(signature))) throw signatureMismatch();
  return true;
}

/**
 * `verifySignature` with WebCrypto: resolves `true` or rejects with the same
 * `LenzWebhookSignatureError`. Works wherever `crypto.subtle` does.
 */
export async function verifySignatureAsync(
  rawBody: RawBodyAsync,
  signature: string,
  secret: string,
): Promise<true> {
  requireSecret(secret);
  if (!signature) throw missingSignature();
  // Copied before the first await: see `snapshot`.
  const bytes = snapshot(rawBody);
  return verifyBytesAsync(bytes, signature, secret);
}

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
export { isEvent } from "./events.js";

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
  if (typeof payload["event_id"] === "string") base.eventId = payload["event_id"];
  if (event === "verification.completed") {
    // The newer event's result has only the fields stored; the original
    // event carried every field, with its default where none was stored.
    const result = has(payload, "result")
      ? payload["result"]
      : webhookResultDefaults(verification?.result);
    // `verification.result` reads with the same defaults as `result`;
    // `raw` is the payload as sent.
    const nestedResult = verification?.result;
    const withDefaults =
      verification && nestedResult && typeof nestedResult === "object"
        ? ({
            ...verification,
            result: webhookResultDefaults(nestedResult),
          } as unknown as TaskStatus)
        : verification;
    return {
      ...base,
      event: "verification.completed",
      result: (normalizeVerification(result) as Record<string, unknown>) ?? {},
      verification: withDefaults,
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
  if (event === "verification.cancelled") {
    return { ...base, event: "verification.cancelled", verification };
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
      needsInput = { ...needsInput, claims: normalizeOptions(needsInput["claims"], false) };
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
  if (event === "review.completed" || event === "review.failed" || event === "review.cancelled") {
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
  if (
    event === "citecheck.completed" ||
    event === "citecheck.failed" ||
    event === "citecheck.cancelled"
  ) {
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
    if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
      throw argumentError(
        "LenzWebhooks takes an options object: { secret }.",
        "options",
        "invalid_option",
      );
    }
    if (!opts.secret) {
      throw argumentError(
        "LenzWebhooks requires a non-empty secret. Get it from /api-credentials.",
        "secret",
        "invalid_option",
      );
    }
    this.secret = opts.secret;
    this.replayWindow = opts.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;
  }

  /**
   * Verify and parse a delivery, synchronously, with Node's `crypto`.
   *
   * For Node servers that hand you the raw body (Express with `express.raw`).
   * It throws on a runtime without Node's `crypto` (Workers, Deno, edge
   * runtimes): use {@link unwrap} or {@link parseAsync} there.
   */
  parse(rawBody: RawBody, headers: HeaderBag): WebhookEvent {
    const sig = this.lookupHeader(headers, SIGNATURE_HEADER);
    requireSecret(this.secret);
    if (!sig) throw missingSignature();
    const bytes = snapshot(rawBody);
    verifyBytes(bytes, sig, this.secret);
    return this.finish(bytes);
  }

  /**
   * `parse` with WebCrypto, for any runtime: Workers, Deno, Bun, Node, edge
   * bundles. Same checks, same events, same errors. The body is copied before
   * the first `await`, so the bytes that are verified are the bytes parsed even
   * if the caller reuses its buffer meanwhile.
   */
  async parseAsync(rawBody: RawBodyAsync, headers: HeaderBag): Promise<WebhookEvent> {
    const sig = this.lookupHeader(headers, SIGNATURE_HEADER);
    requireSecret(this.secret);
    if (!sig) throw missingSignature();
    const bytes = snapshot(rawBody);
    await verifyBytesAsync(bytes, sig, this.secret);
    return this.finish(bytes);
  }

  /**
   * Verify and parse a delivery from a standard `Request`: reads the raw body
   * once and the `X-Lenz-Signature` header, then behaves as {@link parseAsync}.
   * For Workers, Deno, Bun, Next.js route handlers, Hono and the like. Call it
   * before anything else reads the body.
   */
  async unwrap(request: Request): Promise<WebhookEvent> {
    if (request === null || typeof request !== "object") {
      throw argumentError("unwrap() takes the incoming Request.", "request");
    }
    if (request.bodyUsed) {
      throw new Error(
        "LenzWebhooks.unwrap(request) found the body already read. Call unwrap before reading " +
          "the body (request.json(), request.text(), a middleware): the signature covers the raw bytes.",
      );
    }
    const rawBody = await request.arrayBuffer();
    return this.parseAsync(rawBody, request.headers);
  }

  // ── helpers ──

  /** Everything after the signature: JSON, object check, replay window, event. */
  private finish(bytes: Uint8Array): WebhookEvent {
    const text = decoder.decode(bytes);
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

  private lookupHeader(headers: HeaderBag, name: string): string {
    if (headers === null || typeof headers !== "object") {
      throw argumentError("Webhook headers must be an object or a Headers.", "headers");
    }
    if (typeof (headers as Headers).get === "function") {
      const v = (headers as Headers).get(name);
      return v ? String(v) : "";
    }
    const h = headers as Record<string, string | string[] | undefined>;
    const v = h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
    // A header sent twice may arrive as an array: the first value is the one.
    return (Array.isArray(v) ? v[0] : v) ?? "";
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
