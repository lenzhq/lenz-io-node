# lenz-io

Official Node SDK for the [Lenz Fact Checking API for AI Product Teams](https://lenz.io/developers).

**Six API calls: one research-depth ladder, one call that runs it on a whole draft, and the citation check on its own.**

- `extract` — pull verifiable claims out of any text, optionally narrowed with a `focus`. Free, 1000 calls/account/day (shared across your API keys).
- `assess` — fast 3-model panel verdict in ~15s; one claim, or up to 20 claims in one call. Sync, paid.
- `verify` — full multi-model pipeline with citations in ~90s. Async, paid.
- `citecheck` — the citation check on its own: does each source a draft cites say what the draft says? Async.
- `ask` — follow-up questions grounded on a verification. Sync, paid.
- `review` — the ladder on a draft in one async call, its citations too if asked: its claims, a quick verdict on each, a deep check on the doubtful ones, issues, with rewrites.

Built for teams whose AI output is async or document-shaped: legal-memo
generators, deep-research products, due-diligence platforms, vertical
agents producing structured deliverables. Not chat AI, not voice AI,
not real-time copilots — pipeline runs are the wrong shape for those.

```bash
npm install lenz-io
```

## Review a draft

```ts
import { Lenz } from "lenz-io";

const client = new Lenz({ apiKey: "lenz_..." });

const draft = `
The EU AI Act entered into force on 1 August 2024, and its obligations for
general-purpose models applied from 2 August 2025. Fines for prohibited
practices reach 7% of global annual turnover. About 40% of European
companies had started compliance work by the end of 2024.
`;

// One call: extract, assess, and verify the doubtful claims (async, 2–4 min)
const review = await client.reviewAndWait({ text: draft });
console.log(review.outcome); // clean | issues_found | incomplete | unchecked
for (const i of review.issues) {
  console.log(i.verdict, i.confidence, i.claim);
  if (i.suggested_rewrite) console.log("  Suggested rewrite:", i.suggested_rewrite);
}

// Past the cap: send the remaining claims to /verify in one batch
const capped = review.claims
  .filter((c) => c.escalation?.disposition === "cap")
  .map((c) => ({ claim: c.claim }));
const results = capped.length ? await client.verifyBatchAndWait({ claims: capped }) : [];
```

`review` reads the draft's claims (up to 20, most check-worthy first), gives
each a quick `assess` verdict, and sends the ones whose quick verdict is
`False`, `Mostly False` or `Mixed`, or whose confidence is `low`, through the
full `verify` pipeline, up to five. Change the rule with the flat options:

```ts
await client.review({
  text: draft,
  verdicts: ["False", "Mostly False"], // quick labels that get a deep check ([] = none)
  confidence: ["low", "medium"], // quick confidence bands that do ([] = none)
  maxAssessments: 10, // how many claims get a quick verdict (1-20)
  maxVerifications: 3, // the deep-check cap (0 = quick verdicts only)
  depth: "low", // depth of every deep check
});
```

- **`outcome`** is the field to branch on once the review ends: `clean`,
  `issues_found`, `incomplete` (a check failed) or `unchecked` (the review
  failed before it assessed anything). `clean` covers the claims the review
  selected, at the depth its policy chose.
- **`issues`** are the claims whose final verdict is `False`, `Mostly False`
  or `Mixed`; a completed deep check overrides the quick verdict. A deep-checked
  issue carries `key_finding`, `verification_id` and `suggested_rewrite`; an
  issue that stayed on its quick verdict carries `rationale` and an
  `escalation` saying why it stayed quick (`cap`, `credits`, …).
- **`suggested_rewrite`** comes from the deep check; an issue that stayed on its
  quick verdict has one only when the review asked for suggested edits
  (`suggestEdits: true`). It is not verified itself: review it, or run it
  through `verify`, before you use it.
- **`failures`** lists the claims outside the issues whose check failed.
- **`positions`** on each claim row says where the draft makes the claim
  (every place, at most 10), and **`more_claim_locations`** gives
  `{ claim, positions }` for each of `more_claims`, in the same order. A
  review checks only the claims it traced back to the draft. A `Position` is
  `{ start, end, text }`: `start` / `end` count code points, so slice with
  `Array.from(text).slice(start, end).join("")`, and `text` is the passage.
  For a URL draft `start` / `end` are `null` and `text` still carries the
  passage. `positions` is `null` when the claim could not be located.

**Checking the draft's sources.** `maxCitations: N` (1-20) also checks the
draft's first N citations, its links and DOIs: does each source say what the
draft says it does? Links are read from `text`, so keep a link as a markdown
link (`[words](https://...)`); a Word or Google document pasted as plain text
loses them. With `maxAssessments: 0` the review checks the sources and no
claim.

```ts
const review = await client.reviewAndWait({ text: draft, maxCitations: 20, maxAssessments: 0 });
const s = review.summary;
console.log(`${s.citations_found} found, ${s.citations_selected} checked`);
for (const c of review.citation_issues) {
  // most serious first
  console.log(c.finding, c.cited_url ?? c.doi, c.statement);
  if (c.snippet) console.log("  The source says:", c.snippet);
}
```

`finding` is one of `doi_not_found`, `page_not_found`, `contradicted`,
`quote_not_in_source`, `not_in_source` or `metadata_mismatch`, most serious
first. `partly_supported` (the source backs part of the statement) is reported
in `citations` with its snippet, but it is not an issue: `is_issue` is false
and it is not in `citation_issues`. `citations` lists every checked
citation with its `check`; a row that could not be checked says why in
`check.unchecked_reason` and what to do in `check.hint`, and
`citation_failures` lists the ones that failed on our side. A citation issue
makes `outcome` `issues_found` even when `issues` is empty. `rationale` is a
reviewer's note, not a checked source; `snippet` is the passage from the page.
`more_claims` and `more_citations` list what the draft holds past
`maxAssessments` and `maxCitations`: found, not checked, to send in a later
request. Leave `maxCitations` out (or `0`) and no citation is checked.

**Suggested edits.** `suggestEdits: true` also returns, for each claim with a
suggested rewrite (from its deep check, or from its quick check when it stayed
on the quick verdict), the smallest edits to the draft that make it say what
the rewrite says, in the draft's own language. They cost no extra credits, and
the review completes once they are settled. Each claim row
(and its issue) carries `suggested_edits`: `status` `"pending"` or
`"completed"`, and `edits`, each a span of the `text` you sent (`start`/`end` in
code points, `text` the exact slice) and its `replacement`. An empty `edits`
means no edit could be made safely, or it could not be computed. They are not
themselves verified. Two claims that share a passage can return overlapping
edits: apply one of them.

Offsets all index the text you sent, so apply every claim's edits together,
from the end of the text back:

```ts
const review = await client.reviewAndWait({ text: draft, suggestEdits: true });
const edits = review.claims
  .flatMap((c) => c.suggested_edits?.edits ?? [])
  .sort((a, b) => b.start - a.start);
const chars = Array.from(draft); // code points
let takenFrom = chars.length;
for (const e of edits) {
  // skip an edit that overlaps one applied, or whose text the draft no longer holds
  if (e.end <= takenFrom && chars.slice(e.start, e.end).join("") === e.text) {
    chars.splice(e.start, e.end - e.start, ...Array.from(e.replacement));
    takenFrom = e.start;
  }
}
const edited = chars.join("");
```

`reviewAndWait` polls on the review's own `poll_after_seconds` and takes
`{ timeoutMs, onUpdate }`: `onUpdate(review)` fires on every poll that changed
the review, so you can show the quick verdicts as they land. It throws
`ReviewFailedError` (`hint`, `review`, whose `failure.code` says why) when the review fails and
`ReviewTimeoutError` (`reviewId`, `partial`) at the deadline (10 minutes by
default); the review keeps running, so read it later with
`client.getReview(reviewId)`. Without waiting: `client.review(...)` returns
`{ review_id }`, and `client.getReview(reviewId, { view: "issues" })` returns
the review without its `claims`.

Credits: 1 per claim assessed, plus 10 (5 at `depth: "low"`) per deep check;
`review.credits.charged` says what the review cost. A resend with the same
`idempotencyKey` within 24 hours returns the same review; a new key is a new
review.

## Check a draft's citations

`citecheck` runs the citation check on its own, without the rest of a review:
does each cited source say what the draft says it does? Send a draft (its
links are read from the text, as for `review`) or the statement-source pairs
yourself.

```ts
const check = await client.citecheckAndWait({ text: draft, maxCitations: 10 });
console.log(check.outcome); // clean | issues_found | incomplete | unchecked
for (const c of check.citation_issues) console.log(c.finding, c.cited_url ?? c.doi, c.statement);

// Pairs: each checked as it is (maxCitations does not apply)
await client.citecheckAndWait({
  pairs: [
    {
      statement: "Water boils at 100 degrees Celsius at sea level.",
      url: "https://en.wikipedia.org/wiki/Boiling_point",
    },
    {
      statement: "Diamond sensors can measure temperature in a living cell.",
      doi: "10.1038/nature12373",
      cited_year: "2013",
    },
  ],
});
```

The body carries the same rows as a review's: `citations`, `citation_issues`,
`citation_failures`, `summary` and `more_citations` (the draft's citations past
`maxCitations`, found but not checked). `client.citecheck(...)` returns a
`citecheck_id` at once; read it with `client.getCitecheck(citecheckId)`.
`citecheckAndWait` throws `CitecheckFailedError` when the check fails and
`CitecheckTimeoutError` at the deadline. `citecheck.completed` and
`citecheck.failed` webhooks parse into `CitecheckCompleted` / `CitecheckFailed`.

## Quickstart — the canonical integration

```ts
import { Lenz } from "lenz-io";
import type { AssessClaim } from "lenz-io";

const client = new Lenz({ apiKey: "lenz_..." });

// 1. extract — pull verifiable claims out of any text (free)
//    add focus: "..." to narrow it to the claims you care about
const out = await client.extract({ text: llmOutput });
const claims = (out.claims ?? []).map((c) => c.claim);

// 2. assess — one call per 20 claims (extract finds up to 100), one row per
//    claim, in the same order (~15s a call, sync)
const quick: AssessClaim[] = [];
for (let i = 0; i < claims.length; i += 20) {
  quick.push(...(await client.assess({ claims: claims.slice(i, i + 20) })).claims);
}
for (const c of quick) {
  console.log(c.verdict, c.confidence, c.claim);
  if (c.rationale) console.log("  ", c.rationale);
}

// 3. verify — escalate the low-confidence rows to the full panel + citations
// verifyBatchAndWait takes up to 20 claims a call: the first 20 here
const doubtful = quick
  .filter((c) => c.status !== "failed" && c.confidence === "low")
  .map((c) => ({ claim: c.claim! }))
  .slice(0, 20);
const results = doubtful.length ? await client.verifyBatchAndWait({ claims: doubtful }) : [];
for (const r of results) {
  if (r.status === "completed") {
    const v = r.verification!;
    console.log(v.verdict, v.lenz_score, v.executive_summary);
  }
}

// 4. ask — follow-up grounded on a verification
const deep = results.find((r) => r.status === "completed")?.verification;
const reply = await client.ask.send(deep!.verification_id!, {
  message: "Which source is strongest?",
});
console.log(reply.content);
```

`assess({ claims })` takes up to 20 claims per call and answers with exactly
one row per item, in the order sent. A row with `status === "failed"` had no
verdict: `failure.code` says why (`no_checkable_claim`, `framing_failed`,
`upstream_unavailable`, or `timeout` — an open set; the last two are the ones
worth resending as-is) and `failure.hint` says what to send next. Failed rows
are free. A compound item is assessed on its main claim and lists the rest in
`more_claims` — send those as their own items to check them. The
single form, `assess({ claim })`, takes one text and answers with a row per
claim found in it, up to 20, at 1 credit each; a text that makes more claims
gets its 20 most check-worthy checked and the rest in `more_claims`, unchecked
and free — send them back as `claims`, 20 a call. The two are mutually
exclusive.

Each verdict row also carries two optional notes. `rationale` is the
reasoning of a reviewer who agrees with the panel's verdict; `dissent`, when
set, is the reasoning of the reviewer farthest from it. Both are reviewers'
notes, not checked sources; for sourced evidence, call `verify`. Read them as
optional: either can be `null` or absent.

**Suggested rewrite.** `suggestRewrite: true` also writes, on each row the
check found `False` or `Mostly False` with high confidence, the claim with its
wrong part corrected (`suggested_rewrite`, else `null`), at no extra credit.
It is not itself verified: review it, or run it through `verify`, before
using it.

```ts
const [row] = (
  await client.assess({ claim: "Venus is the closest planet to the Sun.", suggestRewrite: true })
).claims;
if (row?.suggested_rewrite) console.log(row.suggested_rewrite); // e.g. "Mercury is the closest planet to the Sun."
```

`assess` and `verify` share a result cache server-side: if a claim
already has a deep verification, `assess` returns it via
`verification_url` and you can skip the escalation. An answer served from
that cache (a claim checked in the last hour) is free, so a tool that
resends the same request is not charged twice.

## How verification works

Framing → Research → Debate (2 models, 2 rounds) → Panel Review
(3 reviewers running the same checks, 2 more when they disagree) → Conclusion. ~90 seconds wall-clock
per claim. `assess` runs a leaner 3-model panel against the same
framing for the ~15s pass.

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

The demo claim is cached for an hour after anyone verifies it, so it can
come back in seconds; otherwise it runs the full pipeline (~90s) like
your own claims. Use webhooks for production async flows.

> **Get your webhook secret here →** [lenz.io/api-credentials](https://lenz.io/api-credentials)

## What you get on the client

- **`client.extract({ text })`** → `ExtractedClaims`. Free, capped at 1000/account/day. Add `focus` to narrow the list, and `locate: true` to keep only the claims traced back to your text with where each is made — see [Steering extract](#steering-extract). Each attempt waits up to 150s by default (a timeout is retried like any transport error, under the same idempotency key); `timeoutMs` overrides it for that call.
- **`client.assess({ claim })`** → `AssessResponse`. Sync, ~15s, returns one entry per identified claim. (`text` is accepted as an alias: a document is `text`, a claim is `claim`.)
- **`client.assess({ claims })`** → `AssessResponse`. Up to 20 claims in one call, one row per item in the order sent; rows without a verdict come back in position with `status: "failed"` and a `failure` (`code`, `hint`). Both forms take a per-call `timeoutMs` (default 100s: a long text can take up to 90s on the server).
- **`client.verify({ claim })`** → `TaskAccepted`. Async submit; returns a `task_id`. Get the result by polling (`client.wait(...)` / `client.getStatus(...)`) or via a webhook.
- **`client.verifyAndWait({ claim, ... })`** → `Verification`. Submit + poll until the pipeline lands (sync ergonomic). Equivalent to `wait(verify(...))`.
- **`client.wait(task)`** → `Verification`. Block on a `task_id` (or a `TaskAccepted`) until it terminates. The polling counterpart to a webhook.
- **`client.verifyBatch({ claims })`** → `BatchAccepted`. Fan-out for multi-claim LLM outputs.
- **`client.verifyBatchAndWait({ claims })`** → `BatchItemResult[]`. Fan out a batch and poll every item to completion; one result per claim, in input order, never throws on a per-item failure.
- **`client.ask.{history,send,reset}(verificationId, ...)`** → Q&A on a verification. `reply.content` uses a small markdown subset (`**bold**`, `*italic*`, `- ` or `* ` bullets, blank-line paragraphs) — render with a minimal markdown library or display verbatim. See [docs/quickstart#ask-reply-format](https://lenz.io/docs/quickstart#ask-reply-format).
- **`client.verifications.{list,get,delete,related}(...)`** → manage past verifications. All API claims are private; reference them by `verification_id`. Cache-hit on another customer's claim is transparent — you always see your own `verification_id`, never another customer's.
- **`client.library.list(...)`** → browse the public catalog (no API key needed).
- **`client.usage()`** → your credit balance (`credits`), the price list (`costs` — `verify` 10, `assess` 1, `ask` 1, `extract` 0 — plus `cost_options` for parameter-dependent prices such as `depth`), and that balance projected into each capability's unit (`verify` / `ask` / `assess`), plus the daily `extract` rate limit. Also reports `has_webhook_secret` — whether this key can receive signed webhook callbacks (`verify` with a `webhook_url` needs one); the secret value itself is never exposed. See [Credits](#credits).

## Polling without webhooks

`verify()` returns immediately with a `task_id`; the pipeline runs async (~90s
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
    console.log(r.claim, "→", r.verification!.verdict);
  } else {
    console.log(r.claim, "→", r.status); // needs_input | failed | timeout
  }
}
```

A `failed` item with no `status_detail` is a verification its account's
retention period has removed (HTTP 410, see [Retention](#retention)); every
other failure carries a `status_detail`.

A verify takes ~90 seconds, so show your users where it is. `onProgress` fires
once per poll while the run is going — it takes the `taskId` as well, because
the batch helper round-robins several ids in one loop:

```ts
await client.verifyAndWait({
  claim: "Sharks don't get cancer",
  onProgress: (taskId, p) => console.log(`${p.step} — step ${p.index} of ${p.total}`),
});
// framing — step 1 of 5
// research — step 2 of 5
// ...
```

`p.step` is one of `starting` / `framing` / `research` / `debate` /
`adjudication` / `conclusion`. `p.index` is stage **position**, not elapsed
work — the stages are uneven, so a bar driven by it sits on `research` for
roughly half the run. A throw inside your callback never breaks the poll.

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

### Newer field names

Since 3.0 the SDK asks for API version `2026-10-11` (`X-Lenz-API-Version`),
the response shape with one name for each field, and reads only that shape
for its own calls (webhooks of both shapes are still parsed). Responses carry
the newer names beside the 2.x ones, which keep their 2.x values and are
deprecated (struck through in editors) but still there, so code written
against 2.x keeps working unchanged. The raw bodies (`LenzError.body`, a
webhook event's `raw`) show the response as sent.

| Read this                                          | Instead of (deprecated)                             |
| -------------------------------------------------- | --------------------------------------------------- |
| `extract` → `claims` (`[{ claim, positions }]`)    | `claim`, `identified_claims`, `locations`           |
| `assess` row `status` (`completed` \| `failed`)    | `verdict === "Error"`                               |
| `failure` (`code`, `detail`, `hint`, ...)          | `error`, `error_code`, `failure_reason`, row `hint` |
| `more_claims` on an `assess` or review row         | `identified_claims`                                 |
| `claim` on receipt items and `needs_input` options | `claim_text`, `text`                                |
| `completed_at` on a verification                   | `modified_at` (set only on a later calendar day)    |
| `claim_limit_exceeded`, `citation_limit_exceeded`  | `claim_limit_reached`, `citation_limit_reached`     |

The full list is under "Deprecated" in the 3.0.0 entry of the
[changelog](CHANGELOG.md). A failure's `code` says `no_checkable_claim` where
the 2.x fields say `not_a_claim` (`verify`, `extract`) or `no_claim`
(`assess`, `review`). `extract`'s `status` keeps reading `not_a_claim`.

### Coverage reasons

On an account with the warranty, a verification carries `coverage`. When
`coverage.status` is `"uncovered"`, `coverage.reasons` says why, from a closed
set (`CoverageReason`): `plan`, `account`, `depth`, `verdict`, `quality`,
`withdrawn`, `issue_failed`. `account` means the account turned certificates
off; it applies to checks submitted after the change, and a verification that
already carries a certificate keeps it.

### Suggested rewrite

A verification can carry `suggested_rewrite`, a string: a suggested rewrite
of `claim` that the verification's findings support, to use in place of the
original sentence. It has not been verified itself: before using it, review
it or run it through `client.verify({ claim })`. It is `null` for a true
claim, when no correction is established, and on verifications that predate
the field, and absent on responses from an API that predates it. It is on every verification, single or listed:
`verifications.get`, `verifications.list`, `library.list`, `verifyAndWait`,
`wait`, and the `verification.completed` webhook's `result`. `assess` rows
carry their own with `suggestRewrite: true`.

```ts
const rewrite = v.suggested_rewrite ?? null;
if (rewrite) {
  console.log("Suggested rewrite:", rewrite);
}
```

### Webhooks

```ts
import { LenzWebhooks } from "lenz-io";
import type {
  ReviewCompleted,
  VerificationCompleted,
  VerificationFailed,
  VerificationNeedsInput,
} from "lenz-io";

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
      // failed.failure.code is WHERE the pipeline stopped; failure_class is
      // WHY (closed set) and retryable tells you what to do about it.
      if (failed.failure?.retryable) {
        resubmitLater(failed.taskId); // transient provider outage
      } else {
        logPermanentFailure(failed.taskId, failed.failure?.code);
      }
      break;
    }
    case "review.completed": {
      const done = event as ReviewCompleted;
      // Dedupe on eventId: a retry of the same delivery keeps it.
      if (alreadyHandled(done.eventId)) break;
      for (const i of done.review.issues) flagIssue(i.claim, i.verdict, i.suggested_rewrite);
      break;
    }
    default:
      // An event you do not recognise: ignore it. New kinds are added
      // without a major release.
      break;
  }
  res.status(200).send();
});
```

`review.completed` and `review.failed` carry the whole review under `review`,
as `client.getReview` returns it; a review's own deep checks fire no
`verification.*` events. Dedupe on `eventId`, which stays the same across
retries while `attempt` changes.

Signature verification is HMAC-SHA256 over the raw bytes; the SDK does it for
you and rejects tampered or replayed payloads.

See [`examples/core/express-webhook.ts`](examples/core/express-webhook.ts)
for a runnable receiver and [`examples/core/verify-llm-output.ts`](examples/core/verify-llm-output.ts)
for the headline assess-then-escalate pattern.

## Credits

One balance per account, spent by every billable call:

| Call                                   | Credits                                  |
| -------------------------------------- | ---------------------------------------- |
| `verify` (and `verifyBatch`, `select`) | **10** per claim                         |
| `verify` with `depth: "low"`           | **5** per claim                          |
| `assess`                               | 1 per claim; `Error` rows are free       |
| `ask`                                  | 1                                        |
| `extract`                              | 0 — free, bounded by a daily cap instead |

```ts
const u = await client.usage();

