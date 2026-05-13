import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LenzWebhooks,
  LenzWebhookSignatureError,
  verifySignature,
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
    expect(() => verifySignature(Buffer.from("{}"), "", SECRET)).toThrow(
      LenzWebhookSignatureError,
    );
  });
});

describe("LenzWebhooks", () => {
  it("constructor requires non-empty secret", () => {
    expect(() => new LenzWebhooks({ secret: "" })).toThrow(/non-empty secret/);
  });

  it("parses verification.completed", () => {
    const body = payload("verification.completed", {
      verification_id: "vid_1",
      status: "completed",
      result: { verification_id: "vid_1", verdict: { label: "false" } },
    });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as VerificationCompleted;
    expect(event.event).toBe("verification.completed");
    expect(event.verificationId).toBe("vid_1");
    expect((event.result as Record<string, unknown>)["verdict"]).toBeTruthy();
  });

  it("parses verification.failed", () => {
    const body = payload("verification.failed", { error: "research_empty" });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as VerificationFailed;
    expect(event.event).toBe("verification.failed");
    expect(event.error).toBe("research_empty");
  });

  it("parses verification.needs_input", () => {
    const body = payload("verification.needs_input", {
      needs_input: { reason: "multi_claim", claims: [{ text: "A", domain: "X" }] },
    });
    const wh = new LenzWebhooks({ secret: SECRET });
    const event = wh.parse(body, { "X-Lenz-Signature": sign(body) }) as VerificationNeedsInput;
    expect(event.event).toBe("verification.needs_input");
    expect((event.needsInput as Record<string, unknown>)["reason"]).toBe("multi_claim");
  });

  it("rejects tampered body with mismatch message", () => {
    const body = payload("verification.completed");
    const wh = new LenzWebhooks({ secret: SECRET });
    expect(() => wh.parse(Buffer.concat([body, Buffer.from("x")]), { "X-Lenz-Signature": sign(body) })).toThrow(
      /mismatch/i,
    );
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
});
