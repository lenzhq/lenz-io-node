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
    const { fetch } = makeFetch([
      { body: { items: [], total: 0, page: 1, page_size: 20 } },
    ]);
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
    const { fetch, calls } = makeFetch([
      { body: { items: [], total: 0, page: 1, page_size: 20 } },
    ]);
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

  it("verifyBatch sends batch-level visibility in the request body", async () => {
    const { fetch, calls } = makeFetch([{ body: { batch_id: "b", items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({
      claims: [{ text: "a" }, { text: "b" }],
      visibility: "public",
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    // Batch-level visibility lands at the top of the body; per-item values
    // can still override server-side.
    expect(body.visibility).toBe("public");
  });

  it("verifyBatch omits visibility when not set", async () => {
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

  it("getStatus returns typed status", async () => {
    const { fetch } = makeFetch([
      { body: { status: "processing", progress: { step: "Framing..." } } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const s = await client.getStatus("tsk_001");
    expect(s.status).toBe("processing");
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

describe("verifyAndWait", () => {
  // First-poll terminal states need no fake timers: the loop returns or
  // throws before any sleep call.

  it("idempotency default true sends uuid header", async () => {
    const { fetch, calls } = makeFetch([
      { body: { task_id: "t", claim_text: "x" } },
      { body: { status: "completed", result: { verification_id: "v", verdict: { label: "true" } } } },
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
      { body: { status: "completed", result: { verification_id: "v", verdict: { label: "true" } } } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyAndWait({ claim: "x", timeoutMs: 5_000, idempotency: false });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBeNull();
  });

  it("happy path returns Verification on first poll", async () => {
    const { fetch } = makeFetch([
      { body: { task_id: "tsk_001", claim_text: "x" } },
      {
        body: {
          status: "completed",
          result: {
            verification_id: "vid_1",
            verdict: { label: "false", score: 2.0, confidence: 0.9 },
          },
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifyAndWait({ claim: "x", timeoutMs: 30_000 });
    expect(v.verdict?.label).toBe("false");
  });

  it("needs_input raises with task_id + payload", async () => {
    const { fetch } = makeFetch([
      { body: { task_id: "t", claim_text: "x" } },
      {
        body: {
          status: "needs_input",
          reason: "multi_claim",
          claims: [{ text: "A", domain: "X" }, { text: "B", domain: "Y" }],
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
      { body: { status: "failed", failure_reason: "research_empty", failure_detail: "no sources" } },
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
    // timeoutMs=1 forces the deadline check after the first poll to fire.
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

describe("Resource namespaces", () => {
  it("verifications.list", async () => {
    const { fetch } = makeFetch([
      { body: { items: [], total: 0, page: 1, page_size: 20 } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const page = await client.verifications.list();
    expect(page.total).toBe(0);
  });

  it("verifications.get", async () => {
    const { fetch } = makeFetch([
      { body: { verification_id: "vid_1", verdict: { label: "true" } } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifications.get("vid_1");
    expect(v.verification_id).toBe("vid_1");
  });

  it("verifications.delete 404 returns true (idempotent)", async () => {
    const { fetch } = makeFetch([{ status: 404, body: { detail: "not found" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(await client.verifications.delete("vid_1")).toBe(true);
  });

  it("verifications.setVisibility", async () => {
    const { fetch } = makeFetch([{ body: { ok: true, visibility: "public" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.verifications.setVisibility("vid_1", "public");
    expect(out["visibility"]).toBe("public");
  });

  it("followup.history", async () => {
    const { fetch } = makeFetch([
      { body: { messages: [], exchanges_used: 0, exchange_limit: 10, can_send: true } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const h = await client.followup.history("vid_1");
    expect(h.can_send).toBe(true);
  });

  it("library.list works without api_key", async () => {
    const { fetch, calls } = makeFetch([
      { body: { items: [], total: 0, page: 1, page_size: 20 } },
    ]);
    const client = new Lenz({ fetch });
    await client.library.list({ page: 1, sort: "recent" });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBeNull();
  });
});

describe("Auto-retry", () => {
  it("503-503-200 succeeds with retries", async () => {
    // Short timeoutMs forces internal retry sleeps to be brief enough that
    // the test completes within vitest's default 5s without fake timers.
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
