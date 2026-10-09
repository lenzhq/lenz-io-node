/**
 * Opt-in smoke tests against a real Lenz environment.
 *
 * Skipped unless LENZ_E2E_KEY is set; the release workflow runs this
 * file via `npm run test:smoke`.
 *
 * Exercises the four-primitive ladder + cancel + webhook signing + /me/usage.
 */

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  Lenz,
  LenzAbortError,
  LenzPipelineError,
  LenzWebhooks,
  verifySignature,
} from "../src/index.js";

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

  // The API's verdict cache lasts an hour, so this is usually a fresh run:
  // depth "low" keeps it cheap and short (~15s), the 150s budget covers a slow
  // one, and a cache hit inside the hour is a bonus. The vitest limit sits
  // above the SDK's so LenzTimeoutError, not vitest, reports a stall.
  it("quickstart claim verifies at low depth", async () => {
    const client = makeClient();
    const v = await client.verifyAndWait({
      claim: "Sharks don't get cancer",
      depth: "low",
      timeoutMs: 150_000,
    });
    expect(v.verdict).toBeTruthy();
  }, 160_000);

  // Stopping a run. The same cheap claim at low depth, cancelled at once. If
  // the call cancelled it (`cancelled: true`), cancelling again answers true
  // again and a wait ends on the cancelled status. Otherwise the run had
  // already finished (e.g. an answer the verdict cache served): `completed` or
  // `failed`, never `cancelled`. Either way is a pass, so the step does not
  // depend on how fast the run is.
  it("cancel stops a run, or reports the status it had already reached", async () => {
    const client = makeClient();
    const accepted = await client.verify({ claim: "Sharks don't get cancer", depth: "low" });
    const out = await client.cancel(accepted.task_id);
    expect(out.task_id).toBe(accepted.task_id);
    if (out.cancelled) {
      expect(out.status).toBe("cancelled");
      const again = await client.cancel(accepted.task_id);
      expect(again).toEqual({ task_id: accepted.task_id, cancelled: true, status: "cancelled" });
      const err = await client.wait(accepted.task_id, { timeoutMs: 30_000 }).catch((e) => e);
      expect(err).toBeInstanceOf(LenzPipelineError);
      expect((err as LenzPipelineError).failureClass).toBe("cancelled");
    } else {
      expect(out.cancelled).toBe(false);
      expect(["completed", "failed"]).toContain(out.status);
    }
  }, 60_000);

  it("assess returns typed claims", async () => {
    const client = makeClient();
    const out = await client.assess({ text: "Sharks don't get cancer" });
    expect(out.claims.length).toBeGreaterThan(0);
    const first = out.claims[0]!;
    expect(typeof first.claim).toBe("string");
    expect(typeof first.verdict).toBe("string");
    expect(["high", "medium", "low"]).toContain(first.confidence);
  }, 20_000);

  it("assess takes a per-call timeout", async () => {
    const client = makeClient();
    const out = await client.assess({ claim: "Sharks don't get cancer" }, { timeoutMs: 100_000 });
    expect(out.claims.length).toBeGreaterThan(0);
  }, 110_000);

  // A wait aborted after the receipt: the error carries the task id, and the
  // run is cancelled through the client whose signal did not fire.
  it("an aborted verifyAndWait carries its task id; the root client cancels it", async () => {
    const client = makeClient();
    const controller = new AbortController();
    const err = await client
      .verifyAndWait(
        { claim: "Sharks don't get cancer", depth: "low" },
        { signal: controller.signal, onProgress: () => controller.abort() },
      )
      .catch((e: unknown) => e);
    if (!(err instanceof LenzAbortError)) {
      // A verdict cache hit can answer before the first progress: nothing to abort.
      expect((err as { verdict?: unknown }).verdict).toBeTruthy();
      return;
    }
    expect(err.taskId).toBeTruthy();
    expect(err.idempotencyKey).toBeTruthy();
    const out = await client.cancel(err.taskId!);
    expect(out.task_id).toBe(err.taskId);
  }, 60_000);

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
    // The pool is the balance; everything else divides it.
    expect(typeof u.credits.remaining).toBe("number");
    expect(typeof u.credits.extra).toBe("number");
    expect(typeof u.costs["verify"]).toBe("number");
    for (const cap of [u.verify, u.ask, u.assess]) {
      expect(typeof cap.quota_remaining).toBe("number");
      expect(typeof cap.remaining).toBe("number");
      expect(typeof cap.bonus).toBe("number");
    }
    expect(u.verify.remaining).toBe(Math.floor(u.credits.remaining / u.costs["verify"]!));
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
