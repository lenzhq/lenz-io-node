/**
 * 3.0 camelCase inputs for the two inputs 2.x took in snake_case: batch
 * items (`sourceUrl`, `webhookUrl`) and citation pairs (`citedTitle`,
 * `citedAuthors`, `citedYear`, `citedJournal`).
 *
 * A camel key goes on the wire under its snake name at the same place in the
 * caller's key order, so each camel form sends the body its 2.x twin sends
 * (`frozen-inputs.test.ts`), under the same pinned idempotency key.
 */

import { describe, expect, it, vi } from "vitest";

import { Lenz } from "../src/index.js";
import type { CitationPair, VerifyBatchItem } from "../src/index.js";

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

async function batchBody(items: VerifyBatchItem[]): Promise<FetchCall> {
  const { fetch, calls } = makeFetch([{ status: 202, body: BATCH_ACCEPTED }]);
  await new Lenz({ apiKey: "lenz_t", fetch }).verifyBatch({
    claims: items,
    idempotencyKey: "frozen-batch",
  });
  return calls[0]!;
}

async function pairsBody(pairs: CitationPair[]): Promise<FetchCall> {
  const { fetch, calls } = makeFetch([{ status: 202, body: CITECHECK_ACCEPTED }]);
  await new Lenz({ apiKey: "lenz_t", fetch }).citecheck({ pairs, idempotencyKey: "frozen-cite" });
  return calls[0]!;
}

// ── batch items ──────────────────────────────────────────────────────────

describe("verifyBatch: camelCase items send the 2.x bytes", () => {
  const cases: Array<{ name: string; items: VerifyBatchItem[]; wire: string }> = [
    {
      name: "claim, sourceUrl, webhookUrl",
      items: [{ claim: "a", sourceUrl: "https://s.example/p", webhookUrl: "https://h.example/w" }],
      wire: '{"claims":[{"text":"a","source_url":"https://s.example/p","webhook_url":"https://h.example/w"}]}',
    },
    {
      name: "webhookUrl, sourceUrl, claim, language",
      items: [
        {
          webhookUrl: "https://h.example/w",
          sourceUrl: "https://s.example/p",
          claim: "a",
          language: "de",
        },
      ],
      wire: '{"claims":[{"text":"a","source_url":"https://s.example/p","webhook_url":"https://h.example/w","language":"de"}]}',
    },
    {
      name: "sourceUrl only, then a bare item",
      items: [{ sourceUrl: "https://s.example/p", text: "a" }, { claim: "b" }],
      wire: '{"claims":[{"text":"a","source_url":"https://s.example/p"},{"text":"b","source_url":""}]}',
    },
    {
      name: "an empty webhookUrl is omitted",
      items: [{ claim: "a", webhookUrl: "", depth: "low", visibility: "unlisted" }],
      wire: '{"claims":[{"text":"a","source_url":"","visibility":"unlisted","depth":"low"}]}',
    },
    {
      name: "one camel, one snake",
      items: [{ claim: "a", sourceUrl: "https://s.example/p", webhook_url: "https://h.example/w" }],
      wire: '{"claims":[{"text":"a","source_url":"https://s.example/p","webhook_url":"https://h.example/w"}]}',
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const call = await batchBody(c.items);
      expect(key(call)).toBe("frozen-batch");
      expect(raw(call)).toBe(c.wire);
    });
  }

  it("both spellings, equal: sent once", async () => {
    const call = await batchBody([
      { claim: "a", source_url: "https://s.example/p", sourceUrl: "https://s.example/p" },
    ]);
    expect(raw(call)).toBe('{"claims":[{"text":"a","source_url":"https://s.example/p"}]}');
  });

  it("an undefined spelling is absent", async () => {
    const call = await batchBody([
      { claim: "a", source_url: undefined, sourceUrl: "https://s.example/p" },
      { claim: "b", sourceUrl: undefined, webhook_url: "https://h.example/w" },
    ]);
    expect(raw(call)).toBe(
      '{"claims":[{"text":"a","source_url":"https://s.example/p"},' +
        '{"text":"b","source_url":"","webhook_url":"https://h.example/w"}]}',
    );
  });

  it("a value 2.x ignored counts as absent: null, an empty source_url, a blank webhook_url", async () => {
    const call = await batchBody([
      { claim: "a", source_url: null as unknown as string, sourceUrl: "https://s.example/p" },
      { claim: "b", sourceUrl: "", source_url: "https://s.example/q" },
      { claim: "c", webhook_url: "", webhookUrl: "https://h.example/w" },
      { claim: "d", webhookUrl: "  ", webhook_url: "https://h.example/v" },
      { claim: "e", webhookUrl: null as unknown as string, webhook_url: "https://h.example/u" },
      { claim: "f", source_url: "", sourceUrl: null as unknown as string, webhook_url: "" },
    ]);
    expect(raw(call)).toBe(
      '{"claims":[{"text":"a","source_url":"https://s.example/p"},' +
        '{"text":"b","source_url":"https://s.example/q"},' +
        '{"text":"c","source_url":"","webhook_url":"https://h.example/w"},' +
        '{"text":"d","source_url":"","webhook_url":"https://h.example/v"},' +
        '{"text":"e","source_url":"","webhook_url":"https://h.example/u"},' +
        '{"text":"f","source_url":""}]}',
    );
  });

  it("a blank source_url is a value (2.x sent it)", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: BATCH_ACCEPTED }]);
    const err = await new Lenz({ apiKey: "lenz_t", fetch })
      .verifyBatch({ claims: [{ claim: "a", source_url: " ", sourceUrl: "https://s.example/p" }] })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "verifyBatch() claims[0]: sourceUrl and source_url differ; send one of them.",
    );
    expect(calls).toHaveLength(0);
  });

  it("both spellings, different: a plain Error naming both, nothing sent", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: BATCH_ACCEPTED }]);
    const err = await new Lenz({ apiKey: "lenz_t", fetch })
      .verifyBatch({
        claims: [
          { claim: "a" },
          { claim: "b", webhook_url: "https://a.example", webhookUrl: "https://b.example" },
        ],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).constructor).toBe(Error);
    expect((err as Error).message).toBe(
      "verifyBatch() claims[1]: webhookUrl and webhook_url differ; send one of them.",
    );
    expect(calls).toHaveLength(0);
  });

  it("the input is not changed", async () => {
    const item = { claim: "a", sourceUrl: "https://s.example/p" };
    const input = { claims: [item] };
    const before = JSON.stringify(input);
    const { fetch } = makeFetch([{ status: 202, body: BATCH_ACCEPTED }]);
    await new Lenz({ apiKey: "lenz_t", fetch }).verifyBatch(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(input.claims[0]).toBe(item);
  });

  it("verifyBatchAndWait takes the camel names too", async () => {
    const { fetch, calls } = makeFetch([
      { status: 202, body: BATCH_ACCEPTED },
      { body: { status: "completed", result: { verification_id: "v1" } } },
    ]);
    await new Lenz({ apiKey: "lenz_t", fetch }).verifyBatchAndWait({
      claims: [{ claim: "a", sourceUrl: "https://s.example/p", webhookUrl: "https://h.example/w" }],
      idempotencyKey: "frozen-batch",
    });
    expect(key(calls[0]!)).toBe("frozen-batch");
    expect(raw(calls[0]!)).toBe(
      '{"claims":[{"text":"a","source_url":"https://s.example/p","webhook_url":"https://h.example/w"}]}',
    );
  });

  it("no camel name for the per-item idempotency_key", () => {
    // @ts-expect-error: the per-item key has no effect, so it gets no new name.
    const item: VerifyBatchItem = { claim: "a", idempotencyKey: "x" };
    expect(item.claim).toBe("a");
  });
});

