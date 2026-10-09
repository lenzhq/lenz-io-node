/**
 * Receive Lenz webhook events in a Hono app: Cloudflare Workers, Deno, Bun,
 * Vercel and Node.
 *
 *   npm install hono lenz-io
 *   npx wrangler secret put LENZ_WEBHOOK_SECRET   # on Workers
 *
 * `unwrap` takes the standard `Request` (`c.req.raw`), reads the raw body once
 * and verifies X-Lenz-Signature with WebCrypto, so it runs where Node's
 * `crypto` does not exist. Do not call `c.req.json()` or `c.req.text()` before
 * it: the signature covers the exact bytes sent.
 */

import { Hono } from "hono";

import { LenzWebhooks, LenzWebhookSignatureError, isEvent } from "lenz-io";

type Bindings = { LENZ_WEBHOOK_SECRET: string };

const app = new Hono<{ Bindings: Bindings }>();

app.post("/webhook", async (c) => {
  // On Workers the secret is a binding; build the receiver per request.
  const webhooks = new LenzWebhooks({ secret: c.env.LENZ_WEBHOOK_SECRET });
  let event;
  try {
    event = await webhooks.unwrap(c.req.raw);
  } catch (exc) {
    if (exc instanceof LenzWebhookSignatureError) {
      console.warn("Rejected webhook:", exc.message);
      return c.json({ error: "invalid signature" }, 400);
    }
    throw exc;
  }

  if (isEvent(event, "verification.completed")) {
    console.log(`Completed: ${event.verificationId} -> ${event.verification.result.verdict}`);
  } else if (isEvent(event, "verification.failed")) {
    console.warn(`Verification failed: ${event.taskId} (${event.failure?.code})`);
  } else {
    console.log(`Unhandled webhook event: ${event.event}`);
  }

  // Return 2xx fast: Lenz expects an ack within 5s.
  return c.json({ received: "ok" });
});

export default app;
