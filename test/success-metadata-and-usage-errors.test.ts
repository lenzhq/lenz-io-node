/**
 * 3.2, mirrored in the Python SDK: success metadata on results (`httpStatus`,
 * `headers`), `settledByConflict` on review / citecheck receipts, specific
 * codes and `param` on local argument errors, `LenzInvalidKeyError`, and a
 * field of the wrong type where the SDK reads it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as browser from "../src/index.browser.js";
import {
  USAGE_ERROR_CODES,
  verifySignature,
  Lenz,
  LenzAuthError,
  LenzInvalidKeyError,
  LenzInvalidResponseError,
  LenzTimeoutError,
  LenzValidationError,
  LenzWebhooks,
} from "../src/index.js";

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

function server(reply: (sent: Sent) => Reply) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const s: Sent = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    sent.push(s);
    const r = reply(s);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

async function thrown(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (exc) {
    return exc;
  }
  throw new Error("expected an error");
}

let envKey: string | undefined;
beforeEach(() => {
  envKey = process.env["LENZ_API_KEY"];
  delete process.env["LENZ_API_KEY"];
});
afterEach(() => {
  if (envKey === undefined) delete process.env["LENZ_API_KEY"];
  else process.env["LENZ_API_KEY"] = envKey;
});

// ── 1: success metadata ──

describe("httpStatus and headers on a result read from an answer", () => {
  const accepted = { task_id: "t1", status: "pending", poll_url: "/verify/status/t1" };

  it("a 202 receipt reports 202, with Location and Retry-After readable", async () => {
    const { fetch } = server(() => ({
      status: 202,
      body: accepted,
      headers: { Location: "/api/v1/verify/status/t1", "Retry-After": "5", "X-Request-ID": "r1" },
    }));
    for (const legacyAliases of [true, false]) {
      const out = await new Lenz({ apiKey: "lenz_t", fetch, legacyAliases }).verify({ claim: "a" });
      expect(out.httpStatus).toBe(202);
      expect(out.headers?.["location"]).toBe("/api/v1/verify/status/t1");
      expect(out.headers?.["retry-after"]).toBe("5");
      expect(out.headers?.["x-request-id"]).toBe("r1");
    }
  });

  it("is not an enumerable key, and headers are a fresh copy on each read", async () => {
    const { fetch } = server(() => ({ status: 202, body: accepted, headers: { "X-A": "1" } }));
    const out = await new Lenz({ apiKey: "lenz_t", fetch }).verify({ claim: "a" });
    expect(Object.keys(out)).not.toContain("httpStatus");
    expect(Object.keys(out)).not.toContain("headers");
    expect(JSON.parse(JSON.stringify(out))).toEqual(accepted);
    expect({ ...out }).toEqual(accepted);
    out.headers!["x-a"] = "changed";
    expect(out.headers?.["x-a"]).toBe("1");
  });

  it("on every result that is one answer's body, in both modes", async () => {
    const status = { task_id: "t1", status: "processing" };
    const review = {
      review_id: "r1",
      status: "completed",
      claims: [],
      issues: [],
      failures: [],
      summary: {},
    };
    const citecheck = {
      citecheck_id: "c1",
      status: "completed",
      citations: [],
      citation_issues: [],
      citation_failures: [],
      summary: {},
      credits: {},
    };
    const { fetch } = server((s) => {
      const u = s.url;
      if (u.includes("/verify/status/")) return { body: status };
      if (u.endsWith("/verify/batch")) return { status: 202, body: { batch_id: "b", items: [] } };
      if (u.includes("/cancel") && u.includes("/reviews/")) return { body: review };
      if (u.includes("/cancel") && u.includes("/citechecks/")) return { body: citecheck };
      if (u.includes("/cancel"))
        return { body: { task_id: "t1", cancelled: true, status: "cancelled" } };
      if (u.endsWith("/review"))
        return { status: 202, body: { review_id: "r1", status: "queued" } };
      if (u.includes("/reviews/")) return { body: review };
      if (u.endsWith("/citecheck")) {
        return { status: 202, body: { citecheck_id: "c1", status: "queued" } };
      }
      if (u.includes("/citechecks/")) return { body: citecheck };
      if (u.endsWith("/extract")) return { body: { claims: [], status: "ok" } };
      if (u.endsWith("/assess")) return { body: { claims: [], more_claims: [] } };
      if (u.endsWith("/me/usage")) return { body: { tier: "free" } };
      if (u.includes("/library")) return { body: { items: [], total: 0, page: 1, page_size: 20 } };
      if (u.includes("/verifications?") || u.endsWith("/verifications")) {
        return { body: { items: [], total: 0, page: 1, page_size: 20 } };
      }
      if (u.includes("/ask")) return { body: { messages: [], reply: "x" } };
      if (u.includes("/verifications/")) return { body: { verification_id: "abcd1234" } };
      return { status: 202, body: accepted };
    });
    const calls: Array<[string, (c: Lenz) => Promise<unknown>, number]> = [
      ["verify", (c) => c.verify({ claim: "a" }), 202],
      ["verifyBatch", (c) => c.verifyBatch({ claims: [{ claim: "a" }] }), 202],
      ["getStatus", (c) => c.getStatus("t1"), 200],
      ["cancel", (c) => c.cancel("t1"), 200],
      ["extract", (c) => c.extract({ text: "a" }), 200],
      ["assess", (c) => c.assess({ claim: "a" }), 200],
      ["usage", (c) => c.usage(), 200],
      ["verifications.get", (c) => c.verifications.get("abcd1234"), 200],
      ["verifications.list", (c) => c.verifications.list(), 200],
      ["library.list", (c) => c.library.list(), 200],
      ["ask.history", (c) => c.ask.history("abcd1234"), 200],
      ["ask.send", (c) => c.ask.send("abcd1234", { message: "x" }), 200],
      ["review", (c) => c.review({ text: "Draft." }), 202],
      ["getReview", (c) => c.getReview("r1"), 200],
      ["cancelReview", (c) => c.cancelReview("r1"), 200],
      ["citecheck", (c) => c.citecheck({ text: "Draft." }), 202],
      ["getCitecheck", (c) => c.getCitecheck("c1"), 200],
      ["cancelCitecheck", (c) => c.cancelCitecheck("c1"), 200],
      ["reviewAndWait", (c) => c.reviewAndWait({ text: "Draft." }), 200],
      ["citecheckAndWait", (c) => c.citecheckAndWait({ text: "Draft." }), 200],
    ];
    for (const legacyAliases of [true, false]) {
      const client = new Lenz({ apiKey: "lenz_t", fetch, legacyAliases });
      for (const [name, run, code] of calls) {
        const out = (await run(client)) as { httpStatus?: number; headers?: object };
        expect([name, out.httpStatus]).toEqual([name, code]);
        expect([name, out.headers]).toEqual([
          name,
          expect.objectContaining({ "content-type": "application/json" }),
        ]);
      }
    }
  });

  it("not on nested objects, a wait's verification or a batch wait's rows", async () => {
    const verification = { verification_id: "abcd1234", claim: "a" };
    const status = { task_id: "t1", status: "completed", result: verification };
    const assessBody = {
      claims: [{ claim: "a", status: "completed", verdict: "True", confidence: "high" }],
      more_claims: [],
    };
    const { fetch } = server((s) => {
      if (s.url.endsWith("/assess")) return { body: assessBody };
      if (s.url.endsWith("/verify/batch")) {
        return { status: 202, body: { batch_id: "b", items: [{ task_id: "t1", claim: "a" }] } };
      }
      return { body: status };
    });
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const st = await client.getStatus("t1");
    expect(st.httpStatus).toBe(200);
    expect(st.result?.httpStatus).toBeUndefined();
    expect(st.result?.headers).toBeUndefined();
    const out = await client.assess({ claim: "a" });
    expect(out.httpStatus).toBe(200);
    expect((out.claims[0] as unknown as { httpStatus?: number }).httpStatus).toBeUndefined();
    const v = await client.wait("t1");
    expect(v.httpStatus).toBeUndefined();
    expect(v.raw).toEqual(verification);
    const rows = await client.verifyBatchAndWait({ claims: [{ claim: "a" }] });
    expect((rows[0] as unknown as { httpStatus?: number }).httpStatus).toBeUndefined();
  });

  it("an object that carries its own headers key keeps it", async () => {
    const { fetch } = server(() => ({ body: { headers: "server's", httpStatus: 7 } }));
    const out = (await new Lenz({
      apiKey: "lenz_t",
      fetch,
      legacyAliases: false,
    }).usage()) as unknown as Record<string, unknown>;
    expect(out["headers"]).toBe("server's");
    expect(out["httpStatus"]).toBe(7);
  });
});

// ── 2: settledByConflict ──

describe("settledByConflict on review and citecheck receipts", () => {
  for (const [kind, idField, path] of [
    ["review", "review_id", "/review"],
    ["citecheck", "citecheck_id", "/citecheck"],
  ] as const) {
    it(`${kind}: false on the 202, true on a 409 naming the job`, async () => {
      let calls = 0;
      const { fetch } = server(() => {
        calls += 1;
        return calls === 1
          ? { status: 202, body: { [idField]: "j1", status: "queued" } }
          : {
              status: 409,
              body: { detail: "in flight", code: "idempotency_conflict", [idField]: "j2" },
              headers: { "X-Request-ID": "req409", "Retry-After": "2" },
            };
      });
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const submit = (c: Lenz) =>
        kind === "review" ? c.review({ text: "Draft." }) : c.citecheck({ text: "Draft." });
      const first = await submit(client);
      expect(first.settledByConflict).toBe(false);
      expect(first.httpStatus).toBe(202);
      const second = await submit(client);
      expect(second.settledByConflict).toBe(true);
      expect(second.httpStatus).toBe(409);
      expect(second.headers?.["x-request-id"]).toBe("req409");
      expect(second.headers?.["retry-after"]).toBe("2");
      expect((second as unknown as Record<string, string>)[idField]).toBe("j2");
      // Not an enumerable key.
      expect(Object.keys(second)).toEqual([idField, "status"]);
      expect(path).toBeTruthy();
    });
  }
});

// ── 3: local argument errors: codes and param ──

describe("local argument errors carry a specific code and param", () => {
  const noFetch = (() => {
    throw new Error("no request expected");
  }) as unknown as typeof globalThis.fetch;
  const client = new Lenz({ apiKey: "lenz_t", fetch: noFetch });
  const raw = new Lenz({ apiKey: "lenz_t", fetch: noFetch, legacyAliases: false });

  const cases: Array<[string, () => unknown, string, string | undefined, string?]> = [
    // The blank inputs keep the code the API's 422 would have given.
    [
      "verify blank claim (2.x reading)",
      () => client.verify({ claim: " " }),
      "blank_input",
      "claim",
    ],
    ["verify blank claim", () => raw.verify({ claim: " " }), "blank_input", "claim"],
    ["assess empty claims list", () => raw.assess({ claims: [] }), "empty_list", "claims"],
    ["assess empty claims list (2.x)", () => client.assess({ claims: [] }), "empty_list", "claims"],
    [
      "assess blank item (2.x)",
      () => client.assess({ claims: ["a", " "] }),
      "blank_item",
      "claims[1]",
    ],
    ["assess blank item", () => raw.assess({ claims: ["a", " "] }), "blank_item", "claims[1]"],
    [
      "assess non-string item",
      () => raw.assess({ claims: ["a", 5 as unknown as string] }),
      "invalid_argument",
      "claims[1]",
    ],
    [
      "assess both forms",
      () => client.assess({ claim: "a", claims: ["b"] }),
      "conflicting_input",
      "claims",
    ],
    [
      "citecheck both",
      () => client.citecheck({ text: "a", pairs: [] }),
      "conflicting_input",
      "text",
    ],
    [
      "citecheck maxCitations with pairs",
      () => client.citecheck({ pairs: [], maxCitations: 3 }),
      "conflicting_input",
      "maxCitations",
    ],
    [
      "two spellings of a batch item field",
      () =>
        client.verifyBatch({
          claims: [{ claim: "a", sourceUrl: "https://a.example", source_url: "https://b.example" }],
        } as never),
      "conflicting_input",
      "claims[0]",
    ],
    ["select without claims", () => client.select("t1", { claims: [] }), "empty_list", "claims"],
    [
      "pageSize",
      () => client.verifications.list({ pageSize: 101 }),
      "invalid_page_size",
      "pageSize",
    ],
    ["listAll start page", () => client.verifications.listAll({ page: 0 }), "invalid_page", "page"],
    [
      "library listAll random",
      () => client.library.listAll({ sort: "random" }),
      "invalid_argument",
      "sort",
    ],
    ["an empty task id", () => client.getStatus(""), "invalid_id", "taskId"],
    ["a review id", () => client.getReview(".."), "invalid_id", "reviewId"],
    ["a citecheck id", () => client.getCitecheck("."), "invalid_id", "citecheckId"],
    ["a verification id", () => client.verifications.get(""), "invalid_id", "verificationId"],
    ["wait on an empty id", () => client.wait({ task_id: "" } as never), "invalid_id", "taskId"],
    [
      "an idempotencyKey",
      () => client.verify({ claim: "a", idempotencyKey: "a\nb" }),
      "invalid_header",
      "idempotencyKey",
    ],
    [
      "a reserved header",
      () => client.usage({ headers: { Authorization: "x" } }),
      "invalid_header",
      "headers",
    ],
    ["options not an object", () => client.usage(5 as never), "invalid_option", "options"],
    ["signal", () => client.usage({ signal: {} as never }), "invalid_option", "signal"],
    ["timeoutMs", () => client.usage({ timeoutMs: 0 }), "invalid_option", "timeoutMs"],
    ["maxRetries", () => client.usage({ maxRetries: -1 }), "invalid_option", "maxRetries"],
    [
      "a wait's maxRetries",
      () => client.wait("t1", { maxRetries: 1 } as never),
      "invalid_option",
      "maxRetries",
    ],
    [
      "cancelOnAbort on a request",
      () => client.usage({ cancelOnAbort: true } as never),
      "invalid_option",
      "cancelOnAbort",
    ],
    [
      "a webhook body that is not bytes",
      () =>
        new LenzWebhooks({ secret: "whsec_x" }).parse(5 as never, {
          "x-lenz-signature": "sha256=00",
          "x-lenz-timestamp": "1",
        }),
      "invalid_argument",
      "body",
    ],
    [
      "LenzWebhooks without a secret",
      () => new LenzWebhooks({ secret: "" }),
      "invalid_option",
      "secret",
    ],
    [
      "verifySignature with an empty secret",
      () => verifySignature("{}", "sha256=00", ""),
      "invalid_argument",
      "secret",
    ],
  ];

  it("every local code is in USAGE_ERROR_CODES, exported from both entry points", () => {
    expect([...USAGE_ERROR_CODES]).toEqual([
      "blank_input",
      "blank_item",
      "empty_list",
      "invalid_page_size",
      "invalid_page",
      "invalid_id",
      "invalid_header",
      "invalid_option",
      "conflicting_input",
      "invalid_argument",
    ]);
    expect(browser.USAGE_ERROR_CODES).toBe(USAGE_ERROR_CODES);
    // Every local code is one of them, whatever legacyAliases says.
    for (const [, , code] of cases) {
      expect(USAGE_ERROR_CODES).toContain(code);
    }
  });

  it.each(cases)("%s", async (_name, run, code, param) => {
    const err = (await thrown(run)) as LenzValidationError;
    expect(err).toBeInstanceOf(LenzValidationError);
    expect(err.statusCode).toBe(0);
    expect(err.code).toBe(code);
    expect(err.param).toBe(param);
  });

  it("messages are unchanged", async () => {
    const err = (await thrown(() => client.verifications.list({ pageSize: 0 }))) as Error;
    expect(err.message).toBe(
      "verifications.list: pageSize must be a whole number from 1 to 100 (got 0).",
    );
  });

  it("the API's own 422 has no param", async () => {
    const { fetch } = server(() => ({
      status: 422,
      body: { detail: "Validation failed", code: "validation_error", errors: [] },
    }));
    const err = (await thrown(() =>
      new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 }).verify({ claim: "a" }),
    )) as LenzValidationError;
    expect(err).toBeInstanceOf(LenzValidationError);
    expect(err.statusCode).toBe(422);
    expect(err.param).toBeUndefined();
    expect(Object.keys(err)).not.toContain("param");
  });
});

// ── 4: LenzInvalidKeyError ──

describe("LenzInvalidKeyError", () => {
  it("is the local refusal of a key that cannot be sent, a LenzAuthError", () => {
    for (const make of [
      () => new Lenz({ apiKey: "lenz_a b" }),
      () => new Lenz({ apiKey: "lenz_t" }).withOptions({ apiKey: "lenz_é" }),
    ]) {
      let err: unknown;
      try {
        make();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LenzInvalidKeyError);
      expect(err).toBeInstanceOf(LenzAuthError);
      expect((err as LenzInvalidKeyError).statusCode).toBe(0);
      expect((err as Error).name).toBe("LenzInvalidKeyError");
    }
  });

  it("a missing key and a server 401 stay a plain LenzAuthError", async () => {
    const missing = await thrown(() => new Lenz({ apiKey: "" }).usage());
    expect(missing).toBeInstanceOf(LenzAuthError);
    expect(missing).not.toBeInstanceOf(LenzInvalidKeyError);
    const { fetch } = server(() => ({ status: 401, body: { detail: "Invalid api key" } }));
    const denied = await thrown(() => new Lenz({ apiKey: "lenz_t", fetch }).usage());
    expect(denied).toBeInstanceOf(LenzAuthError);
    expect(denied).not.toBeInstanceOf(LenzInvalidKeyError);
  });

  it("is exported from both entry points", () => {
    expect(browser.LenzInvalidKeyError).toBe(LenzInvalidKeyError);
  });
});

// ── 5: a field of the wrong type where the SDK reads it ──

describe("a field of the wrong type where the SDK reads it", () => {
  it.each([null, "x", 42, [null], [42], ["x"]])(
    "verifyBatchAndWait with items %j: LenzInvalidResponseError",
    async (items) => {
      const { fetch, sent } = server(() => ({
        status: 202,
        body: { batch_id: "b", items },
        headers: { "X-Request-ID": "req1" },
      }));
      const err = (await thrown(() =>
        new Lenz({ apiKey: "lenz_t", fetch }).verifyBatchAndWait({ claims: [{ claim: "a" }] }),
      )) as LenzInvalidResponseError;
      expect(err).toBeInstanceOf(LenzInvalidResponseError);
      expect(err.statusCode).toBe(202);
      expect(err.requestId).toBe("req1");
      expect(err.headers?.["x-request-id"]).toBe("req1");
      expect(err.body).toEqual({ batch_id: "b", items });
      expect(err.bodyText).toBe(JSON.stringify({ batch_id: "b", items }));
      expect(err.message).toContain("items");
      // No poll was sent.
      expect(sent).toHaveLength(1);
    },
  );

  it.each(["x", 42, [], true])(
    "a completed poll whose result is %j ends the wait at once: LenzInvalidResponseError",
    async (result) => {
      const body = { task_id: "t1", status: "completed", result };
      for (const legacyAliases of [true, false]) {
        const { fetch, sent } = server(() => ({ body }));
        const err = (await thrown(() =>
          new Lenz({ apiKey: "lenz_t", fetch, legacyAliases }).wait("t1"),
        )) as LenzInvalidResponseError;
        expect(err).toBeInstanceOf(LenzInvalidResponseError);
        expect(err.statusCode).toBe(200);
        expect(err.body).toEqual(body);
        expect(err.bodyText).toBe(JSON.stringify(body));
        expect(err.headers?.["content-type"]).toBe("application/json");
        expect(sent).toHaveLength(1);
      }
    },
  );

  it("in a batch wait too", async () => {
    const { fetch } = server((s) => {
      if (s.url.endsWith("/verify/batch")) {
        return { status: 202, body: { batch_id: "b", items: [{ task_id: "t1", claim: "a" }] } };
      }
      return { body: { task_id: "t1", status: "completed", result: "x" } };
    });
    const err = await thrown(() =>
      new Lenz({ apiKey: "lenz_t", fetch }).verifyBatchAndWait({ claims: [{ claim: "a" }] }),
    );
    expect(err).toBeInstanceOf(LenzInvalidResponseError);
  });

  it("a poll that cannot be read and is not ended is polled again", async () => {
    let polls = 0;
    const verification = { verification_id: "abcd1234", claim: "a" };
    const { fetch } = server(() => {
      polls += 1;
      return polls === 1
        ? { body: { task_id: "t1", status: 42 } }
        : { body: { task_id: "t1", status: "completed", result: verification } };
    });
    const v = await new Lenz({ apiKey: "lenz_t", fetch }).wait("t1");
    expect(polls).toBe(2);
    expect(v.raw).toEqual(verification);
  });

  it("at the deadline, the timeout carries the last unreadable poll as its cause", async () => {
    const body = { task_id: "t1", status: 42 };
    const { fetch } = server(() => ({ body, headers: { "X-Request-ID": "req9" } }));
    const err = (await thrown(() =>
      new Lenz({ apiKey: "lenz_t", fetch }).wait("t1", { timeoutMs: 50 }),
    )) as LenzTimeoutError;
    expect(err).toBeInstanceOf(LenzTimeoutError);
    expect(err.message).toBe("wait timed out after 50ms; the last polls could not be read");
    const cause = err.cause as LenzInvalidResponseError;
    expect(cause).toBeInstanceOf(LenzInvalidResponseError);
    expect(cause.body).toEqual(body);
    expect(cause.requestId).toBe("req9");
  });

  it("a review wait's timeout carries it too; a readable last poll leaves none", async () => {
    const running = {
      review_id: "r1",
      status: "verifying",
      claims: [],
      issues: [],
      failures: [],
      summary: {},
    };
    for (const [poll, unreadable] of [
      [{ review_id: "r1", status: "verifying" }, true],
      [running, false],
    ] as const) {
      const { fetch } = server((s) =>
        s.method === "POST"
          ? { status: 202, body: { review_id: "r1", status: "queued" } }
          : { body: poll },
      );
      const err = (await thrown(() =>
        new Lenz({ apiKey: "lenz_t", fetch }).reviewAndWait({ text: "Draft." }, { timeoutMs: 50 }),
      )) as LenzTimeoutError;
      expect(err).toBeInstanceOf(LenzTimeoutError);
      if (unreadable) {
        expect(err.message).toContain("the last polls could not be read");
        expect(err.cause).toBeInstanceOf(LenzInvalidResponseError);
      } else {
        expect(err.message).not.toContain("could not be read");
        expect(err.cause).toBeUndefined();
      }
    }
  });

  it("a cancel answering another job's body: LenzInvalidResponseError with the answer", async () => {
    const other = { review_id: "other", status: "cancelled", claims: [], issues: [], failures: [] };
    const { fetch } = server(() => ({ body: other, headers: { "X-Request-ID": "req2" } }));
    const err = (await thrown(() =>
      new Lenz({ apiKey: "lenz_t", fetch }).cancelReview("r1"),
    )) as LenzInvalidResponseError;
    expect(err).toBeInstanceOf(LenzInvalidResponseError);
    expect(err.statusCode).toBe(200);
    expect(err.requestId).toBe("req2");
    expect(err.body).toEqual(other);
    expect(err.message).toBe("POST /reviews/r1/cancel returned an unexpected response body.");
  });
});

// ── 6: a key's surrounding ASCII whitespace ──

it("ASCII whitespace around a key is dropped silently", async () => {
  const { fetch, sent } = server(() => ({ body: { tier: "free" } }));
  await new Lenz({ apiKey: " \tlenz_t\r\n", fetch }).usage();
  expect(sent[0]!.headers.get("authorization")).toBe("Bearer lenz_t");
});
