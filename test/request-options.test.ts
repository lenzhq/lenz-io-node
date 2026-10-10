/**
 * Per-call request options (`signal`, `timeoutMs`, `maxRetries`, `headers`)
 * and `withOptions()`: what reaches the wire, precedence, validation, header
 * merging and the copy. Aborts are in `abort.test.ts`.
 *
 * The table below is the Node half of the per-method parity map: every
 * public method, the option names it takes and its Python name. The Python
 * SDK keeps the same table; the two are compared entry by entry.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Lenz,
  LenzAbortError,
  LenzRequestTimeoutError,
  type RequestOptions,
  type TaskStatus,
  LenzValidationError,
} from "../src/index.js";
import { header, recorder, settle, wire, type Reply, type Sent } from "./support/recorder.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(HERE, "fixtures", "contract", name), "utf-8")) as Record<
    string,
    unknown
  >;

const TASK = { task_id: "t1", status: "queued" };
const BATCH = {
  batch_id: "b1",
  items: [
    { task_id: "t1", claim: "a" },
    { task_id: "t2", claim: "b" },
  ],
};
const PROCESSING = { status: "processing", progress: { step: "research" } };
const COMPLETED = {
  status: "completed",
  result: { verification_id: "v1", verdict: { label: "True", score: 9, confidence: "high" } },
};
const REVIEW_ACCEPTED = fixture("review_accepted.json");
const REVIEW_ID = String(REVIEW_ACCEPTED["review_id"]);
const REVIEW_VERIFYING = fixture("review_verifying.json");
const REVIEW_COMPLETED = fixture("review_completed.json");
const CITECHECK_ACCEPTED = fixture("citecheck_accepted.json");
const CITECHECK_ID = String(CITECHECK_ACCEPTED["citecheck_id"]);
const CITECHECK_COMPLETED = fixture("citecheck_completed.json");
const LIST = (page: number, n: number, total: number) => ({
  items: Array.from({ length: n }, (_, i) => ({ verification_id: `v${page}${i}` })),
  total,
  page,
  page_size: 2,
});

/** Which request options a method takes (its row in the parity map). */
type Takes = "all" | "wait" | "submitWait";

const ALL = ["signal", "timeoutMs", "maxRetries", "headers"] as const;
const OPTION_NAMES: Record<Takes, readonly string[]> = {
  all: ALL,
  // `timeoutMs` there is the wait's budget, an existing name; no retries.
  wait: ["signal", "headers"],
  // `maxRetries` is the submit's.
  submitWait: ["signal", "maxRetries", "headers"],
};

