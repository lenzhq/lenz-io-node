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
  headers?: Record<string, string>;
  body?: unknown;
  payload?: Record<string, unknown>;
}

/**
 * Recordings no SDK method reads (OAuth, the web app's own routes, the API's
 * index, the webhook-secret read): no scenario, so no oracle.
 */
export function hasScenario(name: string): boolean {
  return !(
    name.startsWith("account__oauth_") ||
    name.startsWith("errors__oauth_") ||
    name.startsWith("errors__web_") ||
    name === "account__api_root" ||
    name === "account__webhook_secret_oauth" ||
    // Routes no method calls, answered in HTML by the original shape.
    name === "review__delete_not_a_route" ||
    name === "errors__not_found_route" ||
    name.startsWith("errors__method_not_allowed_")
  );
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

/**
 * A fetch that answers every call with the recording. When the recording is a
 * review or citation check read, the submit before it gets a receipt.
 */
function fetchFor(r: Recorded): typeof fetch {
  const body = bodyOf(r);
  const isRead = "view" in body || "outcome" in body;
  const headers = r.headers ?? {};
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (!isRead) {
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers });
    }
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
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers });
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
  if (name === "verify__batch_202" || name === "verify__batch_partial_202") {
    return outcome(() => client.verifyBatch({ claims: [{ claim: "a" }, { claim: "b" }] }));
  }
  if (name === "verify__select_202") return outcome(() => client.select("t", { claims: ["a"] }));
  if (
    name.startsWith("verify__submit_202") ||
    name === "verify__stored_replay_202" ||
    name === "verify__idempotency_key_replay" ||
    name.startsWith("verify__implicit_")
  ) {
    return outcome(() => client.verify({ claim: "a" }));
  }
  if (name === "verify__delete_200") return outcome(() => client.verifications.delete("v"));
  if (
    name.startsWith("verify__status_") ||
    name.startsWith("verify__stored_progress_") ||
    /__poll(_|$)/.test(name)
  ) {
    return {
      getStatus: await outcome(() => client.getStatus("t")),
      wait: await outcome(() => client.wait("t", { timeoutMs: 50 })),
    };
  }
  if (name.startsWith("verify__verification_")) return outcome(() => client.verifications.get("v"));
  if (name.startsWith("verify__list_")) return outcome(() => client.verifications.list());
  if (name.startsWith("account__me_usage_") || name.startsWith("account__api_version_header_")) {
    return outcome(() => client.usage());
  }
  if (name.startsWith("account__library_")) return outcome(() => client.library.list());
  if (name.startsWith("account__ask_history_")) return outcome(() => client.ask.history("v"));
  if (name.startsWith("account__ask_send")) {
    return outcome(() => client.ask.send("v", { message: "x" }));
  }
  if (name === "account__ask_reset") return outcome(() => client.ask.reset("v"));
  if (
    name.startsWith("review__receipt_") ||
    name === "review__idempotent_replay_202" ||
    name === "review__stored_replay_202"
  ) {
    return outcome(() => client.review({ text: "x" }));
  }
  if (name.startsWith("citecheck__receipt_") || name === "citecheck__idempotent_replay_202") {
    return outcome(() => client.citecheck({ text: "x" }));
  }
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
  // Error responses: what the method that calls that endpoint throws.
  return outcome(() => errorCall(client, name));
}

/** The call whose endpoint answered an error recording. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorCall(client: any, name: string): Promise<unknown> {
  const ask =
    /^errors__(ask_|auth_private_claim_ask_|payment_required_ask|service_unavailable_ask|not_found_ask)/;
  if (ask.test(name)) {
    if (name.includes("reset")) return client.ask.reset("v");
    if (name.includes("history") || name === "errors__not_found_ask")
      return client.ask.history("v");
    return client.ask.send("v", { message: "x" });
  }
  if (name.startsWith("errors__payment_required_assess")) return client.assess({ claim: "x" });
  if (name === "errors__payment_required_verify_batch_short" || name.startsWith("verify__batch_")) {
    return client.verifyBatch({ claims: [{ claim: "a" }, { claim: "b" }] });
  }
  if (name.startsWith("verify__select_")) return client.select("t", { claims: ["a"] });
  if (name.startsWith("verify__delete_")) return client.verifications.delete("v");
  if (name === "errors__not_found_verification") return client.verifications.get("v");
  if (name === "errors__not_found_verify_status") return client.getStatus("t");
  if (name.startsWith("errors__http_error_library_")) return client.library.list();
  if (name.startsWith("review__") || /^errors__older_(review|invalid_verdict)/.test(name)) {
    return client.review({ text: "x" });
  }
  if (name.startsWith("citecheck__")) return client.citecheck({ text: "x" });
  if (name.startsWith("extract__") || name === "errors__rate_limited_extract") {
    return client.extract({ text: "x" });
  }
  if (name.startsWith("errors__auth_")) return client.usage();
  return client.verify({ claim: "a" });
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
