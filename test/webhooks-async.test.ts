/**
 * `unwrap(request)` and `parseAsync(rawBody, headers)` verify with WebCrypto
 * and must agree with the synchronous `parse` on every input: the same event
 * for a valid delivery, the same `LenzWebhookSignatureError` (message, cause,
 * fix, docUrl) for everything else.
 */

import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LenzValidationError,
  LenzWebhooks,
  LenzWebhookSignatureError,
  verifySignature,
  verifySignatureAsync,
} from "../src/index.js";

const SECRET = "whsec_test_async";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shapes");

function sign(body: Uint8Array | string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function recordedPayloads(): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const shape of ["canonical", "legacy"]) {
    for (const file of readdirSync(join(ROOT, shape)).filter((f) => f.startsWith("webhook__"))) {
      const rec = JSON.parse(readFileSync(join(ROOT, shape, file), "utf-8")) as {
        payload: Record<string, unknown>;
      };
      out.push([`${shape}/${file}`, rec.payload]);
    }
  }
  return out;
}

const hooks = new LenzWebhooks({ secret: SECRET, replayWindowSeconds: 1e12 });

type Outcome = { event: unknown } | { error: Record<string, unknown> };

async function settle(run: () => unknown): Promise<Outcome> {
  try {
    return { event: await run() };
  } catch (exc) {
    if (!(exc instanceof LenzWebhookSignatureError)) throw exc;
    const e = exc as unknown as Record<string, unknown>;
    return {
      error: {
        name: exc.name,
        message: exc.message,
        cause: e["cause"],
        fix: e["fix"],
        docUrl: e["docUrl"],
      },
    };
  }
}

const viaParse = (raw: Uint8Array | string, headers: Record<string, string> | Headers) =>
  settle(() => hooks.parse(raw, headers));
const viaParseAsync = (raw: Uint8Array | string, headers: Record<string, string> | Headers) =>
  settle(() => hooks.parseAsync(raw, headers));
const viaUnwrap = (raw: Uint8Array | string, headers: Record<string, string>) =>
  settle(() =>
    hooks.unwrap(new Request("https://example.test/hook", { method: "POST", headers, body: raw })),
  );

describe("recorded deliveries", () => {
  const cases = recordedPayloads();
  it("the suite has deliveries to check", () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases)("%s: unwrap and parseAsync return what parse returns", async (_name, payload) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const headers = { "X-Lenz-Signature": sign(raw) };
    const expected = hooks.parse(raw, headers);
    expect(await hooks.parseAsync(raw, headers)).toEqual(expected);
    expect(
      await hooks.unwrap(
        new Request("https://example.test/hook", { method: "POST", headers, body: raw }),
      ),
    ).toEqual(expected);
  });
});