interface Method {
  /** The Node name. */
  name: string;
  /** The Python name. */
  python: string;
  takes: Takes;
  replies: Reply[];
  /** Runs the method; `o` goes where the method takes its request options. */
  run: (c: Lenz, o?: RequestOptions) => Promise<unknown>;
}

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/** Every public method that makes a request, with one call form each. */
const METHODS: Method[] = [
  {
    name: "verify",
    python: "verify",
    takes: "all",
    replies: [{ status: 202, body: TASK }],
    run: (c, o) => c.verify({ claim: "a" }, o),
  },
  {
    name: "verifyBatch",
    python: "verify_batch",
    takes: "all",
    replies: [{ status: 202, body: BATCH }],
    run: (c, o) => c.verifyBatch({ claims: [{ claim: "a" }], idempotencyKey: "k-b" }, o),
  },
  {
    name: "extract",
    python: "extract",
    takes: "all",
    replies: [{ body: { claims: [], status: "not_a_claim" } }],
    run: (c, o) => c.extract({ text: "x", focus: "f" }, o),
  },
  {
    name: "assess",
    python: "assess",
    takes: "all",
    replies: [{ body: { claims: [] } }],
    run: (c, o) => c.assess({ claims: ["a", "b"], idempotencyKey: "k-a" }, o),
  },
  {
    name: "select",
    python: "select",
    takes: "all",
    replies: [{ status: 202, body: BATCH }],
    run: (c, o) => c.select("t0", { claims: ["a"] }, o),
  },
  {
    name: "getStatus",
    python: "get_status",
    takes: "all",
    replies: [{ body: PROCESSING }],
    run: (c, o) => c.getStatus("t1", o),
  },
  {
    name: "cancel",
    python: "cancel",
    takes: "all",
    replies: [{ body: { task_id: "t1", cancelled: true, status: "cancelled" } }],
    run: (c, o) => c.cancel("t1", o),
  },
  {
    name: "usage",
    python: "usage",
    takes: "all",
    replies: [{ body: fixture("usage.json") }],
    run: (c, o) => c.usage(o),
  },
  {
    name: "review",
    python: "review",
    takes: "all",
    replies: [{ status: 202, body: REVIEW_ACCEPTED }],
    run: (c, o) => c.review({ text: "draft", maxCitations: 2 }, o),
  },
  {
    name: "getReview",
    python: "get_review",
    takes: "all",
    replies: [{ body: fixture("review_completed_issues.json") }],
    run: (c, o) => c.getReview(REVIEW_ID, { view: "issues", ...o }),
  },
  {
    name: "cancelReview",
    python: "cancel_review",
    takes: "all",
    replies: [{ body: REVIEW_COMPLETED }],
    run: (c, o) => c.cancelReview(REVIEW_ID, o),
  },
  {
    name: "citecheck",
    python: "citecheck",
    takes: "all",
    replies: [{ status: 202, body: CITECHECK_ACCEPTED }],
    run: (c, o) => c.citecheck({ pairs: [{ statement: "s", doi: "10.1/x" }] }, o),
  },
  {
    name: "getCitecheck",
    python: "get_citecheck",
    takes: "all",
    replies: [{ body: CITECHECK_COMPLETED }],
    run: (c, o) => c.getCitecheck(CITECHECK_ID, o),
  },
  {
    name: "cancelCitecheck",
    python: "cancel_citecheck",
    takes: "all",
    replies: [{ body: CITECHECK_COMPLETED }],
    run: (c, o) => c.cancelCitecheck(CITECHECK_ID, o),
  },
  {
    name: "verifications.list",
    python: "verifications.list",
    takes: "all",
    replies: [{ body: LIST(3, 1, 5) }],
    run: (c, o) => c.verifications.list({ page: 3, ...o }),
  },
  {
    name: "verifications.listAll",
    python: "verifications.iter",
    takes: "all",
    replies: [{ body: LIST(2, 2, 6) }, { body: LIST(3, 1, 6) }],
    run: (c, o) => drain(c.verifications.listAll({ page: 2, ...o })),
  },
  {
    name: "verifications.get",
    python: "verifications.get",
    takes: "all",
    replies: [{ body: fixture("verifications_detail.json") }],
    run: (c, o) => c.verifications.get("v1", o),
  },
  {
    name: "verifications.getCertificate",
    python: "verifications.get_certificate",
    takes: "all",
    replies: [{ body: fixture("certificate.json") }],
    run: (c, o) => c.verifications.getCertificate("v1", o),
  },
  {
    name: "verifications.delete",
    python: "verifications.delete",
    takes: "all",
    replies: [{ status: 200, body: { ok: true } }],
    run: (c, o) => c.verifications.delete("v1", o),
  },
  {
    name: "verifications.related",
    python: "verifications.related",
    takes: "all",
    replies: [{ body: { items: [] } }],
    run: (c, o) => c.verifications.related("v1", { limit: 3, ...o }),
  },
  {
    name: "ask.history",
    python: "ask.history",
    takes: "all",
    replies: [{ body: { messages: [] } }],
    run: (c, o) => c.ask.history("v1", o),
  },
  {
    name: "ask.send",
    python: "ask.send",
    takes: "all",
    replies: [{ body: { content: "x" } }],
    run: (c, o) => c.ask.send("v1", { message: "why?" }, o),
  },
  {
    name: "ask.reset",
    python: "ask.reset",
    takes: "all",
    replies: [{ status: 200, body: { ok: true } }],
    run: (c, o) => c.ask.reset("v1", o),
  },
  {
    name: "library.list",
    python: "library.list",
    takes: "all",
    replies: [{ body: LIST(2, 1, 1) }],
    run: (c, o) => c.library.list({ page: 2, search: "s", curated: ["x"] }, o),
  },
  {
    name: "library.listAll",
    python: "library.iter",
    takes: "all",
    replies: [{ body: LIST(1, 2, 3) }, { body: LIST(2, 1, 3) }],
    run: (c, o) => drain(c.library.listAll({ search: "s" }, o)),
  },
  {
    name: "wait",
    python: "wait",
    takes: "wait",
    replies: [{ body: PROCESSING }, { body: COMPLETED }],
    run: (c, o) => c.wait("t1", { timeoutMs: 60_000, ...o }),
  },
  {
    name: "verifyAndWait",
    python: "verify_and_wait",
    takes: "submitWait",
    replies: [{ status: 202, body: TASK }, { body: PROCESSING }, { body: COMPLETED }],
    run: (c, o) => c.verifyAndWait({ claim: "a" }, { timeoutMs: 60_000, ...o }),
  },
  {
    name: "verifyBatchAndWait",
    python: "verify_batch_and_wait",
    takes: "submitWait",
    replies: [
      { status: 202, body: BATCH },
      { body: PROCESSING },
      { body: COMPLETED },
      { body: COMPLETED },
    ],
    run: (c, o) => c.verifyBatchAndWait({ claims: [{ claim: "a" }, { claim: "b" }] }, { ...o }),
  },
  {
    name: "reviewAndWait",
    python: "review_and_wait",
    takes: "submitWait",
    replies: [
      { status: 202, body: REVIEW_ACCEPTED },
      { body: { ...REVIEW_VERIFYING, poll_after_seconds: 5 } },
      { body: REVIEW_COMPLETED },
    ],
    run: (c, o) => c.reviewAndWait({ text: "draft", idempotencyKey: "k-r" }, { ...o }),
  },
  {
    name: "citecheckAndWait",
    python: "citecheck_and_wait",
    takes: "submitWait",
    replies: [
      { status: 202, body: CITECHECK_ACCEPTED },
      { body: { ...CITECHECK_COMPLETED, status: "checking", poll_after_seconds: 5 } },
      { body: CITECHECK_COMPLETED },
    ],
    run: (c, o) => c.citecheckAndWait({ text: "t" }, { ...o }),
  },
];

