/**
 * `POST /citecheck` + `GET /citechecks/{id}` + `citecheckAndWait`.
 *
 * The completed bodies are recorded server responses in
 * `test/fixtures/contract/` (the same files the Python SDK reads): one check
 * of a draft's first four citations, and one of two statement-source pairs.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CitecheckFailedError,
  CitecheckTimeoutError,
  Lenz,
  LenzGoneError,
  LenzPipelineError,
  LenzTimeoutError,
  LenzWebhooks,
} from "../src/index.js";
import type { Citecheck, CitecheckCompleted, CitecheckInput } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "contract", name), "utf-8")) as T;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(responses: Iterable<{ status?: number; body?: unknown }>) {
  const queue = Array.from(responses);
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("No more mocked responses");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

function sentBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const ACCEPTED = fixture("citecheck_accepted.json");
const COMPLETED = fixture<Citecheck>("citecheck_completed.json");
const PAIRS_COMPLETED = fixture<Citecheck>("citecheck_pairs_completed.json");
const CHECK_ID = COMPLETED.citecheck_id;
const DRAFT =
  "Water boils at 100 degrees Celsius, according to [the entry](https://en.wikipedia.org/wiki/Boiling_point).";

/** The completed body with its rows set back to waiting. */
function running(): Citecheck {
  const body = JSON.parse(JSON.stringify(COMPLETED)) as Citecheck;
  body.status = "checking";
  body.outcome = null;
  body.completed_at = null;
  body.poll_after_seconds = 5;
  for (const row of body.citations) {
    row.result = null;
    row.check.status = "running";
  }
  body.citation_issues = [];
  return body;
}

// ── submit ───────────────────────────────────────────────────────────────

describe("citecheck()", () => {
  async function sent(input: CitecheckInput): Promise<Record<string, unknown>> {
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const started = await client.citecheck({ idempotencyKey: "k", ...input });
    expect(started).toEqual({ citecheck_id: CHECK_ID, status: "queued" });
    expect(calls[0]!.url).toBe("https://lenz.io/api/v1/citecheck");
    return sentBody(calls[0]!);
  }

  it("sends a draft as text", async () => {
    expect(await sent({ text: DRAFT })).toEqual({ text: DRAFT });
  });

  it("sends the options under their wire names", async () => {
    expect(await sent({ text: DRAFT, maxCitations: 4, language: "de", webhookUrl: "" })).toEqual({
      text: DRAFT,
      max_citations: 4,
      language: "de",
      webhook_url: "",
    });
  });

  it("sends pairs as they are", async () => {
    const pairs = [
      { statement: "Water boils at 100 degrees Celsius.", url: "https://example.org/boiling" },
      {
        statement: "Diamond sensors measure heat in cells.",
        doi: "10.1038/nature12373",
        cited_year: "2015",
      },
    ];
    expect(await sent({ pairs })).toEqual({ pairs });
  });

  it("always sends an Idempotency-Key", async () => {
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }]);
    await new Lenz({ apiKey: "lenz_t", fetch }).citecheck({ text: DRAFT });
    const key = (calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]!;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each<[CitecheckInput, RegExp]>([
    [{}, /exactly one of text and pairs/],
    [{ text: "   " }, /exactly one of text and pairs/],
    [
      { text: DRAFT, pairs: [{ statement: "s", url: "https://x.org" }] },
      /exactly one of text and pairs/,
    ],
    [{ pairs: [{ statement: "s", url: "https://x.org" }], maxCitations: 2 }, /goes with text/],
  ])("refuses %o before any request", async (input, message) => {
    const { fetch, calls } = makeFetch([{ status: 202, body: ACCEPTED }]);
    await expect(new Lenz({ apiKey: "lenz_t", fetch }).citecheck(input)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it.each(["citecheck_id", "review_id"])(
    "a conflict naming the check (%s) is the receipt",
    async (key) => {
      const { fetch } = makeFetch([
        {
          status: 409,
          body: { detail: "still being created", code: "idempotency_conflict", [key]: CHECK_ID },
        },
      ]);
      const started = await new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 }).citecheck({
        text: DRAFT,
      });
      expect(started.citecheck_id).toBe(CHECK_ID);
    },
  );
});

