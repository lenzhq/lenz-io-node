# lenz-io

Official Node SDK for the [Lenz Claim Verification API for AI Product Teams](https://lenz.io/developers).

**Four API primitives, one research-depth ladder.**

- `extract` — pull verifiable claims out of any text. Free, 1000 calls/key/day.
- `assess` — fast 3-model panel verdict in ~5-10s. Sync, paid.
- `verify` — full 7-model pipeline with citations in ~90s. Async, paid.
- `ask` — follow-up questions grounded on a verification.

Built for teams whose AI output is async or document-shaped: legal-memo
generators, deep-research products, due-diligence platforms, vertical
agents producing structured deliverables. Not chat AI, not voice AI,
not real-time copilots — pipeline runs are the wrong shape for those.

```bash
npm install lenz-io
```

## Quickstart — the canonical integration

```ts
import { Lenz } from "lenz-io";

const client = new Lenz({ apiKey: "lenz_..." });

// 1. extract — pull verifiable claims out of any text (free)
const out = await client.extract({ text: llmOutput });

// 2. assess — fast 3-model verdict on each (~5-10s, sync)
const quick = await client.assess({ text: llmOutput });
for (const c of quick.claims) {
  console.log(c.verdict, c.confidence, c.claim);
}

// 3. verify — escalate low-confidence claims to the full panel + citations
for (const c of quick.claims) {
  if (c.confidence === "low") {
    const v = await client.verifyAndWait({ claim: c.claim! });
    console.log(v.verdict, v.lenz_score, v.executive_summary);
  }
}

// 4. ask — follow-up grounded on a verification
const reply = await client.ask.send(v.verification_id!, {
  message: "Which source is strongest?",
});
console.log(reply.reply);
```

`assess` and `verify` share a result cache server-side: if a claim
already has a deep verification, `assess` returns it via
`verification_url` and you can skip the escalation.

## How verification works

Frame → Collect Evidence → Debate (2 models, 2 rounds) → Adjudicate
(3 models: sources, logic, context) → Conclude. ~90 seconds wall-clock
per claim. `assess` runs a leaner 3-model panel against the same
framing for the ~5-10s pass.

## Magical-moment demo

```ts
import { Lenz } from "lenz-io";

const client = new Lenz({ apiKey: "lenz_..." });

const v = await client.verifyAndWait({ claim: "Sharks don't get cancer" });
console.log(v.verdict, v.lenz_score);
// False 2.0

for (const source of (v.sources ?? []).slice(0, 3)) {
  console.log(" -", source.title, source.url);
}
```

The demo claim is pre-cached so this returns in ~1.5s. Your own claims
hit the full pipeline (~60-90s) — use webhooks for production async flows.

> **Get your webhook secret here →** [lenz.io/api-integration](https://lenz.io/api-integration)

## What you get on the client

- **`client.extract({ text })`** → `ExtractedClaims`. Free, capped at 1000/key/day.
- **`client.assess({ text })`** → `AssessResponse`. Sync, ~5-10s, returns one entry per identified claim.
- **`client.verify({ claim })`** → `TaskAccepted`. Async submit; pair with a webhook for the callback.
- **`client.verifyAndWait({ claim, ... })`** → `Verification`. Submit + poll until the pipeline lands (sync ergonomic).
- **`client.verifyBatch({ claims })`** → `BatchAccepted`. Fan-out for multi-claim LLM outputs.
- **`client.ask.{history,send,reset}(verificationId, ...)`** → Q&A on a verification.
- **`client.verifications.{list,get,delete,setVisibility,related}(...)`** → manage past verifications. `get` accepts anon callers and returns any non-hidden public claim.
- **`client.library.list(...)`** → browse the public catalog (no API key needed).
- **`client.usage()`** → credits and rate-limit remaining.

## Response shape — the unified vocabulary

Every claim-shaped response shares these fields at top level:

| Field | Type | Notes |
|-------|------|-------|
| `claim` | `string` | The framed claim text. |
| `verdict` | `string` | `"True"` \| `"Mostly True"` \| `"Misleading"` \| `"False"` \| `"Error"`. |
| `confidence` | `string` | Categorical: `"high"` \| `"medium"` \| `"low"`. |
| `lenz_score` | `number \| null` | Integer 0–10 (deep verdicts and list endpoints; `assess` omits it). |

### Webhooks

```ts
import { LenzWebhooks } from "lenz-io";
import type { VerificationCompleted, VerificationNeedsInput } from "lenz-io";

const webhooks = new LenzWebhooks({ secret: "whsec_..." });

// In your Express handler (use express.raw() to get rawBody as Buffer):
app.post("/lenz-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const event = webhooks.parse(req.body, req.headers as Record<string, string>);
  switch (event.event) {
    case "verification.completed": {
      const completed = event as VerificationCompleted;
      const r = completed.result as Record<string, unknown>;
      // r.verdict, r.lenz_score, r.confidence, ...
      break;
    }
    case "verification.needs_input": {
      const ni = event as VerificationNeedsInput;
      // …surface candidate claims, call client.select(taskId, ...) to resolve
      break;
    }
  }
  res.status(200).send();
});
```

Signature verification is HMAC-SHA256 over the raw bytes; the SDK does it for
you and rejects tampered or replayed payloads.

See [`examples/core/express-webhook.ts`](examples/core/express-webhook.ts)
for a runnable receiver and [`examples/core/verify-llm-output.ts`](examples/core/verify-llm-output.ts)
for the headline assess-then-escalate pattern.

## Errors

Every error subclass is typed and carries a `requestId` you can quote on
support tickets:

```ts
import { LenzAuthError, LenzRateLimitError, LenzValidationError } from "lenz-io";

try {
  await client.verifyAndWait({ claim: "..." });
} catch (exc) {
  if (exc instanceof LenzAuthError) {
    console.error(String(exc));
    // Unauthorized
    //   Cause:  Invalid api key
    //   Fix:    Generate a new key at https://lenz.io/api-integration.
    //   Docs:   https://lenz.io/docs/auth
    //   Request ID: req_abc123
  } else if (exc instanceof LenzRateLimitError) {
    await new Promise((r) => setTimeout(r, exc.retryAfter * 1000));
  } else if (exc instanceof LenzValidationError) {
    for (const fieldErr of exc.errors) {
      console.error(fieldErr["loc"], fieldErr["msg"]);
    }
  } else {
    throw exc;
  }
}
```

## Resuming a verification

If a `verifyAndWait` call exceeds its `timeoutMs` (default 120000) or your
process dies mid-poll, the pipeline keeps running. The exception carries the
`taskId`:

```ts
import { LenzTimeoutError } from "lenz-io";

try {
  await client.verifyAndWait({ claim: "...", timeoutMs: 30000 });
} catch (exc) {
  if (exc instanceof LenzTimeoutError) {
    console.error("resume later via:", exc.taskId);
  }
}

// Later (different process / restart):
const status = await client.getStatus("tsk_abc123");
if (status.status === "completed") {
  console.log(status.result?.verdict, status.result?.lenz_score);
}
```

## Idempotency

`verifyAndWait` sends an auto-generated `Idempotency-Key` on every call by
default, so a network drop after submit doesn't spawn a duplicate verification
or charge a second credit. Override with `idempotencyKey: "..."` to pin a
specific key, or `idempotency: false` to opt out.

## Configuration

```ts
new Lenz({
  apiKey: "lenz_...",                 // or set LENZ_API_KEY env var
  baseUrl: "https://lenz.io/api/v1",  // override for staging / local
  timeoutMs: 30000,
  maxRetries: 3,
  fetch: customFetch,                  // inject for tests
});
```

Environment variables:

- `LENZ_API_KEY` — read if `apiKey` is not passed
- `LENZ_BASE_URL` — read if `baseUrl` is not passed

## Compatibility

- Node 18, 20, 22
- ESM + CJS dual exports
- TypeScript types included
- Works in Cloudflare Workers / edge runtimes — pass a `fetch` polyfill if `globalThis.fetch` isn't available

## Bug reports + feature requests

[github.com/lenzhq/lenz-io-node/issues](https://github.com/lenzhq/lenz-io-node/issues)

For commercial use, volume pricing, or onboarding support,
[get in touch](https://lenz.io/contact).

## License

MIT. See [LICENSE](LICENSE).