/** The rest of the parity map: what takes no request options, by design. */
const NOT_A_CALL: Record<string, string> = {
  // Lifecycle and the copy itself.
  withOptions: "with_options",
  // The raw request keeps its own argument shape; Python has no public one.
  request: "(none)",
};

/** Every option, set: what a populated call sends. */
function populated(takes: Takes): RequestOptions {
  const all: RequestOptions = {
    signal: new AbortController().signal,
    timeoutMs: 45_000,
    maxRetries: 2,
    headers: { "X-Marker": "m" },
  };
  const out: Record<string, unknown> = {};
  for (const name of OPTION_NAMES[takes]) out[name] = all[name as keyof RequestOptions];
  return out as RequestOptions;
}

async function record(m: Method, o: RequestOptions | undefined) {
  const { fetch, sent } = recorder(m.replies);
  const c = new Lenz({ apiKey: "lenz_t", fetch });
  const pending = settle(m.run(c, o));
  await vi.advanceTimersByTimeAsync(100_000);
  expect(await pending).not.toBeInstanceOf(Error);
  return sent;
}

function withoutMarker(sent: Sent[]): string[][] {
  return sent.map((s) => wire(s).filter((line) => line !== "X-Marker: m"));
}

describe("the parity map", () => {
  it("names every public method of the client and its namespaces", () => {
    const client = new Lenz({ apiKey: "lenz_t" });
    const names = new Set<string>();
    const own = (proto: object, prefix: string) => {
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k === "constructor" || k.startsWith("_")) continue;
        const d = Object.getOwnPropertyDescriptor(proto, k);
        if (typeof d?.value === "function") names.add(prefix + k);
      }
    };
    own(Lenz.prototype, "");
    own(Object.getPrototypeOf(client.verifications) as object, "verifications.");
    own(Object.getPrototypeOf(client.ask) as object, "ask.");
    own(Object.getPrototypeOf(client.library) as object, "library.");
    // Private helpers TypeScript leaves on the prototype.
    for (const internal of ["submit", "log"]) names.delete(internal);
    const mapped = new Set([...METHODS.map((m) => m.name), ...Object.keys(NOT_A_CALL)]);
    expect([...names].sort()).toEqual([...mapped].sort());
  });

  it("is the table the Python SDK mirrors", () => {
    expect(
      Object.fromEntries(METHODS.map((m) => [m.name, [m.python, ...OPTION_NAMES[m.takes]]])),
    ).toMatchSnapshot();
  });
});

describe("options never change the request bytes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const m of METHODS) {
    it(`${m.name}: an empty options object sends what no options send`, async () => {
      const bare = await record(m, undefined);
      const empty = await record(m, {});
      expect(empty.map(wire)).toEqual(bare.map(wire));
    });

    it(`${m.name}: every option set adds only the asked header, on every request`, async () => {
      const bare = await record(m, undefined);
      const full = await record(m, populated(m.takes));
      expect(full.length).toBe(bare.length);
      // Forwarding: the header reaches every request the call makes (the
      // submit, every poll, every page).
      for (const s of full) expect(header(s, "X-Marker")).toBe("m");
      expect(withoutMarker(full)).toEqual(bare.map(wire));
      // Placed after the defaults, before the method's own headers.
      expect(full[0]!.headers.slice(0, 3).map(([n]) => n)).toEqual([
        "User-Agent",
        "Accept",
        "X-Marker",
      ]);
    });

    it(`${m.name}: a copy's options reach every request too`, async () => {
      const { fetch, sent } = recorder(m.replies);
      const root = new Lenz({ apiKey: "lenz_t", fetch });
      const copy = root.withOptions({ headers: { "X-Marker": "m" } });
      const pending = settle(m.run(copy));
      await vi.advanceTimersByTimeAsync(100_000);
      expect(await pending).not.toBeInstanceOf(Error);
      for (const s of sent) expect(header(s, "X-Marker")).toBe("m");
    });
  }
});

describe("options on a retried request", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("every attempt sends the same bytes and the asked header", async () => {
    const { fetch, sent } = recorder([{ status: 503 }, { networkError: true }, { body: TASK }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = settle(
      c.verify(
        { claim: "a", idempotencyKey: "k-retry" },
        { headers: { "X-Marker": "m" }, maxRetries: 2, timeoutMs: 5_000 },
      ),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ task_id: "t1" });
    expect(sent).toHaveLength(3);
    for (const s of sent) expect(wire(s)).toEqual(wire(sent[0]!));
    expect(header(sent[0]!, "X-Marker")).toBe("m");
  });
});

// ── budgets and precedence ───────────────────────────────────────────────

