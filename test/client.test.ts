/**
 * Mocks fetch via vi.fn() rather than nock — global fetch is the simpler
 * surface and we control it via the `fetch` injection point on `new Lenz`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  API_VERSION,
  Lenz,
  LenzAuthError,
  LenzNeedsInputError,
  LenzPipelineError,
  LenzTimeoutError,
} from "../src/index.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeFetch(responses: Iterable<MockResponse>) {
  const queue = Array.from(responses);
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("No more mocked responses");
    const headers = new Headers(next.headers ?? {});
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers,
    });
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {
    LENZ_API_KEY: process.env["LENZ_API_KEY"],
    LENZ_BASE_URL: process.env["LENZ_BASE_URL"],
  };
  delete process.env["LENZ_API_KEY"];
  delete process.env["LENZ_BASE_URL"];
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("Construction", () => {
  it("no api key permits library", async () => {
    const { fetch } = makeFetch([{ body: { items: [], total: 0, page: 1, page_size: 20 } }]);
    const client = new Lenz({ fetch });
    const page = await client.library.list();
    expect(page.total).toBe(0);
  });

  it("auth-required method without key raises with link", async () => {
    const client = new Lenz();
    let captured: unknown;
    try {
      await client.verifications.list();
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(LenzAuthError);
    expect(String(captured)).toContain("api-integration");
  });

  it("base url override routes through alternate base", async () => {
    const { fetch, calls } = makeFetch([{ body: { items: [], total: 0, page: 1, page_size: 20 } }]);
    const client = new Lenz({ baseUrl: "http://localhost:8001/api/v1", fetch });
    await client.library.list();
    expect(calls[0]!.url).toContain("http://localhost:8001/api/v1/library");
  });

  it("X-Lenz-API-Version header sent on every request", async () => {
    const { fetch, calls } = makeFetch([
      { body: { plan: "free", credits_used: 0, credits_total: 10 } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.usage();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("X-Lenz-API-Version")).toBe(API_VERSION);
  });

  it("LENZ_API_KEY env var picked up", async () => {
    process.env["LENZ_API_KEY"] = "lenz_env_key";
    const { fetch, calls } = makeFetch([
      { body: { plan: "free", credits_used: 0, credits_total: 10 } },
    ]);
    const client = new Lenz({ fetch });
    await client.usage();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer lenz_env_key");
  });
});

describe("Marquee verbs", () => {
  it("verify happy path returns task_id", async () => {
    const { fetch } = makeFetch([{ body: { task_id: "tsk_001", claim_text: "x" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const t = await client.verify({ claim: "The earth is flat" });
    expect(t.task_id).toBe("tsk_001");
  });

  it("verify with idempotency key sets header", async () => {
    const { fetch, calls } = makeFetch([{ body: { task_id: "t", claim_text: "x" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verify({ claim: "x", idempotencyKey: "custom-key-1" });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBe("custom-key-1");
  });

  it("verifyBatch does not send visibility (1.1.0: API claims are private)", async () => {
    const { fetch, calls } = makeFetch([{ body: { batch_id: "b", items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({ claims: [{ text: "a" }] });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.visibility).toBeUndefined();
  });

  it("verifyBatch returns batch_id and items", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          batch_id: "batch_1",
          items: [
            { task_id: "t1", claim_text: "a" },
            { task_id: "t2", claim_text: "b" },
          ],
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const b = await client.verifyBatch({ claims: [{ text: "a" }, { text: "b" }] });
    expect(b.batch_id).toBe("batch_1");
    expect(b.items).toHaveLength(2);
  });

  it("extract returns identified claims", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          status: "multi_claim",
          identified_claims: ["A", "B"],
          domain: "Science",
          original_input: "...",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.extract({ text: "A. B." });
    expect(out.identified_claims).toEqual(["A", "B"]);
  });

  it("extract surfaces claim (singular) on a cohesive input", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          status: "ready",
          claim: "Sharks don't get cancer.",
          identified_claims: [],
          domain: "Science",
          original_input: "Sharks don't get cancer.",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.extract({ text: "Sharks don't get cancer." });
    expect(out.claim).toBe("Sharks don't get cancer.");
  });

  it("getStatus returns typed status", async () => {
    const { fetch } = makeFetch([
      { body: { status: "processing", progress: { step: "Framing..." } } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const s = await client.getStatus("tsk_001");
    expect(s.status).toBe("processing");
  });

  it("getStatus clarification uses candidates not candidate_claims", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          status: "needs_input",
          reason: "clarification",
          candidates: ["What did you mean by X?", "Or did you mean Y?"],
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const s = await client.getStatus("tsk_001");
    expect(s.candidates).toEqual(["What did you mean by X?", "Or did you mean Y?"]);
  });

  it("select requires text or claimIndex", async () => {
    const client = new Lenz({ apiKey: "lenz_t" });
    await expect(() => client.select("tsk", {})).rejects.toThrow(/text or claimIndex/);
  });

  it("select with text dispatches new task", async () => {
    const { fetch } = makeFetch([{ body: { task_id: "tsk_002", claim_text: "x" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const t = await client.select("tsk_001", { text: "Earth is flat." });
    expect(t.task_id).toBe("tsk_002");
  });
});

describe("Assess", () => {
  it("happy path returns typed AssessResponse", async () => {
    const { fetch, calls } = makeFetch([
      {
        body: {
          claims: [
            {
              claim: "The Earth is flat.",
              verdict: "False",
              confidence: "high",
              verification_url: null,
            },
          ],
          error: null,
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.assess({ text: "The Earth is flat." });
    expect(calls[0]!.url).toContain("/assess");
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]!.verdict).toBe("False");
    expect(out.claims[0]!.confidence).toBe("high");
    expect(out.error).toBeNull();
  });

  it("multiclaim returns one entry per claim with optional verification_url", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          claims: [
            {
              claim: "Water boils at 100°C.",
              verdict: "True",
              confidence: "high",
              verification_url: "https://lenz.io/api/v1/verifications/a1b2c3d4",
            },
            {
              claim: "Coffee causes cancer.",
              verdict: "Misleading",
              confidence: "low",
              verification_url: null,
            },
          ],
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.assess({ text: "..." });
    expect(out.claims).toHaveLength(2);
    expect(out.claims[0]!.verification_url).toContain("/verifications/");
    expect(out.claims[1]!.verification_url).toBeNull();
  });

  it("error response shape surfaces error string", async () => {
    const { fetch } = makeFetch([
      {
        body: { claims: [], error: "no_atomic_claim_identified" },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.assess({ text: "" });
    expect(out.claims).toEqual([]);
    expect(out.error).toBe("no_atomic_claim_identified");
  });

  it("requires api_key (auth-required)", async () => {
    const client = new Lenz();
    await expect(() => client.assess({ text: "x" })).rejects.toBeInstanceOf(LenzAuthError);
  });
});

describe("verifyAndWait", () => {
  it("idempotency default true sends uuid header", async () => {
    const { fetch, calls } = makeFetch([
      { body: { task_id: "t", claim_text: "x" } },
      {
        body: {
          status: "completed",
          result: {
            verification_id: "v",
            verdict: "True",
            confidence: "high",
            lenz_score: 9,
          },
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyAndWait({ claim: "x", timeoutMs: 5_000 });
    const headers = new Headers(calls[0]!.init.headers);
    const idem = headers.get("Idempotency-Key");
    expect(idem).toBeTruthy();
    expect(idem!.length).toBeGreaterThanOrEqual(32);
  });

  it("idempotency=false omits the header", async () => {
    const { fetch, calls } = makeFetch([
      { body: { task_id: "t", claim_text: "x" } },
      {
        body: {
          status: "completed",
          result: {
            verification_id: "v",
            verdict: "True",
            confidence: "high",
          },
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyAndWait({ claim: "x", timeoutMs: 5_000, idempotency: false });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBeNull();
  });

  it("happy path returns Verification on first poll (flat verdict block)", async () => {
    const { fetch } = makeFetch([
      { body: { task_id: "tsk_001", claim_text: "x" } },
      {
        body: {
          status: "completed",
          result: {
            verification_id: "vid_1",
            claim: "Sharks don't get cancer.",
            verdict: "False",
            confidence: "high",
            lenz_score: 2,
          },
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifyAndWait({ claim: "x", timeoutMs: 30_000 });
    // Flat verdict block — categorical confidence only, no nested Verdict object
    expect(v.verdict).toBe("False");
    expect(v.confidence).toBe("high");
    expect(v.lenz_score).toBe(2);
  });

  it("needs_input raises with task_id + payload", async () => {
    const { fetch } = makeFetch([
      { body: { task_id: "t", claim_text: "x" } },
      {
        body: {
          status: "needs_input",
          reason: "multi_claim",
          claims: [
            { text: "A", domain: "X" },
            { text: "B", domain: "Y" },
          ],
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.verifyAndWait({ claim: "x", timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      LenzNeedsInputError,
    );
  });

  it("failed pipeline raises LenzPipelineError", async () => {
    const { fetch } = makeFetch([
      { body: { task_id: "t", claim_text: "x" } },
      {
        body: { status: "failed", failure_reason: "research_empty", failure_detail: "no sources" },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.verifyAndWait({ claim: "x", timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      LenzPipelineError,
    );
  });

  it("timeout raises with task_id after a processing response", async () => {
    const { fetch } = makeFetch([
      { body: { task_id: "tsk_slow", claim_text: "x" } },
      { body: { status: "processing", progress: {} } },
      { body: { status: "processing", progress: {} } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    let captured: unknown;
    try {
      await client.verifyAndWait({ claim: "x", timeoutMs: 1 });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(LenzTimeoutError);
    expect((captured as LenzTimeoutError).taskId).toBe("tsk_slow");
  });
});

const COMPLETED_RESULT = {
  verification_id: "v",
  claim: "Sample claim",
  verdict: "True",
  confidence: "high",
  lenz_score: 8,
};

describe("wait", () => {
  it("accepts a task_id string", async () => {
    const { fetch } = makeFetch([{ body: { status: "completed", result: COMPLETED_RESULT } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.wait("t", { timeoutMs: 5_000 });
    expect(v.verdict).toBe("True");
  });

  it("accepts a TaskAccepted object", async () => {
    const { fetch } = makeFetch([{ body: { status: "completed", result: COMPLETED_RESULT } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.wait({ task_id: "t", claim_text: "x" }, { timeoutMs: 5_000 });
    expect(v.lenz_score).toBe(8);
  });

  it("throws on an empty task_id", async () => {
    const { fetch } = makeFetch([]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.wait({ task_id: "" })).rejects.toThrow();
  });

  it("polls until completed", async () => {
    const { fetch } = makeFetch([
      { body: { status: "processing", progress: {} } },
      { body: { status: "completed", result: COMPLETED_RESULT } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.wait("t", { timeoutMs: 10_000 });
    expect(v.verdict).toBe("True");
  });

  it("needs_input rejects", async () => {
    const { fetch } = makeFetch([
      { body: { status: "needs_input", reason: "multi_claim", claims: [] } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.wait("t", { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      LenzNeedsInputError,
    );
  });

  it("completed-without-result rejects", async () => {
    const { fetch } = makeFetch([{ body: { status: "completed" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.wait("t", { timeoutMs: 5_000 })).rejects.toBeInstanceOf(LenzPipelineError);
  });

  it("failed surfaces the error wire field", async () => {
    const { fetch } = makeFetch([
      { body: { status: "failed", error: "Pipeline stopped at: research_empty" } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.wait("t", { timeoutMs: 5_000 })).rejects.toThrow(/research_empty/);
  });

  it("timeout rejects with task_id", async () => {
    const { fetch } = makeFetch([
      { body: { status: "processing", progress: {} } },
      { body: { status: "processing", progress: {} } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    let captured: unknown;
    try {
      await client.wait("tsk_slow", { timeoutMs: 1 });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(LenzTimeoutError);
    expect((captured as LenzTimeoutError).taskId).toBe("tsk_slow");
  });
});

describe("verifyBatchAndWait", () => {
  it("returns all completed results in input order", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          batch_id: "b",
          items: [
            { task_id: "t1", claim_text: "a" },
            { task_id: "t2", claim_text: "b" },
          ],
        },
      },
      { body: { status: "completed", result: COMPLETED_RESULT } },
      { body: { status: "completed", result: COMPLETED_RESULT } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const results = await client.verifyBatchAndWait({
      claims: [{ text: "a" }, { text: "b" }],
      timeoutMs: 5_000,
    });
    expect(results.map((r) => r.task_id)).toEqual(["t1", "t2"]);
    expect(results.every((r) => r.status === "completed" && r.verification)).toBe(true);
  });

  it("captures mixed per-item outcomes", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          batch_id: "b",
          items: [
            { task_id: "t1", claim_text: "a" },
            { task_id: "t2", claim_text: "b" },
            { task_id: "t3", claim_text: "c" },
          ],
        },
      },
      { body: { status: "completed", result: COMPLETED_RESULT } },
      { body: { status: "needs_input", reason: "multi_claim", claims: [] } },
      { body: { status: "failed", error: "research_empty" } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const results = await client.verifyBatchAndWait({
      claims: [{ text: "a" }, { text: "b" }, { text: "c" }],
      timeoutMs: 5_000,
    });
    expect(results.map((r) => r.status)).toEqual(["completed", "needs_input", "failed"]);
    expect(results[1]!.status_detail?.reason).toBe("multi_claim");
    expect(results[2]!.status_detail?.error).toBe("research_empty");
  });

  it("marks a still-pending item as timeout", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          batch_id: "b",
          items: [
            { task_id: "t1", claim_text: "a" },
            { task_id: "t2", claim_text: "b" },
          ],
        },
      },
      { body: { status: "completed", result: COMPLETED_RESULT } },
      { body: { status: "processing", progress: {} } },
      { body: { status: "processing", progress: {} } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const results = await client.verifyBatchAndWait({
      claims: [{ text: "a" }, { text: "b" }],
      timeoutMs: 1,
    });
    const byId = Object.fromEntries(results.map((r) => [r.task_id, r]));
    expect(byId["t1"]!.status).toBe("completed");
    expect(byId["t2"]!.status).toBe("timeout");
    expect(byId["t2"]!.status_detail).toBeUndefined();
  });

  it("forwards the idempotency key to /verify/batch", async () => {
    const { fetch, calls } = makeFetch([
      { body: { batch_id: "b", items: [{ task_id: "t1", claim_text: "a" }] } },
      { body: { status: "completed", result: COMPLETED_RESULT } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatchAndWait({
      claims: [{ text: "a" }],
      idempotencyKey: "k1",
      timeoutMs: 5_000,
    });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBe("k1");
  });
});

describe("Resource namespaces", () => {
  it("verifications.list", async () => {
    const { fetch } = makeFetch([{ body: { items: [], total: 0, page: 1, page_size: 20 } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const page = await client.verifications.list();
    expect(page.total).toBe(0);
  });

  it("verifications.get returns flat verdict block", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          verification_id: "vid_1",
          verdict: "True",
          confidence: "high",
          lenz_score: 10,
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifications.get("vid_1");
    expect(v.verification_id).toBe("vid_1");
    expect(v.verdict).toBe("True");
    expect(v.confidence).toBe("high");
    expect(v.lenz_score).toBe(10);
  });

  it("verifications.get works without api_key (anon → public claims)", async () => {
    const { fetch, calls } = makeFetch([
      {
        body: {
          verification_id: "vid_pub",
          verdict: "True",
          confidence: "high",
        },
      },
    ]);
    const client = new Lenz({ fetch });
    const v = await client.verifications.get("vid_pub");
    expect(v.verification_id).toBe("vid_pub");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBeNull();
  });

  it("verifications.delete 404 returns true (idempotent)", async () => {
    const { fetch } = makeFetch([{ status: 404, body: { detail: "not found" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(await client.verifications.delete("vid_1")).toBe(true);
  });

  it("verifications.setVisibility removed in 1.1.0", () => {
    const client = new Lenz({ apiKey: "lenz_t" });
    // The method was removed; type system flags it but at runtime
    // it's just `undefined`.
    expect(
      (client.verifications as unknown as { setVisibility?: unknown }).setVisibility,
    ).toBeUndefined();
  });

  it("verifications.related returns typed items with flat verdict + lenz_score", async () => {
    const { fetch, calls } = makeFetch([
      {
        body: {
          items: [
            {
              verification_id: "rel00001",
              claim: "A related claim",
              verdict: "False",
              confidence: "medium",
              lenz_score: 2,
              url: "https://lenz.io/c/foo-rel00001",
              distance: 0.31,
            },
          ],
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const related = await client.verifications.related("vid_1", { limit: 5 });
    expect(calls[0]!.url).toContain("limit=5");
    expect(related.items).toHaveLength(1);
    expect(related.items[0]!.verification_id).toBe("rel00001");
    expect(related.items[0]!.verdict).toBe("False");
    expect(related.items[0]!.lenz_score).toBe(2);
    expect(related.items[0]!.distance).toBe(0.31);
  });

  it("verifications.related empty list", async () => {
    const { fetch } = makeFetch([{ body: { items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const related = await client.verifications.related("vid_2");
    expect(related.items).toEqual([]);
  });

  it("ask.history hits /ask/{id} and returns typed messages", async () => {
    const { fetch, calls } = makeFetch([
      {
        body: {
          messages: [
            {
              role: "user",
              content: "Which source is strongest?",
              created_at: "2026-05-22T12:00:00Z",
            },
            {
              role: "expert",
              content: "The Nobel committee citation.",
              created_at: "2026-05-22T12:00:05Z",
            },
          ],
          exchanges_used: 1,
          exchange_limit: 10,
          can_send: true,
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const h = await client.ask.history("vid_1");
    expect(calls[0]!.url).toContain("/ask/vid_1");
    expect(h.can_send).toBe(true);
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0]!.role).toBe("user");
  });

  it("ask.send hits POST /ask/{id} and surfaces the server's {role, content, created_at}", async () => {
    // Server returns {role, content, created_at} — see
    // lenz/api/public_authed.py:1804. Pre-1.0.2 the mock used `{reply: ...}`
    // and the interface declared `.reply`; both were drift away from the
    // wire format. Test passed because mock + interface matched (each
    // other, not the server).
    const { fetch, calls } = makeFetch([
      {
        body: {
          role: "expert",
          content: "Because the Nobel citation says so.",
          created_at: "2026-05-27T12:00:05Z",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const reply = await client.ask.send("vid_1", { message: "Why?" });
    expect(calls[0]!.url).toContain("/ask/vid_1");
    expect(calls[0]!.init.method).toBe("POST");
    expect(reply.role).toBe("expert");
    expect(reply.content).toContain("Nobel");
    expect(reply.created_at).toBe("2026-05-27T12:00:05Z");
  });

  it("ask.reset hits DELETE /ask/{id}", async () => {
    const { fetch, calls } = makeFetch([{ status: 204 }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const ok = await client.ask.reset("vid_1");
    expect(ok).toBe(true);
    expect(calls[0]!.url).toContain("/ask/vid_1");
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("library.list works without api_key", async () => {
    const { fetch, calls } = makeFetch([{ body: { items: [], total: 0, page: 1, page_size: 20 } }]);
    const client = new Lenz({ fetch });
    await client.library.list({ page: 1, sort: "recent" });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBeNull();
  });

  it("library.get is removed (TypeScript surface)", () => {
    const client = new Lenz();
    // @ts-expect-error -- library.get was merged into verifications.get
    const _ref = client.library.get;
    expect(_ref).toBeUndefined();
  });
});

describe("Auto-retry", () => {
  it("503-503-200 succeeds with retries", async () => {
    const { fetch } = makeFetch([
      { status: 503, body: { detail: "unavailable" } },
      { status: 503, body: { detail: "unavailable" } },
      { body: { plan: "free", credits_used: 0, credits_total: 10 } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(u.plan).toBe("free");
  }, 10_000);
});
