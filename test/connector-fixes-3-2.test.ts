/**
 * 3.2 fixes for a server that forwards per-user credentials,
 * mirrored in the Python SDK: errors from another API version,
 * the wire `code` with `legacyAliases: false`, timeouts given on a copy, a
 * 2xx that is JSON but not an object, keys a header cannot carry, blank
 * inputs, `idempotency` on review / citecheck, and `raw` on results.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  API_VERSION,
  Lenz,
  LenzApiVersionError,
  LenzAuthError,
  LenzError,
  LenzInvalidResponseError,
  LenzNotFoundError,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzRequestTimeoutError,
  LenzUpstreamUnavailableError,
  LenzValidationError,
} from "../src/index.js";

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };

function server(reply: (sent: Sent) => Reply | Promise<Reply>) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const s: Sent = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    sent.push(s);
    const r = await reply(s);
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text, {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

async function thrown(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (exc) {
    return exc;
  }
  throw new Error("expected an error");
}

const LEGACY = "2026-05-13";
const SERVED = "X-Lenz-API-Version";

let envKey: string | undefined;
beforeEach(() => {
  envKey = process.env["LENZ_API_KEY"];
  delete process.env["LENZ_API_KEY"];
});
afterEach(() => {
  if (envKey === undefined) delete process.env["LENZ_API_KEY"];
  else process.env["LENZ_API_KEY"] = envKey;
});

// ── 5 + 6: another API version ──

describe("an error response from another API version is the real error", () => {
  it("a 402 is LenzQuotaExceededError, with servedVersion", async () => {
    const body = { detail: "Out of credits.", code: "no_credits", credits_remaining: 0, cost: 10 };
    const { fetch } = server(() => ({ status: 402, body, headers: { [SERVED]: LEGACY } }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await thrown(() => client.verify({ claim: "x" }))) as LenzQuotaExceededError;
    expect(err).toBeInstanceOf(LenzQuotaExceededError);
    expect(err).not.toBeInstanceOf(LenzApiVersionError);
    expect(err.statusCode).toBe(402);
    expect(err.code).toBe("no_credits");
    expect(err.servedVersion).toBe(LEGACY);
    expect(err.body).toEqual(body);
  });

  it("a 404 is LenzNotFoundError, which a delete throws (not 'already deleted')", async () => {
    const { fetch } = server(() => ({
      status: 404,
      body: { detail: "Not found." },
      headers: { [SERVED]: LEGACY },
    }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await thrown(() => client.verifications.get("v1"))) as LenzError;
    expect(err).toBeInstanceOf(LenzNotFoundError);
    expect(err.servedVersion).toBe(LEGACY);
    await expect(client.verifications.delete("v1")).rejects.toBeInstanceOf(LenzNotFoundError);
  });

  it("a typed 503 is retried and typed as this version's would be", async () => {
    let calls = 0;
    const { fetch } = server(() => {
      calls += 1;
      return {
        status: 503,
        body: { detail: "busy", code: "capacity", retry_after: 0 },
        headers: { [SERVED]: LEGACY, "Retry-After": "0" },
      };
    });
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 1 });
    const err = (await thrown(() => client.usage())) as LenzError;
    expect(err).toBeInstanceOf(LenzUpstreamUnavailableError);
    expect(calls).toBe(2);
    expect(err.servedVersion).toBe(LEGACY);
  });

  it("a 2xx from another version still throws LenzApiVersionError", async () => {
    const legacy = { task_id: "t1", status: "pending" };
    const { fetch } = server(() => ({ status: 202, body: legacy, headers: { [SERVED]: LEGACY } }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await thrown(() => client.verify({ claim: "x" }))) as LenzApiVersionError;
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect(err.servedVersion).toBe(LEGACY);
    expect(err.expectedVersion).toBe(API_VERSION);
    expect(err.apiVersion).toBe(LEGACY);
    expect(err.statusCode).toBe(202);
    expect(err.body).toEqual(legacy);
  });

  it("an error in this version names it in servedVersion; none named reads ''", async () => {
    let named = true;
    const { fetch } = server(() => ({
      status: 404,
      body: { detail: "Not found." },
      headers: named ? { [SERVED]: API_VERSION } : ({} as Record<string, string>),
    }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const a = (await thrown(() => client.verifications.get("v1"))) as LenzError;
    expect(a.servedVersion).toBe(API_VERSION);
    named = false;
    const b = (await thrown(() => client.verifications.get("v1"))) as LenzError;
    expect(b.servedVersion).toBe("");
  });

  it("an error carries the response headers", async () => {
    const { fetch } = server(() => ({
      status: 429,
      body: { detail: "Slow down.", code: "rate_limited" },
      headers: { "Retry-After": "7", "X-Request-ID": "req_1" },
    }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await thrown(() => client.usage())) as LenzRateLimitError;
    expect(err).toBeInstanceOf(LenzRateLimitError);
    expect(err.headers?.["retry-after"]).toBe("7");
    expect(err.headers?.["x-request-id"]).toBe("req_1");
    expect(err.retryAfter).toBe(7);
  });

  it("an error the SDK makes itself has no headers", () => {
    expect(new LenzError({ message: "x" }).headers).toBeUndefined();
    expect(new LenzError({ message: "x" }).servedVersion).toBe("");
  });
});

// ── 1: the wire code with legacyAliases: false ──

describe("legacyAliases: false keeps the wire code on errors", () => {
  const notAuthenticated = { detail: "Not authenticated.", code: "not_authenticated" };

  it("a /review 401 keeps code not_authenticated (the default blanks it)", async () => {
    const { fetch } = server(() => ({ status: 401, body: notAuthenticated }));
    const raw = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, legacyAliases: false });
    const def = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const a = (await thrown(() => raw.review({ text: "Draft." }))) as LenzError;
    const b = (await thrown(() => def.review({ text: "Draft." }))) as LenzError;
    expect(a).toBeInstanceOf(LenzAuthError);
    expect(a.code).toBe("not_authenticated");
    expect(b).toBeInstanceOf(LenzAuthError);
    expect(b.code).toBe("");
    expect(a.body).toEqual(notAuthenticated);
    expect(b.body).toEqual(notAuthenticated);
  });

  it("a /review 422 keeps code blank_input (the default says validation_error)", async () => {
    const body = { detail: "text: Text is required.", code: "blank_input" };
    const { fetch } = server(() => ({ status: 422, body }));
    const raw = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, legacyAliases: false });
    const def = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    expect(((await thrown(() => raw.review({ text: "Draft." }))) as LenzError).code).toBe(
      "blank_input",
    );
    expect(((await thrown(() => def.review({ text: "Draft." }))) as LenzError).code).toBe(
      "validation_error",
    );
  });

  it("a withOptions copy keeps the client's reading", async () => {
    const { fetch } = server(() => ({ status: 401, body: notAuthenticated }));
    const raw = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, legacyAliases: false });
    const err = (await thrown(() =>
      raw.withOptions({ apiKey: "lenz_u" }).review({ text: "Draft." }),
    )) as LenzError;
    expect(err.code).toBe("not_authenticated");
  });

  it("a 404's not_found is kept (the default reads '', as 2.x had none)", async () => {
    const body = { detail: "Not found.", code: "not_found" };
    const { fetch } = server(() => ({ status: 404, body }));
    const raw = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, legacyAliases: false });
    const def = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const a = (await thrown(() => raw.verifications.get("v1"))) as LenzError;
    const b = (await thrown(() => def.verifications.get("v1"))) as LenzError;
    expect([a.code, b.code]).toEqual(["not_found", ""]);
    expect(a).toBeInstanceOf(LenzNotFoundError);
    expect(b).toBeInstanceOf(LenzNotFoundError);
  });

  it("a blank input refused before sending says blank_input, as the API would", async () => {
    const raw = new Lenz({ apiKey: "lenz_t", legacyAliases: false });
    const def = new Lenz({ apiKey: "lenz_t" });
    const codes = async (c: Lenz) => [
      ((await thrown(() => c.verify({ claim: " " }))) as LenzError).code,
      ((await thrown(() => c.assess({ claim: " " }))) as LenzError).code,
      ((await thrown(() => c.assess({ claims: ["a", " "] }))) as LenzError).code,
    ];
    expect(await codes(raw)).toEqual(["blank_input", "blank_input", "blank_input"]);
    expect(await codes(def)).toEqual(["", "", "blank_item"]);
  });
});

// ── 4: timeouts ──

/** A fetch that answers only when its signal fires (then rejects like fetch does). */
function hanging(): { fetch: typeof globalThis.fetch; seen: AbortSignal[] } {
  const seen: AbortSignal[] = [];
  const fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      seen.push(signal);
      signal.addEventListener("abort", () =>
        reject(new DOMException("This operation was aborted", "AbortError")),
      );
    })) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