describe("what the per-call timeoutMs bounds, and precedence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** When the first attempt of `run` is aborted by its timer. */
  async function firstAbort(
    run: (c: Lenz) => Promise<unknown>,
    clientOpts: { timeoutMs?: number; maxRetries?: number } = {},
    copy?: RequestOptions,
  ): Promise<number> {
    const { fetch, aborts } = recorder([], { hang: true });
    const root = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, ...clientOpts });
    const pending = settle(run(copy ? root.withOptions(copy) : root));
    await vi.advanceTimersByTimeAsync(1_000_000);
    await pending;
    return aborts[0]!;
  }

  const CASES: Array<{
    name: string;
    run: (c: Lenz) => Promise<unknown>;
    client?: { timeoutMs?: number };
    copy?: RequestOptions;
    expected: number;
  }> = [
    { name: "plain: the call's", run: (c) => c.usage({ timeoutMs: 7_000 }), expected: 7_000 },
    {
      name: "plain: the call's over the copy's",
      run: (c) => c.usage({ timeoutMs: 7_000 }),
      copy: { timeoutMs: 9_000 },
      expected: 7_000,
    },
    {
      name: "plain: the copy's over the client's",
      run: (c) => c.usage(),
      client: { timeoutMs: 20_000 },
      copy: { timeoutMs: 9_000 },
      expected: 9_000,
    },
    {
      name: "extract: the call's over the input's",
      run: (c) => c.extract({ text: "a", timeoutMs: 8_000 }, { timeoutMs: 6_000 }),
      expected: 6_000,
    },
    {
      name: "extract: the input's over the copy's",
      run: (c) => c.extract({ text: "a", timeoutMs: 8_000 }),
      copy: { timeoutMs: 200_000 },
      expected: 8_000,
    },
    {
      name: "extract: an explicit call value below the floor is used",
      run: (c) => c.extract({ text: "a" }, { timeoutMs: 1_000 }),
      expected: 1_000,
    },
    {
      name: "extract: a copy's value is used as given, below the floor (3.2)",
      run: (c) => c.extract({ text: "a" }),
      copy: { timeoutMs: 9_000 },
      expected: 9_000,
    },
    {
      name: "extract: a copy value above the floor is kept",
      run: (c) => c.extract({ text: "a" }),
      copy: { timeoutMs: 200_000 },
      expected: 200_000,
    },
    {
      name: "assess: the call's over the input's",
      run: (c) => c.assess({ claim: "a", timeoutMs: 8_000 }, { timeoutMs: 2_000 }),
      expected: 2_000,
    },
    {
      name: "assess: the floor lifts an inherited client value",
      run: (c) => c.assess({ claims: ["a"] }),
      client: { timeoutMs: 5_000 },
      expected: 100_000,
    },
    {
      name: "assess: a copy's value is used as given, below the floor (3.2)",
      run: (c) => c.assess({ claims: ["a"] }),
      copy: { timeoutMs: 5_000 },
      expected: 5_000,
    },
    {
      name: "a wait's poll: the copy's attempt timeout, cut at the budget",
      run: (c) => c.wait("t1", { timeoutMs: 60_000 }),
      copy: { timeoutMs: 4_000 },
      expected: 4_000,
    },
    {
      name: "a wait's timeoutMs stays its budget",
      run: (c) => c.wait("t1", { timeoutMs: 3_000 }),
      expected: 3_000,
    },
    {
      name: "a wait's submit keeps the copy's attempt timeout",
      run: (c) => c.verifyAndWait({ claim: "a" }, { timeoutMs: 1_000 }),
      copy: { timeoutMs: 12_000 },
      expected: 12_000,
    },
  ];

  for (const c of CASES) {
    it(c.name, async () => {
      expect(await firstAbort(c.run, c.client, c.copy)).toBe(c.expected);
    });
  }

  it("a copy of a copy flattens its chain", async () => {
    const { fetch, aborts, sent } = recorder([], { hang: true });
    const copy = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 })
      .withOptions({ timeoutMs: 9_000, headers: { "X-A": "1", "X-B": "1" } })
      .withOptions({ timeoutMs: 4_000, headers: { "x-a": "2", "X-B": null } });
    const pending = settle(copy.usage());
    await vi.advanceTimersByTimeAsync(100_000);
    await pending;
    expect(aborts[0]).toBe(4_000);
    const extra = sent[0]!.headers.filter(
      ([n]) => n.toLowerCase().startsWith("x-") && n !== "X-Lenz-API-Version",
    );
    expect(extra).toEqual([["x-a", "2"]]);
  });

  for (const [name, copy, expected] of [
    ["the client's", undefined, 30_000],
    ["the copy's", { timeoutMs: 12_000 }, 12_000],
  ] as const) {
    it(`a review wait with no budget reads once with ${name} attempt timeout`, async () => {
      const { fetch, aborts, sent } = recorder([{ status: 202, body: REVIEW_ACCEPTED }], {
        hang: true,
      });
      const root = new Lenz({ apiKey: "lenz_t", fetch });
      const c = copy ? root.withOptions(copy) : root;
      const pending = settle(c.reviewAndWait({ text: "a" }, { timeoutMs: 0 }));
      await vi.advanceTimersByTimeAsync(100_000);
      expect(await pending).toHaveProperty("name", "ReviewTimeoutError");
      expect(sent).toHaveLength(2);
      expect(aborts).toEqual([expected]);
    });
  }

  it("an untouched copy timeout leaves the client's", async () => {
    expect(await firstAbort((c) => c.usage(), {}, { headers: { "X-A": "1" } })).toBe(30_000);
  });
});

