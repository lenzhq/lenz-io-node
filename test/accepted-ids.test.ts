/**
 * An acceptance body that names a task, review or check by an id that cannot
 * be put in a path ("", "." or "..") is a bad answer from the server: every
 * `*AndWait` fails at once, after the submit alone, with a LenzAPIError. It
 * never enters the poll loop, where a local validation error would read as a
 * transient failure and end in a timeout minutes later.
 */

import { describe, expect, it } from "vitest";

import { Lenz, LenzAPIError, type VerifyBatchAndWaitInput } from "../src/index.js";

const BAD = ["", ".", ".."];

function oneSubmit(accepted: unknown): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
    return new Response(JSON.stringify(accepted), { status: 202 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const client = (fetch: typeof globalThis.fetch) =>
  new Lenz({ apiKey: "lenz_test", fetch, maxRetries: 0 });

const CASES: Array<
  [string, (c: Lenz) => Promise<unknown>, (id: string) => unknown, string, string]
> = [
  [
    "verifyAndWait",
    (c) => c.verifyAndWait({ claim: "x" }, { timeoutMs: 60_000 }),
    (id) => ({ task_id: id, status: "processing" }),
    "/api/v1/verify",
    "task_id",
  ],
  [
    "verifyBatchAndWait",
    (c) =>
      c.verifyBatchAndWait({ claims: [{ claim: "a" }] } as VerifyBatchAndWaitInput, {
        timeoutMs: 60_000,
      }),
    (id) => ({ batch_id: "b", items: [{ task_id: id, claim: "a" }] }),
    "/api/v1/verify/batch",
    "task_id",
  ],
  [
    "reviewAndWait",
    (c) => c.reviewAndWait({ text: "x" }, { timeoutMs: 60_000 }),
    (id) => ({ review_id: id, status: "queued" }),
    "/api/v1/review",
    "review_id",
  ],
  [
    "citecheckAndWait",
    (c) => c.citecheckAndWait({ text: "x" }, { timeoutMs: 60_000 }),
    (id) => ({ citecheck_id: id, status: "queued" }),
    "/api/v1/citecheck",
    "citecheck_id",
  ],
];

describe("an accepted id that cannot name one thing", () => {
  for (const [name, call, accepted, path, field] of CASES) {
    it.each(BAD)(`${name}: id %j fails at once after the submit alone`, async (id) => {
      const { fetch, calls } = oneSubmit(accepted(id));
      const started = Date.now();
      const err = (await call(client(fetch)).catch((e: unknown) => e)) as LenzAPIError;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(err).toBeInstanceOf(LenzAPIError);
      expect(err.message).toBe(`The API accepted the request with an invalid ${field}.`);
      expect(calls).toEqual([`POST ${path}`]);
    });
  }

  it("a batch with one good item and one bad id fails before any poll too", async () => {
    const { fetch, calls } = oneSubmit({
      batch_id: "b",
      items: [
        { task_id: "t1", claim: "a" },
        { task_id: "..", claim: "b" },
      ],
    });
    const err = await client(fetch)
      .verifyBatchAndWait({ claims: [{ claim: "a" }, { claim: "b" }] }, { timeoutMs: 60_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LenzAPIError);
    expect(calls).toEqual(["POST /api/v1/verify/batch"]);
  });
});

describe("a local validation error is never a transient poll failure", () => {
  // The helper's own error, thrown by a real client the way a poll would meet it.
  const refusing = new Lenz({ apiKey: "lenz_test", maxRetries: 0 });

  it("a wait whose poll throws it ends at once", async () => {
    const { fetch } = oneSubmit({ task_id: "t1", status: "processing" });
    const c = client(fetch);
    c.getStatus = (() => refusing.getStatus("..")) as typeof c.getStatus;
    const started = Date.now();
    const err = (await c.wait("t1", { timeoutMs: 30_000 }).catch((e: unknown) => e)) as Error;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err.message).toBe("getStatus() was given an invalid task_id.");
  });

  it("a batch wait whose poll throws it ends at once", async () => {
    const { fetch } = oneSubmit({ batch_id: "b", items: [{ task_id: "t1", claim: "a" }] });
    const c = client(fetch);
    c.getStatus = (() => refusing.getStatus("..")) as typeof c.getStatus;
    const started = Date.now();
    const err = (await c
      .verifyBatchAndWait({ claims: [{ claim: "a" }] }, { timeoutMs: 30_000 })
      .catch((e: unknown) => e)) as Error;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err.message).toBe("getStatus() was given an invalid task_id.");
  });

  it("the review and citation check poll loop too", async () => {
    const c = client(oneSubmit({}).fetch) as unknown as {
      _waitJob(job: Record<string, unknown>): Promise<unknown>;
    };
    const started = Date.now();
    const err = (await c
      ._waitJob({
        deadline: Date.now() + 30_000,
        read: () => refusing.getReview(".."),
        isBody: () => true,
        failed: () => new Error("failed"),
        timedOut: () => new Error("timed out"),
      })
      .catch((e: unknown) => e)) as Error;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err.message).toBe("getReview() was given an invalid review_id.");
  });
});
