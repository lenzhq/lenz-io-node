/**
 * 3.2, mirrored in the Python SDK: a blank input refused before sending says
 * the API's own 422 sentence for that operation, whatever `legacyAliases`
 * says; a blank `select` item and a blank `ask.send` message are refused
 * too; a wait reading a failure block of the wrong type throws
 * `LenzInvalidResponseError`; top-level results carry `httpStatus` and
 * `headers`; and a call made without a key throws `LenzMissingKeyError`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as browser from "../src/index.browser.js";
import {
  Lenz,
  LenzAuthError,
  LenzError,
  LenzInvalidKeyError,
  LenzInvalidResponseError,
  LenzMissingKeyError,
  LenzNeedsInputError,
  LenzValidationError,
} from "../src/index.js";

interface Sent {
  url: string;
  method: string;
  body: string | undefined;
}

type Reply = { status?: number; body?: unknown };

function server(reply: (sent: Sent) => Reply) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const s: Sent = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    sent.push(s);
    const r = reply(s);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", "x-request-id": "req-1" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

async function thrown(call: () => unknown): Promise<LenzError> {
  try {
    await call();
  } catch (exc) {
    return exc as LenzError;
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

// ── 1 + 2: the API's own sentence, in both modes ──

describe("a blank input refused locally says the API's canonical 422 sentence", () => {
  const REVIEW = "text: send the draft, or one public http(s) URL.";
  const CITECHECK = "payload: Value error, send exactly one of text and pairs";
  const cases: Array<[string, (c: Lenz) => Promise<unknown>, string, string, string]> = [
    ["verify", (c) => c.verify({ claim: " " }), "claim is required.", "blank_input", "claim"],
    [
      "verifyAndWait",
      (c) => c.verifyAndWait({ claim: "" }),
      "claim is required.",
      "blank_input",
      "claim",
    ],
    ["assess", (c) => c.assess({ claim: "\n" }), "claim is required.", "blank_input", "claim"],
    // Absent, not blank: the API's schema sentence (an empty list reads as absent there).
    ["verify {}", (c) => c.verify({}), "claim: Field required", "blank_input", "claim"],
    ["assess {}", (c) => c.assess({}), "claim: Field required", "blank_input", "claim"],
    ["assess []", (c) => c.assess({ claims: [] }), "claim: Field required", "empty_list", "claims"],
    [
      "assess [] beside a blank claim",
      (c) => c.assess({ claims: [], claim: " " }),
      "claim is required.",
      "blank_input",
      "claim",
    ],
    [
      "assess blank item",
      (c) => c.assess({ claims: ["a", " "] }),
      "claims[1] is blank.",
      "blank_item",
      "claims[1]",
    ],
    [
      "select []",
      (c) => c.select("t1", { claims: [] }),
      "claims is required.",
      "empty_list",
      "claims",
    ],
    [
      "select no claims",
      (c) => c.select("t1", {}),
      "claims: Field required",
      "empty_list",
      "claims",
    ],
    [
      "select texts []",
      (c) => c.select("t1", { texts: [] }),
      "texts is required.",
      "empty_list",
      "texts",
    ],
    [
      "select blank item",
      (c) => c.select("t1", { claims: ["a", " "] }),
      "claims[1] is blank.",
      "blank_item",
      "claims[1]",
    ],
    [
      "select blank texts item",
      (c) => c.select("t1", { texts: ["\t"] }),
      "texts[0] is blank.",
      "blank_item",
      "texts[0]",
    ],
    [
      "ask.send blank",
      (c) => c.ask.send("abcd1234", { message: "  " }),
      "Message cannot be empty.",
      "blank_input",
      "message",
    ],
    [
      "ask.send none",
      (c) => c.ask.send("abcd1234", {} as { message: string }),
      "message: Field required",
      "blank_input",
      "message",
    ],
    ["review", (c) => c.review({ text: " " }), REVIEW, "blank_input", "text"],
    [
      "review {}",
      (c) => c.review({} as { text: string }),
      "text: Field required",
      "blank_input",
      "text",
    ],
    ["reviewAndWait", (c) => c.reviewAndWait({ text: "" }), REVIEW, "blank_input", "text"],
    ["citecheck", (c) => c.citecheck({}), CITECHECK, "blank_input", "text"],
    [
      "citecheckAndWait",
      (c) => c.citecheckAndWait({ text: "  " }),
      CITECHECK,
      "blank_input",
      "text",
    ],
  ];

  for (const legacyAliases of [true, false]) {
    it.each(cases)(
      `%s (legacyAliases: ${legacyAliases})`,
      async (_name, run, sentence, code, param) => {
        const { fetch, sent } = server(() => ({ body: {} }));
        const err = await thrown(() => run(new Lenz({ apiKey: "lenz_t", fetch, legacyAliases })));
        expect(err).toBeInstanceOf(LenzValidationError);
        expect(err.message).toBe(sentence);
        expect(err.code).toBe(code);
        expect((err as LenzValidationError).param).toBe(param);
        expect(err.statusCode).toBe(0);
        expect(err.body).toBeNull();
        expect(sent).toEqual([]);
      },
    );
  }

  it("a select with every item filled sends the same request as before", async () => {
    const { fetch, sent } = server(() => ({ status: 202, body: { batch_id: "b", items: [] } }));
    await new Lenz({ apiKey: "lenz_t", fetch }).select("t1", { claims: ["a", "b"] });
    expect(sent[0]!.body).toBe('{"texts":["a","b"]}');
  });

  it.each([
    [5, "number"],
    [true, "boolean"],
    [null, "null"],
    [{ claim: "a" }, "object"],
    [["a"], "object"],
  ])("an assess item %j says Python's sentence, in both modes", async (item, type) => {
    for (const legacyAliases of [true, false]) {
      const { fetch, sent } = server(() => ({ body: {} }));
      const err = await thrown(() =>
        new Lenz({ apiKey: "lenz_t", fetch, legacyAliases }).assess({
          claims: ["a", item as unknown as string],
        }),
      );
      expect(err).toBeInstanceOf(LenzValidationError);
      expect(err.message).toBe(`claims[1] must be a string (got ${type}).`);
      expect(err.code).toBe("invalid_argument");
      expect((err as LenzValidationError).param).toBe("claims[1]");
      expect(sent).toEqual([]);
    }
  });

  it("a select claims that is not a list (from JavaScript) still reaches the API", async () => {
    const { fetch, sent } = server(() => ({ status: 202, body: { batch_id: "b", items: [] } }));
    await new Lenz({ apiKey: "lenz_t", fetch }).select("t1", {
      claims: "a claim" as unknown as string[],
    });
    expect(sent[0]!.body).toBe('{"texts":"a claim"}');
  });

  it("an ask.send with a message sends the same request as before", async () => {
    const { fetch, sent } = server(() => ({ body: { reply: "x" } }));
    await new Lenz({ apiKey: "lenz_t", fetch }).ask.send("abcd1234", {
      message: " why? ",
      idempotency: false,
    });
    expect(sent[0]!.body).toBe('{"message":" why? "}');
  });
});

// ── 3: a failure block of the wrong type where the SDK reads it ──

describe("a failure block that is not an object", () => {
  const status = (s: string, failure: unknown) => ({ task_id: "t1", status: s, failure });

  it.each([
    ["failed", "broken"],
    ["failed", 5],
    ["failed", ["x"]],
    ["cancelled", "broken"],
  ])("wait on %s with failure %j throws LenzInvalidResponseError", async (s, failure) => {
    const { fetch } = server(() => ({ body: status(s, failure) }));
    const err = await thrown(() => new Lenz({ apiKey: "lenz_t", fetch }).wait("t1"));
    expect(err).toBeInstanceOf(LenzInvalidResponseError);
    expect(err.message).toBe("GET /verify/status/t1 answered with failure of the wrong type.");
    expect(err.statusCode).toBe(200);
    expect(err.requestId).toBe("req-1");
    expect(err.body).toEqual(status(s, failure));
  });

  it("a completed poll with a bad failure still returns its verification", async () => {
    const body = {
      task_id: "t1",
      status: "completed",
      failure: "broken",
      result: { verification_id: "abcd1234" },
    };
    const { fetch } = server(() => ({ body }));
    const v = await new Lenz({ apiKey: "lenz_t", fetch }).wait("t1");
    expect(v.verification_id).toBe("abcd1234");
  });

  it("a needs_input poll with a bad failure still throws LenzNeedsInputError", async () => {
    const body = {
      task_id: "t1",
      status: "needs_input",
      reason: "multi_claim",
      claims: [],
      failure: 5,
    };
    const { fetch } = server(() => ({ body }));
    const err = await thrown(() => new Lenz({ apiKey: "lenz_t", fetch }).wait("t1"));
    expect(err).toBeInstanceOf(LenzNeedsInputError);
  });

  it("a null or absent failure on cancelled still reads as cancelled", async () => {
    for (const body of [status("cancelled", null), { task_id: "t1", status: "cancelled" }]) {
      const { fetch } = server(() => ({ body }));
      const err = await thrown(() => new Lenz({ apiKey: "lenz_t", fetch }).wait("t1"));
      expect(err).not.toBeInstanceOf(LenzInvalidResponseError);
      expect((err as unknown as { failureReason: string }).failureReason).toBe("cancelled");
    }
  });

  it("getStatus keeps it as sent (never replaced by the cancelled block)", async () => {
    const { fetch } = server(() => ({ body: status("cancelled", "broken") }));
    const st = await new Lenz({ apiKey: "lenz_t", fetch }).getStatus("t1");
    expect(st.failure as unknown).toBe("broken");
  });

  it("a batch wait's row for it fails with that error; the others stand", async () => {
    const { fetch } = server((s) => {
      if (s.url.endsWith("/verify/batch")) {
        return {
          status: 202,
          body: {
            batch_id: "b",
            items: [
              { task_id: "t1", claim: "a" },
              { task_id: "t2", claim: "b" },
            ],
          },
        };
      }
      if (s.url.endsWith("/t1")) return { body: status("failed", "broken") };
      return {
        body: { task_id: "t2", status: "completed", result: { verification_id: "abcd1234" } },
      };
    });
    const rows = await new Lenz({ apiKey: "lenz_t", fetch }).verifyBatchAndWait({
      claims: [{ claim: "a" }, { claim: "b" }],
    });
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toBeInstanceOf(LenzInvalidResponseError);
    expect(rows[0]!.error!.message).toContain("failure of the wrong type");
    expect(rows[1]!.status).toBe("completed");
    expect(rows[1]!.error).toBeUndefined();
  });

  it("assess: a row's or the body's failure of the wrong type throws (the 2.x reading reads it)", async () => {
    for (const body of [
      { claims: [{ claim: "a", status: "failed", failure: "broken" }], more_claims: [] },
      { claims: [], more_claims: [], failure: 7 },
    ]) {
      const { fetch } = server(() => ({ body }));
      const err = await thrown(() => new Lenz({ apiKey: "lenz_t", fetch }).assess({ claim: "a" }));
      expect(err).toBeInstanceOf(LenzInvalidResponseError);
      expect(err.message).toMatch(
        /^POST \/assess answered with (claims\[0\]\.)?failure of the wrong type\.$/,
      );
      expect(err.body).toEqual(body);
      // It may have charged: the key it sent rides the error, for a safe resend.
      const sentKey = new Headers(
        (fetch as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls.at(-1)![1]
          .headers,
      ).get("Idempotency-Key");
      expect(sentKey).toBeTruthy();
      expect(err.idempotencyKey).toBe(sentKey);
      // Read as sent, the body is returned as sent.
      const raw = await new Lenz({ apiKey: "lenz_t", fetch, legacyAliases: false }).assess({
        claim: "a",
      });
      expect(raw.raw).toEqual(body);
    }
  });

  it("assess: a null failure (a row with a verdict) reads as before", async () => {
    const body = {
      claims: [
        { claim: "a", status: "completed", verdict: "True", confidence: "high", failure: null },
      ],
      more_claims: [],
      failure: null,
    };
    const { fetch } = server(() => ({ body }));
    const out = await new Lenz({ apiKey: "lenz_t", fetch }).assess({ claim: "a" });
    expect(out.claims[0]!.verdict).toBe("True");
  });
});

// ── a completed poll with no result ──

describe("a completed poll that carries no result", () => {
  const SENTENCE =
    "The API answered HTTP 200 with status completed and no result: the run ended, but its verification cannot be read.";

  it.each([
    [{ task_id: "t1", status: "completed" }],
    [{ task_id: "t1", status: "completed", result: null }],
  ])("wait and verifyAndWait throw LenzInvalidResponseError (%j)", async (body) => {
    const { fetch } = server((s) =>
      s.url.endsWith("/verify") ? { status: 202, body: { task_id: "t1" } } : { body },
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    for (const run of [() => client.wait("t1"), () => client.verifyAndWait({ claim: "a" })]) {
      const err = await thrown(run);
      expect(err).toBeInstanceOf(LenzInvalidResponseError);
      expect(err.message).toBe(SENTENCE);
      expect(err.statusCode).toBe(200);
      expect(err.requestId).toBe("req-1");
      expect(err.headers?.["x-request-id"]).toBe("req-1");
      expect(err.body).toEqual(body);
    }
  });

  it("a batch wait's row carries the same error; the others stand", async () => {
    const { fetch } = server((s) => {
      if (s.url.endsWith("/verify/batch")) {
        return {
          status: 202,
          body: {
            batch_id: "b",
            items: [
              { task_id: "t1", claim: "a" },
              { task_id: "t2", claim: "b" },
            ],
          },
        };
      }
      if (s.url.endsWith("/t1")) return { body: { task_id: "t1", status: "completed" } };
      return {
        body: { task_id: "t2", status: "completed", result: { verification_id: "abcd1234" } },
      };
    });
    const rows = await new Lenz({ apiKey: "lenz_t", fetch }).verifyBatchAndWait({
      claims: [{ claim: "a" }, { claim: "b" }],
    });
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toBeInstanceOf(LenzInvalidResponseError);
    expect(rows[0]!.error!.message).toBe(SENTENCE);
    expect(rows[1]!.status).toBe("completed");
  });
});

// ── 4: httpStatus and headers on top-level results, runtime side ──

describe("every top-level result carries httpStatus and headers", () => {
  it("select, getCertificate and related too", async () => {
    const { fetch } = server((s) => {
      if (s.url.includes("/select")) return { status: 202, body: { batch_id: "b", items: [] } };
      if (s.url.includes("/certificate")) return { body: { verification_id: "abcd1234" } };
      return { body: { items: [] } };
    });
    const c = new Lenz({ apiKey: "lenz_t", fetch });
    const outs: Array<[unknown, number]> = [
      [await c.select("t1", { claims: ["a"] }), 202],
      [await c.verifications.getCertificate("abcd1234"), 200],
      [await c.verifications.related("abcd1234"), 200],
    ];
    for (const [out, code] of outs) {
      const o = out as { httpStatus: number; headers: Record<string, string> };
      expect(o.httpStatus).toBe(code);
      expect(o.headers["content-type"]).toBe("application/json");
    }
  });
});

// ── 5: LenzMissingKeyError ──

describe("LenzMissingKeyError", () => {
  it.each([
    ["no key", (fetch: typeof globalThis.fetch) => new Lenz({ apiKey: "", fetch })],
    ["whitespace", (fetch: typeof globalThis.fetch) => new Lenz({ apiKey: "  ", fetch })],
    [
      "a copy with none",
      (fetch: typeof globalThis.fetch) =>
        new Lenz({ apiKey: "lenz_t", fetch }).withOptions({ apiKey: null }),
    ],
  ])("%s: a call that needs one throws it before sending", async (_name, make) => {
    const { fetch, sent } = server(() => ({ body: {} }));
    const client = make(fetch);
    const err = await thrown(() => client.usage());
    expect(err).toBeInstanceOf(LenzMissingKeyError);
    expect(err).toBeInstanceOf(LenzAuthError);
    expect(err).not.toBeInstanceOf(LenzInvalidKeyError);
    expect(err.name).toBe("LenzMissingKeyError");
    expect(err.message).toBe("API key required");
    expect(err.statusCode).toBe(0);
    expect(sent).toEqual([]);
  });

  it("a server 401 stays a plain LenzAuthError", async () => {
    const { fetch } = server(() => ({
      status: 401,
      body: { detail: "Invalid API key.", code: "not_authenticated" },
    }));
    const err = await thrown(() => new Lenz({ apiKey: "lenz_t", fetch }).usage());
    expect(err).toBeInstanceOf(LenzAuthError);
    expect(err).not.toBeInstanceOf(LenzMissingKeyError);
    expect(err).not.toBeInstanceOf(LenzInvalidKeyError);
  });

  it("a malformed key stays LenzInvalidKeyError, not a missing one", () => {
    let err: unknown;
    try {
      new Lenz({ apiKey: "lenz_a b" });
    } catch (exc) {
      err = exc;
    }
    expect(err).toBeInstanceOf(LenzInvalidKeyError);
    expect(err).not.toBeInstanceOf(LenzMissingKeyError);
  });

  it("is exported from the browser entry point", () => {
    expect(browser.LenzMissingKeyError).toBe(LenzMissingKeyError);
  });
});
