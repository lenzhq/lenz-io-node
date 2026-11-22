import { describe, expect, it, vi } from "vitest";

import {
  Lenz,
  LenzAbortError,
  LenzValidationError,
  type ListReviewsOptions,
  type ReviewList,
  type ReviewListItem,
} from "../src/index.js";
import { normalizeReviewListItem } from "../src/compat.js";
import { normalizeReviewList, withReviewListItemDefaults } from "../src/reviewDefaults.js";

function makeReviewItem(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    review_id: id,
    status: "completed",
    outcome: "issues_found",
    created_at: "2026-09-25T19:00:39.962779Z",
    completed_at: "2026-09-25T19:01:57.678147Z",
    language: "en",
    policy: {
      verdicts: ["False", "Mostly False"],
      confidence: ["low"],
      max_assessments: 20,
      max_verifications: 2,
      depth: "low",
    },
    summary: {
      claims_selected: 4,
      claim_limit: 20,
      claim_limit_reached: false,
      input_truncated: false,
      assessments: { completed: 4, failed: 0 },
      verifications: { planned: 2, completed: 2, failed: 0 },
      issues: 2,
    },
    credits: { charged: 14 },
    failure: null,
    ...overrides,
  };
}

function mockFetchPages(
  ...pagesData: Array<{
    items: Array<Record<string, unknown>>;
    page: number;
    page_size: number;
    total?: number;
  }>
) {
  const urls: string[] = [];
  const headersList: Array<Headers> = [];
  const queue = [...pagesData];

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    headersList.push(new Headers(init?.headers));
    const next = queue.shift();
    if (!next) throw new Error("Fetched past the end of mocked responses");
    const body: ReviewList = {
      items: next.items as unknown as ReviewListItem[],
      total: next.total ?? 99,
      page: next.page,
      page_size: next.page_size,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": `req-${next.page}`,
        "x-lenz-api-version": "2026-10-11",
      },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, urls, headersList };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const reviewIds = (rows: ReviewListItem[]) => rows.map((r) => r.review_id);

describe("listReviews()", () => {
  it("queries GET /reviews?page=1 by default", async () => {
    const item1 = makeReviewItem("rev_1");
    const { fetch, urls } = mockFetchPages({ items: [item1], page: 1, page_size: 20, total: 1 });
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const res = await client.listReviews();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.review_id).toBe("rev_1");
    expect(res.total).toBe(1);
    expect(res.page).toBe(1);
    expect(res.page_size).toBe(20);

    expect(urls).toHaveLength(1);
    const parsedUrl = new URL(urls[0]!);
    expect(parsedUrl.pathname).toBe("/api/v1/reviews");
    expect(parsedUrl.search).toBe("?page=1");
  });

  it("sends explicit page and pageSize as query parameters", async () => {
    const item1 = makeReviewItem("rev_a");
    const { fetch, urls } = mockFetchPages({ items: [item1], page: 2, page_size: 50, total: 100 });
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const res = await client.listReviews({ page: 2, pageSize: 50 });
    expect(res.items[0]!.review_id).toBe("rev_a");
    expect(urls).toHaveLength(1);
    const parsedUrl = new URL(urls[0]!);
    expect(parsedUrl.search).toBe("?page=2&page_size=50");
  });

  it("eagerly refuses invalid pageSize before making any request", async () => {
    const { fetch, urls } = mockFetchPages();
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    for (const bad of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = client.listReviews({ pageSize: bad });
      await expect(p).rejects.toBeInstanceOf(LenzValidationError);
      const err = await p.catch((e) => e);
      expect(err.code).toBe("invalid_page_size");
      expect(err.param).toBe("pageSize");
    }

    await expect(client.listReviews({ pageSize: "20" as unknown as number })).rejects.toMatchObject(
      { code: "invalid_page_size", param: "pageSize" },
    );

    expect(urls).toHaveLength(0);
  });

  it("eagerly refuses options that are not an object", async () => {
    const { fetch, urls } = mockFetchPages();
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    for (const bad of [null, "str", 42, [1, 2]]) {
      const p = client.listReviews(bad as unknown as ListReviewsOptions);
      await expect(p).rejects.toBeInstanceOf(LenzValidationError);
      const err = await p.catch((e) => e);
      expect(err.code).toBe("invalid_option");
      expect(err.param).toBe("options");
    }

    expect(urls).toHaveLength(0);
  });

  it("preserves response metadata (.raw, .httpStatus, .headers) and item .raw", async () => {
    const item1 = makeReviewItem("rev_raw");
    const { fetch } = mockFetchPages({ items: [item1], page: 1, page_size: 20, total: 1 });
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const res = await client.listReviews();
    expect(res.httpStatus).toBe(200);
    expect(res.headers["x-request-id"]).toBe("req-1");
    const expectedBody = {
      items: [item1],
      total: 1,
      page: 1,
      page_size: 20,
    };
    expect(res.raw).toEqual(expectedBody);

    const row = res.items[0]!;
    expect(row.raw).toEqual(item1);
  });

  it("client with legacyAliases: false returns items with raw server shape and .raw intact", async () => {
    const rawItem = {
      review_id: "rev_raw_shape",
      status: "completed",
      summary: {
        claims_selected: 2,
        claim_limit: 5,
        claim_limit_reached: true,
      },
      policy: {
        max_assessments: 10,
      },
    };
    const { fetch } = mockFetchPages({ items: [rawItem], page: 1, page_size: 20, total: 1 });
    const client = new Lenz({ apiKey: "lenz_test", legacyAliases: false, fetch });

    const res = await client.listReviews();
    expect(res.httpStatus).toBe(200);
    expect(res.raw).toEqual({
      items: [rawItem],
      total: 1,
      page: 1,
      page_size: 20,
    });
    const item = res.items[0]!;
    expect(item.raw).toEqual(rawItem);
    const summary = item.summary as unknown as Record<string, unknown>;
    expect(summary["citations_found"]).toBeUndefined();
    expect(summary["citation_issues"]).toBeUndefined();
    const policy = item.policy as unknown as Record<string, unknown>;
    expect(policy["max_citations"]).toBeUndefined();
    expect(policy["suggest_edits"]).toBeUndefined();
  });
});