u.credits.remaining; // 5070 — the balance, in credits
u.credits.extra; // 200 — the non-expiring part of it
u.credits.resets_at; // when the monthly allowance refills, or null

u.costs["verify"]; // 10 credits per verification
u.cost_options.verify.depth.low; // 5 — half price at depth: "low"
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

`credits.bonus` is the **deprecated** old name of `credits.extra`, the same
number, and the per-capability `credits` field (always that capability's
one-off top-up balance) is the deprecated name of `bonus`. Both, like the
`verify` / `ask` / `assess` blocks and `quota_resets_at`, are kept for
existing code: `usage()` fills them in from `credits` and `costs` when the API
sends only those.

### Depth pricing

`cost_options.verify.depth.low` is the price of a `depth: "low"` verification — half a
standard one. `low` caps research breadth (fewer discovery queries, a hard
extraction ceiling, no recovery fetch tiers) while every reasoning step runs
the same models; it is not a model downgrade.

It is a **price, not a capability**, which is why it is nested under
`cost_options` rather than sitting in `costs` beside the four capability
names. There is deliberately no `u.verify_low`
block beside `u.verify` — it would report the same balance in a second unit.
Divide the balance yourself when you want the count:

```ts
// Every level is optional: a server predating this field sends `{}`, and
// the capability's default price in `costs` is the right fallback.
const low = u.cost_options.verify?.depth?.low ?? u.costs["verify"];
const lowDepthLeft = Math.floor(u.credits.remaining / low); // 1014
```

