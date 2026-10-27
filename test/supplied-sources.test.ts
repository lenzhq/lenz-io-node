/**
 * Unit tests for user-supplied sources in /verify, /verify/batch, /review, and /citecheck.
 */

import { describe, expect, it, vi } from "vitest";

import { Lenz } from "../src/index.js";
import type {
  Evidence,
  Source,
  SuppliedSource,
  VerifyOptions,
  VerifyBatchOptions,
  BatchClaimItem,
  ReviewOptions,
  CitecheckOptions,
  CitecheckPairInput,
  AssessInput,
} from "../src/index.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const queue = [...responses];
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
  return { fn: impl, calls };
}

describe("supplied_sources", () => {
  describe("types and aliases export parity", () => {
    it("exports type aliases correctly", () => {
      const verifyOpts: VerifyOptions = { claim: "test", depth: "low" };
      const batchClaim: BatchClaimItem = { claim: "test" };
      const batchOpts: VerifyBatchOptions = { claims: [batchClaim] };
      const reviewOpts: ReviewOptions = { text: "test draft" };
      const citecheckOpts: CitecheckOptions = { text: "test draft" };
      const pairInput: CitecheckPairInput = { statement: "test", url: "https://example.com" };
      const assessOpts: AssessInput = { claim: "test" };

      expect(verifyOpts.claim).toBe("test");
      expect(batchOpts.claims).toHaveLength(1);
      expect(reviewOpts.text).toBe("test draft");
      expect(citecheckOpts.text).toBe("test draft");
      expect(pairInput.statement).toBe("test");
      expect(assessOpts.claim).toBe("test");
    });

    it("supports Evidence and Source with origin property", () => {
      const source: Source = {
        title: "Test",
        origin: "supplied",
      };
      const evidence: Evidence = {
        title: "Test Evidence",
        origin: "web",
      };
      expect(source.origin).toBe("supplied");
      expect(evidence.origin).toBe("web");
    });
  });

  describe("verify() wire formatting", () => {
    it("omits supplied_sources when undefined", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        { status: 202, body: { task_id: "tsk_1", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.verify({ claim: "The sky is blue." });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body).toEqual({ text: "The sky is blue." });
      expect(body.supplied_sources).toBeUndefined();
    });

    it("forwards supplied_sources with camelCase publishedDate normalized", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        { status: 202, body: { task_id: "tsk_1", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      const sources: SuppliedSource[] = [
        {
          text: "Document full text content.",
          url: "https://example.com/doc",
          title: "Doc Title",
          publishedDate: "2026-01-15",
        },
      ];
      await client.verify({
        claim: "The sky is blue.",
        suppliedSources: sources,
      });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.supplied_sources).toEqual([
        {
          text: "Document full text content.",
          url: "https://example.com/doc",
          title: "Doc Title",
          published_date: "2026-01-15",
        },
      ]);
    });

    it("forwards supplied_sources in snake_case intact", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        { status: 202, body: { task_id: "tsk_1", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.verify({
        claim: "The sky is blue.",
        supplied_sources: [
          {
            text: "Document full text content.",
            doi: "10.1038/s41586-020-2649-2",
            published_date: "2026-02-20",
          },
        ],
      });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.supplied_sources).toEqual([
        {
          text: "Document full text content.",
          doi: "10.1038/s41586-020-2649-2",
          published_date: "2026-02-20",
        },
      ]);
    });
  });

  describe("verifyBatch() wire formatting", () => {
    it("omits supplied_sources when undefined", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        {
          status: 202,
          body: {
            batch_id: "bth_1",
            status: "queued",
            claims: [{ task_id: "tsk_1", status: "queued", claim: "Claim 1" }],
          },
        },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.verifyBatch({
        claims: [{ claim: "Claim 1" }],
      });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body).toEqual({
        claims: [{ text: "Claim 1" }],
      });
      expect(body.supplied_sources).toBeUndefined();
    });

    it("forwards batch-level and item-level supplied_sources", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        {
          status: 202,
          body: {
            batch_id: "bth_1",
            status: "queued",
            claims: [
              { task_id: "tsk_1", status: "queued", claim: "Claim 1" },
              { task_id: "tsk_2", status: "queued", claim: "Claim 2" },
            ],
          },
        },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.verifyBatch({
        claims: [
          {
            claim: "Claim 1",
            suppliedSources: [{ text: "Item source 1", publishedDate: "2026-03-01" }],
          },
          {
            claim: "Claim 2",
            supplied_sources: [{ text: "Item source 2", cite: "42 U.S.C. § 1983" }],
          },
        ],
        suppliedSources: [{ text: "Batch source", url: "https://example.com/batch" }],
      });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.supplied_sources).toEqual([
        { text: "Batch source", url: "https://example.com/batch" },
      ]);
      expect(body.claims).toEqual([
        {
          text: "Claim 1",
          supplied_sources: [{ text: "Item source 1", published_date: "2026-03-01" }],
        },
        {
          text: "Claim 2",
          supplied_sources: [{ text: "Item source 2", cite: "42 U.S.C. § 1983" }],
        },
      ]);
    });

    it("rejects conflicting batch-item suppliedSources aliases and reports exact param path", async () => {
      const { fn: fetchFn } = makeFetch([]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await expect(
        client.verifyBatch({
          claims: [
            {
              claim: "Claim 1",
              suppliedSources: [{ text: "A" }],
              supplied_sources: null as unknown as undefined,
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "conflicting_input",
        param: "claims[0]",
      });

      await expect(
        client.verifyBatch({
          claims: [
            {
              claim: "Claim 1",
              suppliedSources: [
                {
                  text: "A",
                  publishedDate: "2026-01-01",
                  published_date: "2026-01-02",
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "conflicting_input",
        param: "claims[0].suppliedSources[0]",
      });
    });
  });

  describe("review() wire formatting", () => {
    it("omits supplied_sources when undefined", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        { status: 202, body: { review_id: "rev_1", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.review({ text: "Review draft text." });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.supplied_sources).toBeUndefined();
    });

    it("forwards supplied_sources with camelCase publishedDate normalized", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        { status: 202, body: { review_id: "rev_1", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.review({
        text: "Review draft text.",
        suppliedSources: [
          {
            text: "Supplied review reference.",
            title: "Policy Memo",
            publishedDate: "2026-04-10",
          },
        ],
      });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.supplied_sources).toEqual([
        {
          text: "Supplied review reference.",
          title: "Policy Memo",
          published_date: "2026-04-10",
        },
      ]);
    });
  });

  describe("citecheck() wire formatting", () => {
    it("omits supplied_sources when undefined", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        { status: 202, body: { citecheck_id: "chk_1", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.citecheck({ text: "Draft [1] citation." });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.supplied_sources).toBeUndefined();
    });

    it("forwards top-level supplied_sources with text input", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        { status: 202, body: { citecheck_id: "chk_1", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.citecheck({
        text: "Draft [1] citation.",
        suppliedSources: [
          {
            text: "Full document source text.",
            url: "https://example.com/paper",
          },
        ],
      });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.supplied_sources).toEqual([
        {
          text: "Full document source text.",
          url: "https://example.com/paper",
        },
      ]);
    });

    it("forwards pair source_text and published_date including camelCase aliases", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        { status: 202, body: { citecheck_id: "chk_1", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.citecheck({
        pairs: [
          {
            statement: "Statement 1",
            url: "https://example.com/one",
            sourceText: "Direct source text for pair 1",
            publishedDate: "2026-05-01",
          },
          {
            statement: "Statement 2",
            source_text: "Direct source text alone without url/doi",
            published_date: "2026-05-02",
          },
        ],
      });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.pairs).toEqual([
        {
          statement: "Statement 1",
          url: "https://example.com/one",
          source_text: "Direct source text for pair 1",
          published_date: "2026-05-01",
        },
        {
          statement: "Statement 2",
          source_text: "Direct source text alone without url/doi",
          published_date: "2026-05-02",
        },
      ]);
    });

    it("throws if pair gives conflicting camelCase and snake_case aliases", async () => {
      const client = new Lenz({ apiKey: "lenz_test" });
      await expect(
        client.citecheck({
          pairs: [
            {
              statement: "Conflict",
              sourceText: "text A",
              source_text: "text B",
            },
          ],
        }),
      ).rejects.toThrow(/sourceText and source_text differ/);
    });

    it("throws if top-level suppliedSources and supplied_sources conflict", async () => {
      const client = new Lenz({ apiKey: "lenz_test" });
      await expect(
        client.verify({
          claim: "Claim",
          suppliedSources: [{ text: "A" }],
          supplied_sources: [{ text: "B" }],
        }),
      ).rejects.toThrow(/suppliedSources and supplied_sources differ/);
    });

    it("accepts identical suppliedSources and supplied_sources with distinct object references", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        { status: 202, body: { task_id: "tsk_1", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.verify({
        claim: "Claim",
        suppliedSources: [{ text: "A", publishedDate: "2026-01-01" }],
        supplied_sources: [{ text: "A", published_date: "2026-01-01" }],
      });
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.supplied_sources).toEqual([{ text: "A", published_date: "2026-01-01" }]);
    });

    it("throws if a supplied source item gives conflicting publishedDate and published_date", async () => {
      const client = new Lenz({ apiKey: "lenz_test" });
      await expect(
        client.verify({
          claim: "Claim",
          suppliedSources: [
            {
              text: "A",
              publishedDate: "2026-01-01",
              published_date: "2026-01-02",
            },
          ],
        }),
      ).rejects.toThrow(/publishedDate and published_date differ/);
    });
  });

  describe("passthrough of non-object / array items in normalizer", () => {
    it("handles primitives or empty arrays gracefully", async () => {
      const { fn: fetchFn, calls } = makeFetch([
        { status: 202, body: { task_id: "tsk_1", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_test", fetch: fetchFn as unknown as typeof fetch });
      await client.verify({
        claim: "Test",
        supplied_sources: [] as unknown as SuppliedSource[],
      });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.supplied_sources).toEqual([]);
    });
  });
});