// ── read ─────────────────────────────────────────────────────────────────

describe("getCitecheck()", () => {
  async function read(body: unknown): Promise<Citecheck> {
    const { fetch } = makeFetch([{ body }]);
    return new Lenz({ apiKey: "lenz_t", fetch }).getCitecheck(CHECK_ID);
  }

  it("reads a recorded check of a draft", async () => {
    const check = await read(COMPLETED);
    expect([check.status, check.outcome, check.policy.max_citations]).toEqual([
      "completed",
      "issues_found",
      4,
    ]);
    const s = check.summary;
    expect([s.citations_found, s.citations_selected, s.citation_limit_reached]).toEqual([
      10,
      4,
      true,
    ]);
    expect(s.citation_checks?.checked).toBe(3);
    expect(check.citation_issues.map((i) => i.finding)).toEqual(["contradicted", "contradicted"]);
    expect(check.credits.charged).toBe(3);
    expect(check.more_citations).toHaveLength(6);
    expect(check.more_citations![0]!.sentence).toBeTruthy();
  });

  it("reads a recorded check of pairs", async () => {
    const check = await read(PAIRS_COMPLETED);
    expect(check.more_citations).toEqual([]);
    expect(check.citations.map((c) => c.result?.finding)).toEqual([
      "supported",
      "metadata_mismatch",
    ]);
  });

  it("fills the lists a body does not carry", async () => {
    const bare: Record<string, unknown> = { ...COMPLETED };
    delete bare["citations"];
    delete bare["more_citations"];
    const check = await read(bare);
    expect(check.citations).toEqual([]);
    expect(check.more_citations).toBeNull();
  });

  it("an empty id rejects", async () => {
    const client = new Lenz({ apiKey: "lenz_t", fetch: makeFetch([]).fetch });
    await expect(client.getCitecheck("")).rejects.toThrow(/non-empty citecheck_id/);
  });

  it("a purged check throws LenzGoneError", async () => {
    const { fetch } = makeFetch([
      {
        status: 410,
        body: { detail: "Purged.", code: "purged", purged_at: "2026-10-01T00:00:00Z" },
      },
    ]);
    await expect(
      new Lenz({ apiKey: "lenz_t", fetch }).getCitecheck(CHECK_ID),
    ).rejects.toBeInstanceOf(LenzGoneError);
  });
});

// ── wait ─────────────────────────────────────────────────────────────────