describe("a timeout given on a copy is used as given", () => {
  it("withOptions({ timeoutMs }) is not raised to assess's 100 s floor", async () => {
    const { fetch } = hanging();
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await thrown(() =>
      client.withOptions({ timeoutMs: 40 }).assess({ claim: "x" }),
    )) as LenzRequestTimeoutError;
    expect(err).toBeInstanceOf(LenzRequestTimeoutError);
    expect(err.message).toContain("timed out after 40ms");
  });

  it("withOptions({ timeoutMs }) is not raised to extract's 150 s floor", async () => {
    const { fetch } = hanging();
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await thrown(() =>
      client.withOptions({ timeoutMs: 40 }).extract({ text: "x" }),
    )) as LenzRequestTimeoutError;
    expect(err.message).toContain("timed out after 40ms");
  });

  it("a copy of a copy keeps the first copy's timeout", async () => {
    const { fetch } = hanging();
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const copy = client.withOptions({ timeoutMs: 40 }).withOptions({ headers: { "X-A": "1" } });
    const err = (await thrown(() => copy.assess({ claim: "x" }))) as LenzRequestTimeoutError;
    expect(err.message).toContain("timed out after 40ms");
  });

  it("the client's own timeout is still raised to the floor (a copy without one too)", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = hanging();
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, timeoutMs: 40 });
      for (const c of [client, client.withOptions({ headers: { "X-A": "1" } })]) {
        const pending = thrown(() => c.assess({ claim: "x" }));
        await vi.advanceTimersByTimeAsync(99_999);
        await vi.advanceTimersByTimeAsync(1);
        const err = (await pending) as LenzRequestTimeoutError;
        expect(err.message).toContain("timed out after 100000ms");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a custom fetch gets the attempt's signal, so the client's timeout applies through it", async () => {
    const { fetch, seen } = hanging();
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, timeoutMs: 40 });
    const err = (await thrown(() => client.usage())) as LenzRequestTimeoutError;
    expect(err).toBeInstanceOf(LenzRequestTimeoutError);
    expect(err.message).toContain("timed out after 40ms");
    expect(seen[0]!.aborted).toBe(true);
  });
});

