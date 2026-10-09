// Runtime-agnostic check of an installed `lenz-io`: Node, Bun and Deno run this
// file unchanged (scripts/edge-check.mjs). It receives a signed request through
// `unwrap`, `parseAsync`, and rejects a forged one. Prints the file `lenz-io`
// resolved to, so the caller can check the export conditions picked the right build.

import { LenzWebhooks, LenzWebhookSignatureError, isEvent } from "lenz-io";

const SECRET = "whsec_edge_check";
const enc = new TextEncoder();

async function signature(body, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function assert(cond, message) {
  if (!cond) throw new Error("FAILED: " + message);
}

const hooks = new LenzWebhooks({ secret: SECRET });
const body = JSON.stringify({
  event: "verification.completed",
  task_id: "t_edge",
  attempt: 1,
  delivered_at: new Date().toISOString(),
  result: { verdict: "True" },
});
const headers = { "X-Lenz-Signature": await signature(body, SECRET) };

const event = await hooks.unwrap(
  new Request("https://example.test/hook", { method: "POST", headers, body }),
);
assert(event.event === "verification.completed" && event.taskId === "t_edge", "unwrap event");
assert(isEvent(event, "verification.completed"), "isEvent narrows");

const again = await hooks.parseAsync(body, headers);
assert(again.taskId === "t_edge", "parseAsync event");

let rejected = "";
try {
  await hooks.unwrap(
    new Request("https://example.test/hook", {
      method: "POST",
      headers: { "X-Lenz-Signature": await signature(body, "whsec_other") },
      body,
    }),
  );
} catch (e) {
  assert(
    e instanceof LenzWebhookSignatureError,
    "a forged request throws LenzWebhookSignatureError",
  );
  rejected = e.message;
}
assert(rejected === "Webhook signature mismatch", "forged request rejected");

console.log("OK resolved=" + import.meta.resolve("lenz-io"));
