# lenz-io

Official Node SDK for the [Lenz Hallucination Verification API](https://lenz.io).

**Two API primitives for AI product teams.** `extract` pulls verifiable
claims out of any text — free, 1000 calls/key/day. `verify` checks one
with a 7-model panel and citations, ~90s. Use them together or alone.

Built for teams whose AI output is async or document-shaped: legal-memo
generators, deep-research products, due-diligence platforms, vertical
agents producing structured deliverables. Not chat AI, not voice AI,
not real-time copilots — 90 seconds is the wrong shape for those.

```bash
npm install lenz-io
```

## Quickstart — the canonical integration

```ts
import { Lenz } from "lenz-io";

const client = new Lenz({ apiKey: "lenz_..." });

// 1. Pull factual claims out of your model output (free, instant)
const { claims } = await client.extract({ text: llmOutput });

// 2. Verify the ones that matter (~90s each, 7-model panel)
for (const claim of claims) {
  const v = (await client.verifyAndWait({ claim })).verdict;
  console.log(v?.label, v?.score, v?.confidence);
}
```

## The 7-model panel — the work is the product

Frame → Debate (2 models, 2 rounds) → Adjudicate (3 models: sources, logic,
context) → Conclude → Cite. ~90 seconds wall-clock per claim. You get a
report with citations, not a similarity score.

ChatGPT gives you an answer in 5 seconds that might be wrong. Lenz takes
~90 seconds and gives you a report you can defend.

## Magical-moment demo

```ts
import { Lenz } from "lenz-io";

const client = new Lenz({ apiKey: "lenz_..." });

const v = await client.verifyAndWait({ claim: "Sharks don't get cancer" });
console.log(v.verdict?.label, v.verdict?.score);
// false 2.0

for (const source of (v.sources ?? []).slice(0, 3)) {
  console.log(" -", source.title, source.url);
}
```

The demo claim is pre-cached so this returns in ~1.5s. Your own claims
hit the full pipeline (~60-90s) — use webhooks for production async flows.

> **Get your webhook secret here →** [lenz.io/api-integration](https://lenz.io/api-integration)

## What you get

- **`client.verifyAndWait({ claim, ... })`** — submit + poll until the pipeline lands. Returns a typed `Verification`.
- **`client.verify({ claim })`** — async submit; returns a `task_id`. Use webhooks for the callback.
- **`client.extract({ text })`** — pull verifiable claims out of any text (free, capped at 1000/key/day).
- **`client.verifyBatch({ claims })`** — fan-out for multi-claim LLM outputs.
- **`client.verifications.{list,get,delete,setVisibility}(...)`** — manage past verifications.
- **`client.followup.{history,send,reset}(verificationId)`** — Q&A on a verification.
- **`client.library.{list,get}(...)`** — browse the public catalog (no API key needed).
- **`client.usage()`** — credits and rate-limit remaining.

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
      const verdict = completed.result?.["verdict"];
      // …persist verdict + sources
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
for the headline extract-and-verify pattern.

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
  console.log(status.result?.verdict?.label);
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
