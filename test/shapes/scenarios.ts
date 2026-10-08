/**
 * What the SDK hands a caller for each recorded response, as plain data.
 *
 * Each scenario feeds one recorded response (`test/fixtures/shapes/<shape>/`)
 * to the public surface the way a caller would meet it (a method call, the
 * error it throws, a webhook parse) and returns a snapshot of the result.
 *
 * Takes the SDK as an argument so the same scenarios run against any build
 * of it: `oracle/` holds the snapshots the previous release produced from the
 * `legacy/` responses, and `read-both-shapes.test.ts` checks that this
 * release produces the same from both `legacy/` and `canonical/`.
 */

import { createHmac } from "node:crypto";

/** The parts of the SDK the scenarios use. */
export interface SdkUnderTest {
  Lenz: new (opts: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  LenzWebhooks: new (opts: Record<string, unknown>) => {
    parse(body: string, headers: Record<string, string>): unknown;
  };
}

export interface Recorded {
  status?: number;
  body?: unknown;
  payload?: Record<string, unknown>;
}

const SECRET = "whsec_test_shapes";

/** How `snapshot` writes a key whose value is `undefined`. */
export const UNDEFINED = "UNDEFINED";

/**
 * Plain data: errors become their class, message and own fields (`body`, the
 * raw wire body, left out); webhook events lose `raw` (the wire payload) for
 * the same reason. A key that is there with the value `undefined` is kept as
 * the string `UNDEFINED`, so "absent" and "present but undefined" differ.
 */
export function snapshot(v: unknown): unknown {
  if (v instanceof Error) {
    const out: Record<string, unknown> = { class: v.constructor.name, message: v.message };
    for (const [k, val] of Object.entries(v)) {
      if (k === "body") continue;
      out[k] = val === undefined ? UNDEFINED : snapshot(val);
    }
    return out;
  }
  if (Array.isArray(v)) return v.map(snapshot);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "raw") continue;
      out[k] = val === undefined ? UNDEFINED : snapshot(val);
    }
    return out;
  }
  return v;
}

function bodyOf(r: Recorded): Record<string, unknown> {
  return (r.body ?? {}) as Record<string, unknown>;
}

/** A fetch that answers every call with the recording (submits get their receipt). */
function fetchFor(r: Recorded): typeof fetch {
  const body = bodyOf(r);
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST" && path.endsWith("/review")) {
      return new Response(JSON.stringify({ review_id: body["review_id"], status: "queued" }), {
        status: 202,
      });
    }
    if (init?.method === "POST" && path.endsWith("/citecheck")) {
      return new Response(
        JSON.stringify({ citecheck_id: body["citecheck_id"], status: "queued" }),
        {
          status: 202,
        },
      );
    }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
}

async function outcome(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return { value: snapshot(await call()) };
  } catch (exc) {
    return { error: snapshot(exc) };
  }
}

/** The snapshot for one recording. `name` is the recording's file name, without `.json`. */
export async function runScenario(sdk: SdkUnderTest, name: string, r: Recorded): Promise<unknown> {
  if (name.startsWith("webhook__")) {
    const raw = JSON.stringify(r.payload);
    const sig = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
    // A wide replay window: the recordings carry fixed delivery times.
    const hooks = new sdk.LenzWebhooks({ secret: SECRET, replayWindowSeconds: 1e12 });
    return outcome(async () => hooks.parse(raw, { "X-Lenz-Signature": sig }));
  }
  const client = new sdk.Lenz({ apiKey: "lenz_test", fetch: fetchFor(r), maxRetries: 0 });
  const status = String(bodyOf(r)["status"] ?? "");
  if (name.startsWith("assess__")) return outcome(() => client.assess({ claim: "x" }));
  if (name.startsWith("extract__")) {
    return outcome(() => client.extract({ text: "x", locate: name.includes("locate") }));
  }
  if (name === "verify__batch_202") {
    return outcome(() => client.verifyBatch({ claims: [{ claim: "a" }, { claim: "b" }] }));
  }
  if (name === "verify__select_202") return outcome(() => client.select("t", { claims: ["a"] }));
  if (name === "verify__submit_202") return outcome(() => client.verify({ claim: "a" }));
  if (name.startsWith("verify__status_")) {
    return {
      getStatus: await outcome(() => client.getStatus("t")),
      wait: await outcome(() => client.wait("t", { timeoutMs: 50 })),
    };
  }
  if (name.startsWith("verify__verification_")) return outcome(() => client.verifications.get("v"));
  if (name.startsWith("verify__list_")) return outcome(() => client.verifications.list());
  if (name.startsWith("account__me_usage_")) return outcome(() => client.usage());
  if (name.startsWith("review__get_")) {
    return {
      getReview: await outcome(() => client.getReview("r")),
      getReviewIssues: await outcome(() => client.getReview("r", { view: "issues" })),
      reviewAndWait:
        status === "completed" || status === "failed"
          ? await outcome(() => client.reviewAndWait({ text: "x" }, { timeoutMs: 50 }))
          : null,
    };
  }
  if (name.startsWith("citecheck__get_")) {
    return {
      getCitecheck: await outcome(() => client.getCitecheck("c")),
      citecheckAndWait:
        status === "completed" || status === "failed"
          ? await outcome(() => client.citecheckAndWait({ text: "x" }, { timeoutMs: 50 }))
          : null,
    };
  }
  // Error responses: what the client throws.
  return outcome(() => client.extract({ text: "x" }));
}

/** The `review` and `citecheck` inputs whose request bodies are pinned. */
const REQUEST_CASES: Array<[string, string, Record<string, unknown>]> = [
  ["review", "no webhookUrl", { text: "x" }],
  ["review", "webhookUrl empty", { text: "x", webhookUrl: "" }],
  ["review", "webhookUrl null", { text: "x", webhookUrl: null }],
  ["review", "webhookUrl set", { text: "x", webhookUrl: "https://example.com/hook" }],
  [
    "review",
    "every option",
    {
      text: "x",
      language: "es",
      visibility: "unlisted",
      verdicts: ["False"],
      confidence: ["low"],
      maxAssessments: 3,
      maxVerifications: 1,
      depth: "low",
      maxCitations: 2,
      suggestEdits: true,
      webhookUrl: "",
      idempotencyKey: "k",
    },
  ],
  ["citecheck", "no webhookUrl", { text: "x" }],
  ["citecheck", "webhookUrl empty", { text: "x", webhookUrl: "" }],
  ["citecheck", "webhookUrl null", { text: "x", webhookUrl: null }],
  ["citecheck", "webhookUrl set", { text: "x", webhookUrl: "https://example.com/hook" }],
  [
    "citecheck",
    "pairs",
    {
      pairs: [{ statement: "s", url: "https://example.com" }],
      language: "de",
      webhookUrl: "",
      idempotencyKey: "k",
    },
  ],
];

/** What `review()` / `citecheck()` send for each pinned input (body and idempotency key). */
export async function reviewRequestBodies(sdk: SdkUnderTest): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [method, label, input] of REQUEST_CASES) {
    let sent: unknown = null;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      const id = method === "review" ? { review_id: "r1" } : { citecheck_id: "c1" };
      return new Response(JSON.stringify({ ...id, status: "queued" }), { status: 202 });
    }) as typeof fetch;
    const client = new sdk.Lenz({ apiKey: "lenz_test", fetch: fetchImpl, maxRetries: 0 });
    await client[method](input);
    out[`${method}: ${label}`] = sent;
  }
  return out;
}
