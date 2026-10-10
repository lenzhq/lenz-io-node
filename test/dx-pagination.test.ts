/**
 * 3.0 pagination iterators (B8): `verifications.listAll` and
 * `library.listAll` walk the pages one request at a time.
 *
 * Contract (the same in the Python SDK's `iter`): the page size is read from
 * each response (no size is sent), the start page is honoured, the walk
 * stops on a short or empty page, `sort: "random"` is refused (its pages are
 * not a partition), and nothing is fetched before it is asked for.
 */

import { describe, expect, it, vi } from "vitest";

import { Lenz, type LibraryItem, type VerificationListItem } from "../src/index.js";

function pages(...bodies: Array<{ ids: string[]; page: number; page_size: number }>) {
  const urls: string[] = [];
  const queue = [...bodies];
  const fetch = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    const next = queue.shift();
    if (!next) throw new Error("fetched past the end");
    return new Response(
      JSON.stringify({
        items: next.ids.map((id) => ({ verification_id: id })),
        total: 99,
        page: next.page,
        page_size: next.page_size,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, urls };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const ids = (rows: Array<{ verification_id?: string }>) => rows.map((r) => r.verification_id);

describe("B8: verifications.listAll", () => {
  it("walks every page and stops on a short one", async () => {
    const { fetch, urls } = pages(
      { ids: ["a", "b"], page: 1, page_size: 2 },
      { ids: ["c", "d"], page: 2, page_size: 2 },
      { ids: ["e"], page: 3, page_size: 2 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const rows: VerificationListItem[] = await collect(client.verifications.listAll());
    expect(ids(rows)).toEqual(["a", "b", "c", "d", "e"]);
    expect(urls.map((u) => new URL(u).searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(urls.every((u) => !new URL(u).searchParams.has("page_size"))).toBe(true);
  });

  it("stops on an empty page", async () => {
    const { fetch, urls } = pages(
      { ids: ["a", "b"], page: 1, page_size: 2 },
      { ids: [], page: 2, page_size: 2 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(ids(await collect(client.verifications.listAll()))).toEqual(["a", "b"]);
    expect(urls).toHaveLength(2);
  });

  it("an empty first page yields nothing", async () => {
    const { fetch, urls } = pages({ ids: [], page: 1, page_size: 20 });
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(await collect(client.verifications.listAll())).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it("starts at the page given", async () => {
    const { fetch, urls } = pages({ ids: ["x"], page: 3, page_size: 2 });
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(ids(await collect(client.verifications.listAll({ page: 3 })))).toEqual(["x"]);
    expect(new URL(urls[0]!).searchParams.get("page")).toBe("3");
  });

  it("reads the page size from each response", async () => {
    const { fetch, urls } = pages(
      { ids: ["a", "b", "c"], page: 1, page_size: 3 },
      { ids: ["d", "e"], page: 2, page_size: 2 },
      { ids: ["f"], page: 3, page_size: 2 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(ids(await collect(client.verifications.listAll()))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(urls).toHaveLength(3);
  });

  it("fetches nothing until asked, and one page at a time", async () => {
    const { fetch, urls } = pages(
      { ids: ["a", "b"], page: 1, page_size: 2 },
      { ids: ["c", "d"], page: 2, page_size: 2 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const iterable = client.verifications.listAll();
    expect(urls).toHaveLength(0);
    for await (const row of iterable) {
      if (row.verification_id === "b") break;
    }
    expect(urls).toHaveLength(1);
  });
});

describe("B8: library.listAll", () => {
  it("forwards the filters on every page", async () => {
    const { fetch, urls } = pages(
      { ids: ["a"], page: 2, page_size: 1 },
      { ids: [], page: 3, page_size: 1 },
    );
    const client = new Lenz({ fetch });
    const rows: LibraryItem[] = await collect(
      client.library.listAll({ page: 2, search: "tower", verdict: "False", sort: "most_true" }),
    );
    expect(ids(rows)).toEqual(["a"]);
    for (const [i, u] of urls.entries()) {
      const q = new URL(u).searchParams;
      expect(q.get("page")).toBe(String(i + 2));
      expect(q.get("search")).toBe("tower");
      expect(q.get("verdict")).toBe("False");
      expect(q.get("sort")).toBe("most_true");
    }
  });

  it("refuses sort: random when called, before any request", () => {
    const { fetch, urls } = pages({ ids: ["a"], page: 1, page_size: 1 });
    const client = new Lenz({ fetch });
    expect(() => client.library.listAll({ sort: "random" })).toThrow(
      'listAll cannot walk sort: "random" (each page is a fresh sample); call library.list instead.',
    );
    expect(urls).toHaveLength(0);
  });
});

describe("S5: listAll stops on every end signal", () => {
  function raw(...bodies: Array<Record<string, unknown>>) {
    const urls: string[] = [];
    const queue = [...bodies];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      const next = queue.shift();
      if (!next) throw new Error("fetched past the end");
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, urls };
  }
  const rows = (...xs: string[]) => xs.map((id) => ({ verification_id: id }));

  it("stops when page * page_size reaches total (a full last page)", async () => {
    const { fetch, urls } = raw(
      { items: rows("a", "b"), total: 4, page: 1, page_size: 2 },
      { items: rows("c", "d"), total: 4, page: 2, page_size: 2 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(ids(await collect(client.verifications.listAll()))).toEqual(["a", "b", "c", "d"]);
    expect(urls).toHaveLength(2);
  });

  it.each([[undefined], [0], [-1], ["20"]])(
    "stops after a page whose page_size is %s",
    async (pageSize) => {
      const { fetch, urls } = raw({
        items: rows("a", "b"),
        total: 99,
        page: 1,
        page_size: pageSize,
      });
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      expect(ids(await collect(client.verifications.listAll()))).toEqual(["a", "b"]);
      expect(urls).toHaveLength(1);
    },
  );

  it("stops, yielding nothing more, when the server answers another page than asked", async () => {
    const { fetch, urls } = raw(
      { items: rows("a", "b"), total: 99, page: 1, page_size: 2 },
      { items: rows("a", "b"), total: 99, page: 1, page_size: 2 },
    );
    const client = new Lenz({ fetch });
    expect(ids(await collect(client.library.listAll()))).toEqual(["a", "b"]);
    expect(urls).toHaveLength(2);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses start page %s when called", (page) => {
    const { fetch, urls } = raw();
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    expect(() => client.verifications.listAll({ page })).toThrow(/page/);
    expect(() => client.library.listAll({ page })).toThrow(/page/);
    expect(urls).toHaveLength(0);
  });
});

describe("pageSize on verifications.list and listAll", () => {
  it("list sends page_size only when it is set", async () => {
    const { fetch, urls } = pages(
      { ids: ["a"], page: 1, page_size: 20 },
      { ids: ["a"], page: 2, page_size: 50 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifications.list();
    await client.verifications.list({ page: 2, pageSize: 50 });
    expect(new URL(urls[0]!).search).toBe("?page=1");
    expect(new URL(urls[1]!).search).toBe("?page=2&page_size=50");
  });

  it("listAll asks every page for the same size and reads the size back", async () => {
    const { fetch, urls } = pages(
      { ids: ["a", "b"], page: 1, page_size: 2 },
      { ids: ["c"], page: 2, page_size: 2 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const rows = await collect(client.verifications.listAll({ pageSize: 2 }));
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expect(urls.map((u) => new URL(u).searchParams.get("page_size"))).toEqual(["2", "2"]);
  });

  it.each([0, 101, -1, 1.5, Number.NaN, "20", null])(
    "refuses pageSize %s before any request",
    async (pageSize) => {
      const { fetch, urls } = pages();
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const bad = pageSize as unknown as number;
      await expect(client.verifications.list({ pageSize: bad })).rejects.toThrow(
        /pageSize must be a whole number from 1 to 100/,
      );
      expect(() => client.verifications.listAll({ pageSize: bad })).toThrow(
        /pageSize must be a whole number from 1 to 100/,
      );
      expect(urls).toHaveLength(0);
    },
  );

  it.each([1, 100])("accepts pageSize %s", async (pageSize) => {
    const { fetch, urls } = pages({ ids: [], page: 1, page_size: pageSize });
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.verifications.list({ pageSize });
    expect(new URL(urls[0]!).searchParams.get("page_size")).toBe(String(pageSize));
  });
});
