/**
 * The exact request bytes of the 2.x input forms, frozen before 3.0 added
 * camelCase batch and citation inputs and the wait options argument.
 *
 * Every case pins its `Idempotency-Key` and compares the raw request body
 * string (key order included), so a body the server hashes for idempotency
 * stays byte-identical for code written against 2.x.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Lenz, LenzTimeoutError } from "../src/index.js";
import type { CitationPair, Progress, VerifyBatchItem } from "../src/index.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(responses: Iterable<{ status?: number; body?: unknown }>) {
  const queue = Array.from(responses);
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("No more mocked responses");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

const key = (c: FetchCall) => new Headers(c.init.headers).get("Idempotency-Key");
const raw = (c: FetchCall) => String(c.init.body);

const BATCH_ACCEPTED = { batch_id: "b", items: [{ task_id: "t1", claim: "a" }] };
const CITECHECK_ACCEPTED = { citecheck_id: "c1", status: "queued" };
const ACCEPTED = { task_id: "t1", status: "queued" };
const PROCESSING = { status: "processing", progress: { step: "research" } };
const COMPLETED = {
  status: "completed",
  result: {
    verification_id: "v1",
    verdict: { label: "True", score: 9, confidence: "high" },
  },
};

// ── batch items ──────────────────────────────────────────────────────────

/** A batch item in the 2.x form, and the body it sends. */
const BATCH_CASES: Array<{ name: string; items: VerifyBatchItem[]; wire: string }> = [
  {
    name: "claim, source_url, webhook_url",
    items: [{ claim: "a", source_url: "https://s.example/p", webhook_url: "https://h.example/w" }],
    wire: '{"claims":[{"text":"a","source_url":"https://s.example/p","webhook_url":"https://h.example/w"}]}',
  },
  {
    name: "webhook_url, source_url, claim, language",
    items: [
      {
        webhook_url: "https://h.example/w",
        source_url: "https://s.example/p",
        claim: "a",
        language: "de",
      },
    ],
    wire: '{"claims":[{"text":"a","source_url":"https://s.example/p","webhook_url":"https://h.example/w","language":"de"}]}',
  },
  {
    name: "source_url only, then a bare item",
    items: [{ source_url: "https://s.example/p", text: "a" }, { claim: "b" }],
    wire: '{"claims":[{"text":"a","source_url":"https://s.example/p"},{"text":"b","source_url":""}]}',
  },
  {
    name: "an empty webhook_url is omitted",
    items: [{ claim: "a", webhook_url: "", depth: "low", visibility: "unlisted" }],
    wire: '{"claims":[{"text":"a","source_url":"","visibility":"unlisted","depth":"low"}]}',
  },
];