// ── 7: a 2xx whose JSON is not an object ──

describe("a 2xx whose JSON is not an object", () => {
  for (const text of ["[]", '"ok"', "null", "42", "true"]) {
    it(`throws LenzInvalidResponseError for ${text}`, async () => {
      const { fetch } = server(() => ({ status: 200, text, headers: { "X-Request-ID": "r1" } }));
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const err = (await thrown(() => client.usage())) as LenzInvalidResponseError;
      expect(err).toBeInstanceOf(LenzInvalidResponseError);
      expect(err.statusCode).toBe(200);
      expect(err.requestId).toBe("r1");
      expect(err.bodyText).toBe(text);
      expect(err.retryable).toBeNull();
      expect(err.message).toContain("not a JSON object");
    });
  }

  it("a 204 still reads as {}", async () => {
    const fetch = (async () =>
      new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    await expect(client.verifications.delete("v1")).resolves.toBe(true);
  });
});

// ── 8: keys a header cannot carry ──

describe("an apiKey a header cannot carry is refused before sending", () => {
  const bad = [
    "lenz_ab cd",
    "lenz_ab\tcd",
    "lenz_ab\ncd",
    "lenz_\u0000x",
    "lenz_é",
    "lenz_ x",
    "lenz_🔑",
  ];

  for (const key of bad) {
    it(`new Lenz() refuses ${JSON.stringify(key)} with LenzAuthError`, () => {
      expect(() => new Lenz({ apiKey: key })).toThrow(LenzAuthError);
    });
    it(`withOptions() refuses ${JSON.stringify(key)} with LenzAuthError`, () => {
      const client = new Lenz({ apiKey: "lenz_t" });
      expect(() => client.withOptions({ apiKey: key })).toThrow(LenzAuthError);
    });
  }

  it("a bad LENZ_API_KEY is refused too, and the message never shows the key", () => {
    process.env["LENZ_API_KEY"] = "lenz_secret value";
    let err: unknown;
    try {
      new Lenz();
    } catch (exc) {
      err = exc;
    }
    expect(err).toBeInstanceOf(LenzAuthError);
    expect(String(err)).not.toContain("secret");
  });

  it("whitespace around a key is dropped; the key is sent as it is between", async () => {
    const { fetch, sent } = server(() => ({ body: { ok: true } }));
    await new Lenz({ apiKey: "  lenz_t\n", fetch }).usage();
    await new Lenz({ apiKey: "lenz_a", fetch }).withOptions({ apiKey: "\tlenz_u " }).usage();
    expect(sent.map((s) => s.headers.get("authorization"))).toEqual([
      "Bearer lenz_t",
      "Bearer lenz_u",
    ]);
  });

  it("empty or whitespace-only still means no key", async () => {
    const { fetch, sent } = server(() => ({
      body: { items: [], total: 0, page: 1, page_size: 20 },
    }));
    process.env["LENZ_API_KEY"] = "lenz_env";
    const none = new Lenz({ apiKey: "", fetch });
    await expect(none.usage()).rejects.toBeInstanceOf(LenzAuthError);
    await expect(new Lenz({ apiKey: "   ", fetch }).usage()).rejects.toBeInstanceOf(LenzAuthError);
    await expect(none.withOptions({ apiKey: " " }).usage()).rejects.toBeInstanceOf(LenzAuthError);
    await none.library.list();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("authorization")).toBeNull();
  });
});

