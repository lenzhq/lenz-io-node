/**
 * Stopping a run: `cancel`, `cancelReview` and `cancelCitecheck`.
 *
 * Responses are the API's own recordings (`fixtures/shapes/canonical/`,
 * imported by `scripts/import-shapes.mjs`). None of the three sends a body or
 * an Idempotency-Key: cancelling is idempotent by nature, and a second cancel
 * of a run that already ended answers with the run as it stands.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  Lenz,
  LenzApiVersionError,
  LenzAPIError,
  LenzAuthError,
  LenzError,
  LenzInvalidResponseError,
  LenzNotFoundError,
  type CancelResult,
  type Citecheck,
  type ReviewFull,
  type TaskStatus,
  LenzValidationError,
} from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shapes", "canonical");

function recorded(name: string): { status: number; body: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(ROOT, `${name}.json`), "utf-8")) as {
    status: number;
    body: Record<string, unknown>;
  };
}

interface Call {
  url: URL;
  init: RequestInit;
}

/** A fetch that answers each call in turn with a recording, and keeps the calls. */
function serving(...answers: Array<Response | (() => Response)>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ url: u, init: init ?? {} });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return forTheIdAsked(u, typeof next === "function" ? next() : next.clone());
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const ID_FIELD: Record<string, string> = {
  verify: "task_id",
  reviews: "review_id",
  citechecks: "citecheck_id",
};

/**
 * A recording answered for the id the call asked for: a cancel (and a read)
 * must name the job asked for (3.0 checks it), so the recorded id is
 * replaced with the requested one. Other bodies go as recorded.
 */
async function forTheIdAsked(url: URL, response: Response): Promise<Response> {
  const m = /^\/api\/v1\/(verify|reviews|citechecks)\/([^/]+)(?:\/cancel)?$/.exec(url.pathname);
  if (!m || response.status !== 200) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const field = ID_FIELD[m[1]!]!;
  if (!body || typeof body !== "object" || Array.isArray(body) || !(field in body)) {
    return response;
  }
  return new Response(JSON.stringify({ ...(body as object), [field]: decodeURIComponent(m[2]!) }), {
    status: response.status,
    headers: response.headers,
  });
}

