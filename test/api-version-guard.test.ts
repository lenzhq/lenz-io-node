/**
 * lenz-io 3.x reads only the 2026-10-11 response shape. It sends that version
 * on every request, and refuses a response that names another one.
 */

import { describe, expect, it } from "vitest";

import {
  API_VERSION,
  Lenz,
  LenzApiVersionError,
  LenzError,
  LenzValidationError,
} from "../src/index.js";
import * as browser from "../src/index.browser.js";

const SERVED = "X-Lenz-API-Version";

function recorder(respond: () => Response): {
  fetch: typeof fetch;
  sent: Array<Record<string, string>>;
} {
  const sent: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(Object.fromEntries(new Headers(init.headers).entries()));
    return respond();
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, sent };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function thrown(call: () => Promise<unknown>): Promise<LenzError> {
  try {
    await call();
  } catch (exc) {
    return exc as LenzError;
  }
  throw new Error("expected an error");
}

describe("the version header is the SDK's, on every request", () => {
  it("is set on a call that sends other headers and uses a caller-supplied fetch", async () => {
    const { fetch, sent } = recorder(() => json({ items: [], total: 0, page: 1, page_size: 20 }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.library.list();
    await client.verifications.list();
    expect(sent).toHaveLength(2);
    for (const headers of sent) expect(headers["x-lenz-api-version"]).toBe(API_VERSION);
  });

  it("replaces a stale value a call carries in its own headers, whatever the casing", async () => {
    const { fetch, sent } = recorder(() => json({}));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await client.request({
      method: "GET",
      path: "/usage",
      headers: { "x-lenz-api-version": "2026-05-13", "X-LENZ-API-VERSION": "2026-05-13" },
    });
    expect(sent[0]!["x-lenz-api-version"]).toBe(API_VERSION);
  });
});

describe("a response from another API version is refused", () => {
  it("throws LenzApiVersionError on a success body served in 2026-05-13", async () => {
    // A stored replay of an earlier idempotent call: the old shape, old header.
    const legacy = { task_id: "t1", status: "pending", detail: "stored" };
    const { fetch } = recorder(() => json(legacy, 200, { [SERVED]: "2026-05-13" }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = await thrown(() => client.verify({ claim: "The sky is blue." }));
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect(err).toBeInstanceOf(LenzError);
    expect(err.message).toBe("The API answered 2026-05-13; this SDK reads 2026-10-11 only.");
    expect((err as LenzApiVersionError).apiVersion).toBe("2026-05-13");
    expect(err.statusCode).toBe(200);
    expect(err.body).toEqual(legacy);
  });

  it("throws on an error response too, with the status and the body as sent", async () => {
    const legacy = { detail: [{ loc: ["body", "text"], msg: "Field required", type: "missing" }] };
    const { fetch } = recorder(() => json(legacy, 422, { [SERVED]: "2026-05-13" }));
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = await thrown(() => client.verify({ claim: "x" }));
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect(err).not.toBeInstanceOf(LenzValidationError);
    expect(err.statusCode).toBe(422);
    expect(err.body).toEqual(legacy);
  });

  it("is not retried: a 503 from another version throws at once", async () => {
    let calls = 0;
    const { fetch } = recorder(() => {
      calls += 1;
      return json({ detail: "x", code: "capacity" }, 503, {
        [SERVED]: "2026-05-13",
        "Retry-After": "1",
      });
    });
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 3 });
    const err = await thrown(() => client.usage());
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect(calls).toBe(1);
  });

  it("keeps a body that is not JSON as null", async () => {
    const { fetch } = recorder(
      () => new Response("<html>", { status: 502, headers: { [SERVED]: "2026-05-13" } }),
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = await thrown(() => client.usage());
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect(err.body).toBeNull();
  });

  it("throws the version error even when the body cannot be read", async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    const { fetch } = recorder(
      () => new Response(broken, { status: 200, headers: { [SERVED]: "2026-05-13" } }),
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = await thrown(() => client.usage());
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect(err.body).toBeNull();
  });

  it("is not read as 'already deleted' on a 404 delete", async () => {
    const { fetch } = recorder(() =>
      json({ detail: "Not found." }, 404, { [SERVED]: "2026-05-13" }),
    );
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = await thrown(() => client.verifications.delete("v1"));
    expect(err).toBeInstanceOf(LenzApiVersionError);
  });

  it("ends a wait at once instead of polling to the deadline", async () => {
    let calls = 0;
    const { fetch } = recorder(() => {
      calls += 1;
      return json({ status: "processing" }, 200, { [SERVED]: "2026-05-13" });
    });
    const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
    const err = await thrown(() => client.wait("t1", { timeoutMs: 5_000 }));
    expect(err).toBeInstanceOf(LenzApiVersionError);
    expect(calls).toBe(1);
  });

  it("passes a response that names the version it asked for", async () => {
    const { fetch } = recorder(() => json({ ok: true }, 200, { [SERVED]: API_VERSION }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.request({ method: "GET", path: "/usage" })).resolves.toEqual({ ok: true });
  });

  it("does not check a response that names no version", async () => {
    const { fetch } = recorder(() => json({ ok: true }));
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.request({ method: "GET", path: "/usage" })).resolves.toEqual({ ok: true });
  });

  it("is exported from the browser entry as well", () => {
    expect(browser.LenzApiVersionError).toBe(LenzApiVersionError);
  });
});