// ── 10: blank inputs and empty optional fields ──

describe("blank inputs are refused before sending", () => {
  const cases: Array<[string, (c: Lenz) => Promise<unknown>]> = [
    ["verify, no claim", (c) => c.verify({})],
    ["verify, blank claim", (c) => c.verify({ claim: "  \n" })],
    ["verify, blank text", (c) => c.verify({ text: " " })],
    ["verifyAndWait, blank claim", (c) => c.verifyAndWait({ claim: " " })],
    ["assess, nothing", (c) => c.assess({})],
    ["assess, blank claim", (c) => c.assess({ claim: "\t" })],
    ["assess, blank text", (c) => c.assess({ text: " " })],
    ["assess, empty list", (c) => c.assess({ claims: [] })],
    ["assess, a blank item", (c) => c.assess({ claims: ["The sky is blue.", "  "] })],
    [
      "assess, an item that is not a string",
      (c) => c.assess({ claims: [null as unknown as string] }),
    ],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const { fetch, sent } = server(() => ({ body: {} }));
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const err = await thrown(() => call(client));
      expect(err).toBeInstanceOf(LenzValidationError);
      expect((err as LenzValidationError).statusCode).toBe(0);
      expect(sent).toHaveLength(0);
    });
  }
});

describe("verify leaves out an empty source_url", () => {
  const accepted = { task_id: "t1", status: "pending", poll_url: "/verify/status/t1" };

  it("verify sends no source_url when none (or an empty one) is given", async () => {
    const { fetch, sent } = server(() => ({ status: 202, body: accepted }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verify({ claim: "a", idempotency: false });
    await client.verify({ claim: "a", sourceUrl: "", idempotency: false });
    await client.verify({ claim: "a", sourceUrl: "https://s.example/p", idempotency: false });
    expect(sent.map((s) => s.body)).toEqual([
      '{"text":"a"}',
      '{"text":"a"}',
      '{"text":"a","source_url":"https://s.example/p"}',
    ]);
  });

  it("verifyBatch items too", async () => {
    const { fetch, sent } = server(() => ({
      status: 202,
      body: { batch_id: "b1", items: [], status: "accepted" },
    }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({
      claims: [{ claim: "a" }, { claim: "b", sourceUrl: "https://s.example/p" }],
      idempotency: false,
    });
    expect(sent[0]!.body).toBe(
      '{"claims":[{"text":"a"},{"text":"b","source_url":"https://s.example/p"}]}',
    );
  });
});

// ── 9: idempotency on review / citecheck ──

describe("review and citecheck take idempotency", () => {
  const reviewStarted = { review_id: "r1", status: "queued" };
  const citecheckStarted = { citecheck_id: "c1", status: "queued" };

  it("idempotency: false sends no key; the default and a given key still do", async () => {
    const { fetch, sent } = server((s) => ({
      status: 202,
      body: s.url.endsWith("/review") ? reviewStarted : citecheckStarted,
    }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.review({ text: "Draft.", idempotency: false });
    await client.citecheck({ text: "Draft.", idempotency: false });
    await client.review({ text: "Draft." });
    await client.citecheck({ text: "Draft." });
    await client.review({ text: "Draft.", idempotency: false, idempotencyKey: "k1" });
    await client.citecheck({ text: "Draft.", idempotency: false, idempotencyKey: "k2" });
    const keys = sent.map((s) => s.headers.get("idempotency-key"));
    expect(keys[0]).toBeNull();
    expect(keys[1]).toBeNull();
    expect(keys[2]).toMatch(/^[0-9a-f]{32}$/);
    expect(keys[3]).toMatch(/^[0-9a-f]{32}$/);
    expect(keys.slice(4)).toEqual(["k1", "k2"]);
    // The option is not part of the body.
    for (const s of sent) expect(s.body).not.toContain("idempotency");
  });

  it("the waits take it too, and their errors then carry no key", async () => {
    const { fetch, sent } = server(() => ({ status: 500, body: { detail: "boom" } }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const a = (await thrown(() =>
      client.reviewAndWait({ text: "Draft.", idempotency: false }),
    )) as LenzError;
    const b = (await thrown(() =>
      client.citecheckAndWait({ text: "Draft.", idempotency: false }),
    )) as LenzError;
    expect(sent.map((s) => s.headers.get("idempotency-key"))).toEqual([null, null]);
    expect(a.idempotencyKey).toBeUndefined();
    expect(b.idempotencyKey).toBeUndefined();
  });

  it("a 409 naming the job is still read as the receipt (with a key)", async () => {
    let calls = 0;
    const { fetch } = server(() => {
      calls += 1;
      return calls === 1
        ? {
            status: 409,
            body: { detail: "in flight", code: "idempotency_conflict", review_id: "r9" },
          }
        : { status: 202, body: reviewStarted };
    });
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const out = await client.review({ text: "Draft." });
    expect(out).toEqual({ review_id: "r9", status: "queued" });
    // `raw` is the 409's body, the answer that settled the call.
    expect(out.raw).toEqual({
      detail: "in flight",
      code: "idempotency_conflict",
      review_id: "r9",
    });
  });
});

// ── 3: raw ──

describe("raw is the body as the API sent it", () => {
  const assessBody = {
    claims: [
      {
        claim: "x",
        status: "failed",
        verdict: null,
        confidence: null,
        failure: { code: "no_checkable_claim", hint: "h" },
      },
    ],
    more_claims: [],
    language: "en",
  };

  it("on assess, with and without the 2.x names", async () => {
    const { fetch } = server(() => ({ body: assessBody }));
    for (const legacyAliases of [true, false]) {
      const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases });
      const out = await client.assess({ claim: "x" });
      expect(out.raw).toEqual(assessBody);
      if (legacyAliases) expect(out).not.toEqual(assessBody);
    }
  });

  it("is a deep copy, a fresh one on every read, and not an enumerable key", async () => {
    const { fetch } = server(() => ({ body: assessBody }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false });
    const out = await client.assess({ claim: "x" });
    const first = out.raw!;
    (first["claims"] as Array<Record<string, unknown>>)[0]!["claim"] = "changed";
    expect(out.raw).toEqual(assessBody);
    expect(out.claims[0]!.claim).toBe("x");
    expect(Object.keys(out)).not.toContain("raw");
    expect(JSON.parse(JSON.stringify(out))).toEqual(assessBody);
    expect(out).toEqual(assessBody);
  });

  it("on the other results", async () => {
    const status = { task_id: "t1", status: "processing", poll_after_seconds: 2 };
    const usage = {
      tier: "free",
      credits: { total: 100, used: 0, remaining: 100, extra: 0, resets_at: null },
      costs: { verify: 10, assess: 1, ask: 1, extract: 0 },
    };
    const accepted = { task_id: "t1", status: "pending", poll_url: "/verify/status/t1" };
    const review = { review_id: "r1", status: "queued" };
    const { fetch } = server((s) => {
      if (s.url.includes("/verify/status/")) return { body: status };
      if (s.url.endsWith("/me/usage")) return { body: usage };
      if (s.url.endsWith("/review")) return { status: 202, body: review };
      return { status: 202, body: accepted };
    });
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect((await client.getStatus("t1")).raw).toEqual(status);
    expect((await client.usage()).raw).toEqual(usage);
    expect((await client.verify({ claim: "a" })).raw).toEqual(accepted);
    expect((await client.review({ text: "Draft." })).raw).toEqual(review);
  });

  it("on a review read, before the defaults are filled", async () => {
    const body = { review_id: "r1", status: "completed", claims: [], summary: {} };
    const { fetch } = server(() => ({ body }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.getReview("r1");
    expect(out.raw).toEqual(body);
    expect(out).toHaveProperty("citations");
  });

  it("on a wait's verification: the verification as the final poll sent it", async () => {
    const verification = {
      verification_id: "abcd1234",
      claim: "a",
      created_at: "2026-10-10T00:00:00Z",
      completed_at: "2026-10-10T00:01:00Z",
    };
    const status = { task_id: "t1", status: "completed", result: verification };
    const { fetch } = server(() => ({ body: status }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.wait("t1");
    expect(out.raw).toEqual(verification);
    expect(out).toHaveProperty("modified_at");
  });

  it("never replaces a raw key the body itself carries", async () => {
    const { fetch } = server(() => ({ body: { raw: "server's", ok: true } }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false });
    const out = (await client.usage()) as unknown as Record<string, unknown>;
    expect(out["raw"]).toBe("server's");
  });
});