describe("citecheckAndWait()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function drain<T>(pending: Promise<T>, ms = 600_000): Promise<T> {
    await vi.advanceTimersByTimeAsync(ms);
    return pending;
  }

  it("polls until completed", async () => {
    const seen: string[] = [];
    const { fetch } = makeFetch([
      { status: 202, body: ACCEPTED },
      { body: running() },
      { body: COMPLETED },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const check = await drain(
      client.citecheckAndWait({ text: DRAFT }, { onUpdate: (c) => seen.push(c.status) }),
    );
    expect(check.outcome).toBe("issues_found");
    expect(seen).toEqual(["checking", "completed"]);
  });

  it("a bare body with this id and a terminal status is a failed poll, not a result", async () => {
    const { fetch } = makeFetch([
      { status: 202, body: ACCEPTED },
      { body: { citecheck_id: CHECK_ID, status: "completed" } },
      { body: COMPLETED },
    ]);
    const check = await drain(
      new Lenz({ apiKey: "lenz_t", fetch }).citecheckAndWait({ text: DRAFT }),
    );
    expect(check.summary.citations_found).toBe(10);
    expect(check.credits.charged).toBe(3);
  });

  it("a body that is not this check is a failed poll", async () => {
    const { fetch } = makeFetch([
      { status: 202, body: ACCEPTED },
      { body: { status: "completed" } },
      { body: { ...COMPLETED, citecheck_id: "other" } },
      { body: COMPLETED },
    ]);
    const check = await drain(
      new Lenz({ apiKey: "lenz_t", fetch }).citecheckAndWait({ text: DRAFT }),
    );
    expect(check.citecheck_id).toBe(CHECK_ID);
  });

  it("throws CitecheckFailedError on a failed check", async () => {
    const failed = {
      ...running(),
      status: "failed",
      outcome: "unchecked",
      failure: {
        failure_reason: "upstream_unavailable",
        failure_class: "upstream_unavailable",
        retryable: true,
        hint: "Retry in a few minutes.",
        docs_url: "https://lenz.io/docs/errors",
      },
    };
    const { fetch } = makeFetch([{ status: 202, body: ACCEPTED }, { body: failed }]);
    const pending = new Lenz({ apiKey: "lenz_t", fetch })
      .citecheckAndWait({ text: DRAFT })
      .catch((e: unknown) => e);
    const err = await drain(pending);
    expect(err).toBeInstanceOf(CitecheckFailedError);
    expect(err).toBeInstanceOf(LenzPipelineError);
    const f = err as CitecheckFailedError;
    expect([f.citecheckId, f.errorCode, f.retryable]).toEqual([
      CHECK_ID,
      "upstream_unavailable",
      true,
    ]);
    expect(f.citecheck.status).toBe("failed");
  });

  it("times out with the last body it saw as `partial`", async () => {
    const polls = Array.from({ length: 20 }, () => ({ body: running() }));
    const { fetch } = makeFetch([{ status: 202, body: ACCEPTED }, ...polls]);
    const pending = new Lenz({ apiKey: "lenz_t", fetch })
      .citecheckAndWait({ text: DRAFT }, { timeoutMs: 12_000 })
      .catch((e: unknown) => e);
    const err = await drain(pending, 30_000);
    expect(err).toBeInstanceOf(CitecheckTimeoutError);
    expect(err).toBeInstanceOf(LenzTimeoutError);
    const t = err as CitecheckTimeoutError;
    expect(t.citecheckId).toBe(CHECK_ID);
    expect(t.partial?.status).toBe("checking");
  });
});

// ── webhooks ─────────────────────────────────────────────────────────────

describe("LenzWebhooks — citecheck events", () => {
  const SECRET = "whsec_test_abc123";
  const hooks = new LenzWebhooks({ secret: SECRET });

  function signed(extra: Record<string, unknown> = {}) {
    const body = Buffer.from(
      JSON.stringify({
        event: "citecheck.completed",
        event_id: "evt_0123456789abcdef01234567",
        citecheck_id: CHECK_ID,
        task_id: "3af4392a7d6747289b88c11778d32d08",
        status: "completed",
        citecheck: COMPLETED,
        attempt: 1,
        delivered_at: new Date().toISOString(),
        ...extra,
      }),
    );
    const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
    return { body, sig };
  }

  it("parses citecheck.completed with the whole check", () => {
    const { body, sig } = signed();
    const evt = hooks.parse(body, { "X-Lenz-Signature": sig }) as CitecheckCompleted;
    expect(evt.event).toBe("citecheck.completed");
    expect([evt.citecheckId, evt.eventId]).toEqual([CHECK_ID, "evt_0123456789abcdef01234567"]);
    expect(evt.citecheck.citation_issues).toHaveLength(2);
  });

  it("an event without its check is the base shape", () => {
    const { body, sig } = signed({ event: "citecheck.failed", citecheck: "not a body" });
    const evt = hooks.parse(body, { "X-Lenz-Signature": sig });
    expect("citecheck" in evt).toBe(false);
    expect(evt.event).toBe("citecheck.failed");
  });
});
