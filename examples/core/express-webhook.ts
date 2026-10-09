/**
 * Receive Lenz webhook events in an Express app.
 *
 * Lenz POSTs HMAC-signed payloads to your `webhook_url` when a verification,
 * a review or a citation check ends. This handler verifies the signature,
 * parses the payload into a typed event, and dispatches per event type.
 *
 *   npm install express
 *   export LENZ_WEBHOOK_SECRET=whsec_...
 *   npx tsx examples/core/express-webhook.ts
 *
 * Then point your Lenz API key's webhook URL at https://<your-host>/lenz-webhook
 * on the /api-credentials page, or pass `webhookUrl: ...` on individual
 * verify() calls.
 */

import express from "express";

import { LenzWebhooks, LenzWebhookSignatureError, isEvent } from "lenz-io";

const app = express();
const webhooks = new LenzWebhooks({ secret: process.env["LENZ_WEBHOOK_SECRET"] ?? "" });

// IMPORTANT: use express.raw() so the body lands as Buffer for signature
// verification. express.json() would parse it first and the signature
// check would fail.
app.post("/lenz-webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = webhooks.parse(req.body, req.headers as Record<string, string>);
  } catch (exc) {
    if (exc instanceof LenzWebhookSignatureError) {
      // Log the detail server-side only — never echo exception text/stack
      // back to the caller, which could leak internals to whoever sent the
      // (possibly forged) request.
      console.warn("Rejected webhook:", exc.message);
      return res.status(400).json({ error: "invalid signature" });
    }
    throw exc;
  }

  // `isEvent` narrows on the event name AND the member it promises, so a
  // malformed payload under a known name falls through to "unhandled".
  if (isEvent(event, "verification.completed")) {
    const r = event.verification.result;
    console.log(
      `Completed: ${event.verificationId} -> ${r.verdict} (lenz_score ${r.lenz_score}, confidence ${r.confidence})`,
    );
    // TODO: persist verdict + sources; ping users; etc.
  } else if (isEvent(event, "verification.needs_input")) {
    console.log(`Needs input on ${event.taskId}: ${event.verification.reason}`);
    // TODO: surface candidate claims; call client.select(taskId, ...) to resolve
  } else if (isEvent(event, "verification.failed")) {
    console.warn(`Verification failed: ${event.taskId} (${event.failure?.code})`);
  } else if (isEvent(event, "verification.cancelled")) {
    // Stopped elsewhere (the website's Stop button, another process).
    console.warn(`Verification cancelled: ${event.taskId}`);
  } else if (
    isEvent(event, "review.completed") ||
    isEvent(event, "review.failed") ||
    isEvent(event, "review.cancelled")
  ) {
    // Dedupe on eventId: every retry of one delivery carries the same one.
    console.log(
      `Review ${event.reviewId} ${event.review.status}: ${event.review.issues.length} issue(s) (event ${event.eventId})`,
    );
  } else if (
    isEvent(event, "citecheck.completed") ||
    isEvent(event, "citecheck.failed") ||
    isEvent(event, "citecheck.cancelled")
  ) {
    console.log(
      `Citation check ${event.citecheckId} ${event.citecheck.status}: ${event.citecheck.citation_issues.length} issue(s)`,
    );
  } else {
    // An event you do not recognise: ignore it. New kinds are added without
    // a major release.
    console.log(`Unhandled webhook event: ${event.event}`);
  }

  // Always return 2xx fast. Lenz expects an ack within 5s; otherwise the
  // delivery retries at 10s / 60s / 600s (4 attempts total).
  res.status(200).json({ received: "ok" });
});

const port = Number(process.env["PORT"] ?? "8000");
app.listen(port, () => console.log(`Listening on :${port}`));
