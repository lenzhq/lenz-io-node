# lenz-io

Official Node SDK for the [Lenz Fact Checking API for AI Product Teams](https://lenz.io/developers).

**Four API primitives, one research-depth ladder.**

- `extract` — pull verifiable claims out of any text. Free, 1000 calls/account/day (shared across your API keys).
- `assess` — fast 3-model panel verdict in ~5-10s. Sync, paid.
- `verify` — full 8-model pipeline with citations in ~90s. Async, paid.
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
let deep;
for (const c of quick.claims) {
  if (c.confidence === "low") {
    deep = await client.verifyAndWait({ claim: c.claim! });
    console.log(deep.verdict, deep.lenz_score, deep.executive_summary);
  }
}

// 4. ask — follow-up grounded on a verification
const reply = await client.ask.send(deep!.verification_id!, {
  message: "Which source is strongest?",
});
console.log(reply.content);
```

`assess` and `verify` share a result cache server-side: if a claim
already has a deep verification, `assess` returns it via
`verification_url` and you can skip the escalation.

## How verification works

Framing → Research → Debate (2 models, 2 rounds) → Panel Review
(3 reviewers: source quality, logical structure, claim precision) → Conclusion. ~90 seconds wall-clock
per claim. `assess` runs a leaner 3-model panel against the same
framing for the ~5-10s pass.

## Quickstart demo

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

> **Get your webhook secret here →** [lenz.io/api-credentials](https://lenz.io/api-credentials)

## What you get on the client

- **`client.extract({ text })`** → `ExtractedClaims`. Free, capped at 1000/account/day.
- **`client.assess({ text })`** → `AssessResponse`. Sync, ~5-10s, returns one entry per identified claim.
- **`client.verify({ claim })`** → `TaskAccepted`. Async submit; returns a `task_id`. Get the result by polling (`client.wait(...)` / `client.getStatus(...)`) or via a webhook.
- **`client.verifyAndWait({ claim, ... })`** → `Verification`. Submit + poll until the pipeline lands (sync ergonomic). Equivalent to `wait(verify(...))`.
- **`client.wait(task)`** → `Verification`. Block on a `task_id` (or a `TaskAccepted`) until it terminates. The polling counterpart to a webhook.
- **`client.verifyBatch({ claims })`** → `BatchAccepted`. Fan-out for multi-claim LLM outputs.
- **`client.verifyBatchAndWait({ claims })`** → `BatchItemResult[]`. Fan out a batch and poll every item to completion; one result per claim, in input order, never throws on a per-item failure.
- **`client.ask.{history,send,reset}(verificationId, ...)`** → Q&A on a verification. `reply.content` uses a small markdown subset (`**bold**`, `*italic*`, `- ` or `* ` bullets, blank-line paragraphs) — render with a minimal markdown library or display verbatim. See [docs/quickstart#ask-reply-format](https://lenz.io/docs/quickstart#ask-reply-format).
- **`client.verifications.{list,get,delete,related}(...)`** → manage past verifications. All API claims are private; reference them by `verification_id`. Cache-hit on another customer's claim is transparent — you always see your own `verification_id`, never another customer's.
- **`client.library.list(...)`** → browse the public catalog (no API key needed).
- **`client.usage()`** → your credit balance (`credits`), the price list (`costs`), and that balance projected into each capability's unit (`verify` / `ask` / `assess`), plus the daily `extract` rate limit. Also reports `has_webhook_secret` — whether this key can receive signed webhook callbacks (`verify` with a `webhook_url` needs one); the secret value itself is never exposed. See [Credits](#credits).

## Polling without webhooks

`verify()` returns immediately with a `task_id`; the pipeline runs async (~60-90s
for a cold claim). You don't need webhooks to get the result — poll for it.

The one-liner is `verifyAndWait()`. If you already hold a `task_id` (or want to
submit and wait separately), use `wait()`:

```ts
const task = await client.verify({ claim: "Sharks don't get cancer" }); // async
const verification = await client.wait(task); // blocks
console.log(verification.verdict, verification.lenz_score);
```

To run several claims in parallel, submit a batch and wait on all of them.
`verifyBatchAndWait` returns one `BatchItemResult` per claim, in input order, and
never throws because a single claim failed — inspect each item's `status`:

```ts
const results = await client.verifyBatchAndWait({
  claims: [{ text: "Sharks don't get cancer" }, { text: "The Eiffel Tower is 330m tall" }],
});
for (const r of results) {
  if (r.status === "completed") {
    console.log(r.claim_text, "→", r.verification!.verdict);
  } else {
    console.log(r.claim_text, "→", r.status); // needs_input | failed | timeout
  }
}
```

Prefer **webhooks** for production async flows (no long-lived HTTP connection);
prefer **polling** for scripts and request/response handlers where awaiting is
fine. For full control over the loop, call `getStatus(taskId)` yourself — it's a
single non-blocking poll.

## Response shape — the unified vocabulary

Every claim-shaped response shares these fields at top level:

| Field        | Type             | Notes                                                                                   |
| ------------ | ---------------- | --------------------------------------------------------------------------------------- |
| `claim`      | `string`         | The framed claim text.                                                                  |
| `verdict`    | `string`         | `"True"` \| `"Mostly True"` \| `"Mixed"` \| `"Mostly False"` \| `"False"` \| `"Error"`. |
| `confidence` | `string`         | Categorical: `"high"` \| `"medium"` \| `"low"`.                                         |
| `lenz_score` | `number \| null` | Integer 1–10 (deep verdicts and list endpoints; `assess` omits it).                     |

### Webhooks

```ts
import { LenzWebhooks } from "lenz-io";
import type { VerificationCompleted, VerificationFailed, VerificationNeedsInput } from "lenz-io";

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
    case "verification.failed": {
      const failed = event as VerificationFailed;
      // failed.error is WHERE the pipeline stopped; failed.failureClass is
      // WHY (closed set) and failed.retryable tells you what to do about it.
      if (failed.retryable) {
        resubmitLater(failed.taskId); // transient provider outage
      } else {
        logPermanentFailure(failed.taskId, failed.error);
      }
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

## Credits

One balance per account, spent by every billable call. `/assess` and `/ask`
cost 1 credit; `/verify` (including each claim of a batch, and `/select`) costs
10; `/extract` is free and bounded by a daily cap instead.

```ts
const u = await client.usage();

u.credits.remaining; // 5070 — the balance, in credits
u.credits.bonus; // 200 — the non-expiring part of it
u.credits.resets_at; // when the monthly allowance refills, or null

u.costs["verify"]; // 10 credits per verification
u.verify.remaining; // 507 — the same balance, in verifications
u.assess.remaining; // 5070 — and in assessments

u.extract.calls_today; // /extract is free: a daily cap, not a credit price
u.extract.daily_limit;
```

`verify` / `ask` / `assess` are **projections of the one balance**, not
separate allowances — spending on any of them moves all three. Divide
`credits.remaining` by `costs[...]` yourself if you prefer; the blocks just do
it for you, flooring (5 credits is 5 assessments and 0 verifications).

Read `costs` as a map rather than destructuring known names: a new capability
appears in it without an SDK release, and the keys are the server's own.

The per-capability `credits` field is **deprecated** — it was always that
capability's one-off top-up balance, which is now `bonus`. It disappears from
the API on **2026-11-29**; read `bonus`.

## Errors

Every error subclass is typed and carries a `requestId` you can quote on
support tickets:

```ts
import {
  LenzAuthError,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzUpstreamUnavailableError,
  LenzValidationError,
} from "lenz-io";

try {
  await client.verifyAndWait({ claim: "..." });
} catch (exc) {
  if (exc instanceof LenzQuotaExceededError) {
    // HTTP 402. Out of balance — retrying will not clear it.
    console.error(exc.remaining); // 0 verifications left, or null if unreported
    console.error(exc.creditBalance); // 4 credits held, or null if unreported
    console.error(exc.cost); // 10 — what this call would have taken
    console.error(exc.resetsAt); // "2026-09-01T00:00:00+00:00", or null
    console.error(exc.upgradeUrl); // https://lenz.io/plans
  } else if (exc instanceof LenzAuthError) {
    console.error(String(exc));
    // Unauthorized
    //   Cause:  Invalid api key
    //   Fix:    Generate a new key at https://lenz.io/api-credentials.
    //   Docs:   https://lenz.io/docs/auth
    //   Request ID: req_abc123
  } else if (exc instanceof LenzRateLimitError) {
    // Waits up to 60s are already retried for you, so reaching here means
    // either the ladder ran out or the wait is long. Don't sleep it — the
    // /extract daily cap can be hours away.
    scheduleRetryIn(exc.retryAfter);
  } else if (exc instanceof LenzValidationError) {
    for (const fieldErr of exc.errors) {
      console.error(fieldErr["loc"], fieldErr["msg"]);
    }
  } else if (exc instanceof LenzUpstreamUnavailableError) {
    // HTTP 503, code "upstream_unavailable" (model/search providers
    // exhausted) or "capacity" (submissions shed at the door). Nothing was
    // charged. Waits up to 60s are already slept through by the automatic
    // retry ladder; reaching here means the server stated a longer one.
    scheduleRetryIn(exc.retryAfter ?? 90); // typically 90-120s
  } else {
    throw exc;
  }
}
```

A failed _verification_ (as opposed to a failed HTTP call) throws
`LenzPipelineError` from `verifyAndWait` / `wait`. Since 2.8.0 it carries
`failureClass` (closed set: `upstream_unavailable` | `insufficient_evidence`
| `invalid_input` | `cancelled` | `internal`) and `retryable` — `true` means
a transient provider-side exhaustion where resubmitting the same claim is the
right move; older servers leave it `null`.

`LenzQuotaExceededError` is a **sibling** of `LenzAuthError`, not a subclass —
"fix your key" and "top up your account" are different actions. So if you were
checking `LenzAuthError` to handle an empty balance, that branch stops firing;
add a `LenzQuotaExceededError` case.

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

// Later (different process / restart) — block on the same task_id:
const verification = await client.wait("tsk_abc123");
console.log(verification.verdict, verification.lenz_score);

// ...or do a single non-blocking poll yourself:
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

## Multi-language output

The Lenz API returns prose fields (atomic claim, executive summary, debate, panel
reasoning) in any of 12 languages. Pass `language:` on `verify`, `verifyAndWait`,
`verifyBatch`, `assess`, `extract`, or `ask.send`. Verdict labels stay English
regardless of language.

```ts
const v = await client.verifyAndWait({
  claim: "La Tierra es plana",
  language: "es", // Spanish output
});
console.log(v.verdict, v.language);
// False es
```

Supported codes: `en` (default), `es`, `de`, `fr`, `it`, `pt`, `nl`, `sv`, `da`,
`no`, `fi`, `bg`. Per-item override on `verifyBatch`:

```ts
const batch = await client.verifyBatch({
  claims: [
    { text: "Coffee causes cancer." }, // en (batch default)
    { text: "El café causa cáncer.", language: "es" }, // overrides
  ],
  language: "en",
});
```

## Configuration

```ts
new Lenz({
  apiKey: "lenz_...", // or set LENZ_API_KEY env var
  baseUrl: "https://lenz.io/api/v1", // override for staging / local
  timeoutMs: 30000,
  maxRetries: 3,
  fetch: customFetch, // inject for tests
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

## Contributing

```bash
git clone https://github.com/lenzhq/lenz-io-node && cd lenz-io-node
npm install
git config core.hooksPath scripts/hooks   # one-time: enables pre-commit
```

The pre-commit hook mirrors CI exactly (`npm run lint`, `npm run type`,
`npm test`, `npm run build`). Runs ~10s per commit on a warm cache. Skip
once with `git commit --no-verify` when you must.

## Bug reports + feature requests

[github.com/lenzhq/lenz-io-node/issues](https://github.com/lenzhq/lenz-io-node/issues)

For commercial use, volume pricing, or onboarding support,
[get in touch](https://lenz.io/contact).

## License

MIT. See [LICENSE](LICENSE).

## Maintainer

[@Pavel12431432](https://github.com/Pavel12431432)
