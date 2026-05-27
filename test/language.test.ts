/**
 * Multi-language SDK behavior — request-body wire format, response
 * parsing, error surfacing, and the byte-identical English regression.
 *
 * Six methods gain an optional `language` field:
 *   verify, verifyAndWait, verifyBatch, assess, extract, ask.send.
 *
 * The convention (see `src/client.ts` module docstring):
 *   - `language` omitted (or empty) MUST omit the field from the
 *     request body. This is the CRITICAL regression invariant: every
 *     existing English caller's wire format must stay byte-identical.
 *   - `language: "es" | "de" | ...` (any of 12 supported codes) MUST
 *     send `"language": "<code>"` on the wire.
 *   - Response objects populate `.language` from the server's echoed
 *     field; missing field on legacy / mocked payloads is tolerated.
 *
 * Server validation lives in the main repo; the SDK just round-trips
 * the field. We mock 422s to confirm typed errors surface cleanly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Lenz, LenzError } from "../src/index.js";

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

function bodyOf(calls: FetchCall[], i = 0): Record<string, unknown> {
  return JSON.parse(String(calls[i]!.init.body)) as Record<string, unknown>;
}

// ─────────────────────────────────────────────── REGRESSION (CRITICAL) ──
// IRON RULE: omit-language MUST produce a request body with no `language`
// key. Without this, every existing English customer starts sending an
// extra key on the wire — silent breaking change.

describe("omit-language wire-format regression (CRITICAL)", () => {
  it("verify: no language key when omitted", async () => {
    const { fetch, calls } = makeFetch([{ body: { task_id: "t", claim_text: "x" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verify({ claim: "The earth is flat" });
    expect(bodyOf(calls)).not.toHaveProperty("language");
  });

  it("verifyAndWait: no language key on the submit body when omitted", async () => {
    const { fetch, calls } = makeFetch([
      { body: { task_id: "t1", claim_text: "x" } },
      {
        body: {
          status: "completed",
          result: {
            verification_id: "v1",
            claim: "x",
            verdict: "True",
            confidence: "high",
          },
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyAndWait({ claim: "x", timeoutMs: 5000 });
    // calls[0] is the POST /verify submit.
    expect(bodyOf(calls, 0)).not.toHaveProperty("language");
  });

  it("verifyBatch: no language key when omitted", async () => {
    const { fetch, calls } = makeFetch([{ body: { batch_id: "b", items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({ claims: [{ text: "a" }, { text: "b" }] });
    expect(bodyOf(calls)).not.toHaveProperty("language");
  });

  it("assess: no language key when omitted", async () => {
    const { fetch, calls } = makeFetch([{ body: { claims: [], error: null } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.assess({ text: "x" });
    expect(bodyOf(calls)).not.toHaveProperty("language");
  });

  it("extract: no language key when omitted", async () => {
    const { fetch, calls } = makeFetch([
      {
        body: {
          status: "ready",
          claim: "x",
          identified_claims: ["x"],
          domain: "Science",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.extract({ text: "The earth is flat" });
    expect(bodyOf(calls)).not.toHaveProperty("language");
  });

  it("ask.send: no language key when omitted", async () => {
    const { fetch, calls } = makeFetch([{ body: { reply: "ok" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.ask.send("v1", { message: "why?" });
    expect(bodyOf(calls)).not.toHaveProperty("language");
  });
});

// ─────────────────────────────────────────────── HAPPY PATH ──

describe("explicit language wire format", () => {
  it("verify: sends language when set", async () => {
    const { fetch, calls } = makeFetch([{ body: { task_id: "t", claim_text: "x" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verify({ claim: "x", language: "es" });
    expect(bodyOf(calls).language).toBe("es");
  });

  it("verifyAndWait: forwards language to submit and surfaces it on the result", async () => {
    const { fetch, calls } = makeFetch([
      { body: { task_id: "t1", claim_text: "x" } },
      {
        body: {
          status: "completed",
          result: {
            verification_id: "v1",
            claim: "La Tierra es plana",
            verdict: "False",
            confidence: "high",
            language: "es",
          },
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifyAndWait({ claim: "x", language: "es", timeoutMs: 5000 });
    expect(bodyOf(calls, 0).language).toBe("es");
    expect(v.language).toBe("es");
    expect(v.verdict).toBe("False"); // enum stays English
  });

  it("verifyBatch: batch-wide language landed at top of body", async () => {
    const { fetch, calls } = makeFetch([{ body: { batch_id: "b", items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({
      claims: [{ text: "a" }, { text: "b" }],
      language: "de",
    });
    expect(bodyOf(calls).language).toBe("de");
  });

  it("verifyBatch: per-item language overrides batch default", async () => {
    const { fetch, calls } = makeFetch([{ body: { batch_id: "b", items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({
      claims: [
        { text: "a", language: "es" },
        { text: "b", language: "de" },
      ],
    });
    const body = bodyOf(calls);
    expect(body).not.toHaveProperty("language");
    expect(body.claims).toMatchObject([
      { text: "a", language: "es" },
      { text: "b", language: "de" },
    ]);
  });

  it("verifyBatch: mixed default + per-item override both reach the wire", async () => {
    const { fetch, calls } = makeFetch([{ body: { batch_id: "b", items: [] } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifyBatch({
      claims: [{ text: "a" }, { text: "b", language: "de" }],
      language: "es",
    });
    const body = bodyOf(calls);
    expect(body.language).toBe("es");
    const claims = body.claims as Array<Record<string, unknown>>;
    expect(claims[1]!.language).toBe("de");
  });

  it("assess: sends language", async () => {
    const { fetch, calls } = makeFetch([{ body: { claims: [], error: null } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.assess({ text: "x", language: "es" });
    expect(bodyOf(calls).language).toBe("es");
  });

  it("extract: sends language", async () => {
    const { fetch, calls } = makeFetch([
      {
        body: {
          status: "ready",
          claim: "x",
          identified_claims: ["x"],
          domain: "Science",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.extract({ text: "x", language: "es" });
    expect(bodyOf(calls).language).toBe("es");
  });

  it("ask.send: sends language", async () => {
    const { fetch, calls } = makeFetch([{ body: { reply: "ok" } }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.ask.send("v1", { message: "why?", language: "en" });
    expect(bodyOf(calls).language).toBe("en");
  });
});

// ─────────────────────────────────────────────── ERROR PATH ──

describe("invalid language code", () => {
  it("assess: 422 surfaces as typed LenzError with status", async () => {
    const { fetch } = makeFetch([
      {
        status: 422,
        body: {
          detail: "Unsupported language code 'xx'. Supported: en, es, de, fr, ...",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.assess({ text: "x", language: "xx" })).rejects.toBeInstanceOf(LenzError);
  });
});

// ─────────────────────────────────────────────── RESPONSE PARSING ──

describe("response parsing", () => {
  it("verifications.get: parses explicit language", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          verification_id: "v1",
          claim: "La Tierra es plana",
          verdict: "False",
          confidence: "high",
          language: "es",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifications.get("v1");
    expect(v.language).toBe("es");
    expect(v.verdict).toBe("False");
  });

  it("verifications.get: legacy payload without language deserializes (language undefined)", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          verification_id: "v1",
          claim: "x",
          verdict: "True",
          confidence: "high",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const v = await client.verifications.get("v1");
    // Mirror Python: the field is optional (`?`) on the TS type. Legacy
    // payload simply has it `undefined`. Callers MUST default to 'en' if
    // they want a non-undefined value.
    expect(v.language).toBeUndefined();
    expect(v.verdict).toBe("True");
  });

  it("verifications.list: parses language on list items", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          items: [
            {
              verification_id: "v1",
              claim: "a",
              verdict: "True",
              language: "fr",
            },
          ],
          total: 1,
          page: 1,
          page_size: 20,
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const page = await client.verifications.list();
    expect(page.items[0]!.language).toBe("fr");
  });

  it("assess: parses language on each AssessClaim", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          claims: [{ claim: "x", verdict: "False", confidence: "high", language: "de" }],
          error: null,
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.assess({ text: "x", language: "de" });
    expect(out.claims[0]!.language).toBe("de");
    expect(out.claims[0]!.verdict).toBe("False");
  });

  it("assess: legacy payload without language is tolerated", async () => {
    const { fetch } = makeFetch([
      {
        body: {
          claims: [{ claim: "x", verdict: "True", confidence: "high" }],
          error: null,
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const out = await client.assess({ text: "x" });
    expect(out.claims[0]!.language).toBeUndefined();
  });
});