describe("listAllReviews()", () => {
  it("walks every page and stops on a short page", async () => {
    const { fetch, urls } = mockFetchPages(
      { items: [makeReviewItem("r1"), makeReviewItem("r2")], page: 1, page_size: 2 },
      { items: [makeReviewItem("r3"), makeReviewItem("r4")], page: 2, page_size: 2 },
      { items: [makeReviewItem("r5")], page: 3, page_size: 2 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const rows = await collect(client.listAllReviews());
    expect(reviewIds(rows)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(urls.map((u) => new URL(u).searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(urls.every((u) => !new URL(u).searchParams.has("page_size"))).toBe(true);
  });

  it("stops on an empty page", async () => {
    const { fetch, urls } = mockFetchPages(
      { items: [makeReviewItem("r1"), makeReviewItem("r2")], page: 1, page_size: 2 },
      { items: [], page: 2, page_size: 2 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const rows = await collect(client.listAllReviews());
    expect(reviewIds(rows)).toEqual(["r1", "r2"]);
    expect(urls).toHaveLength(2);
  });

  it("stops when page * page_size >= total", async () => {
    const { fetch, urls } = mockFetchPages(
      { items: [makeReviewItem("r1"), makeReviewItem("r2")], page: 1, page_size: 2, total: 4 },
      { items: [makeReviewItem("r3"), makeReviewItem("r4")], page: 2, page_size: 2, total: 4 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const rows = await collect(client.listAllReviews());
    expect(reviewIds(rows)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(urls).toHaveLength(2);
  });

  it("starts at the page given", async () => {
    const { fetch, urls } = mockFetchPages({
      items: [makeReviewItem("r99")],
      page: 5,
      page_size: 2,
    });
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const rows = await collect(client.listAllReviews({ page: 5 }));
    expect(reviewIds(rows)).toEqual(["r99"]);
    expect(new URL(urls[0]!).searchParams.get("page")).toBe("5");
  });

  it("passes explicit pageSize to every request", async () => {
    const { fetch, urls } = mockFetchPages(
      { items: [makeReviewItem("r1"), makeReviewItem("r2")], page: 1, page_size: 2 },
      { items: [makeReviewItem("r3")], page: 2, page_size: 2 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const rows = await collect(client.listAllReviews({ pageSize: 2 }));
    expect(reviewIds(rows)).toEqual(["r1", "r2", "r3"]);
    expect(new URL(urls[0]!).searchParams.get("page_size")).toBe("2");
    expect(new URL(urls[1]!).searchParams.get("page_size")).toBe("2");
  });

  it("eagerly refuses invalid start page when called", () => {
    const { fetch, urls } = mockFetchPages();
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => client.listAllReviews({ page: bad })).toThrowError(
        /listAllReviews needs a whole start page of 1 or more/,
      );
      try {
        client.listAllReviews({ page: bad });
      } catch (err: unknown) {
        expect((err as LenzValidationError).code).toBe("invalid_page");
        expect((err as LenzValidationError).param).toBe("page");
      }
    }

    expect(urls).toHaveLength(0);
  });

  it("eagerly refuses invalid pageSize when called", () => {
    const { fetch, urls } = mockFetchPages();
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    for (const bad of [0, -1, 101, 1.5, Number.NaN]) {
      expect(() => client.listAllReviews({ pageSize: bad })).toThrowError(LenzValidationError);
      try {
        client.listAllReviews({ pageSize: bad });
      } catch (err: unknown) {
        expect((err as LenzValidationError).code).toBe("invalid_page_size");
        expect((err as LenzValidationError).param).toBe("pageSize");
      }
    }

    expect(urls).toHaveLength(0);
  });

  it("stops and throws LenzAbortError when signal is already aborted", async () => {
    const { fetch, urls } = mockFetchPages({
      items: [makeReviewItem("r1")],
      page: 1,
      page_size: 2,
    });
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const it = client.listAllReviews({ signal: AbortSignal.abort() });
    await expect(collect(it)).rejects.toBeInstanceOf(LenzAbortError);
    expect(urls).toHaveLength(0);
  });

  it("stops and throws LenzAbortError when signal fires during iteration", async () => {
    const controller = new AbortController();
    const { fetch, urls } = mockFetchPages(
      { items: [makeReviewItem("r1"), makeReviewItem("r2")], page: 1, page_size: 2 },
      { items: [makeReviewItem("r3"), makeReviewItem("r4")], page: 2, page_size: 2 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const it = client.listAllReviews({ signal: controller.signal });
    const out: ReviewListItem[] = [];
    await expect(async () => {
      for await (const row of it) {
        out.push(row);
        controller.abort();
      }
    }).rejects.toBeInstanceOf(LenzAbortError);

    expect(out).toHaveLength(1);
    expect(out[0]!.review_id).toBe("r1");
    expect(urls).toHaveLength(1);
  });

  it("propagates withOptions headers to listReviews and listAllReviews", async () => {
    const { fetch, headersList } = mockFetchPages(
      { items: [makeReviewItem("r1")], page: 1, page_size: 20 },
      { items: [makeReviewItem("r2")], page: 1, page_size: 20 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const scoped = client.withOptions({ headers: { "X-Custom-Scope": "unit-test" } });

    await scoped.listReviews();
    expect(headersList[0]!.get("x-custom-scope")).toBe("unit-test");

    await collect(scoped.listAllReviews());
    expect(headersList[1]!.get("x-custom-scope")).toBe("unit-test");
  });

  it("preserves item .raw during listAllReviews iteration", async () => {
    const item1 = makeReviewItem("r1");
    const { fetch } = mockFetchPages({ items: [item1], page: 1, page_size: 20 });
    const client = new Lenz({ apiKey: "lenz_t", fetch });

    const rows = await collect(client.listAllReviews());
    expect(rows[0]!.raw).toEqual(item1);
  });
});

describe("Review list item normalization & defaults", () => {
  it("normalizes a canonical 2026-10-11 item without injecting citations/more_*", () => {
    const rawItem = {
      review_id: "rev_canonical",
      status: "completed",
      outcome: "issues_found",
      created_at: "2026-09-25T19:00:39.962779Z",
      completed_at: "2026-09-25T19:01:57.678147Z",
      language: "en",
      policy: {
        verdicts: ["False"],
        confidence: ["low"],
      },
      summary: {
        claims_found: 25,
        claims_selected: 20,
        claim_limit: 20,
        claim_limit_exceeded: true,
        citation_limit_exceeded: false,
      },
      credits: { charged: 5 },
      failure: {
        code: "no_checkable_claim",
        detail: "No checkable statement.",
        hint: null,
        failure_class: "invalid_input",
        retryable: false,
        docs_url: "https://lenz.io/docs/errors",
      },
    };

    const normalized = withReviewListItemDefaults(rawItem, true) as Record<string, unknown>;

    // Top-level must NOT have citations, citation_issues, citation_failures, or more_*
    expect(normalized["citations"]).toBeUndefined();
    expect(normalized["citation_issues"]).toBeUndefined();
    expect(normalized["citation_failures"]).toBeUndefined();
    expect(normalized["more_claims"]).toBeUndefined();
    expect(normalized["more_claim_locations"]).toBeUndefined();
    expect(normalized["more_citations"]).toBeUndefined();

    // Summary has citation defaults filled and limit flags normalized
    const s = normalized["summary"] as Record<string, unknown>;
    expect(s["claims_found"]).toBe(25);
    expect(s["claim_limit_reached"]).toBe(true);
    expect(s["citation_limit_reached"]).toBe(false);
    expect(s["citations_found"]).toBeNull();
    expect(s["citations_selected"]).toBeNull();
    expect(s["citation_limit"]).toBeNull();
    expect(s["citation_checks"]).toBeNull();
    expect(s["citations_skipped"]).toBeNull();
    expect(s["citation_issues"]).toBe(0);

    // Policy has citation / edit defaults filled
    const p = normalized["policy"] as Record<string, unknown>;
    expect(p["max_citations"]).toBeNull();
    expect(p["suggest_edits"]).toBe(false);

    // Failure block carries legacy failure_reason alias
    const f = normalized["failure"] as Record<string, unknown>;
    expect(f["code"]).toBe("no_checkable_claim");
    expect(f["failure_reason"]).toBe("no_claim");
  });

  it("normalizes a legacy 2026-05-13 item where more_claims absence keeps claims_found null", () => {
    const rawLegacyItem = {
      review_id: "rev_legacy",
      status: "completed",
      outcome: "clean",
      created_at: "2026-05-15T12:00:00Z",
      completed_at: "2026-05-15T12:01:00Z",
      language: "en",
      policy: {
        verdicts: ["False", "Mostly False"],
      },
      summary: {
        claims_selected: 5,
        claim_limit: 10,
        claim_limit_reached: true,
      },
      credits: { charged: 10 },
      failure: {
        failure_reason: "no_claim",
        failure_class: "invalid_input",
        detail: "Input had no claim.",
      },
    };

    const normalized = withReviewListItemDefaults(rawLegacyItem, true) as Record<string, unknown>;

    const s = normalized["summary"] as Record<string, unknown>;
    // When more_claims is absent on a list item, claims_found stays null
    expect(s["claims_found"]).toBeNull();
    // claim_limit_reached: true fills claim_limit_exceeded: null (since counted is false)
    expect(s["claim_limit_reached"]).toBe(true);
    expect(s["claim_limit_exceeded"]).toBeNull();
    expect(s["citation_issues"]).toBe(0);

    // Failure block normalizes failure_reason -> code
    const f = normalized["failure"] as Record<string, unknown>;
    expect(f["code"]).toBe("no_checkable_claim");
    expect(f["failure_reason"]).toBe("no_claim");

    // No extra lists injected
    expect(normalized["citations"]).toBeUndefined();
    expect(normalized["citation_issues"]).toBeUndefined();
    expect(normalized["more_claims"]).toBeUndefined();
  });

  it("normalizeReviewListItem does not mutate input and normalizes failure and summary", () => {
    const item = {
      summary: {
        claims_selected: 2,
        claim_limit: 5,
        claim_limit_reached: false,
      },
      failure: {
        code: "no_checkable_claim",
        failure_class: "invalid_input",
      },
    };
    const out = normalizeReviewListItem(item) as Record<string, unknown>;
    expect(out).not.toBe(item);
    expect((out["failure"] as Record<string, unknown>)["failure_reason"]).toBe("no_claim");
    expect((out["summary"] as Record<string, unknown>)["claims_found"]).toBeNull();
  });

  it("normalizeReviewList maps items and returns body as sent when legacyAliases: false", () => {
    const rawItem = {
      review_id: "rev_plain",
      summary: { claims_selected: 1 },
      policy: {},
    };
    const body = {
      items: [rawItem],
      total: 1,
      page: 1,
      page_size: 20,
    };

    const aliasedOut = normalizeReviewList(body, true) as ReviewList;
    expect(aliasedOut.items[0]!.summary.citations_found).toBeNull();
    expect(aliasedOut.items[0]!.policy.suggest_edits).toBe(false);

    const plainOut = normalizeReviewList(body, false) as ReviewList;
    expect(
      (plainOut.items[0]!.summary as unknown as Record<string, unknown>)["citations_found"],
    ).toBeUndefined();
    expect(
      (plainOut.items[0]!.policy as unknown as Record<string, unknown>)["suggest_edits"],
    ).toBeUndefined();
  });
});
