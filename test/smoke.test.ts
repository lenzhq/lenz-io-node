/**
 * Opt-in smoke tests against a real Lenz environment.
 *
 * Skipped unless LENZ_E2E_KEY is set; the release workflow runs this
 * file via `npm run test:smoke`.
 *
 * Exercises the four-primitive ladder + webhook signing + /me/usage.
 */

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { Lenz, LenzWebhooks, verifySignature } from "../src/index.js";

const LENZ_E2E_KEY = process.env["LENZ_E2E_KEY"] ?? "";
const LENZ_BASE_URL = process.env["LENZ_BASE_URL"] ?? "";

const maybe = LENZ_E2E_KEY ? describe : describe.skip;

maybe("smoke", () => {
  function makeClient() {
    return new Lenz({
      apiKey: LENZ_E2E_KEY,
      ...(LENZ_BASE_URL ? { baseUrl: LENZ_BASE_URL } : {}),
    });
  }

  it("quickstart claim returns via cache", async () => {
    const client = makeClient();
    const v = await client.verifyAndWait({ claim: "Sharks don't get cancer", timeoutMs: 30_000 });
    expect(v.verdict).toBeTruthy();
  }, 35_000);

  it("assess returns typed claims", async () => {
    const client = makeClient();
    const out = await client.assess({ text: "Sharks don't get cancer" });
    expect(out.claims.length).toBeGreaterThan(0);
    const first = out.claims[0]!;
    expect(typeof first.claim).toBe("string");
    expect(typeof first.verdict).toBe("string");
    expect(["high", "medium", "low"]).toContain(first.confidence);
  }, 20_000);

  it("webhook signature roundtrip", () => {
    const secret = "whsec_smoke_fixed";
    const body = Buffer.from(
      JSON.stringify({ event: "verification.completed", task_id: "tsk_smoke" }),
    );
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifySignature(body, sig, secret)).toBe(true);
    const wh = new LenzWebhooks({ secret });
    const event = wh.parse(body, { "X-Lenz-Signature": sig });
    expect(event.event).toBe("verification.completed");
  });

  it("/me/usage returns populated structure", async () => {
    const client = makeClient();
    const u = await client.usage();
    expect(typeof u.plan).toBe("string");
    for (const cap of [u.verify, u.ask, u.assess]) {
      expect(typeof cap.quota_remaining).toBe("number");
      expect(typeof cap.remaining).toBe("number");
    }
    // assess is quota-only — no one-off credit pool.
    expect(u.assess.credits).toBe(0);
    expect(typeof u.extract.daily_limit).toBe("number");
  });

  it("extract returns parseable claims", async () => {
    // Framing returns either `claim` (one cohesive claim) OR
    // `identified_claims` (multiple). Either is success — the LLM picks
    // based on the input's coherence.
    const brief =
      "Albert Einstein won the 1921 Nobel Prize in Physics for his theory " +
      "of general relativity. He developed the special theory of relativity " +
      "in 1905 while working as a patent clerk in Bern. Born in Ulm in " +
      "1879, he emigrated to the US in 1933 and joined the Institute for " +
      "Advanced Study.";
    const client = makeClient();
    const out = await client.extract({ text: brief });
    const hasAtomic = (out.claim ?? "").trim().length > 0;
    const hasIdentified =
      Array.isArray(out.identified_claims) &&
      out.identified_claims.length > 0 &&
      out.identified_claims.every((c) => c.trim().length > 0);
    expect(hasAtomic || hasIdentified).toBe(true);
  });
});
