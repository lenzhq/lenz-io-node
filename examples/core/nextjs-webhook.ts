/**
 * Receive Lenz webhook events in a Next.js App Router route handler.
 *
 * Save this as `app/api/lenz-webhook/route.ts`. It runs on the Node.js runtime
 * and on the Edge runtime (`export const runtime = "edge"`): `unwrap` verifies
 * the signature with WebCrypto and needs no Node built-in.
 *
 *   export LENZ_WEBHOOK_SECRET=whsec_...
 *
 * Then point your Lenz API key's webhook URL at https://<your-host>/api/lenz-webhook
 * on the /api-credentials page, or pass `webhookUrl: ...` on individual
 * verify() calls.
 *
 * Next.js route handlers take and return the standard `Request` / `Response`,
 * so this file needs no import from `next`.
 */

import { LenzWebhooks, LenzWebhookSignatureError, isEvent } from "lenz-io";

// Uncomment to run on the Edge runtime:
// export const runtime = "edge";

const webhooks = new LenzWebhooks({ secret: process.env["LENZ_WEBHOOK_SECRET"] ?? "" });

export async function POST(request: Request): Promise<Response> {
  let event;
  try {
    // Reads the raw body once and checks X-Lenz-Signature. Never call
    // `request.json()` first: the signature covers the exact bytes sent.
    event = await webhooks.unwrap(request);
  } catch (exc) {
    if (exc instanceof LenzWebhookSignatureError) {
      // Log the detail server-side only; the caller learns nothing more.
      console.warn("Rejected webhook:", exc.message);
      return Response.json({ error: "invalid signature" }, { status: 400 });
    }
    throw exc;
  }

  if (isEvent(event, "verification.completed")) {
    const r = event.verification.result;
    console.log(`Completed: ${event.verificationId} -> ${r.verdict} (lenz_score ${r.lenz_score})`);
  } else if (isEvent(event, "verification.failed")) {
    console.warn(`Verification failed: ${event.taskId} (${event.failure?.code})`);
  } else if (isEvent(event, "review.completed")) {
    // Dedupe on eventId: every retry of one delivery carries the same one.
    console.log(`Review ${event.reviewId}: ${event.review.issues.length} issue(s)`);
  } else {
    // An event you do not handle: acknowledge it. New kinds are added without
    // a major release.
    console.log(`Unhandled webhook event: ${event.event}`);
  }

  // Return 2xx fast. Lenz expects an ack within 5s; otherwise the delivery
  // retries at 10s / 60s / 600s (4 attempts total).
  return Response.json({ received: "ok" });
}