describe("parse, parseAsync and unwrap agree", () => {
  const now = () => new Date().toISOString();
  const good = JSON.stringify({
    event: "verification.failed",
    task_id: "t1",
    attempt: 1,
    delivered_at: now(),
    error: "x",
  });
  const goodBytes = new TextEncoder().encode(good);
  const strict = new LenzWebhooks({ secret: SECRET });
  const stale = JSON.stringify({
    event: "verification.failed",
    task_id: "t1",
    delivered_at: new Date(Date.now() - 3600_000).toISOString(),
  });

  const inputs: Array<[string, Uint8Array | string, Record<string, string>, LenzWebhooks]> = [
    ["a valid delivery (bytes)", goodBytes, { "X-Lenz-Signature": sign(goodBytes) }, strict],
    ["a valid delivery (string)", good, { "X-Lenz-Signature": sign(good) }, strict],
    ["lower-case header name", good, { "x-lenz-signature": sign(good) }, strict],
    ["a tampered body", good + " ", { "X-Lenz-Signature": sign(good) }, strict],
    ["a wrong secret", good, { "X-Lenz-Signature": sign(good, "whsec_other") }, strict],
    ["a missing header", good, {}, strict],
    ["an empty header", good, { "X-Lenz-Signature": "" }, strict],
    ["no sha256= prefix", good, { "X-Lenz-Signature": sign(good).slice(7) }, strict],
    ["upper-case hex", good, { "X-Lenz-Signature": sign(good).toUpperCase() }, strict],
    ["a truncated signature", good, { "X-Lenz-Signature": sign(good).slice(0, -2) }, strict],
    [
      "a signature with non-hex text",
      good,
      { "X-Lenz-Signature": "sha256=" + "zz".repeat(32) },
      strict,
    ],
    ["a non-ASCII signature", good, { "X-Lenz-Signature": "sha256=" + "é".repeat(32) }, strict],
    ["a stale delivered_at", stale, { "X-Lenz-Signature": sign(stale) }, strict],
    ["a stale delivered_at in a wide window", stale, { "X-Lenz-Signature": sign(stale) }, hooks],
    ["not JSON", "not json", { "X-Lenz-Signature": sign("not json") }, strict],
    ["an empty body", "", { "X-Lenz-Signature": sign("") }, strict],
    ["a JSON array", "[1,2]", { "X-Lenz-Signature": sign("[1,2]") }, strict],
    ["JSON null", "null", { "X-Lenz-Signature": sign("null") }, strict],
    ["a JSON string", '"hi"', { "X-Lenz-Signature": sign('"hi"') }, strict],
    ["a BOM before the JSON", "﻿" + good, { "X-Lenz-Signature": sign("﻿" + good) }, strict],
    [
      "non-ASCII text in the body",
      JSON.stringify({ event: "x.y", task_id: "t", note: "héllo \u{1F600} wörld" }),
      {
        "X-Lenz-Signature": sign(
          JSON.stringify({ event: "x.y", task_id: "t", note: "héllo \u{1F600} wörld" }),
        ),
      },
      strict,
    ],
    [
      "invalid UTF-8 under a valid signature",
      new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      {
        "X-Lenz-Signature": sign(
          new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
        ),
      },
      strict,
    ],
  ];

  it.each(inputs)("%s", async (_name, raw, headers, h) => {
    const run = (fn: "parse" | "parseAsync" | "unwrap") =>
      settle(() =>
        fn === "unwrap"
          ? h.unwrap(
              new Request("https://example.test/hook", {
                method: "POST",
                headers,
                body: raw,
              }),
            )
          : h[fn](raw, headers),
      );
    const expected = await run("parse");
    expect(await run("parseAsync")).toEqual(expected);
    expect(await run("unwrap")).toEqual(expected);
  });

  it("covers both outcomes", async () => {
    expect(await viaParse(good, { "X-Lenz-Signature": sign(good) })).toHaveProperty("event");
    expect(await viaParse(good, {})).toHaveProperty("error");
    expect(await viaParseAsync(good, {})).toHaveProperty("error");
    expect(await viaUnwrap(good, {})).toHaveProperty("error");
  });

  it("a Headers object works for parseAsync", async () => {
    const headers = new Headers({ "X-Lenz-Signature": sign(good) });
    expect(await viaParseAsync(good, headers)).toEqual(await viaParse(good, headers));
  });

  it("the errors are LenzWebhookSignatureError with the documented messages", async () => {
    await expect(
      strict.unwrap(new Request("https://example.test/", { method: "POST", body: good })),
    ).rejects.toThrow(/Missing webhook signature/);
    await expect(
      strict.parseAsync(good, { "X-Lenz-Signature": sign(good, "other") }),
    ).rejects.toBeInstanceOf(LenzWebhookSignatureError);
    await expect(
      strict.parseAsync(good, { "X-Lenz-Signature": sign(good, "other") }),
    ).rejects.toThrow(/Webhook signature mismatch/);
  });

  it("unwrap reads the body once, as bytes", async () => {
    const request = new Request("https://example.test/hook", {
      method: "POST",
      headers: { "X-Lenz-Signature": sign(good) },
      body: good,
    });
    const event = await strict.unwrap(request);
    expect(event.event).toBe("verification.failed");
    // The body was consumed: a handler that also read it would have failed.
    expect(request.bodyUsed).toBe(true);
  });

  it("accepts an ArrayBuffer and a Node Buffer", async () => {
    const buf = Buffer.from(good);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const headers = { "X-Lenz-Signature": sign(buf) };
    expect((await strict.parseAsync(buf, headers)).event).toBe("verification.failed");
    expect((await strict.parseAsync(ab, headers)).event).toBe("verification.failed");
  });
});

describe("the bytes that were signed are the bytes that are parsed", () => {
  const strict = new LenzWebhooks({ secret: SECRET });
  const signed = JSON.stringify({
    event: "verification.failed",
    task_id: "t_signed",
    delivered_at: new Date().toISOString(),
  });

  it("parseAsync ignores a caller who changes the buffer while it verifies", async () => {
    const buf = Buffer.from(signed);
    const headers = { "X-Lenz-Signature": sign(buf) };
    // Same length, so the JSON stays valid: only the fields differ.
    const at = buf.indexOf("t_signed");
    setImmediate(() => buf.write("t_forged", at));
    const outcome = await strict.parseAsync(buf, headers).then(
      (event) => ({ taskId: event.taskId }),
      (exc: unknown) => ({ error: exc }),
    );
    // Either the signed bytes' event, or a refusal: never the changed fields.
    if ("taskId" in outcome) expect(outcome.taskId).toBe("t_signed");
    else expect(outcome.error).toBeInstanceOf(LenzWebhookSignatureError);
    expect(buf.toString()).toContain("t_forged");
  });

  it("verifySignatureAsync and unwrap do not read the caller's buffer after verifying", async () => {
    const buf = Buffer.from(signed);
    const headers = { "X-Lenz-Signature": sign(buf) };
    const at = buf.indexOf("t_signed");
    const pending = strict.unwrap(
      new Request("https://example.test/hook", { method: "POST", headers, body: buf }),
    );
    buf.write("t_forged", at);
    expect((await pending).taskId).toBe("t_signed");
  });

  it("parse reads the buffer once, as signed", () => {
    const buf = Buffer.from(signed);
    expect(strict.parse(buf, { "X-Lenz-Signature": sign(buf) }).taskId).toBe("t_signed");
  });
});

