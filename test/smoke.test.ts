/**
 * Opt-in smoke tests against a real Lenz environment.
 *
 * Skipped unless LENZ_E2E_KEY is set; the release workflow runs this
 * file via `npm run test:smoke`.
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
    expect(v.verdict?.label).toBeTruthy();
  }, 35_000);

  it("webhook signature roundtrip", () => {
    const secret = "whsec_smoke_fixed";
    const body = Buffer.from(JSON.stringify({ event: "verification.completed", task_id: "tsk_smoke" }));
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifySignature(body, sig, secret)).toBe(true);
    const wh = new LenzWebhooks({ secret });
    const event = wh.parse(body, { "X-Lenz-Signature": sig });
    expect(event.event).toBe("verification.completed");
  });

  it("/me/usage returns populated structure", async () => {
    const client = makeClient();
    const u = await client.usage();
    expect(typeof u.credits_total).toBe("number");
    expect(typeof u.credits_used).toBe("number");
  });
});