describe("maxRetries precedence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function attempts(
    run: (c: Lenz) => Promise<unknown>,
    clientRetries?: number,
    copy?: RequestOptions,
  ): Promise<number> {
    const { fetch, sent } = recorder([], { status: 503 });
    const root = new Lenz({
      apiKey: "lenz_t",
      fetch,
      ...(clientRetries === undefined ? {} : { maxRetries: clientRetries }),
    });
    const pending = settle(run(copy ? root.withOptions(copy) : root));
    await vi.advanceTimersByTimeAsync(1_000_000);
    await pending;
    return sent.length;
  }

  it("the call's over the copy's over the client's", async () => {
    expect(await attempts((c) => c.usage())).toBe(4);
    expect(await attempts((c) => c.usage(), 1)).toBe(2);
    expect(await attempts((c) => c.usage(), 1, { maxRetries: 2 })).toBe(3);
    expect(await attempts((c) => c.usage({ maxRetries: 0 }), 1, { maxRetries: 2 })).toBe(1);
  });

  it("reaches every page of a listAll", async () => {
    expect(await attempts((c) => drain(c.library.listAll({}, { maxRetries: 1 })))).toBe(2);
  });

  it("on a wait, is the submit's; the polls keep the client's", async () => {
    const { fetch, sent } = recorder(
      [{ status: 503 }, { status: 503 }, { status: 202, body: TASK }],
      { status: 503 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 1, timeoutMs: 1_000 });
    const pending = settle(client.verifyAndWait({ claim: "a" }, { maxRetries: 2, timeoutMs: 1 }));
    await vi.advanceTimersByTimeAsync(100_000);
    await pending;
    // Three submit attempts (2 retries), then one poll of the client's
    // ladder, cut at the 1 ms budget.
    expect(sent.filter((s) => s.method === "POST")).toHaveLength(3);
  });

  it("reviewAndWait's polls stay one attempt each", async () => {
    const { fetch, sent } = recorder(
      [{ status: 202, body: REVIEW_ACCEPTED }, { status: 503 }, { body: REVIEW_COMPLETED }],
      { status: 503 },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const pending = settle(client.reviewAndWait({ text: "a" }, { maxRetries: 3 }));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(await pending).toMatchObject({ status: "completed" });
    expect(sent.map((s) => s.at)).toEqual([0, 0, 5_000]);
  });
});

// ── validation ───────────────────────────────────────────────────────────