describe("a body that is not bytes", () => {
  const strict = new LenzWebhooks({ secret: SECRET });
  const headers = { "X-Lenz-Signature": "sha256=" + "0".repeat(64) };
  const hostile: Array<[string, unknown]> = [
    ["{} from express.json()", {}],
    ["a parsed object", { event: "verification.completed", task_id: "t" }],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an array", [1, 2]],
  ];

  it.each(hostile)(
    "%s is the local argument error, naming the body parser, on every path",
    async (_n, body) => {
      const message = /body parser ran before LenzWebhooks/;
      expect(() => strict.parse(body as never, headers)).toThrow(LenzValidationError);
      expect(() => strict.parse(body as never, headers)).toThrow(message);
      await expect(strict.parseAsync(body as never, headers)).rejects.toThrow(LenzValidationError);
      await expect(strict.parseAsync(body as never, headers)).rejects.toThrow(message);
    },
  );

  it("still reports a missing signature before looking at the body", async () => {
    expect(() => strict.parse({} as never, {})).toThrow(/Missing webhook signature/);
    await expect(strict.parseAsync({} as never, {})).rejects.toThrow(/Missing webhook signature/);
  });

  it("a DataView and a Uint16Array are read as the bytes they cover", async () => {
    let text = JSON.stringify({ event: "x.y", task_id: "t_view" });
    if (text.length % 2) text += " ";
    const bytes = new TextEncoder().encode(text);
    expect(bytes.length % 2).toBe(0);
    const h = { "X-Lenz-Signature": sign(bytes) };
    const u16 = new Uint16Array(bytes.buffer.slice(0));
    const dv = new DataView(bytes.buffer.slice(0));
    for (const view of [u16, dv]) {
      expect(strict.parse(view as never, h).taskId).toBe("t_view");
      expect((await strict.parseAsync(view as never, h)).taskId).toBe("t_view");
    }
    // A view onto part of a larger buffer reads only its own bytes.
    const big = new Uint8Array(bytes.length + 8);
    big.set(bytes, 4);
    const part = new Uint8Array(big.buffer, 4, bytes.length);
    expect(strict.parse(part, h).taskId).toBe("t_view");
    expect((await strict.parseAsync(part, h)).taskId).toBe("t_view");
  });
});

describe("the secret", () => {
  it("an empty secret is refused by both verify functions, with the same error", async () => {
    const body = "{}";
    const sig = sign(body, "");
    let sync = "";
    try {
      verifySignature(body, sig, "");
    } catch (exc) {
      sync = String((exc as Error).message);
    }
    expect(sync).toMatch(/non-empty/);
    await expect(verifySignatureAsync(body, sig, "")).rejects.toThrow(sync);
    await expect(verifySignatureAsync(body, sig, "")).rejects.toBeInstanceOf(Error);
  });
});

describe("header values", () => {
  const strict = new LenzWebhooks({ secret: SECRET });
  const body = JSON.stringify({ event: "x.y", task_id: "t_arr" });
  const good = sign(body);

  it("an array value reads as its first element, on both paths", async () => {
    const headers = { "X-Lenz-Signature": [good, "sha256=other"] } as never;
    expect(strict.parse(body, headers).taskId).toBe("t_arr");
    expect((await strict.parseAsync(body, headers)).taskId).toBe("t_arr");
  });

  it("an array whose first element is wrong is a mismatch, an empty one is missing", async () => {
    const wrong = { "X-Lenz-Signature": ["sha256=other", good] } as never;
    expect(() => strict.parse(body, wrong)).toThrow(/signature mismatch/);
    await expect(strict.parseAsync(body, wrong)).rejects.toThrow(/signature mismatch/);
    const empty = { "X-Lenz-Signature": [] } as never;
    expect(() => strict.parse(body, empty)).toThrow(/Missing webhook signature/);
    await expect(strict.parseAsync(body, empty)).rejects.toThrow(/Missing webhook signature/);
  });
});

describe("unwrap on a Request whose body was read", () => {
  it("says to call unwrap first", async () => {
    const strict = new LenzWebhooks({ secret: SECRET });
    const request = new Request("https://example.test/hook", {
      method: "POST",
      headers: { "X-Lenz-Signature": sign("{}") },
      body: "{}",
    });
    await request.text();
    await expect(strict.unwrap(request)).rejects.toThrow(/unwrap before reading the body/);
  });
});
