/**
 * Mocks fetch via vi.fn() rather than nock — global fetch is the simpler
 * surface and we control it via the `fetch` injection point on `new Lenz`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  API_VERSION,
  Lenz,
  LenzAPIError,
  LenzAuthError,
  LenzNeedsInputError,
  LenzPipelineError,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzTimeoutError,
  LenzUpstreamUnavailableError,
  LenzValidationError,
  MAX_RETRY_AFTER_SLEEP,
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

// `GET /me/usage` body: one credit pool, projected into each capability's
// unit. Reused across usage tests. A free account: 100 credits, no bonus.
const USAGE_BODY = {
  plan: "free",
  quota_resets_at: "2026-07-01T00:00:00+00:00",
  credits: {
    total: 100,
    used: 0,
    remaining: 100,
    bonus: 0,
    resets_at: "2026-07-01T00:00:00+00:00",
  },
  costs: { verify: 10, assess: 1, ask: 1, extract: 0 },
  cost_options: { verify: { depth: { standard: 10, low: 5 } } },
  verify: {
    quota_used: 0,
    quota_total: 10,
    quota_remaining: 10,
    bonus: 0,
    credits: 0,
    remaining: 10,
  },
  ask: {
    quota_used: 0,
    quota_total: 100,
    quota_remaining: 100,
    bonus: 0,
    credits: 0,
    remaining: 100,
  },
  assess: {
    quota_used: 0,
    quota_total: 100,
    quota_remaining: 100,
    bonus: 0,
    credits: 0,
    remaining: 100,
  },
  extract: { calls_today: 0, daily_limit: 1000, unlimited: false },
};

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
    expect(String(captured)).toContain("api-credentials");
  });

  it("base url override routes through alternate base", async () => {
    const { fetch, calls } = makeFetch([{ body: { items: [], total: 0, page: 1, page_size: 20 } }]);
    const client = new Lenz({ baseUrl: "http://localhost:8001/api/v1", fetch });
    await client.library.list();
    expect(calls[0]!.url).toContain("http://localhost:8001/api/v1/library");
  });

  it("X-Lenz-API-Version header sent on every request", async () => {
    const { fetch, calls } = makeFetch([{ body: USAGE_BODY }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.usage();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("X-Lenz-API-Version")).toBe(API_VERSION);
  });

  it("LENZ_API_KEY env var picked up", async () => {
    process.env["LENZ_API_KEY"] = "lenz_env_key";
    const { fetch, calls } = makeFetch([{ body: USAGE_BODY }]);
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

  it("verify omits visibility by default", async () => {
    const { fetch, calls } = makeFetch([{ body: { task_id: "t", claim_text: "x" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verify({ claim: "x" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.visibility).toBeUndefined();
  });

  it("verify sends visibility when set", async () => {
    const { fetch, calls } = makeFetch([{ body: { task_id: "t", claim_text: "x" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verify({ claim: "x", visibility: "unlisted" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.visibility).toBe("unlisted");
  });

  it("verifyBatch sends batch-wide visibility and per-item override", async () => {
    const { fetch, calls } = makeFetch([{ body: { batch_id: "b", items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({
      claims: [{ text: "a" }, { text: "b", visibility: "private" }],
      visibility: "unlisted",
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.visibility).toBe("unlisted");
    expect(body.claims[1].visibility).toBe("private");
  });

  it("verifyBatch omits visibility by default", async () => {
    const { fetch, calls } = makeFetch([{ body: { batch_id: "b", items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({ claims: [{ text: "a" }] });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.visibility).toBeUndefined();
  });

  it("verify omits depth by default", async () => {
    // The currently-deployed server 422s on unknown fields, so an
    // always-present key would break every call.
    const { fetch, calls } = makeFetch([{ body: { task_id: "t", claim_text: "x" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verify({ claim: "x" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.depth).toBeUndefined();
  });

  it("verify sends depth when set", async () => {
    const { fetch, calls } = makeFetch([{ body: { task_id: "t", claim_text: "x" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verify({ claim: "x", depth: "low" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.depth).toBe("low");
  });

  it("verifyBatch sends batch-wide depth and per-item override", async () => {
    const { fetch, calls } = makeFetch([{ body: { batch_id: "b", items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({
      claims: [{ text: "a" }, { text: "b", depth: "standard" }],
      depth: "low",
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.depth).toBe("low");
    expect(body.claims[1].depth).toBe("standard");
  });

  it("verifyBatch omits depth by default", async () => {
    const { fetch, calls } = makeFetch([{ body: { batch_id: "b", items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({ claims: [{ text: "a" }] });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.depth).toBeUndefined();
    expect(body.claims[0].depth).toBeUndefined();
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

  it("extract returns no_match when nothing fell within the focus", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          status: "no_match",
          claim: "",
          identified_claims: [],
          candidate_claims: [],
          domain: "",
          key_entities: [],
          presumed_intent: "Raise a Series A round from investors.",
          original_input: "...",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.extract({ text: "...", focus: "claims about cricket" });
    // no_match is a successful answer, not an error, and it is never the
    // unfocused list in disguise.
    expect(out.status).toBe("no_match");
    expect(out.identified_claims).toEqual([]);
    expect(out.claim).toBe("");
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

  it("select requires a non-empty texts array", async () => {
    const client = new Lenz({ apiKey: "lenz_t" });
    await expect(() => client.select("tsk", { texts: [] })).rejects.toThrow(/non-empty/);
  });

  it("select fans out one task per claim and sends { texts }", async () => {
    const { fetch, calls } = makeFetch([
      {
        body: {
          batch_id: "bat_1",
          items: [
            { task_id: "tsk_002", claim_text: "Earth is flat." },
            { task_id: "tsk_003", claim_text: "Coffee causes cancer." },
          ],
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const b = await client.select("tsk_001", {
      texts: ["Earth is flat.", "Coffee causes cancer."],
    });
    expect(b.batch_id).toBe("bat_1");
    expect(b.items.map((i) => i.task_id)).toEqual(["tsk_002", "tsk_003"]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      texts: ["Earth is flat.", "Coffee causes cancer."],
    });
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
              verdict: "Mixed",
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

  it("ambiguous input returns error_code + candidate_claims", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          claims: [],
          error: "Claim is ambiguous — pick a specific reading",
          error_code: "ambiguous",
          candidate_claims: [
            "DDR4 desktop RAM prices doubled 2021-2026.",
            "DRAM contract prices doubled 2021-2026.",
          ],
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.assess({ text: "RAM prices have more than doubled in recent years" });
    expect(out.claims).toEqual([]);
    expect(out.error_code).toBe("ambiguous");
    expect(out.candidate_claims).toHaveLength(2);
    expect(out.candidate_claims?.[0]).toContain("DDR4");
  });

  it("requires api_key (auth-required)", async () => {
    const client = new Lenz();
    await expect(() => client.assess({ text: "x" })).rejects.toBeInstanceOf(LenzAuthError);
  });

  it("single form is unchanged on the wire: `text`, never `claims`", async () => {
    const { fetch, calls } = makeFetch([{ body: { claims: [], error: null } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.assess({ claim: "The Earth is flat." });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "The Earth is flat." });
  });

  it("list form sends `claims` (no `text`) and returns one row per item, in order", async () => {
    const { fetch, calls } = makeFetch([
      {
        body: {
          claims: [
            {
              claim: "Water boils at 100 °C at sea level.",
              language: "en",
              verdict: "True",
              confidence: "high",
              verification_url: null,
              error_code: null,
              candidate_claims: [],
              identified_claims: [],
              hint: null,
            },
            {
              claim: "Bilingual children develop stronger executive function.",
              language: "en",
              verdict: "Mixed",
              confidence: "medium",
              verification_url: "https://lenz.io/api/v1/verifications/3f9a1c2e",
              error_code: null,
              candidate_claims: [],
              identified_claims: ["Bilingual children learn to read later than monolingual peers."],
              hint: "Assessed the main claim only. Send identified_claims as their own items to check the rest.",
            },
            {
              claim: "RAM prices have more than doubled",
              language: "en",
              verdict: "Error",
              confidence: "low",
              verification_url: null,
              error_code: "ambiguous",
              candidate_claims: [
                "Average U.S. retail prices for consumer DDR4 desktop RAM have more than doubled between 2021 and 2026.",
                "Global DRAM contract prices have more than doubled between 2021 and 2026.",
              ],
              identified_claims: [],
              hint: "Ambiguous: Which memory market / form factor? Send one of candidate_claims as its own item.",
            },
          ],
          error: null,
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const claims = [
      "Water boils at 100 °C at sea level.",
      "Bilingual children develop stronger executive function and learn to read later than monolingual peers.",
      "RAM prices have more than doubled",
    ];
    const out = await client.assess({ claims, language: "en" });

    expect(calls[0]!.url).toContain("/assess");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ claims, language: "en" });

    expect(out.error).toBeNull();
    expect(out.claims).toHaveLength(3);
    expect(out.claims.map((c) => c.verdict)).toEqual(["True", "Mixed", "Error"]);

    const [plain, compound, error] = out.claims;
    // A plain verdict row: the four fields are present and empty.
    expect(plain!.error_code).toBeNull();
    expect(plain!.candidate_claims).toEqual([]);
    expect(plain!.identified_claims).toEqual([]);
    expect(plain!.hint).toBeNull();
    // A compound item: assessed on its main claim, the rest listed on the row.
    expect(compound!.verdict).toBe("Mixed");
    expect(compound!.identified_claims).toEqual([
      "Bilingual children learn to read later than monolingual peers.",
    ]);
    expect(compound!.hint).toContain("identified_claims");
    // An Error row stays in position and says why.
    expect(error!.verdict).toBe("Error");
    expect(error!.error_code).toBe("ambiguous");
    expect(error!.candidate_claims).toHaveLength(2);
    expect(error!.hint).toContain("candidate_claims");
  });

  it("list form with `claim` / `text` throws LenzValidationError before any request", async () => {
    const { fetch, calls } = makeFetch([]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.assess({ claims: ["a"], claim: "b" })).rejects.toBeInstanceOf(
      LenzValidationError,
    );
    await expect(client.assess({ claims: ["a"], text: "b" })).rejects.toThrow(
      /one claim \(`claim`\) or a list \(`claims`\), not both/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("Assess per-call timeout", () => {
  /** A fetch that never answers — it settles only when the SDK aborts it. */
  function hangingFetch() {
    const signals: AbortSignal[] = [];
    const impl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    return { fetch: impl as unknown as typeof fetch, signals };
  }

  /** The one in-flight attempt is aborted at exactly `ms`, and nothing sooner. */
  async function expectAbortAt(pending: Promise<unknown>, signals: AbortSignal[], ms: number) {
    const settled = pending.catch((exc: unknown) => exc);
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(await settled).toBeInstanceOf(LenzAPIError);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("list form waits 45s by default (the client default is 30s)", async () => {
    const { fetch, signals } = hangingFetch();
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    await expectAbortAt(client.assess({ claims: ["a", "b"] }), signals, 45_000);
  });

  it("single form keeps the client's 30s default", async () => {
    const { fetch, signals } = hangingFetch();
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    await expectAbortAt(client.assess({ claim: "a" }), signals, 30_000);
  });

  it("per-call timeoutMs overrides the list default", async () => {
    const { fetch, signals } = hangingFetch();
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    await expectAbortAt(client.assess({ claims: ["a"], timeoutMs: 5_000 }), signals, 5_000);
  });

  it("a longer client-wide timeoutMs is never shortened for a list", async () => {
    const { fetch, signals } = hangingFetch();
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, timeoutMs: 90_000 });
    await expectAbortAt(client.assess({ claims: ["a"] }), signals, 90_000);
  });

  it("other calls are untouched by the assess override", async () => {
    const { fetch, signals } = hangingFetch();
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    await expectAbortAt(client.extract({ text: "a" }), signals, 30_000);
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

  it("forwards depth to the submit body, and omits it when unset", async () => {
    const polled = {
      body: {
        status: "completed",
        result: { verification_id: "v", verdict: "True", confidence: "high" },
      },
    };
    const withDepth = makeFetch([{ body: { task_id: "t", claim_text: "x" } }, polled]);
    const c1 = new Lenz({ apiKey: "lenz_t", fetch: withDepth.fetch });
    await c1.verifyAndWait({ claim: "x", timeoutMs: 5_000, depth: "low" });
    expect(JSON.parse(String(withDepth.calls[0]!.init.body)).depth).toBe("low");

    const without = makeFetch([{ body: { task_id: "t", claim_text: "x" } }, polled]);
    const c2 = new Lenz({ apiKey: "lenz_t", fetch: without.fetch });
    await c2.verifyAndWait({ claim: "x", timeoutMs: 5_000 });
    expect(JSON.parse(String(without.calls[0]!.init.body)).depth).toBeUndefined();
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

  it("needs_input carries the server's hint; empty when an older server omits it", async () => {
    const hint = "The text contains several claims. Pick the ones to check and resolve via select.";
    const withHint = makeFetch([
      { body: { task_id: "t", claim_text: "x" } },
      { body: { status: "needs_input", reason: "multi_claim", claims: [], hint } },
    ]);
    await expect(
      new Lenz({ apiKey: "lenz_t", fetch: withHint.fetch }).verifyAndWait({
        claim: "x",
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ kind: "multi_claim", hint });

    const withoutHint = makeFetch([
      { body: { task_id: "t", claim_text: "x" } },
      { body: { status: "needs_input", reason: "multi_claim", claims: [] } },
    ]);
    await expect(
      new Lenz({ apiKey: "lenz_t", fetch: withoutHint.fetch }).verifyAndWait({
        claim: "x",
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ kind: "multi_claim", hint: "" });
  });

  it("failed not_a_claim carries the server's hint on LenzPipelineError", async () => {
    const hint =
      "No factual statement that can be checked against evidence was found in the input.";
    const { fetch } = makeFetch([
      { body: { task_id: "t", claim_text: "x" } },
      {
        body: {
          status: "failed",
          error: "not_a_claim",
          failure_reason: "not_a_claim",
          failure_class: "invalid_input",
          retryable: false,
          hint,
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.verifyAndWait({ claim: "x", timeoutMs: 5_000 })).rejects.toMatchObject({
      failureReason: "not_a_claim",
      hint,
    });
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
      await client.verifyAndWait({ claim: "x", timeoutMs: 0 });
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
      await client.wait("tsk_slow", { timeoutMs: 0 });
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
      timeoutMs: 0,
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

  it("forwards depth to /verify/batch", async () => {
    const { fetch, calls } = makeFetch([
      { body: { batch_id: "b", items: [{ task_id: "t1", claim_text: "a" }] } },
      { body: { status: "completed", result: COMPLETED_RESULT } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatchAndWait({
      claims: [{ text: "a" }],
      depth: "low",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(String(calls[0]!.init.body)).depth).toBe("low");
  });
});

const PROCESSING = {
  status: "processing",
  task_id: "t",
  progress: { step: "research", index: 2, total: 5, elapsed_seconds: 42, poll_after_seconds: 5 },
};

describe("onProgress", () => {
  // The callback is the only way anyone using the documented happy path sees
  // the stage at all — verifyAndWait / wait do the polling.
  //
  // Fake timers: PROCESSING carries a real 5s poll hint, and the SDK honours
  // it, so these would otherwise sit out the wait for real.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive a promise past every poll sleep it is going to take. */
  async function drain<T>(pending: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(60_000);
    return pending;
  }

  it("fires per still-running poll with the task id", async () => {
    const { fetch } = makeFetch([
      { body: PROCESSING },
      { body: { status: "completed", result: COMPLETED_RESULT } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const seen: Array<[string, string, number | undefined]> = [];
    await drain(
      client.wait("t", {
        timeoutMs: 600_000,
        onProgress: (taskId, p) => seen.push([taskId, p.step, p.index]),
      }),
    );
    // Once for the processing poll; never for the terminal one.
    expect(seen).toEqual([["t", "research", 2]]);
  });

  it("the batch loop says which claim moved", async () => {
    // Without the id a callback cannot tell the caller which of the
    // round-robined ids the progress belongs to.
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
      { body: { ...PROCESSING, task_id: "t2", progress: { step: "debate", index: 3 } } },
      { body: { status: "completed", result: COMPLETED_RESULT } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const seen: Array<[string, string]> = [];
    await drain(
      client.verifyBatchAndWait({
        claims: [{ text: "a" }, { text: "b" }],
        timeoutMs: 600_000,
        onProgress: (taskId, p) => seen.push([taskId, p.step]),
      }),
    );
    expect(seen).toEqual([["t2", "debate"]]);
  });

  it("a throwing callback does not kill the poll", async () => {
    const { fetch } = makeFetch([
      { body: PROCESSING },
      { body: { status: "completed", result: COMPLETED_RESULT } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await drain(
      client.wait("t", {
        timeoutMs: 600_000,
        onProgress: () => {
          throw new Error("caller bug");
        },
      }),
    );
    expect(v.verdict).toBe("True");
  });

  it("hands the callback a copy, not the response object it came from", async () => {
    const { fetch } = makeFetch([
      { body: PROCESSING },
      { body: { status: "completed", result: COMPLETED_RESULT } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    let handed: { step: string } | undefined;
    await drain(
      client.wait("t", {
        timeoutMs: 600_000,
        onProgress: (_id, p) => {
          handed = p;
        },
      }),
    );
    handed!.step = "tampered";
    // The mutation stayed in the caller's copy: the next poll built its own
    // object from a fresh response, so nothing downstream saw it.
    expect(handed!.step).toBe("tampered");
  });
});

describe("poll_after_seconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Resolve `wait` by advancing exactly `expectedMs`, and no sooner. */
  async function expectSleepOf(progress: unknown, expectedMs: number) {
    const { fetch } = makeFetch([
      { body: { status: "processing", task_id: "t", progress } },
      { body: { status: "completed", result: COMPLETED_RESULT } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    let settled = false;
    const pending = client.wait("t", { timeoutMs: 600_000 }).then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(expectedMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).verdict).toBe("True");
  }

  it("the hint replaces the local ladder", async () => {
    await expectSleepOf({ step: "research", poll_after_seconds: 5 }, 5_000);
  });

  it("no hint falls back to the ladder", async () => {
    await expectSleepOf({ step: "research" }, 2_000);
  });

  for (const bad of [0, -1, 999, "5", null]) {
    it(`out-of-range hint ${JSON.stringify(bad)} falls back to the ladder`, async () => {
      await expectSleepOf({ step: "research", poll_after_seconds: bad }, 2_000);
    });
  }

  it("a batch waits the shortest hint in flight", async () => {
    // Waiting the longest one would starve the fastest claim.
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
      {
        body: {
          status: "processing",
          task_id: "t1",
          progress: { step: "research", poll_after_seconds: 12 },
        },
      },
      {
        body: {
          status: "processing",
          task_id: "t2",
          progress: { step: "research", poll_after_seconds: 3 },
        },
      },
      { body: { status: "completed", result: COMPLETED_RESULT } },
      { body: { status: "completed", result: COMPLETED_RESULT } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    let settled = false;
    const pending = client
      .verifyBatchAndWait({ claims: [{ text: "a" }, { text: "b" }], timeoutMs: 600_000 })
      .then((r) => {
        settled = true;
        return r;
      });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toHaveLength(2);
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

  it("verifications.get sends bearer when keyed (optional-auth → owner sees private rows)", async () => {
    const { fetch, calls } = makeFetch([
      { body: { verification_id: "mine", verdict: "False", confidence: "high" } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifications.get("mine");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer lenz_t");
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

  it("library.list stays anonymous even when keyed (public content, no authOptional)", async () => {
    const { fetch, calls } = makeFetch([{ body: { items: [], total: 0, page: 1, page_size: 20 } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
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

  it("library.list forwards curated / verdict / sort=random as query params", async () => {
    const { fetch, calls } = makeFetch([{ body: { items: [], total: 0, page: 1, page_size: 20 } }]);
    const client = new Lenz({ fetch });
    await client.library.list({ curated: ["trivia"], sort: "random", verdict: "True,False" });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("curated")).toBe("trivia");
    expect(url.searchParams.get("sort")).toBe("random");
    expect(url.searchParams.get("verdict")).toBe("True,False");
  });

  it("library.list joins multiple curated lists and omits when empty", async () => {
    const { fetch, calls } = makeFetch([
      { body: { items: [], total: 0, page: 1, page_size: 20 } },
      { body: { items: [], total: 0, page: 1, page_size: 20 } },
    ]);
    const client = new Lenz({ fetch });
    await client.library.list({ curated: ["trivia", "featured"] });
    expect(new URL(calls[0]!.url).searchParams.get("curated")).toBe("trivia,featured");
    await client.library.list({ curated: [] });
    expect(new URL(calls[1]!.url).searchParams.has("curated")).toBe(false);
  });
});

describe("Auto-retry", () => {
  it("503-503-200 succeeds with retries", async () => {
    const { fetch } = makeFetch([
      { status: 503, body: { detail: "unavailable" } },
      { status: 503, body: { detail: "unavailable" } },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(u.plan).toBe("free");
  }, 10_000);

  it("429 with a long Retry-After throws instead of sleeping", async () => {
    // The /extract daily cap sends seconds-until-UTC-midnight. Sleeping that
    // would block the call for most of a day — and this sleep sits outside
    // the AbortController, so `timeoutMs` would not bound it.
    //
    // Without the clamp this test does not fail, it HANGS for 24 hours.
    const { fetch, calls } = makeFetch([
      {
        status: 429,
        body: { detail: "Daily /extract limit of 1000 reached.", reset_in_seconds: 86_400 },
        headers: { "Retry-After": "86400" },
      },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const err = await client.usage().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LenzRateLimitError);
    // The true wait is surfaced so the caller can schedule the work.
    expect((err as LenzRateLimitError).retryAfter).toBe(86_400);
    // Must not burn retries on an unwinnable wait.
    expect(calls).toHaveLength(1);
  }, 10_000);

  it("429 one second past the clamp throws after a single call", async () => {
    // Pins MAX_RETRY_AFTER_SLEEP itself. A test using Retry-After: 0 stays
    // green even if the constant or the comparison changes, so it pins
    // nothing.
    const { fetch, calls } = makeFetch([
      {
        status: 429,
        body: { detail: "slow" },
        headers: { "Retry-After": String(MAX_RETRY_AFTER_SLEEP + 1) },
      },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const err = await client.usage().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LenzRateLimitError);
    expect((err as LenzRateLimitError).retryAfter).toBe(MAX_RETRY_AFTER_SLEEP + 1);
    expect(calls).toHaveLength(1);
  }, 10_000);

  it("429 without a stated wait falls back to backoff", async () => {
    const { fetch, calls } = makeFetch([
      { status: 429, body: { detail: "slow" } },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(u.plan).toBe("free");
    expect(calls).toHaveLength(2);
  }, 10_000);

  it("429 reads the wait from the body when no header — parity with Python", async () => {
    // Python's client falls back to the body here. Node must too, or the same
    // server response produces 1 call in Python and 4 in Node.
    const { fetch, calls } = makeFetch([
      { status: 429, body: { detail: "capped", reset_in_seconds: 86_400 } },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const err = await client.usage().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LenzRateLimitError);
    expect((err as LenzRateLimitError).retryAfter).toBe(86_400);
    expect(calls).toHaveLength(1);
  }, 10_000);

  it("5xx still honors a short Retry-After", async () => {
    // 2.6.0 honored Retry-After on 5xx; the clamp must not silently drop that
    // for a status class the changelog never mentions. A real value (5s, as
    // in the Python SDK's twin test) — "0" would pass even if the stated wait
    // were ignored entirely.
    const { fetch, calls } = makeFetch([
      { status: 503, body: { detail: "down" }, headers: { "Retry-After": "5" } },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(u.plan).toBe("free");
    expect(calls).toHaveLength(2);
  }, 10_000);

  it("untyped 503 with a long Retry-After keeps retrying rather than aborting", async () => {
    // The regression pin for the code-gated rule. A 503 with NO Lenz `code`
    // is an ordinary Cloud Run / CDN / load-balancer maintenance-or-overload
    // response — the server is down, not pacing us, and our own backoff may
    // still satisfy it.
    //
    // Gating this on the status number instead of the body code aborts here
    // with a bare LenzAPIError and throws the stated wait away.
    const { fetch, calls } = makeFetch([
      { status: 503, body: { detail: "maintenance" }, headers: { "Retry-After": "600" } },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(u.plan).toBe("free");
    expect(calls).toHaveLength(2);
  }, 10_000);

  it("5xx with a long Retry-After keeps retrying rather than aborting", async () => {
    // Same rule for every other 5xx — untouched by 2.8.0.
    const { fetch, calls } = makeFetch([
      { status: 500, body: { detail: "down" }, headers: { "Retry-After": "3600" } },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(u.plan).toBe("free");
    expect(calls).toHaveLength(2);
  }, 10_000);

  it("typed 503 with a long Retry-After throws immediately with the true wait", async () => {
    // 2.8.0: the server's own shed/exhaustion 503s carry `code` `capacity` /
    // `upstream_unavailable` and state 90-120s waits.
    // Burning the 1/2/4s ladder against them is the opposite of what the
    // header asks — throw at once with the wait, exactly like 429.
    const { fetch, calls } = makeFetch([
      {
        status: 503,
        body: { detail: "at capacity", code: "capacity", retry_after: 90 },
        headers: { "Retry-After": "90" },
      },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const err = await client.usage().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LenzUpstreamUnavailableError);
    expect(err).toBeInstanceOf(LenzAPIError); // existing handlers still catch it
    expect((err as LenzUpstreamUnavailableError).retryAfter).toBe(90);
    expect((err as LenzUpstreamUnavailableError).code).toBe("capacity");
    expect(calls).toHaveLength(1);
  }, 10_000);

  it("typed 503 within the cap is slept through and retried", async () => {
    // The abort is gated on the stated wait as well as the code: a typed 503
    // asking for less than MAX_RETRY_AFTER_SLEEP is waited out and retried,
    // rather than handing the caller an error it could have avoided.
    //
    // (Python's twin states 30s — its sleep is monkeypatched and therefore
    // free. This one really sleeps, so it states 3s.)
    const { fetch, calls } = makeFetch([
      {
        status: 503,
        body: { detail: "at capacity", code: "capacity", retry_after: 3 },
        headers: { "Retry-After": "3" },
      },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(u.plan).toBe("free");
    expect(calls).toHaveLength(2);
  }, 10_000);

  it("503 reads the wait from the body retry_after key — parity with Python", async () => {
    // The 503 bodies carry `retry_after` (429 carries `reset_in_seconds`);
    // a proxy that strips the header must not demote the stated wait to the
    // blind ladder.
    const { fetch, calls } = makeFetch([
      {
        status: 503,
        body: { detail: "providers down", code: "upstream_unavailable", retry_after: 90 },
      },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const err = await client.usage().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LenzUpstreamUnavailableError);
    expect((err as LenzUpstreamUnavailableError).retryAfter).toBe(90);
    expect(calls).toHaveLength(1);
  }, 10_000);

  it("402 surfaces as LenzQuotaExceededError and is never retried", async () => {
    // The central promise of the release: an out-of-credits response reaches
    // the caller as a quota error through request(), without burning three
    // guaranteed-failing retries. That non-retry property is the whole reason
    // the server chose 402 over 429.
    const { fetch, calls } = makeFetch([
      {
        status: 402,
        body: {
          detail: "No remaining claim checks.",
          code: "no_credits",
          upgrade_url: "https://lenz.io/plans",
          remaining: 0,
          resets_at: "2026-09-01T00:00:00+00:00",
        },
      },
      { body: USAGE_BODY },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const err = await client.usage().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LenzQuotaExceededError);
    expect(err).not.toBeInstanceOf(LenzAuthError);
    expect((err as LenzQuotaExceededError).remaining).toBe(0);
    expect((err as LenzQuotaExceededError).upgradeUrl).toBe("https://lenz.io/plans");
    expect(calls).toHaveLength(1);
  }, 10_000);
});

describe("usage", () => {
  it("returns the pool, the price list and the per-capability projections", async () => {
    const { fetch, calls } = makeFetch([{ body: USAGE_BODY }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(calls[0]!.url).toContain("/me/usage");
    expect(u.plan).toBe("free");
    expect(u.quota_resets_at).toBe("2026-07-01T00:00:00+00:00");
    // The pool is the balance; the capability blocks divide it by the cost.
    expect(u.credits.total).toBe(100);
    expect(u.credits.remaining).toBe(100);
    expect(u.credits.bonus).toBe(0);
    expect(u.credits.resets_at).toBe("2026-07-01T00:00:00+00:00");
    expect(u.verify.quota_total).toBe(10); // 100 credits / 10 per verify
    expect(u.verify.remaining).toBe(10);
    expect(u.assess.remaining).toBe(100); // 100 credits / 1 per assess
    expect(u.extract.daily_limit).toBe(1000);
    expect(u.extract.unlimited).toBe(false);
  });

  it("passes the costs map through with the server's own keys", async () => {
    // The SDK does not rewrite response keys, and `costs` is keyed by
    // capability NAME — a casing transform here would rename the API surface.
    const { fetch } = makeFetch([{ body: USAGE_BODY }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(Object.keys(u.costs).sort()).toEqual(["ask", "assess", "extract", "verify"]);
    expect(u.costs["verify"]).toBe(10);
    expect(u.costs["assess"]).toBe(1);
    expect(u.costs["ask"]).toBe(1);
    // Free at the pool — bounded by the daily cap in `extract` instead.
    expect(u.costs["extract"]).toBe(0);
  });

  it("carries the low-depth verify price in the same costs map", async () => {
    // `costs` is an open Record<string, number>, so a new price key needs no
    // type change — this is the tripwire that it actually survives parsing.
    const { fetch } = makeFetch([{ body: USAGE_BODY }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(u.cost_options["verify"]!["depth"]!["low"]).toBe(5);
    expect(u.cost_options["verify"]!["depth"]!["low"]! * 2).toBe(u.costs["verify"]);
    // `costs` names capabilities and nothing else.
    expect(u.costs["verify_low"]).toBeUndefined();
  });

  it("treats the low-depth price as a price, never as a capability block", async () => {
    // A `verify_low` projection would report the same balance in a second
    // unit, so the server deliberately does not send one and the SDK must not
    // invent one. Clients divide the balance themselves.
    const { fetch } = makeFetch([{ body: USAGE_BODY }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    const bag = u as unknown as Record<string, unknown>;
    expect(bag["verify_low"]).toBeUndefined();
    // Only the three real capability blocks exist beside the pool.
    const blockKeys = ["verify", "ask", "assess"].filter((k) => typeof bag[k] === "object");
    expect(blockKeys).toEqual(["verify", "ask", "assess"]);
    // 100 credits at 5 each is 20 low-depth checks — twice the verify block's
    // 10, and a number no block on the response reports.
    expect(Math.floor(u.credits.remaining / u.cost_options["verify"]!["depth"]!["low"]!)).toBe(20);
    expect(u.verify.remaining).toBe(10);
  });

  it("reports bonus per capability, floored by that capability's cost", async () => {
    // 25 non-expiring credits buys 25 assesses but only 2 verifications.
    const body = {
      ...USAGE_BODY,
      credits: { total: 125, used: 0, remaining: 125, bonus: 25, resets_at: null },
      verify: { ...USAGE_BODY.verify, bonus: 2, credits: 2 },
      assess: { ...USAGE_BODY.assess, bonus: 25, credits: 25 },
    };
    const { fetch } = makeFetch([{ body }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(u.credits.bonus).toBe(25);
    expect(u.credits.resets_at).toBeNull();
    expect(u.verify.bonus).toBe(2);
    expect(u.assess.bonus).toBe(25);
    // The deprecated per-capability `credits` is an alias of `bonus` until
    // the server drops it on 2026-11-29.
    expect(u.verify.credits).toBe(u.verify.bonus);
    expect(u.assess.credits).toBe(u.assess.bonus);
  });

  it("parses a response that has already dropped the deprecated credits alias", async () => {
    // After 2026-11-29 the server stops sending it; `bonus` carries on.
    const withoutAlias = (cap: Record<string, unknown>): Record<string, unknown> => {
      const copy = { ...cap };
      delete copy["credits"];
      return copy;
    };
    const body = {
      ...USAGE_BODY,
      verify: withoutAlias(USAGE_BODY.verify),
      assess: withoutAlias(USAGE_BODY.assess),
      ask: withoutAlias(USAGE_BODY.ask),
    };
    const { fetch } = makeFetch([{ body }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const u = await client.usage();
    expect(u.verify.credits).toBeUndefined();
    expect(u.verify.bonus).toBe(0);
    expect(u.verify.remaining).toBe(10);
  });
});

describe("coverage", () => {
  // Three states the SDK has to keep apart, because conflating the first two
  // is the mistake a caller makes: `coverage` absent means the feature is not
  // enabled for this account at all, `status === "uncovered"` means it IS
  // enabled and this verdict did not qualify, and `"covered"` means a
  // certificate exists. Only the third has a certificate to fetch.
  const detail = (coverage?: unknown) => ({
    verification_id: "vid_c",
    claim: "x",
    verdict: "True",
    language: "en",
    ...(coverage === undefined ? {} : { coverage }),
  });

  it("leaves coverage undefined when the feature is off", async () => {
    // `undefined` and `status: "uncovered"` are different facts. A caller that
    // reads the first as the second tells a user their verdict did not
    // qualify, when in truth nothing was ever assessed.
    const { fetch } = makeFetch([{ body: detail(undefined) }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifications.get("vid_c");
    expect(v.coverage).toBeUndefined();
  });

  it("carries the certificate and both caps on a covered verdict", async () => {
    const { fetch } = makeFetch([
      {
        body: detail({
          status: "covered",
          reasons: [],
          certificate_id: "9f2c",
          certificate_url: "https://lenz.io/certificate/9f2c",
          as_of: "2026-09-03T10:00:00+00:00",
          currency: "EUR",
          cap: 10000,
          aggregate: 500000,
          terms_version: "v1",
        }),
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifications.get("vid_c");
    expect(v.coverage?.status).toBe("covered");
    expect(v.coverage?.certificate_id).toBe("9f2c");
    expect(v.coverage?.reasons).toEqual([]);
    // Major units, and the currency is read rather than assumed.
    expect(v.coverage?.currency).toBe("EUR");
    expect(v.coverage?.cap).toBe(10000);
    expect(v.coverage?.aggregate).toBe(500000);
  });

  it("says why on an uncovered verdict", async () => {
    const { fetch } = makeFetch([
      {
        body: detail({
          status: "uncovered",
          reasons: ["plan", "verdict"],
          certificate_id: null,
          certificate_url: null,
          as_of: null,
          currency: "EUR",
          cap: 10000,
          aggregate: 500000,
          terms_version: "v1",
        }),
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifications.get("vid_c");
    expect(v.coverage?.status).toBe("uncovered");
    expect(v.coverage?.reasons).toEqual(["plan", "verdict"]);
    expect(v.coverage?.certificate_id).toBeNull();
  });

  it("does not reject a status added after this release", async () => {
    // `CoverageStatus` is exported for exhaustive matching, but the field
    // stays `string` so a newer server cannot break an older SDK.
    const { fetch } = makeFetch([{ body: detail({ status: "something_new", reasons: [] }) }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifications.get("vid_c");
    expect(v.coverage?.status).toBe("something_new");
  });

  it("getCertificate returns the verifiable document, authenticated", async () => {
    const { fetch, calls } = makeFetch([
      {
        body: {
          document_version: "1",
          certificate_id: "9f2c",
          record_version: "1",
          payload: { atomic_claim: "x", verdict: "True", currency: "EUR", cap: 10000 },
          leaf: "0".repeat(64),
          signature: "MEUCIQ",
          key_id: "projects/.../cryptoKeyVersions/1",
          anchors: { qualified_timestamp: { authority: "qtsp" }, opentimestamps: {} },
          withdrawn_at: null,
          keys_url: "https://lenz.io/.well-known/lenz-certificate-keys.json",
          verifier_url: "https://lenz.io/verify_certificate.py",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const cert = await client.verifications.getCertificate("vid_c");

    expect(calls[0]!.url).toContain("/verifications/vid_c/certificate");
    // Resolved by (verification, ACCOUNT) — an anonymous fetch would be the
    // wrong document or none, so the key must go on the wire.
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer lenz_t");
    expect(cert.certificate_id).toBe("9f2c");
    expect(cert.leaf).toBe("0".repeat(64));
    // The pointers that make it checkable WITHOUT Lenz.
    expect(cert.verifier_url).toContain("verify_certificate.py");
    expect(cert.keys_url).toContain("lenz-certificate-keys.json");
  });

  it("still returns a withdrawn certificate", async () => {
    // It is the record of what WAS warranted, and use before the withdrawal
    // notice can still be covered — so withdrawal is not an error.
    const { fetch } = makeFetch([
      {
        body: {
          certificate_id: "9f2c",
          leaf: "0".repeat(64),
          withdrawn_at: "2026-10-01T09:00:00+00:00",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const cert = await client.verifications.getCertificate("vid_c");
    expect(cert.withdrawn_at).toBe("2026-10-01T09:00:00+00:00");
  });

  it("rejects rather than returning an empty certificate when there is none", async () => {
    const { fetch } = makeFetch([{ status: 404, body: { detail: "Not found." } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.verifications.getCertificate("vid_c")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