// ── citation pairs ───────────────────────────────────────────────────────

describe("citecheck: camelCase pairs send the 2.x bytes", () => {
  const cases: Array<{ name: string; pairs: CitationPair[]; wire: string }> = [
    {
      name: "{citedYear, statement, doi}",
      pairs: [{ citedYear: "2015", statement: "s", doi: "10.1038/nature12373" }],
      wire: '{"pairs":[{"cited_year":"2015","statement":"s","doi":"10.1038/nature12373"}]}',
    },
    {
      name: "{statement, doi, citedYear}",
      pairs: [{ statement: "s", doi: "10.1038/nature12373", citedYear: "2015" }],
      wire: '{"pairs":[{"statement":"s","doi":"10.1038/nature12373","cited_year":"2015"}]}',
    },
    {
      name: "every cited field, interleaved",
      pairs: [
        {
          citedJournal: "Nature",
          statement: "s",
          citedAuthors: ["Kucsko", "Lukin"],
          doi: "10.1038/nature12373",
          citedTitle: "Nanometre-scale thermometry",
          quotes: ["nanometre-scale thermometry in a living cell"],
          citedYear: "2013",
        },
      ],
      wire:
        '{"pairs":[{"cited_journal":"Nature","statement":"s","cited_authors":["Kucsko","Lukin"],' +
        '"doi":"10.1038/nature12373","cited_title":"Nanometre-scale thermometry",' +
        '"quotes":["nanometre-scale thermometry in a living cell"],"cited_year":"2013"}]}',
    },
    {
      name: "a url pair beside a camel doi pair",
      pairs: [
        { url: "https://example.org/boiling", statement: "Water boils at 100 degrees Celsius." },
        { statement: "t", citedTitle: "T", doi: "10.1/x" },
      ],
      wire:
        '{"pairs":[{"url":"https://example.org/boiling","statement":"Water boils at 100 degrees Celsius."},' +
        '{"statement":"t","cited_title":"T","doi":"10.1/x"}]}',
    },
    {
      name: "camel and snake mixed in one pair",
      pairs: [{ statement: "s", cited_title: "T", doi: "10.1/x", citedYear: "2015" }],
      wire: '{"pairs":[{"statement":"s","cited_title":"T","doi":"10.1/x","cited_year":"2015"}]}',
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const call = await pairsBody(c.pairs);
      expect(key(call)).toBe("frozen-cite");
      expect(raw(call)).toBe(c.wire);
    });
  }

  it("both spellings, equal: sent once, where the first one stands", async () => {
    const call = await pairsBody([
      {
        citedAuthors: ["A", "B"],
        statement: "s",
        doi: "10.1/x",
        cited_authors: ["A", "B"],
        cited_year: "2015",
        citedYear: "2015",
      },
    ]);
    expect(raw(call)).toBe(
      '{"pairs":[{"cited_authors":["A","B"],"statement":"s","doi":"10.1/x","cited_year":"2015"}]}',
    );
  });

  it("equality is Object.is, arrays element by element at any depth", async () => {
    const call = await pairsBody([
      {
        statement: "s",
        doi: "10.1/x",
        cited_year: NaN as unknown as string,
        citedYear: NaN as unknown as string,
        cited_authors: [["A"], ["B"]] as unknown as string[],
        citedAuthors: [["A"], ["B"]] as unknown as string[],
      },
    ]);
    expect(raw(call)).toBe(
      '{"pairs":[{"statement":"s","doi":"10.1/x","cited_year":null,"cited_authors":[["A"],["B"]]}]}',
    );
  });

  it("null on a pair is a value (it is sent), not an absence", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: CITECHECK_ACCEPTED }]);
    const err = await new Lenz({ apiKey: "lenz_t", fetch })
      .citecheck({
        pairs: [
          { statement: "s", doi: "d", cited_year: null as unknown as string, citedYear: "2015" },
        ],
      })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "citecheck() pairs[0]: citedYear and cited_year differ; send one of them.",
    );
    expect(calls).toHaveLength(0);
    const sent = await pairsBody([
      { statement: "s", doi: "d", citedYear: null as unknown as string },
    ]);
    expect(raw(sent)).toBe('{"pairs":[{"statement":"s","doi":"d","cited_year":null}]}');
  });

  it("an undefined spelling is absent", async () => {
    const call = await pairsBody([
      { cited_year: undefined, statement: "s", doi: "10.1/x", citedYear: "2015" },
    ]);
    expect(raw(call)).toBe('{"pairs":[{"statement":"s","doi":"10.1/x","cited_year":"2015"}]}');
  });

  it.each([
    [
      { statement: "s", doi: "d", cited_year: "2015", citedYear: "2016" },
      "citedYear and cited_year",
    ],
    [
      { statement: "s", doi: "d", cited_authors: ["A", "B"], citedAuthors: ["B", "A"] },
      "citedAuthors and cited_authors",
    ],
    [
      { statement: "s", doi: "d", cited_authors: ["A"], citedAuthors: ["A", "B"] },
      "citedAuthors and cited_authors",
    ],
    [
      {
        statement: "s",
        doi: "d",
        cited_authors: [["A"]] as unknown as string[],
        citedAuthors: [["B"]] as unknown as string[],
      },
      "citedAuthors and cited_authors",
    ],
    [
      {
        statement: "s",
        doi: "d",
        cited_year: 0 as unknown as string,
        citedYear: -0 as unknown as string,
      },
      "citedYear and cited_year",
    ],
  ] as Array<[CitationPair, string]>)(
    "both spellings, different: a plain Error naming both (%#)",
    async (pair, names) => {
      const { fetch, calls } = makeFetch([{ status: 202, body: CITECHECK_ACCEPTED }]);
      const err = await new Lenz({ apiKey: "lenz_t", fetch })
        .citecheck({ pairs: [{ statement: "ok", url: "https://x.org" }, pair] })
        .catch((e: unknown) => e);
      expect((err as Error).constructor).toBe(Error);
      expect((err as Error).message).toBe(
        `citecheck() pairs[1]: ${names} differ; send one of them.`,
      );
      expect(calls).toHaveLength(0);
    },
  );

  it("the input is not changed", async () => {
    const pair = { statement: "s", doi: "10.1/x", citedAuthors: ["A"] };
    const pairs = [pair];
    const before = JSON.stringify(pairs);
    await pairsBody(pairs);
    expect(JSON.stringify(pairs)).toBe(before);
    expect(pairs[0]).toBe(pair);
    expect(Object.keys(pair)).toEqual(["statement", "doi", "citedAuthors"]);
  });

  it("nothing else gains validation", async () => {
    // A field outside the alias pairs goes as given, as in 2.x.
    const call = await pairsBody([
      { statement: "s", doi: "10.1/x", citedYear: "2015", extra: 1 } as unknown as CitationPair,
    ]);
    expect(raw(call)).toBe(
      '{"pairs":[{"statement":"s","doi":"10.1/x","cited_year":"2015","extra":1}]}',
    );
  });
});