describe("validation: one rule for every per-request setting", () => {
  const BAD_TIMEOUTS: unknown[] = [0, -1, NaN, Infinity, -Infinity, "5", null, 2 ** 31];
  const BAD_RETRIES: unknown[] = [-1, 1.5, NaN, Infinity, "2", null];

  function noNetwork() {
    const fetch = vi.fn(() => Promise.reject(new Error("the network must not be used")));
    return fetch as unknown as typeof globalThis.fetch;
  }

  let uuid: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    uuid = vi.spyOn(globalThis.crypto, "randomUUID");
  });
  afterEach(() => {
    uuid.mockRestore();
  });

  async function refused(run: () => Promise<unknown> | unknown, fetch: typeof globalThis.fetch) {
    let err: unknown;
    try {
      await run();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LenzAbortError);
    // Since 3.2 the local argument error (still an Error).
    expect(err?.constructor).toBe(LenzValidationError);
    expect((err as LenzValidationError).statusCode).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    return err as Error;
  }

  for (const value of BAD_TIMEOUTS) {
    it(`timeoutMs ${String(value)} is refused at the call, the copy and the constructor`, async () => {
      const fetch = noNetwork();
      const c = new Lenz({ apiKey: "lenz_t", fetch });
      const o = { timeoutMs: value } as unknown as RequestOptions;
      expect((await refused(() => c.verify({ claim: "a" }, o), fetch)).message).toMatch(
        /timeoutMs must be (a finite number|at most)/,
      );
      await refused(() => c.assess({ claim: "a" }, o), fetch);
      await refused(() => c.getReview("r1", o), fetch);
      await refused(() => c.verifications.list(o), fetch);
      await refused(() => c.library.listAll({}, o), fetch);
      await refused(() => c.verifications.listAll(o), fetch);
      await refused(() => c.withOptions(o), fetch);
      // On the 2.x fields, null still means "not given" (below).
      if (value !== null) {
        await refused(
          () => new Lenz({ apiKey: "lenz_t", fetch, timeoutMs: value as number }),
          fetch,
        );
      }
    });

    if (value === null) continue;
    it(`the deprecated in-input timeoutMs ${String(value)} is refused`, async () => {
      const fetch = noNetwork();
      const c = new Lenz({ apiKey: "lenz_t", fetch });
      await refused(() => c.extract({ text: "a", timeoutMs: value as number }), fetch);
      await refused(() => c.assess({ claims: ["a"], timeoutMs: value as number }), fetch);
    });
  }

  for (const value of BAD_RETRIES) {
    it(`maxRetries ${String(value)} is refused at the call, a wait, the copy and the constructor`, async () => {
      const fetch = noNetwork();
      const c = new Lenz({ apiKey: "lenz_t", fetch });
      const o = { maxRetries: value } as unknown as RequestOptions;
      expect((await refused(() => c.usage(o), fetch)).message).toMatch(/maxRetries must be/);
      await refused(() => c.verifyAndWait({ claim: "a" }, o), fetch);
      await refused(() => c.reviewAndWait({ text: "a" }, o), fetch);
      await refused(() => c.citecheckAndWait({ text: "a" }, o), fetch);
      await refused(() => c.verifyBatchAndWait({ claims: [{ claim: "a" }] }, o), fetch);
      await refused(() => c.withOptions(o), fetch);
      if (value !== null) {
        await refused(
          () => new Lenz({ apiKey: "lenz_t", fetch, maxRetries: value as number }),
          fetch,
        );
      }
    });
  }

  it("a signal that is not an AbortSignal is refused", async () => {
    const fetch = noNetwork();
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const o = { signal: { aborted: false } } as unknown as RequestOptions;
    expect((await refused(() => c.verify({ claim: "a" }, o), fetch)).message).toMatch(
      /signal must be an AbortSignal/,
    );
    await refused(() => c.wait("t1", o), fetch);
    await refused(() => c.withOptions(o), fetch);
  });

  it("a validation error wins over an aborted signal", async () => {
    const fetch = noNetwork();
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    await refused(() => c.usage({ signal: AbortSignal.abort(), maxRetries: -1 }), fetch);
  });

  it("the waits' budgets are not newly refused: 0 and less still poll once", async () => {
    const { fetch, sent } = recorder([{ body: PROCESSING }, { body: PROCESSING }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    expect(await settle(c.wait("t1", { timeoutMs: 0 }))).toHaveProperty("name", "LenzTimeoutError");
    expect(await settle(c.wait("t1", { timeoutMs: -5 }))).toHaveProperty(
      "name",
      "LenzTimeoutError",
    );
    expect(sent).toHaveLength(2);
  });

  it("wait() takes no maxRetries: a value there is refused, naming it", async () => {
    const fetch = noNetwork();
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const o = { maxRetries: 1 } as unknown as RequestOptions;
    expect((await refused(() => c.wait("t1", o), fetch)).message).toMatch(/takes no maxRetries/);
  });

  it("null on a 2.x field (constructor, extract / assess input) means not given", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, aborts, sent } = recorder([], { hang: true });
      const c = new Lenz({
        apiKey: "lenz_t",
        fetch,
        timeoutMs: null as unknown as number,
        maxRetries: null as unknown as number,
      });
      const p1 = settle(c.usage());
      await vi.advanceTimersByTimeAsync(1_000_000);
      await p1;
      // The defaults: 30 s attempts, 3 retries.
      expect(sent).toHaveLength(4);
      expect(aborts[0]).toBe(30_000);
      const one = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const before = aborts.length;
      const p2 = settle(one.extract({ text: "a", timeoutMs: null as unknown as number }));
      const p3 = settle(one.assess({ claim: "a", timeoutMs: null as unknown as number }));
      await vi.advanceTimersByTimeAsync(1_000_000);
      await Promise.all([p2, p3]);
      // Started at 1,000,000 ms: the 100 s and 150 s floors.
      expect(aborts.slice(before).sort((a, b) => a - b)).toEqual([1_100_000, 1_150_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the request options refuse null", async () => {
    const fetch = noNetwork();
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    await refused(() => c.usage({ timeoutMs: null as unknown as number }), fetch);
    await refused(() => c.usage({ maxRetries: null as unknown as number }), fetch);
  });

  for (const name of ["X A", "X:A", "", "Ä-Header", "X\nA"]) {
    it(`the header name ${JSON.stringify(name)} is refused before any key or request`, async () => {
      const fetch = noNetwork();
      const c = new Lenz({ apiKey: "lenz_t", fetch });
      const o = { headers: { [name]: "v" } };
      expect((await refused(() => c.verify({ claim: "a" }, o), fetch)).message).toMatch(
        /not a valid header name/,
      );
      await refused(() => c.withOptions(o), fetch);
    });
  }

  for (const value of [
    "a\r\nX-Evil: 1",
    "a\nb",
    "a\u0000b",
    "\u0100",
    "caf\u00e9",
    "a\u0001b",
    "a\u007fb",
    " lead",
    "trail\t",
  ]) {
    it(`the header value ${JSON.stringify(value)} is refused before any key or request`, async () => {
      const fetch = noNetwork();
      const c = new Lenz({ apiKey: "lenz_t", fetch });
      const o = { headers: { "X-A": value } };
      expect((await refused(() => c.verify({ claim: "a" }, o), fetch)).message).toMatch(
        /visible ASCII/,
      );
      await refused(() => c.reviewAndWait({ text: "a" }, o), fetch);
      await refused(() => c.withOptions(o), fetch);
    });
  }

  it("empty values and inner spaces and tabs are sent as given", async () => {
    const { fetch, sent } = recorder([{ body: {} }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    await c.usage({ headers: { "X-A": "", "X-B": "a  b\tc", "X-C": "~!x" } });
    expect(
      sent[0]!.headers.filter(([n]) => n.startsWith("X-") && n !== "X-Lenz-API-Version"),
    ).toEqual([
      ["X-A", ""],
      ["X-B", "a  b\tc"],
      ["X-C", "~!x"],
    ]);
  });

  it("listAll checks its options when called, before the first page", () => {
    const fetch = noNetwork();
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    expect(() => c.verifications.listAll({ maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => c.library.listAll({}, { headers: { Host: "x" } })).toThrow(/Host/);
    // The options first, then the input.
    expect(() => c.library.listAll({ sort: "random" }, { maxRetries: -1 })).toThrow(/maxRetries/);
  });

  it("valid constructor values are taken as before", async () => {
    const { fetch, sent } = recorder([{ status: 503 }, { body: {} }]);
    vi.useFakeTimers();
    try {
      const c = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0, timeoutMs: 1 });
      const pending = settle(c.usage());
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── headers ──────────────────────────────────────────────────────────────

describe("request option headers", () => {
  async function headersOf(
    run: (c: Lenz) => Promise<unknown>,
    copy?: RequestOptions,
  ): Promise<Array<[string, string]>> {
    const { fetch, sent } = recorder([{ body: {} }]);
    const root = new Lenz({ apiKey: "lenz_t", fetch });
    await run(copy ? root.withOptions(copy) : root);
    return sent[0]!.headers;
  }

  it("merge without regard to case: the call's spelling and value win", async () => {
    const h = await headersOf((c) => c.usage({ headers: { "X-A": "call" } }), {
      headers: { "x-a": "copy", "x-b": "copy" },
    });
    expect(h.filter(([n]) => n.toLowerCase() === "x-a")).toEqual([["X-A", "call"]]);
    expect(h.filter(([n]) => n.toLowerCase() === "x-b")).toEqual([["x-b", "copy"]]);
  });

  it("a name set again keeps its place on the wire", async () => {
    const h = await headersOf((c) => c.usage({ headers: { "x-a": "call" } }), {
      headers: { "X-A": "copy", "X-B": "copy" },
    });
    expect(
      h.filter(([n]) => n.toLowerCase().startsWith("x-") && n !== "X-Lenz-API-Version"),
    ).toEqual([
      ["x-a", "call"],
      ["X-B", "copy"],
    ]);
  });

  it("within one object, the last spelling wins", async () => {
    const h = await headersOf((c) => c.usage({ headers: { "x-a": "1", "X-A": "2" } }));
    expect(h.filter(([n]) => n.toLowerCase() === "x-a")).toEqual([["X-A", "2"]]);
  });

  it("replace User-Agent and Accept in any casing", async () => {
    const h = await headersOf((c) =>
      c.usage({ headers: { "user-agent": "my-app/1", ACCEPT: "application/problem+json" } }),
    );
    expect(h.slice(0, 2)).toEqual([
      ["user-agent", "my-app/1"],
      ["ACCEPT", "application/problem+json"],
    ]);
    expect(h.some(([n]) => n === "User-Agent" || n === "Accept")).toBe(false);
  });

  it("null removes a copy's header; undefined is ignored", async () => {
    const h = await headersOf((c) => c.usage({ headers: { "X-A": null, "X-B": undefined } }), {
      headers: { "X-A": "copy", "X-B": "copy" },
    });
    expect(h.find(([n]) => n === "X-A")).toBeUndefined();
    expect(h.find(([n]) => n === "X-B")).toEqual(["X-B", "copy"]);
  });

  it("null does not reach the client's own headers", async () => {
    const h = await headersOf((c) => c.usage({ headers: { "User-Agent": null } }));
    expect(h[0]).toEqual(["User-Agent", expect.stringMatching(/^lenz-io-node\//)]);
  });

  for (const name of [
    "X-Lenz-API-Version",
    "idempotency-key",
    "AUTHORIZATION",
    "Content-Type",
    "content-length",
    "Host",
    "Transfer-Encoding",
  ]) {
    it(`${name} is refused at the call, a wait and the copy, before any request`, async () => {
      const fetch = vi.fn() as unknown as typeof globalThis.fetch;
      const c = new Lenz({ apiKey: "lenz_t", fetch });
      const o = { headers: { [name]: "x" } };
      await expect(c.usage(o)).rejects.toThrow(new RegExp(`the ${name} header is set`));
      await expect(c.verifyAndWait({ claim: "a" }, o)).rejects.toThrow(/header is set/);
      await expect(c.wait("t1", o)).rejects.toThrow(/header is set/);
      expect(() => c.withOptions(o)).toThrow(/header is set/);
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it("a value that is not a string is refused", async () => {
    const c = new Lenz({ apiKey: "lenz_t", fetch: vi.fn() as unknown as typeof fetch });
    const o = { headers: { "X-A": 5 } } as unknown as RequestOptions;
    await expect(c.usage(o)).rejects.toThrow(/must be a string, or null/);
  });

  it("the raw request() keeps its own header behaviour", async () => {
    const { fetch, sent } = recorder([{ body: {} }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    await c.request({
      method: "GET",
      path: "/x",
      headers: { accept: "text/plain", "Idempotency-Key": "raw", Host: "h" },
    });
    expect(sent[0]!.headers.map(([n]) => n)).toEqual([
      "User-Agent",
      "Accept",
      "accept",
      "Idempotency-Key",
      "Host",
      "X-Lenz-API-Version",
      "Authorization",
    ]);
  });

  it("no header is added without options (a copy with none included)", async () => {
    const bare = await headersOf((c) => c.usage());
    const copied = await headersOf((c) => c.usage(), {});
    expect(copied).toEqual(bare);
  });
});

// ── options are read once, when the call is made ─────────────────────────

describe("a call's options are copied when it is made", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("listAll: every page uses the headers as they were at the call", async () => {
    const { fetch, sent } = recorder([{ body: LIST(1, 2, 3) }, { body: LIST(2, 1, 3) }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const headers: Record<string, string> = { "X-A": "1" };
    const it = c.verifications.listAll({ headers })[Symbol.asyncIterator]();
    headers["X-A"] = "changed";
    await it.next();
    headers["X-B"] = "added";
    while (!(await it.next()).done);
    expect(sent.map((s) => [header(s, "X-A"), header(s, "X-B")])).toEqual([
      ["1", undefined],
      ["1", undefined],
    ]);
  });

  it("library.listAll: the same, options object and all", async () => {
    const { fetch, sent } = recorder([{ body: LIST(1, 2, 3) }, { body: LIST(2, 1, 3) }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const options: RequestOptions = { headers: { "X-A": "1" } };
    const it = c.library.listAll({}, options)[Symbol.asyncIterator]();
    await it.next();
    options.headers = { "X-A": "changed" };
    while (!(await it.next()).done);
    expect(sent.map((s) => header(s, "X-A"))).toEqual(["1", "1"]);
  });

  it("a wait: every poll uses the headers as they were at the call", async () => {
    const { fetch, sent } = recorder([{ body: PROCESSING }, { body: COMPLETED }]);
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const headers: Record<string, string> = { "X-A": "1" };
    const pending = settle(
      c.wait("t1", { headers, onProgress: () => (headers["X-A"] = "changed") }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(sent.map((s) => header(s, "X-A"))).toEqual(["1", "1"]);
  });
});

// ── withOptions ──────────────────────────────────────────────────────────

describe("withOptions()", () => {
  it("shares the fetch: one mock sees both", async () => {
    const { fetch, sent } = recorder([{ body: {} }, { body: {} }]);
    const root = new Lenz({ apiKey: "lenz_t", fetch });
    const copy = root.withOptions({ headers: { "X-A": "1" } });
    await root.usage();
    await copy.usage();
    expect(sent).toHaveLength(2);
    expect(header(sent[0]!, "X-A")).toBeUndefined();
    expect(header(sent[1]!, "X-A")).toBe("1");
    expect(header(sent[1]!, "Authorization")).toBe("Bearer lenz_t");
  });

  it("leaves the client it was made from unchanged", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, aborts } = recorder([], { hang: true });
      const root = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      root.withOptions({ timeoutMs: 1_000, maxRetries: 5, signal: AbortSignal.abort() });
      const pending = settle(root.usage());
      await vi.advanceTimersByTimeAsync(100_000);
      expect(await pending).toBeInstanceOf(LenzRequestTimeoutError);
      expect(aborts).toEqual([30_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a subclass and its overrides", async () => {
    class Mine extends Lenz {
      override async getStatus(): Promise<TaskStatus> {
        return COMPLETED as unknown as TaskStatus;
      }
    }
    const copy = new Mine({ apiKey: "lenz_t", fetch: vi.fn() as unknown as typeof fetch });
    const c = copy.withOptions({ headers: { "X-A": "1" } });
    expect(c).toBeInstanceOf(Mine);
    expect((await c.wait("t1")).verification_id).toBe("v1");
  });

  it("keeps an instance override", async () => {
    const root = new Lenz({ apiKey: "lenz_t", fetch: vi.fn() as unknown as typeof fetch });
    root.getStatus = (async () => COMPLETED as unknown as TaskStatus) as typeof root.getStatus;
    const copy = root.withOptions({ timeoutMs: 5_000 });
    expect((await copy.wait("t1")).verification_id).toBe("v1");
  });

  it("keeps a namespace's own overrides and class, bound to the copy", async () => {
    const { fetch, sent } = recorder([{ body: LIST(1, 1, 1) }]);
    const root = new Lenz({ apiKey: "lenz_t", fetch });
    class MyAsk
      extends (Object.getPrototypeOf(root.ask) as { constructor: new (c: Lenz) => object })
        .constructor
    {
      tag = "mine";
    }
    (root as unknown as { ask: object }).ask = new MyAsk(root);
    root.verifications.get = (async () => ({
      verification_id: "stub",
    })) as typeof root.verifications.get;
    const copy = root.withOptions({ headers: { "X-A": "1" } });
    expect(copy.ask).toBeInstanceOf(MyAsk);
    expect((copy.ask as unknown as { tag: string }).tag).toBe("mine");
    expect((await copy.verifications.get("v1")).verification_id).toBe("stub");
    await copy.verifications.list();
    expect(header(sent[0]!, "X-A")).toBe("1");
  });

  it("binds the namespaces to the copy", async () => {
    const { fetch, sent } = recorder([{ body: LIST(1, 1, 1) }, { body: { messages: [] } }]);
    const root = new Lenz({ apiKey: "lenz_t", fetch });
    const copy = root.withOptions({ headers: { "X-A": "1" } });
    expect(copy.verifications).not.toBe(root.verifications);
    await copy.verifications.list();
    await copy.ask.history("v1");
    expect(sent.map((s) => header(s, "X-A"))).toEqual(["1", "1"]);
  });
});