describe("frozen: verifyBatch item bodies", () => {
  for (const c of BATCH_CASES) {
    it(c.name, async () => {
      const { fetch, calls } = makeFetch([{ status: 202, body: BATCH_ACCEPTED }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.verifyBatch({ claims: c.items, idempotencyKey: "frozen-batch" });
      expect(key(calls[0]!)).toBe("frozen-batch");
      expect(raw(calls[0]!)).toBe(c.wire);
    });
  }
});

// ── citation pairs ───────────────────────────────────────────────────────

/** Citation pairs in the 2.x form, and the body they send. */
const PAIR_CASES: Array<{ name: string; pairs: CitationPair[]; wire: string }> = [
  {
    name: "{cited_year, statement, doi}",
    pairs: [{ cited_year: "2015", statement: "s", doi: "10.1038/nature12373" }],
    wire: '{"pairs":[{"cited_year":"2015","statement":"s","doi":"10.1038/nature12373"}]}',
  },
  {
    name: "{statement, doi, cited_year}",
    pairs: [{ statement: "s", doi: "10.1038/nature12373", cited_year: "2015" }],
    wire: '{"pairs":[{"statement":"s","doi":"10.1038/nature12373","cited_year":"2015"}]}',
  },
  {
    name: "every cited field, interleaved",
    pairs: [
      {
        cited_journal: "Nature",
        statement: "s",
        cited_authors: ["Kucsko", "Lukin"],
        doi: "10.1038/nature12373",
        cited_title: "Nanometre-scale thermometry",
        quotes: ["nanometre-scale thermometry in a living cell"],
        cited_year: "2013",
      },
    ],
    wire:
      '{"pairs":[{"cited_journal":"Nature","statement":"s","cited_authors":["Kucsko","Lukin"],' +
      '"doi":"10.1038/nature12373","cited_title":"Nanometre-scale thermometry",' +
      '"quotes":["nanometre-scale thermometry in a living cell"],"cited_year":"2013"}]}',
  },
  {
    name: "a url pair beside a doi pair",
    pairs: [
      { url: "https://example.org/boiling", statement: "Water boils at 100 degrees Celsius." },
      { statement: "t", cited_title: "T", doi: "10.1/x" },
    ],
    wire:
      '{"pairs":[{"url":"https://example.org/boiling","statement":"Water boils at 100 degrees Celsius."},' +
      '{"statement":"t","cited_title":"T","doi":"10.1/x"}]}',
  },
];

describe("frozen: citecheck pair bodies", () => {
  for (const c of PAIR_CASES) {
    it(c.name, async () => {
      const { fetch, calls } = makeFetch([{ status: 202, body: CITECHECK_ACCEPTED }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.citecheck({ pairs: c.pairs, idempotencyKey: "frozen-cite" });
      expect(key(calls[0]!)).toBe("frozen-cite");
      expect(raw(calls[0]!)).toBe(c.wire);
    });
  }

  it("with the request options after the pairs", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: CITECHECK_ACCEPTED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.citecheck({
      pairs: PAIR_CASES[0]!.pairs,
      language: "de",
      webhookUrl: "",
      idempotencyKey: "frozen-cite",
    });
    expect(raw(calls[0]!)).toBe(
      '{"pairs":[{"cited_year":"2015","statement":"s","doi":"10.1038/nature12373"}],' +
        '"language":"de","webhook_url":""}',
    );
  });
});

// ── the 2.x wait forms ───────────────────────────────────────────────────

describe("frozen: the in-input wait options", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifyAndWait({ ..., timeoutMs, onProgress })", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = makeFetch([
      { status: 202, body: ACCEPTED },
      { body: PROCESSING },
      { body: COMPLETED },
    ]);
    const seen: Array<[string, Progress]> = [];
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const p = client.verifyAndWait({
      claim: "a",
      idempotencyKey: "frozen-verify",
      timeoutMs: 60_000,
      onProgress: (id, progress) => seen.push([id, progress]),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const v = await p;
    expect(v.verification_id).toBe("v1");
    expect(calls.map((c) => c.url)).toEqual([
      "https://lenz.io/api/v1/verify",
      "https://lenz.io/api/v1/verify/status/t1",
      "https://lenz.io/api/v1/verify/status/t1",
    ]);
    expect(key(calls[0]!)).toBe("frozen-verify");
    expect(raw(calls[0]!)).toBe('{"text":"a","source_url":""}');
    expect(seen).toEqual([["t1", { step: "research" }]]);
  });

  it("verifyAndWait({ ..., timeoutMs: 0 }) polls once", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }, { body: PROCESSING }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = await client
      .verifyAndWait({ claim: "a", idempotencyKey: "frozen-verify", timeoutMs: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzTimeoutError);
    expect((err as LenzTimeoutError).message).toBe("wait timed out after 0ms");
    expect(calls).toHaveLength(2);
  });

  it("verifyBatchAndWait({ ..., timeoutMs, onProgress })", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = makeFetch([
      { status: 202, body: BATCH_ACCEPTED },
      { body: PROCESSING },
      { body: COMPLETED },
    ]);
    const seen: Array<[string, Progress]> = [];
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const p = client.verifyBatchAndWait({
      claims: BATCH_CASES[0]!.items,
      idempotencyKey: "frozen-batch",
      timeoutMs: 60_000,
      onProgress: (id, progress) => seen.push([id, progress]),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const rows = await p;
    expect(rows.map((r) => [r.task_id, r.status])).toEqual([["t1", "completed"]]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://lenz.io/api/v1/verify/batch",
      "https://lenz.io/api/v1/verify/status/t1",
      "https://lenz.io/api/v1/verify/status/t1",
    ]);
    expect(key(calls[0]!)).toBe("frozen-batch");
    expect(raw(calls[0]!)).toBe(BATCH_CASES[0]!.wire);
    expect(seen).toEqual([["t1", { step: "research" }]]);
  });

  it("verifyBatchAndWait({ ..., timeoutMs: 0 }) polls once", async () => {
    const { fetch, calls } = makeFetch([
      { status: 202, body: BATCH_ACCEPTED },
      { body: PROCESSING },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const rows = await client.verifyBatchAndWait({
      claims: [{ claim: "a" }],
      idempotencyKey: "frozen-batch",
      timeoutMs: 0,
    });
    expect(rows.map((r) => r.status)).toEqual(["timeout"]);
    expect(calls).toHaveLength(2);
  });
});
