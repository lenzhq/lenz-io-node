import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LenzWebhooks,
  LenzWebhookSignatureError,
  verifySignature,
  type CertificateAnchored,
  type VerificationCompleted,
  type VerificationFailed,
  type VerificationNeedsInput,
} from "../src/index.js";

const SECRET = "whsec_test_abc123";

function sign(body: Buffer | string, secret = SECRET): string {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return `sha256=${createHmac("sha256", secret).update(buf).digest("hex")}`;
}

function payload(event: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      event,
      task_id: "tsk_abc",
      attempt: 1,
      delivered_at: new Date().toISOString(),
      ...extra,
    }),
  );
}

describe("verifySignature", () => {
  it("returns true on valid signature", () => {
    const body = Buffer.from('{"x":1}');
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("throws on tampered body", () => {
    const body = Buffer.from('{"x":1}');
    const sig = sign(body);
    expect(() => verifySignature(Buffer.from('{"x":1} '), sig, SECRET)).toThrow(
      LenzWebhookSignatureError,
    );
  });

  it("throws on missing signature", () => {
    expect(() => verifySignature(Buffer.from("{}"), "", SECRET)).toThrow(LenzWebhookSignatureError);
  });
});

describe("LenzWebhooks", () => {
  it("constructor requires non-empty secret", () => {
    expect(() => new LenzWebhooks({ secret: "" })).toThrow(/non-empty secret/);
  });

  it("parses verification.completed with flat verdict block", () => {
    const body = payload("verification.completed", {
      verification_id: "vid_1",
      status: "completed",
      result: {
        verification_id: "vid_1",
        claim: "Sample claim.",
        verdict: "False",
        confidence: "high",
        lenz_score: 2,
        created_at: "2026-05-22T12:00:00Z",
        modified_at: null,
      },
    });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as VerificationCompleted;
    expect(event.event).toBe("verification.completed");
    expect(event.verificationId).toBe("vid_1");
    const result = event.result as Record<string, unknown>;
    // Flat block — categorical confidence only; numeric confidence_score is gone.
    expect(result["verdict"]).toBe("False");
    expect(result["confidence"]).toBe("high");
    expect(result["lenz_score"]).toBe(2);
    expect(result["confidence_score"]).toBeUndefined();
    // published_at is no longer part of the contract
    expect(result["published_at"]).toBeUndefined();
  });

  it("parses verification.failed", () => {
    const body = payload("verification.failed", {
      error: "research_empty",
      failure_class: "upstream_unavailable",
      retryable: true,
    });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as VerificationFailed;
    expect(event.event).toBe("verification.failed");
    expect(event.error).toBe("research_empty");
    expect(event.failureClass).toBe("upstream_unavailable");
    expect(event.retryable).toBe(true);
  });

  it("parses verification.failed from an older server without the class fields", () => {
    const body = payload("verification.failed", { error: "research_empty" });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as VerificationFailed;
    expect(event.failureClass).toBe("");
    expect(event.retryable).toBeNull();
  });

  it("parses verification.needs_input", () => {
    const body = payload("verification.needs_input", {
      needs_input: { reason: "multi_claim", claims: [{ text: "A", domain: "X" }] },
    });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as VerificationNeedsInput;
    expect(event.event).toBe("verification.needs_input");
    expect((event.needsInput as Record<string, unknown>)["reason"]).toBe("multi_claim");
    // No hint in the block → "" rather than "undefined".
    expect(event.hint).toBe("");
  });

  it("needs_input lifts the hint out of the needs_input block", () => {
    const hint = "Ambiguous: which memory market? Pick one candidate and resolve via select.";
    const body = payload("verification.needs_input", {
      needs_input: { reason: "clarification_required", candidate_claims: ["A", "B"], hint },
    });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as VerificationNeedsInput;
    expect(event.hint).toBe(hint);
    // The raw block is untouched — the hint is still readable there too.
    expect((event.needsInput as Record<string, unknown>)["hint"]).toBe(hint);
  });

  it("rejects tampered body with mismatch message", () => {
    const body = payload("verification.completed");
    const wh = new LenzWebhooks({ secret: SECRET });
    expect(() =>
      wh.parse(Buffer.concat([body, Buffer.from("x")]), { "X-Lenz-Signature": sign(body) }),
    ).toThrow(/mismatch/i);
  });

  it("rejects missing signature header", () => {
    const body = payload("verification.completed");
    const wh = new LenzWebhooks({ secret: SECRET });
    expect(() => wh.parse(body, {})).toThrow(LenzWebhookSignatureError);
  });

  it("rejects old delivered_at outside replay window", () => {
    const old = new Date(Date.now() - 600_000).toISOString();
    const body = Buffer.from(
      JSON.stringify({ event: "verification.completed", task_id: "tsk", delivered_at: old }),
    );
    const wh = new LenzWebhooks({ secret: SECRET, replayWindowSeconds: 300 });
    expect(() => wh.parse(body, { "X-Lenz-Signature": sign(body) })).toThrow(/replay/i);
  });

  it("malformed JSON raises signature error", () => {
    const body = Buffer.from("not json {");
    const wh = new LenzWebhooks({ secret: SECRET });
    expect(() => wh.parse(body, { "X-Lenz-Signature": sign(body) })).toThrow(
      LenzWebhookSignatureError,
    );
  });

  it("lower-case header lookup works", () => {
    const body = payload("verification.completed");
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "x-lenz-signature": sign(body) });
    expect(event.event).toBe("verification.completed");
  });

  it("unknown event returns generic WebhookEventBase", () => {
    const body = payload("verification.future_event");
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) });
    expect(event.event).toBe("verification.future_event");
  });

  // `certificate.anchored` — the event publishers must key on. The warranty
  // requires the certificate's timestamp to PRECEDE what the customer
  // publishes, so a pipeline that publishes on `verification.completed` races
  // the anchor and can put the statement out before cover exists. An SDK that
  // leaves this event untyped quietly encourages the wrong ordering.
  it("parses certificate.anchored with a coverage block", () => {
    const body = payload("certificate.anchored", {
      verification_id: "vid_c",
      status: "completed",
      coverage: {
        status: "covered",
        reasons: [],
        certificate_id: "9f2c",
        certificate_url: "https://lenz.io/certificate/9f2c",
        as_of: "2026-09-03T10:00:00+00:00",
        currency: "EUR",
        cap: 10000,
        aggregate: 500000,
        terms_version: "v1",
      },
    });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as CertificateAnchored;
    expect(event.event).toBe("certificate.anchored");
    expect(event.verificationId).toBe("vid_c");
    expect(event.coverage.certificate_id).toBe("9f2c");
    expect(event.coverage.cap).toBe(10000);
  });

  it("certificate.anchored carries coverage instead of result", () => {
    // It reports a timestamp landing, not a verdict being produced, so
    // `result` is null and a caller reaching for it gets nothing.
    const body = payload("certificate.anchored", {
      verification_id: "vid_c",
      status: "completed",
      result: null,
      coverage: { status: "covered", certificate_id: "9f2c" },
    });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as CertificateAnchored;
    expect(event.coverage.status).toBe("covered");
    expect((event as unknown as Record<string, unknown>)["result"]).toBeUndefined();
  });

  it("a missing coverage block is an empty object, not a crash", () => {
    const body = payload("certificate.anchored", { verification_id: "vid_c", status: "completed" });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as CertificateAnchored;
    expect(event.coverage).toEqual({});
  });
});
