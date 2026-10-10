/**
 * 3.2 options for callers that hold several keys or read the API's own shape
 * (the same in the Python SDK: `with_options(api_key=...)`,
 * `legacy_aliases=False`), plus three edges of the transport: lone UTF-16
 * surrogates in a body, a 2xx whose body is not JSON, and the message of
 * `LenzApiVersionError`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Lenz,
  LenzApiVersionError,
  LenzAPIError,
  LenzAuthError,
  LenzConnectionError,
  LenzError,
  LenzInvalidResponseError,
  LenzPipelineError,
  LenzNeedsInputError,
} from "../src/index.js";

interface Sent {
  url: string;
  headers: Headers;
  body: string | undefined;
}

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };

function server(reply: (sent: Sent) => Reply | Promise<Reply>) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const s: Sent = {
      url: String(url),
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

const USAGE = {
  tier: "free",
  credits: { total: 100, used: 0, remaining: 100, extra: 0, resets_at: "2026-11-01T00:00:00Z" },
  costs: { verify: 10, assess: 1, ask: 1, extract: 0 },
};

let envKey: string | undefined;
beforeEach(() => {
  envKey = process.env["LENZ_API_KEY"];
  delete process.env["LENZ_API_KEY"];
});
afterEach(() => {
  if (envKey === undefined) delete process.env["LENZ_API_KEY"];
  else process.env["LENZ_API_KEY"] = envKey;
});

// ── 1. withOptions({ apiKey }) ──

describe("withOptions({ apiKey })", () => {
  it("a copy sends its own key; the parent keeps its own", async () => {
    const { fetch, sent } = server(() => ({ body: USAGE }));
    const client = new Lenz({ apiKey: "lenz_parent", fetch });
    const copy = client.withOptions({ apiKey: "lat_oauth_token" });
    await copy.usage();
    await client.usage();
    expect(sent.map((s) => s.headers.get("Authorization"))).toEqual([
      "Bearer lat_oauth_token",
      "Bearer lenz_parent",
    ]);
  });

  it("two copies called concurrently each send their own key", async () => {
    const { fetch, sent } = server(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { body: USAGE };
    });
    const client = new Lenz({ fetch });
    const a = client.withOptions({ apiKey: "lenz_a" });
    const b = client.withOptions({ apiKey: "lenz_b" });
    await Promise.all([a.usage(), b.usage(), a.usage(), b.usage()]);
    const keys = sent.map((s) => s.headers.get("Authorization")).sort();
    expect(keys).toEqual(["Bearer lenz_a", "Bearer lenz_a", "Bearer lenz_b", "Bearer lenz_b"]);
  });

  it("omitted keeps the parent's key, and a copy of a copy keeps the copy's", async () => {
    const { fetch, sent } = server(() => ({ body: USAGE }));
    const client = new Lenz({ apiKey: "lenz_parent", fetch });
    await client.withOptions({ maxRetries: 0 }).usage();
    await client.withOptions({ apiKey: "lenz_child" }).withOptions({ maxRetries: 0 }).usage();
    expect(sent.map((s) => s.headers.get("Authorization"))).toEqual([
      "Bearer lenz_parent",
      "Bearer lenz_child",
    ]);
  });

  it.each(["", "   "])("%j gives the copy no key, and never reads LENZ_API_KEY", async (apiKey) => {
    process.env["LENZ_API_KEY"] = "lenz_env";
    const { fetch, sent } = server(() => ({
      body: { items: [], total: 0, page: 1, page_size: 20 },
    }));
    const client = new Lenz({ apiKey: "lenz_parent", fetch });
    const copy = client.withOptions({ apiKey });
    await expect(copy.usage()).rejects.toBeInstanceOf(LenzAuthError);
    expect(sent).toHaveLength(0);
    await copy.library.list();
    expect(sent[0]!.headers.has("Authorization")).toBe(false);
  });

  it("a copy given a key works on a client made without one", async () => {
    const { fetch, sent } = server(() => ({ body: USAGE }));
    const client = new Lenz({ fetch });
    await client.withOptions({ apiKey: "lenz_late" }).usage();
    expect(sent[0]!.headers.get("Authorization")).toBe("Bearer lenz_late");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("an apiKey given as %s gives the copy no key (not the root's)", async (_label, apiKey) => {
    process.env["LENZ_API_KEY"] = "lenz_env";
    const { fetch, sent } = server(() => ({ body: USAGE }));
    const client = new Lenz({ apiKey: "lenz_root", fetch });
    const tenant: { key?: string | null } = { key: apiKey };
    const copy = client.withOptions({ apiKey: tenant.key });
    await expect(copy.usage()).rejects.toBeInstanceOf(LenzAuthError);
    expect(sent).toHaveLength(0);
    // A copy of that copy, with no apiKey property, keeps "no key".
    await expect(copy.withOptions({ maxRetries: 0 }).usage()).rejects.toBeInstanceOf(LenzAuthError);
  });

  it.each(["apikey", "api_key", "ApiKey", "timeout", "legacy_aliases"])(
    "an option it does not take (%s) throws",
    (name) => {
      const client = new Lenz({ apiKey: "lenz_t" });
      expect(() =>
        client.withOptions({ [name]: "lenz_x" } as unknown as Parameters<
          typeof client.withOptions
        >[0]),
      ).toThrow(new RegExp(`unknown option "${name}"`));
    },
  );

  it("takes every request option and apiKey", () => {
    const client = new Lenz({ apiKey: "lenz_t" });
    expect(() =>
      client.withOptions({
        signal: new AbortController().signal,
        timeoutMs: 1000,
        maxRetries: 1,
        headers: { "X-Trace": "1" },
        apiKey: "lenz_y",
      }),
    ).not.toThrow();
  });

  it("a key that is not a string is refused", () => {
    const client = new Lenz({ apiKey: "lenz_t" });
    expect(() => client.withOptions({ apiKey: 42 as unknown as string })).toThrow(
      /apiKey must be a string/,
    );
  });

  it("legacyAliases is not set on a copy", () => {
    const client = new Lenz({ apiKey: "lenz_t" });
    expect(() =>
      client.withOptions({ legacyAliases: false } as unknown as Parameters<
        typeof client.withOptions
      >[0]),
    ).toThrow(/legacyAliases/);
  });
});

// ── 2. legacyAliases ──

const FAILED_ROW = {
  claim: "x",
  status: "failed",
  verdict: null,
  confidence: null,
  more_claims: [],
  failure: { code: "no_checkable_claim", detail: "Nothing to check.", hint: "Rephrase." },
};
const ASSESS = { claims: [FAILED_ROW], more_claims: [] };

const NEEDS_INPUT = {
  task_id: "t1",
  status: "needs_input",
  reason: "multi_claim",
  claims: [{ claim: "A" }, { claim: "B" }],
};

const VERIFICATION = {
  verification_id: "v1",
  claim: "x",
  created_at: "2026-10-01T10:00:00Z",
  completed_at: "2026-10-02T10:00:00Z",
};

describe("legacyAliases", () => {
  it("is on by default: 3.x results unchanged", async () => {
    const { fetch } = server(() => ({ body: ASSESS }));
    const out = await new Lenz({ apiKey: "lenz_t", fetch }).assess({ claim: "x" });
    const row = out.claims[0]! as unknown as Record<string, unknown>;
    expect(row["verdict"]).toBe("Error");
    expect(row["confidence"]).toBe("low");
    expect(row["error_code"]).toBe("no_claim");
  });

  it("false: an /assess body is returned as sent", async () => {
    const { fetch } = server(() => ({ body: ASSESS }));
    const out = await new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false }).assess({
      claim: "x",
    });
    expect(out).toEqual(ASSESS);
  });

  it("false: a needs_input poll's options carry claim only", async () => {
    const { fetch } = server(() => ({ body: NEEDS_INPUT }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false });
    expect(await client.getStatus("t1")).toEqual(NEEDS_INPUT);
  });

  it("false: wait's needs-input error carries the poll as sent", async () => {
    const { fetch } = server(() => ({ body: NEEDS_INPUT }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false });
    const err = await client.wait("t1", { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzNeedsInputError);
    expect((err as LenzNeedsInputError).payload).toEqual(NEEDS_INPUT);
  });

  it("false: a failed run still throws the same error, fields filled", async () => {
    const failed = {
      task_id: "t1",
      status: "failed",
      failure: {
        code: "no_checkable_claim",
        detail: "Nothing to check.",
        hint: null,
        failure_class: "invalid_input",
        retryable: false,
        docs_url: null,
      },
    };
    const run = async (legacyAliases: boolean) => {
      const { fetch } = server(() => ({ body: failed }));
      const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases });
      return (await client.wait("t1", { timeoutMs: 1000 }).catch((e: unknown) => e)) as Error;
    };
    const [on, off] = [await run(true), await run(false)];
    expect(off).toBeInstanceOf(LenzPipelineError);
    for (const k of ["message", "failureReason", "failureClass", "retryable", "hint"] as const) {
      expect((off as unknown as Record<string, unknown>)[k]).toEqual(
        (on as unknown as Record<string, unknown>)[k],
      );
    }
  });

  it("false: /me/usage is returned as sent", async () => {
    const { fetch } = server(() => ({ body: USAGE }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false });
    expect(await client.usage()).toEqual(USAGE);
  });

  it("false: a verification has no modified_at, a list's items neither", async () => {
    const { fetch } = server((s) =>
      s.url.includes("/verifications?")
        ? { body: { items: [VERIFICATION], total: 1, page: 1, page_size: 20 } }
        : { body: VERIFICATION },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false });
    expect(await client.verifications.get("v1")).toEqual(VERIFICATION);
    expect((await client.verifications.list()).items).toEqual([VERIFICATION]);
  });

  it("false: extract keeps the API's status and adds no 2.x fields", async () => {
    const body = { status: "no_checkable_claim", claims: [] };
    const { fetch } = server(() => ({ body }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false });
    expect(await client.extract({ text: "hi" })).toEqual(body);
  });

  it("false: a batch receipt and its results carry no claim_text", async () => {
    const receipt = { batch_id: "b1", items: [{ task_id: "t1", claim: "x" }] };
    const done = { task_id: "t1", status: "completed", result: VERIFICATION };
    const { fetch } = server((s) =>
      s.url.endsWith("/verify/batch") ? { body: receipt } : { body: done },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false });
    const results = await client.verifyBatchAndWait({ claims: [{ claim: "x" }] });
    expect(results[0]).not.toHaveProperty("claim_text");
    expect(results[0]!.verification).toEqual(VERIFICATION);
    expect(results[0]!.status_detail).toEqual(done);
    const { fetch: f2 } = server(() => ({ body: receipt }));
    expect(
      await new Lenz({ apiKey: "lenz_t", fetch: f2, legacyAliases: false }).verifyBatch({
        claims: [{ claim: "x" }],
      }),
    ).toEqual(receipt);
  });

  it("false: a review assessment row keeps its nulls and adds no 2.x names", async () => {
    const review = {
      review_id: "r1",
      status: "completed",
      summary: { claims_found: 1, claim_limit: 20, claim_limit_exceeded: false },
      claims: [{ assessment: { ...FAILED_ROW } }],
    };
    const { fetch } = server(() => ({ body: review }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false });
    const out = (await client.getReview("r1")) as unknown as Record<string, unknown>;
    const row = (out["claims"] as Array<Record<string, unknown>>)[0]!;
    const a = row["assessment"] as Record<string, unknown>;
    expect(a["verdict"]).toBeNull();
    expect(a["confidence"]).toBeNull();
    expect(a).not.toHaveProperty("identified_claims");
    expect(a).not.toHaveProperty("error_code");
    expect(a["failure"] as Record<string, unknown>).not.toHaveProperty("failure_reason");
    expect(out["summary"]).not.toHaveProperty("claim_limit_reached");
  });

  it("a copy keeps the client's setting", async () => {
    const { fetch } = server(() => ({ body: USAGE }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false });
    expect(await client.withOptions({ apiKey: "lenz_other" }).usage()).toEqual(USAGE);
  });

  it("a value that is not a boolean is refused", () => {
    expect(() => new Lenz({ legacyAliases: "no" as unknown as boolean })).toThrow(/legacyAliases/);
  });
});

// ── 3. Lone surrogates ──

const hex = (s: string) =>
  Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

describe("lone UTF-16 surrogates in a body", () => {
  it("each lone surrogate is sent as U+FFFD; a valid pair is unchanged", async () => {
    const { fetch, sent } = server(() => ({ body: { task_id: "t1" } }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verify({ claim: "a\ud800b\udc00c😀d" });
    const body = sent[0]!.body!;
    expect(body).not.toMatch(/\\ud8|\\udc/i);
    expect(JSON.parse(body).text).toBe("a�b�c😀d");
    expect(hex(body)).toContain("efbfbd");
    expect(hex(body)).toContain(hex("😀"));
  });

  it("a high surrogate at the end, and one in a list item, too", async () => {
    const { fetch, sent } = server(() => ({ body: { claims: [], more_claims: [] } }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.assess({ claims: ["x\ud800", "\udfff"] });
    expect(JSON.parse(sent[0]!.body!).claims).toEqual(["x�", "�"]);
  });

  it("a well-formed body is sent byte for byte as before", async () => {
    const { fetch, sent } = server(() => ({ body: { task_id: "t1" } }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const claim = 'Ünïcödé "quotes" \\ back\\slash   😀 \\ud800';
    await client.verify({ claim });
    expect(JSON.parse(sent[0]!.body!).text).toBe(claim);
  });
});

// ── 4. A 2xx that is not JSON ──

describe("a 2xx whose body is not JSON", () => {
  it("throws LenzInvalidResponseError with the real status, request id and body text", async () => {
    const page = "<html>" + "x".repeat(5000) + "</html>";
    const { fetch } = server(() => ({
      status: 200,
      text: page,
      headers: { "content-type": "text/html", "X-Request-ID": "req_1" },
    }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await client.usage().catch((e: unknown) => e)) as LenzInvalidResponseError;
    expect(err).toBeInstanceOf(LenzInvalidResponseError);
    expect(err).toBeInstanceOf(LenzAPIError);
    expect(err).toBeInstanceOf(LenzError);
    expect(err).not.toBeInstanceOf(LenzConnectionError);
    expect(err.statusCode).toBe(200);
    expect(err.requestId).toBe("req_1");
    expect(err.bodyText.startsWith("<html>")).toBe(true);
    expect(err.bodyText.length).toBeLessThanOrEqual(1001);
  });

  it("a 201 with a truncated JSON body too", async () => {
    const { fetch } = server(() => ({ status: 201, text: '{"task_id": "t' }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await client.verify({ claim: "x" }).catch((e: unknown) => e)) as LenzError;
    expect(err).toBeInstanceOf(LenzInvalidResponseError);
    expect(err.statusCode).toBe(201);
    expect(err.idempotencyKey).toBeTruthy();
  });

  it.each([
    [204, {}],
    [205, {}],
    [200, { "content-length": "0" }],
  ] as const)("a %s with headers %j reads as an empty object", async (status, headers) => {
    const fetch = vi.fn(
      async () => new Response(null, { status, headers }),
    ) as unknown as typeof globalThis.fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(await client.request({ method: "GET", path: "/x" })).toEqual({});
  });

  it.each(["", "   \n"])("a 200 whose body is %j (no Content-Length) throws", async (text) => {
    const fetch = vi.fn(async () => {
      const body = new ReadableStream({
        start(c) {
          if (text) c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await client.usage().catch((e: unknown) => e)) as LenzInvalidResponseError;
    expect(err).toBeInstanceOf(LenzInvalidResponseError);
    expect(err.statusCode).toBe(200);
    expect(err.bodyText).toBe(text);
  });

  it("bodyText never ends on half of a surrogate pair", async () => {
    const page = "x".repeat(999) + "😀" + "y".repeat(10);
    const { fetch } = server(() => ({ status: 200, text: page }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await client.usage().catch((e: unknown) => e)) as LenzInvalidResponseError;
    expect(err.bodyText).toBe("x".repeat(999) + "…");
  });

  it("a transport failure still has status 0", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await client.usage().catch((e: unknown) => e)) as LenzError;
    expect(err).toBeInstanceOf(LenzConnectionError);
    expect(err.statusCode).toBe(0);
  });
});

// ── 5. LenzApiVersionError's message ──

describe("LenzApiVersionError's message", () => {
  it("names the version the API answered, and no server setting", async () => {
    const { fetch } = server(() => ({
      body: { tier: "free" },
      headers: { "X-Lenz-API-Version": "2026-05-13" },
    }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = (await client.usage().catch((e: unknown) => e)) as LenzApiVersionError;
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect(err.message).toBe("The API answered 2026-05-13; this SDK reads 2026-10-11 only.");
    expect(err.apiVersion).toBe("2026-05-13");
  });
});