function reply(name: string, headers: Record<string, string> = {}): Response {
  const r = recorded(name);
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const make = (fetch: typeof globalThis.fetch, maxRetries = 0) =>
  new Lenz({ apiKey: "lenz_test", fetch, maxRetries });

describe("cancel(taskId)", () => {
  it("POSTs /verify/{task_id}/cancel with no body, no Idempotency-Key and no Content-Type", async () => {
    const { fetch, calls } = serving(reply("verify__cancel_200_cancelled"));
    await make(fetch).cancel("t1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/api/v1/verify/t1/cancel");
    expect(calls[0]!.url.search).toBe("");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBeNull();
    expect(headers.get("Content-Type")).toBeNull();
    expect(headers.get("Authorization")).toBe("Bearer lenz_test");
  });

  it("a run it stopped: cancelled true, status cancelled", async () => {
    const { fetch } = serving(reply("verify__cancel_200_cancelled"));
    const out = await make(fetch).cancel(
      String(recorded("verify__cancel_200_cancelled").body["task_id"]),
    );
    expect(out).toEqual(recorded("verify__cancel_200_cancelled").body);
    expect(out).toEqual({
      task_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      cancelled: true,
      status: "cancelled",
    });
  });

  it("a run that had already finished: cancelled false with its final status", async () => {
    const { fetch } = serving(reply("verify__cancel_200_completed"));
    const out = await make(fetch).cancel(
      String(recorded("verify__cancel_200_completed").body["task_id"]),
    );
    expect(out.cancelled).toBe(false);
    expect(out.status).toBe("completed");
    expect(out.task_id).toBe(recorded("verify__cancel_200_completed").body["task_id"]);
  });

  it("encodes the id and refuses an empty one before any request", async () => {
    const { fetch, calls } = serving(reply("verify__cancel_200_cancelled"));
    const client = make(fetch);
    await client.cancel("a/b c");
    expect(calls[0]!.url.pathname).toBe("/api/v1/verify/a%2Fb%20c/cancel");
    await expect(client.cancel("")).rejects.toThrow("cancel() requires a non-empty task_id.");
    expect(calls).toHaveLength(1);
  });

  it.each(["verify__cancel_404", "verify__cancel_not_yours_404"])(
    "%s: LenzNotFoundError with the server's code",
    async (name) => {
      const { fetch, calls } = serving(reply(name));
      const err = (await make(fetch, 2)
        .cancel("t1")
        .catch((e: unknown) => e)) as LenzNotFoundError;
      expect(err).toBeInstanceOf(LenzNotFoundError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("Task not found.");
      expect(calls).toHaveLength(1);
    },
  );

  it("the 409 use_review_cancel is a LenzError with that code, sent once and never waited on", async () => {
    // Default retries, and a Retry-After the retry ladder would honour for a
    // 5xx: the only 409s the client waits on are an in-flight Idempotency-Key.
    const { fetch, calls } = serving(
      reply("verify__cancel_review_child_409", { "Retry-After": "1" }),
    );
    const started = Date.now();
    const err = (await new Lenz({ apiKey: "lenz_test", fetch })
      .cancel("t1")
      .catch((e: unknown) => e)) as LenzError;
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(LenzError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("use_review_cancel");
    expect(err.message).toBe("This task is a review's deep check. Cancel the review to cancel it.");
    expect(err.retryable).toBe(false);
    expect(err.fix).toBe(
      "Cancel the review that started this task instead: client.cancelReview(reviewId).",
    );
  });

  it("a 409 idempotency_conflict is not retried either: this call has no key", async () => {
    const conflict = () =>
      new Response(JSON.stringify({ detail: "In flight.", code: "idempotency_conflict" }), {
        status: 409,
      });
    const { fetch, calls } = serving(conflict);
    const err = (await new Lenz({ apiKey: "lenz_test", fetch })
      .cancel("t1")
      .catch((e: unknown) => e)) as LenzError;
    expect(calls).toHaveLength(1);
    expect(err.statusCode).toBe(409);
  });

  it("answers in another API version: LenzApiVersionError, one request", async () => {
    const { fetch, calls } = serving(
      new Response(JSON.stringify({ task_id: "t1", cancelled: true, status: "cancelled" }), {
        status: 200,
        headers: { "X-Lenz-API-Version": "2026-05-13" },
      }),
    );
    const err = await new Lenz({ apiKey: "lenz_test", fetch })
      .cancel("t1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect(calls).toHaveLength(1);
  });

  it("a 401 is the auth error", async () => {
    const { fetch } = serving(
      new Response(JSON.stringify({ detail: "Bad key.", code: "not_authenticated" }), {
        status: 401,
      }),
    );
    const err = await make(fetch, 2)
      .cancel("t1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzAuthError);
  });

  it("a 5xx or a dropped connection is retried on the client's ladder, still without a key", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const calls: Array<Headers> = [];
      const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
        calls.push(new Headers(init?.headers));
        n += 1;
        if (n === 1) return new Response(JSON.stringify({ detail: "boom" }), { status: 500 });
        if (n === 2) throw new TypeError("fetch failed");
        return reply("verify__cancel_200_cancelled");
      }) as typeof fetch;
      const pending = new Lenz({ apiKey: "lenz_test", fetch: fetchImpl }).cancel(
        String(recorded("verify__cancel_200_cancelled").body["task_id"]),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const out = await pending;
      expect(out.cancelled).toBe(true);
      expect(calls).toHaveLength(3);
      for (const h of calls) expect(h.get("Idempotency-Key")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the result type", () => {
    expectTypeOf<CancelResult>().toEqualTypeOf<{
      task_id: string;
      cancelled: boolean;
      status: TaskStatus["status"];
      readonly raw?: Record<string, unknown>;
      readonly httpStatus?: number;
      readonly headers?: Record<string, string>;
    }>();
  });
});

describe("cancelReview(reviewId)", () => {
  const CASES = [
    "review__cancel_200_cancelled",
    "review__cancel_200_already_cancelled",
    "review__cancel_200_completed",
  ] as const;

  it("POSTs /reviews/{review_id}/cancel with no body and no Idempotency-Key", async () => {
    const { fetch, calls } = serving(reply(CASES[0]));
    await make(fetch).cancelReview("r1");
    expect(calls[0]!.url.pathname).toBe("/api/v1/reviews/r1/cancel");
    expect(calls[0]!.url.search).toBe("");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBeNull();
    expect(headers.get("Content-Type")).toBeNull();
  });

  it.each(CASES)("%s: the full view, read the way getReview reads it", async (name) => {
    const { fetch } = serving(reply(name));
    const cancelled = await make(fetch).cancelReview("r1");
    const read = await make(serving(reply(name)).fetch).getReview("r1");
    expect(cancelled).toEqual(read);
    expect(cancelled.status).toBe(String(recorded(name).body["status"]));
    expectTypeOf(cancelled).toEqualTypeOf<ReviewFull>();
  });

  it("a review it stopped reads cancelled, and one that had finished is returned as it was", async () => {
    const stopped = await make(serving(reply(CASES[0])).fetch).cancelReview("r1");
    expect(stopped.status).toBe("cancelled");
    expect(stopped.outcome).toBe("incomplete");
    const done = await make(serving(reply(CASES[2])).fetch).cancelReview("r1");
    expect(done.status).toBe("completed");
    expect(done.outcome).toBe("clean");
  });

  it("encodes the id and refuses an empty one before any request", async () => {
    const { fetch, calls } = serving(reply(CASES[0]));
    const client = make(fetch);
    await client.cancelReview("a/b");
    expect(calls[0]!.url.pathname).toBe("/api/v1/reviews/a%2Fb/cancel");
    await expect(client.cancelReview("")).rejects.toThrow(
      "cancelReview() requires a non-empty review_id.",
    );
    expect(calls).toHaveLength(1);
  });

  it.each(["review__cancel_404_not_found", "review__cancel_404_other_account"])(
    "%s: LenzNotFoundError",
    async (name) => {
      const { fetch, calls } = serving(reply(name));
      const err = (await make(fetch, 2)
        .cancelReview("r1")
        .catch((e: unknown) => e)) as LenzNotFoundError;
      expect(err).toBeInstanceOf(LenzNotFoundError);
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("Review not found.");
      expect(calls).toHaveLength(1);
    },
  );

  it("answers in another API version: LenzApiVersionError on a 200", async () => {
    const { fetch } = serving(
      new Response("{}", { status: 200, headers: { "X-Lenz-API-Version": "2026-05-13" } }),
    );
    const err = await make(fetch)
      .cancelReview("r1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzApiVersionError);
  });

  it("a 404 in another API version is the 404, with servedVersion (3.2)", async () => {
    const { fetch } = serving(
      new Response("{}", { status: 404, headers: { "X-Lenz-API-Version": "2026-05-13" } }),
    );
    const err = (await make(fetch)
      .cancelReview("r1")
      .catch((e: unknown) => e)) as LenzNotFoundError;
    expect(err).toBeInstanceOf(LenzNotFoundError);
    expect(err.servedVersion).toBe("2026-05-13");
  });
});

describe("cancelCitecheck(citecheckId)", () => {
  const CASES = [
    "citecheck__cancel_200_cancelled",
    "citecheck__cancel_200_already_cancelled",
    "citecheck__cancel_200_completed",
  ] as const;

  it("POSTs /citechecks/{citecheck_id}/cancel with no body and no Idempotency-Key", async () => {
    const { fetch, calls } = serving(reply(CASES[0]));
    await make(fetch).cancelCitecheck("c1");
    expect(calls[0]!.url.pathname).toBe("/api/v1/citechecks/c1/cancel");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBeNull();
    expect(headers.get("Content-Type")).toBeNull();
  });

  it.each(CASES)("%s: the check, read the way getCitecheck reads it", async (name) => {
    const cancelled = await make(serving(reply(name)).fetch).cancelCitecheck("c1");
    const read = await make(serving(reply(name)).fetch).getCitecheck("c1");
    expect(cancelled).toEqual(read);
    expect(cancelled.status).toBe(String(recorded(name).body["status"]));
    expectTypeOf(cancelled).toEqualTypeOf<Citecheck>();
  });

  it("encodes the id and refuses an empty one before any request", async () => {
    const { fetch, calls } = serving(reply(CASES[0]));
    const client = make(fetch);
    await client.cancelCitecheck("a/b");
    expect(calls[0]!.url.pathname).toBe("/api/v1/citechecks/a%2Fb/cancel");
    await expect(client.cancelCitecheck("")).rejects.toThrow(
      "cancelCitecheck() requires a non-empty citecheck_id.",
    );
    expect(calls).toHaveLength(1);
  });

  it.each(["citecheck__cancel_404_not_found", "citecheck__cancel_404_review_id"])(
    "%s: LenzNotFoundError",
    async (name) => {
      const { fetch, calls } = serving(reply(name));
      const err = (await make(fetch, 2)
        .cancelCitecheck("c1")
        .catch((e: unknown) => e)) as LenzNotFoundError;
      expect(err).toBeInstanceOf(LenzNotFoundError);
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("Citation check not found.");
      expect(calls).toHaveLength(1);
    },
  );
});

describe("ids that cannot name one run", () => {
  const CALLS: Array<[string, (c: Lenz, id: string) => Promise<unknown>, string]> = [
    ["cancel", (c, id) => c.cancel(id), "task_id"],
    ["cancelReview", (c, id) => c.cancelReview(id), "review_id"],
    ["cancelCitecheck", (c, id) => c.cancelCitecheck(id), "citecheck_id"],
    ["getReview", (c, id) => c.getReview(id), "review_id"],
    ["getCitecheck", (c, id) => c.getCitecheck(id), "citecheck_id"],
  ];

  it.each(CALLS)(
    "%s refuses '.', '..' and a lone surrogate before any request",
    async (name, call, field) => {
      const { fetch, calls } = serving(reply("verify__cancel_200_cancelled"));
      const client = make(fetch);
      for (const id of [".", "..", "ab\ud800"]) {
        const err = (await call(client, id).catch((e: unknown) => e)) as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(URIError);
        // Since 3.2 the local argument error: a LenzValidationError, no status.
        expect(err).toBeInstanceOf(LenzValidationError);
        expect((err as LenzError).statusCode).toBe(0);
        expect((err as LenzError).code).toBe("invalid_id");
        expect(err.message).toBe(`${name}() was given an invalid ${field}.`);
      }
      expect(calls).toHaveLength(0);
    },
  );

  it("an id with dots inside, or a full stop, is still sent as it was", async () => {
    const { fetch, calls } = serving(reply("verify__cancel_200_cancelled"));
    await make(fetch).cancel("a.b");
    await make(fetch).cancel("...");
    expect(calls[0]!.url.pathname).toBe("/api/v1/verify/a.b/cancel");
    expect(calls[1]!.url.pathname).toBe("/api/v1/verify/.../cancel");
  });
});

describe("a 200 that is not a cancel result", () => {
  const empty = () => new Response("", { status: 200, headers: { "content-length": "0" } });
  const noContent = () => new Response(null, { status: 204 });
  const noTaskId = () =>
    new Response(JSON.stringify({ cancelled: true, status: "cancelled" }), { status: 200 });
  const notAnObject = () => new Response("[]", { status: 200 });

  it.each([
    ["a list", notAnObject],
    ["an empty body", empty],
    ["a 204", noContent],
  ])("cancel throws LenzInvalidResponseError for %s (3.2)", async (_label, answer) => {
    const { fetch, calls } = serving(answer);
    const err = (await make(fetch)
      .cancel("t1")
      .catch((e: unknown) => e)) as LenzAPIError;
    expect(err).toBeInstanceOf(LenzInvalidResponseError);
    expect(err).toBeInstanceOf(LenzAPIError);
    expect(calls).toHaveLength(1);
  });

  it.each([["a body without task_id", noTaskId]])(
    "cancel throws LenzAPIError for %s",
    async (_label, answer) => {
      const { fetch, calls } = serving(answer);
      const err = (await make(fetch)
        .cancel("t1")
        .catch((e: unknown) => e)) as LenzAPIError;
      expect(err).toBeInstanceOf(LenzAPIError);
      expect(err.message).toBe("POST /verify/t1/cancel answered without a cancel result.");
      expect(calls).toHaveLength(1);
    },
  );
});

describe("every id that goes into a path", () => {
  const ok = () => new Response("{}", { status: 200 });
  const TRAVERSAL: Array<[string, string]> = [
    ["../x", "..%2Fx"],
    ["a/b", "a%2Fb"],
    ["a?b", "a%3Fb"],
    ["a#b", "a%23b"],
  ];

  // Each call with the path it must make for a normal id `ID`.
  const CALLS: Array<[string, (c: Lenz, id: string) => Promise<unknown>, string, string]> = [
    ["getStatus", (c, id) => c.getStatus(id), "GET", "/verify/status/ID"],
    ["select", (c, id) => c.select(id, { claims: ["a"] }), "POST", "/verify/ID/select"],
    ["verifications.get", (c, id) => c.verifications.get(id), "GET", "/verifications/ID"],
    [
      "verifications.getCertificate",
      (c, id) => c.verifications.getCertificate(id),
      "GET",
      "/verifications/ID/certificate",
    ],
    ["verifications.delete", (c, id) => c.verifications.delete(id), "DELETE", "/verifications/ID"],
    [
      "verifications.related",
      (c, id) => c.verifications.related(id),
      "GET",
      "/verifications/ID/related",
    ],
    ["ask.history", (c, id) => c.ask.history(id), "GET", "/ask/ID"],
    ["ask.send", (c, id) => c.ask.send(id, { message: "x" }), "POST", "/ask/ID"],
    ["ask.reset", (c, id) => c.ask.reset(id), "DELETE", "/ask/ID"],
    ["getReview", (c, id) => c.getReview(id), "GET", "/reviews/ID"],
    ["getCitecheck", (c, id) => c.getCitecheck(id), "GET", "/citechecks/ID"],
    ["cancel", (c, id) => c.cancel(id), "POST", "/verify/ID/cancel"],
    ["cancelReview", (c, id) => c.cancelReview(id), "POST", "/reviews/ID/cancel"],
    ["cancelCitecheck", (c, id) => c.cancelCitecheck(id), "POST", "/citechecks/ID/cancel"],
  ];

  const answer = (name: string) =>
    name === "cancel"
      ? () =>
          new Response(JSON.stringify({ task_id: "t", cancelled: true, status: "cancelled" }), {
            status: 200,
          })
      : ok;

  it.each(CALLS)("%s: a traversal id stays one path segment", async (name, call, method, tpl) => {
    for (const [id, encoded] of TRAVERSAL) {
      const { fetch, calls } = serving(answer(name));
      await call(make(fetch), id).catch(() => undefined);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.method).toBe(method);
      expect(calls[0]!.url.search).toBe(name === "verifications.related" ? "?limit=5" : "");
      expect(calls[0]!.url.hash).toBe("");
      expect(calls[0]!.url.pathname).toBe(`/api/v1${tpl.replace("ID", encoded)}`);
    }
  });

  it.each(CALLS)("%s: '.' and '..' are refused with no request", async (name, call) => {
    const { fetch, calls } = serving(answer(name));
    for (const id of [".", "..", ""]) {
      const err = (await call(make(fetch), id).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(LenzValidationError);
      expect(err.message).toMatch(new RegExp(`^${name.replace(".", "\\.")}\\(\\) `));
    }
    expect(calls).toHaveLength(0);
  });

  it("wait refuses them too, before polling", async () => {
    const { fetch, calls } = serving(ok);
    for (const id of [".", ".."]) {
      const err = (await make(fetch)
        .wait(id, { timeoutMs: 1000 })
        .catch((e: unknown) => e)) as Error;
      expect(err.message).toBe("wait() was given an invalid task_id.");
    }
    expect(calls).toHaveLength(0);
  });
});
