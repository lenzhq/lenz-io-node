/**
 * `text` is a document, `claim` is a claim — and nothing on the wire changes.
 *
 * `assess`, `verify`, batch items and `select` take `claim` / `claims` from
 * 2.10.0; the older spellings stay as aliases. Each test pins one of two
 * things: the new name reaches the same wire key the server has always
 * accepted, or an existing call's request body is unchanged from 2.9.x.
 */

import { describe, expect, it, vi } from "vitest";

import { Lenz } from "../src/index.js";

const CLAIM = "The Danube flows through more countries than any other river.";

interface Call {
  url: string;
  init: RequestInit;
}

function makeFetch(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch, calls };
}

function sent(calls: Call[]): Record<string, unknown> {
  return JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
}

describe("assess", () => {
  it("claim sends the text wire key", async () => {
    const { fetch, calls } = makeFetch({ claims: [] });
    await new Lenz({ apiKey: "lenz_t", fetch }).assess({ claim: CLAIM });
    expect(sent(calls)).toEqual({ text: CLAIM });
  });

  it("text still works, byte-identically", async () => {
    const { fetch, calls } = makeFetch({ claims: [] });
    await new Lenz({ apiKey: "lenz_t", fetch }).assess({ text: CLAIM, language: "es" });
    expect(sent(calls)).toEqual({ text: CLAIM, language: "es" });
  });

  it("claim wins when both are given", async () => {
    const { fetch, calls } = makeFetch({ claims: [] });
    await new Lenz({ apiKey: "lenz_t", fetch }).assess({ claim: CLAIM, text: "ignored" });
    expect(sent(calls)).toEqual({ text: CLAIM });
  });
});

describe("verify", () => {
  const accepted = { task_id: "tsk_1", status: "queued" };

  it("text is an alias for claim", async () => {
    const { fetch, calls } = makeFetch(accepted, 202);
    await new Lenz({ apiKey: "lenz_t", fetch }).verify({ text: CLAIM });
    expect(sent(calls).text).toBe(CLAIM);
  });

  it("claim is unchanged", async () => {
    const { fetch, calls } = makeFetch(accepted, 202);
    await new Lenz({ apiKey: "lenz_t", fetch }).verify({ claim: CLAIM });
    expect(sent(calls)).toEqual({ text: CLAIM, source_url: "", webhook_url: "" });
  });
});

describe("verifyBatch", () => {
  const accepted = { batch_id: "bat_1", items: [{ task_id: "tsk_1", claim_text: CLAIM }] };

  it("item claim is sent as text", async () => {
    const { fetch, calls } = makeFetch(accepted, 202);
    await new Lenz({ apiKey: "lenz_t", fetch }).verifyBatch({
      claims: [{ claim: CLAIM, language: "es" }],
    });
    expect(sent(calls).claims).toEqual([
      { text: CLAIM, source_url: "", webhook_url: "", language: "es" },
    ]);
  });

  it("item text is unchanged", async () => {
    const { fetch, calls } = makeFetch(accepted, 202);
    await new Lenz({ apiKey: "lenz_t", fetch }).verifyBatch({ claims: [{ text: CLAIM }] });
    expect(sent(calls).claims).toEqual([{ text: CLAIM, source_url: "", webhook_url: "" }]);
  });
});

describe("select", () => {
  const accepted = { batch_id: "bat_1", items: [{ task_id: "tsk_2", claim_text: CLAIM }] };

  it("claims sends the texts wire key", async () => {
    const { fetch, calls } = makeFetch(accepted);
    await new Lenz({ apiKey: "lenz_t", fetch }).select("tsk_1", { claims: [CLAIM] });
    expect(sent(calls)).toEqual({ texts: [CLAIM] });
  });

  it("texts still works", async () => {
    const { fetch, calls } = makeFetch(accepted);
    await new Lenz({ apiKey: "lenz_t", fetch }).select("tsk_1", { texts: [CLAIM] });
    expect(sent(calls)).toEqual({ texts: [CLAIM] });
  });

  it("neither throws", async () => {
    const client = new Lenz({ apiKey: "lenz_t" });
    await expect(() => client.select("tsk_1", {})).rejects.toThrow(/non-empty claims/);
  });
});
