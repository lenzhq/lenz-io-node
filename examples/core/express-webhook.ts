/**
 * Receive Lenz webhook events in an Express app.
 *
 * Lenz POSTs HMAC-signed payloads to your `webhook_url` when the
 * verification pipeline terminates. This handler verifies the signature,
 * parses the payload into a typed event, and dispatches per event type.
 *
 *   npm install express
 *   export LENZ_WEBHOOK_SECRET=whsec_...
 *   npx tsx examples/core/express-webhook.ts
 *
 * Then point your Lenz API key's webhook URL at https://<your-host>/lenz-webhook
 * on the /api-integration page, or pass `webhookUrl: ...` on individual
 * verify() calls.
 */

import express from "express";

import {
  LenzWebhooks,
  LenzWebhookSignatureError,
  type VerificationCompleted,
  type VerificationFailed,
  type VerificationNeedsInput,
} from "lenz-io";

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
      console.warn("Rejected webhook:", exc.message);
      return res.status(400).send(String(exc));
    }
    throw exc;
  }

  switch (event.event) {
    case "verification.completed": {
      const e = event as VerificationCompleted;
      const verdict = (e.result["verdict"] as Record<string, unknown>) ?? {};
      console.log(
        `Completed: ${e.verificationId} -> ${verdict["label"]} (score ${verdict["score"]})`,
      );
      // TODO: persist verdict + sources; ping users; etc.
      break;
    }
    case "verification.needs_input": {
      const e = event as VerificationNeedsInput;
      console.log(`Needs input on ${e.taskId}: ${e.needsInput["reason"]}`);
      // TODO: surface candidate claims; call client.select(taskId, ...) to resolve
      break;
    }
    case "verification.failed": {
      const e = event as VerificationFailed;
      console.warn(`Pipeline failed: ${e.taskId} (${e.error})`);
      break;
    }
    default:
      console.log(`Unhandled webhook event: ${event.event}`);
  }

  // Always return 2xx fast. Lenz expects an ack within 5s; otherwise the
  // delivery retries at 10s / 60s / 600s (4 attempts total).
  res.status(200).json({ received: "ok" });
});

const port = Number(process.env["PORT"] ?? "8000");
app.listen(port, () => console.log(`Listening on :${port}`));