**You are charged for the depth you requested, not the one you were served.**
The `depth` echoed on the completed verification is what the verdict was
_produced_ with, so it can read `standard` on a `low` request — the echo
describes the evidence behind the answer, the charge follows the request. A
batch may mix depths and is billed per item.

**A verdict served from the last hour's cache is free**, on `verify`,
`assess` and `review` alike. The one exception is a `verify` that issues your
business plan a new warranty certificate, charged at the depth you requested.

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
    // `cost` is depth-aware: a rejected depth: "low" verify reports 5, and a
    // rejected batch mixing depths reports its real summed total. Read it
    // rather than multiplying `requested` by a price you assumed.
    console.error(exc.resetsAt); // "2026-09-01T00:00:00+00:00", or null
    console.error(exc.upgradeUrl); // https://lenz.io/plans
  } else if (exc instanceof LenzAuthError) {
    console.error(String(exc));
    // Unauthorized
    //   Cause:  Invalid api key
    //   Fix:    Your credential is missing, invalid or expired. Check the key you passed, or get a new one at https://lenz.io/api-credentials.
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

A read of a verification removed under its account's retention period throws
`LenzGoneError` (HTTP 410, `code` `"purged"`, with `purgedAt`), and `wait` /
`verifyAndWait` stop on it instead of polling to the deadline. See
[Retention](#retention).

`LenzQuotaExceededError` is a **sibling** of `LenzAuthError`, not a subclass —
"fix your key" and "top up your account" are different actions. So if you were
checking `LenzAuthError` to handle an empty balance, that branch stops firing;
add a `LenzQuotaExceededError` case.

## Resuming a verification

If a `verifyAndWait` call exceeds its `timeoutMs` (default 300000) or your
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

## Retention

An account on the Pro or Scale plan can set a retention period on its
[API credentials page](https://lenz.io/api-credentials). Verifications older than the period are removed, and every
read of one — `verifications.get`, `wait` / `getStatus` on its task, related
claims, follow-up questions — throws `LenzGoneError`:

```ts
import { LenzGoneError } from "lenz-io";

try {
  await client.verifications.get("a1b2c3d4");
} catch (exc) {
  if (exc instanceof LenzGoneError) {
    console.error(exc.code, exc.purgedAt); // "purged", "2026-10-01T09:00:00+00:00"
  }
}
```

It also disappears from `verifications.list()`. Retrying does not bring a
removed verification back. The certificate of a
covered verification is kept and can still be downloaded.

## Idempotency

`verify`, `verifyAndWait`, `select`, `assess` and `extract` send an
auto-generated `Idempotency-Key` on every call by default: a random key per
call, reused across that call's own retries, so a network drop or a client
timeout doesn't spawn a duplicate verification or charge a second credit. The
key is never derived from the request. Override with `idempotencyKey: "..."`
to pin a specific key, or `idempotency: false` to opt out.

`review` always sends one: a random key per call unless you pass
`idempotencyKey`. A resend with the same key within 24 hours returns the same
review; a new key is a new review.

`ask.send` takes a key too, but only pins one you choose:

```ts
const reply = await client.ask.send(verificationId, {
  message: "Which source says that?",
  idempotencyKey: `${conversationId}:turn-4`,
});
```

With a key, a retry of a question that already got a reply replays that reply
instead of spending a second credit and leaving the question plus a second
answer in the conversation. A retry sent while the first call is still running
gets a 409 (`LenzError`, `statusCode` 409) — there is no reply to replay yet.

No key is ever generated for you here, and none is derived from the message: a
reply depends on the conversation so far, so asking the same question again is
a normal thing to do. Without a key the call behaves exactly as before — a
retry asks again, and pays again.

## Steering extract

`extract` returns every major factual claim it finds, ranked most-check-worthy
first. On a long document that is often more than you want to verify. Pass
`focus` to narrow it:

```ts
const out = await client.extract({
  text: pitchDeck,
  focus: "market size, growth and competitors",
});
```

A focus can only **select** from the claims the extractor found. It cannot add
a claim, reword one, reorder them, change the output language, or change what
counts as a claim — selection runs over the claim list, not over your document,
so a claim you get back is one an unfocused call would have returned too,
verbatim.

At most 300 characters. A longer focus is rejected with a 422 rather than
truncated, so you never get a subset you did not ask for.

When the document has claims but none fall within your focus, `status` is
`"no_match"` and `claims` is empty. The unfocused list is never
substituted — widen the focus and call again.

```ts
if (out.status === "no_match") {
  // nothing in this document matched; broaden the focus
}
```

A focused call costs the same single unit of the daily cap as an unfocused one.

### Locating claims in the text

Pass `locate: true` to keep only the claims that could be traced directly back
to your text, with where the text makes each one:

```ts
const out = await client.extract({ text: draft, locate: true });

for (const found of out.claims ?? []) {
  for (const p of found.positions ?? []) {
    if (p.start === null || p.end === null) continue; // the text was a URL
    // Offsets are code points: slice with Array.from, not text.slice.
    const passage = Array.from(draft).slice(p.start, p.end).join("");
    console.log(found.claim, "->", passage); // passage === p.text
  }
}
```

A claim found nowhere in the text, or found with a different figure, is left
out; if none is left, `status` is `"not_a_claim"`. `claims` has one entry
per returned claim, and each entry's `positions` lists every place the text makes the claim, in text
order (1 to 10). Locating adds a few seconds.

`start` and `end` (exclusive) count Unicode **code points** in the text as you
sent it. JavaScript's `text.slice(start, end)` counts UTF-16 units, so it
shifts after an emoji; `Array.from(text).slice(start, end).join("")` is the
correct slice. Both are `null` when the text was a URL (the page is not
returned, so there is nothing to index); `text` is always the passage as it
appears. The same `Position` shape marks a claim in a review and a citation's
statement (where `text` is `null`: the row carries the statement).

`claims` is `[]` when every claim was left out (`status` is then
`"not_a_claim"`). Each claim's `positions` is `null` when `locate` was not set
or when the claims could not be located, in which case the list is returned
unfiltered. `locate` defaults to `false`.

## Multi-language output

The Lenz API returns prose fields (atomic claim, executive summary, debate, panel
reasoning) in any of 12 languages. Pass `language:` on `verify`, `verifyAndWait`,
`verifyBatch`, `assess`, `extract`, or `ask.send`. Verdict labels stay English
regardless of language. On `extract`, `language` and `focus` are independent —
a focus written in any language selects claims emitted in `language`.

```ts
const v = await client.verifyAndWait({
  claim: "La Tierra es plana",
  language: "es", // Spanish output
});
console.log(v.verdict, v.language);
// False es
```

Supported codes: `en` (default), `es`, `de`, `fr`, `it`, `pt`, `nl`, `sv`, `da`,
`no`, `fi`, `bg`. To ask for another language, contact us at
https://lenz.io/contact.

### Answer in the language of the text

Pass `language: "auto"` on `assess`, `verify`, `verifyAndWait` or `ask.send` and
the answer comes back in the language of the text you submitted. A concrete code
such as `"es"` always wins, and omitting `language` still means English. On
`ask.send`, `"auto"` uses the language of the claim being discussed. `extract`,
`verifyBatch`, `citecheck` and `review` do not accept `"auto"` (the API answers
422, as for any unsupported language).

```ts
const v = await client.verifyAndWait({
  claim: "Die Erde ist flach",
  language: "auto", // answer in German
});
console.log(v.language);
// de
```

On `assess` with a `claims` list, one language is chosen for the whole request:
the language most items agree on, else English. For a list in mixed languages,
name a code instead.

A runnable version is in [`examples/core/verify-auto.ts`](examples/core/verify-auto.ts).

Per-item override on `verifyBatch`:

```ts
const batch = await client.verifyBatch({
  claims: [
    { claim: "Coffee causes cancer." }, // en (batch default)
    { claim: "El café causa cáncer.", language: "es" }, // overrides
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

An OAuth access token for the Lenz API works wherever the API key goes: pass it as `apiKey` or in `LENZ_API_KEY`.

## Compatibility

- Node 20.19+, 22, 24
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
