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

## First call

```bash
npm install lenz-io
export LENZ_API_KEY=lenz_...   # from https://lenz.io/api-credentials (a free account comes with credits)
```

```ts
import { Lenz } from "lenz-io";

const client = new Lenz(); // reads LENZ_API_KEY

const { claims } = await client.assess({ claim: "The Eiffel Tower is in Berlin." });
for (const row of claims) {
  if (row.status === "failed") console.log("No verdict:", row.failure?.hint);
  else console.log(row.verdict, row.confidence, row.claim); // False high The Eiffel Tower is in Berlin.
}
```

`assess` is the quick check: a verdict and a confidence for each claim in
about 15-20 seconds, 1 credit a claim. For sources and a 1-10 score, deep-check
a claim with `verify` (below); to check a whole draft, `review` it.

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

Credits: 1 per claim assessed, plus 10 (5 at `depth: "low"`) per deep check,
plus 1 per checked citation;
`review.credits.charged` says what the review cost. A resend with the same
`idempotencyKey` within 24 hours returns the same review; a new key is a new
review.

A runnable version is in [`examples/core/review-draft.ts`](examples/core/review-draft.ts).

## Check a draft's citations

`citecheck` runs the citation check on its own, without the rest of a review:
does each cited source say what the draft says it does? Send a draft (its
links are read from the text, as for `review`) or the statement-source pairs
yourself.

```ts
const check = await client.citecheckAndWait({ text: draft, maxCitations: 10 });
console.log(check.outcome); // clean | issues_found | incomplete | unchecked
for (const c of check.citation_issues) console.log(c.finding, c.cited_url ?? c.doi, c.statement);

// Pairs: each checked as it is (maxCitations does not apply). A DOI pair can
// carry what the reference gives: citedTitle, citedAuthors, citedYear, citedJournal.
await client.citecheckAndWait({
  pairs: [
    {
      statement: "Water boils at 100 degrees Celsius at sea level.",
      url: "https://en.wikipedia.org/wiki/Boiling_point",
    },
    {
      statement: "Diamond sensors can measure temperature in a living cell.",
      doi: "10.1038/nature12373",
      citedYear: "2013",
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
A runnable version is in [`examples/core/citecheck.ts`](examples/core/citecheck.ts).

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
  .filter((c) => c.status !== "failed" && c.confidence === "low" && c.claim)
  .map((c) => ({ claim: c.claim! }))
  .slice(0, 20);
const results = doubtful.length ? await client.verifyBatchAndWait({ claims: doubtful }) : [];
for (const r of results) {
  if (r.status === "completed") {
    const v = r.verification!;
    console.log(v.verdict, v.lenz_score, v.executive_summary);
  }
}

// 4. ask — a follow-up question on a completed deep check, when there is one
const deep = results.find((r) => r.status === "completed")?.verification;
if (deep?.verification_id) {
  const reply = await client.ask.send(deep.verification_id, {
    message: "Which source is strongest?",
  });
  console.log(reply.content);
}
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

Each verdict row also carries an optional note. `rationale` is the
reasoning of a reviewer who agrees with the panel's verdict. It is a
reviewer's note, not a checked source; for sourced evidence, call `verify`.
Read it as optional: it can be `null` or absent. (`dissent` is deprecated: it
is always `null` and is kept only so code that reads it keeps working.)

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

Inputs are camelCase; outputs keep the API's names. (The 2.x snake_case
inputs, `source_url` / `webhook_url` on a batch item and `cited_title` /
`cited_authors` / `cited_year` / `cited_journal` on a citation pair, still
work and are deprecated. A citation pair's own enumerable keys are read, as
when it is serialized. Giving both spellings of a field with different values
throws an `Error` naming both before anything is sent.)

- **`client.extract({ text })`** → `ExtractedClaims`. Free, capped at 1000/account/day. Add `focus` to narrow the list, and `locate: true` to keep only the claims traced back to your text with where each is made — see [Steering extract](#steering-extract). Each attempt waits up to 150s by default (a timeout is retried like any transport error, under the same idempotency key); `timeoutMs` in the options argument (`extract(input, { timeoutMs })`) overrides it for that call.
- **`client.assess({ claim })`** → `AssessResponse`. Sync, ~15s, returns one entry per identified claim. (`text` is accepted as an alias: a document is `text`, a claim is `claim`.)
- **`client.assess({ claims })`** → `AssessResponse`. Up to 20 claims in one call, one row per item in the order sent; rows without a verdict come back in position with `status: "failed"` and a `failure` (`code`, `hint`). Both forms take a per-call `timeoutMs` in the options argument (default 100s: a long text can take up to 90s on the server).
- **`client.verify({ claim })`** → `TaskAccepted`. Async submit; returns a `task_id`. Get the result by polling (`client.wait(...)` / `client.getStatus(...)`) or via a webhook.
- **`client.verifyAndWait({ claim, ... })`** → `Verification`. Submit + poll until the pipeline lands (sync ergonomic). Equivalent to `wait(verify(...))`.
- **`client.wait(task)`** → `Verification`. Block on a `task_id` (or a `TaskAccepted`) until it terminates. The polling counterpart to a webhook.
- **`client.verifyBatch({ claims })`** → `BatchAccepted`. Fan-out for multi-claim LLM outputs.
- **`client.verifyBatchAndWait({ claims })`** → `BatchItemResult[]`. Fan out a batch and poll every item to completion; one result per claim, in input order, never throws on a per-item failure.
- **`client.ask.{history,send,reset}(verificationId, ...)`** → Q&A on a verification. `reply.content` uses a small markdown subset (`**bold**`, `*italic*`, `- ` or `* ` bullets, blank-line paragraphs) — render with a minimal markdown library or display verbatim. See [docs/quickstart#ask-reply-format](https://lenz.io/docs/quickstart#ask-reply-format).
- **`client.verifications.{list,get,delete,related}(...)`** → manage past verifications. `verifications.list({ page, pageSize })` reads one page; `pageSize` is a whole number from 1 to 100 (anything else throws before a request) and, when omitted, the server's default of 20 applies. `verifications.listAll()` iterates every page (`for await (const v of client.verifications.listAll({ pageSize: 100 })) …`), one request a page, each asking for the same `pageSize`. All API claims are private; reference them by `verification_id`. Cache-hit on another customer's claim is transparent — you always see your own `verification_id`, never another customer's.
- **`client.library.list(...)`** → browse the public catalog (no API key needed). `library.listAll(filters)` iterates every page of a filtered list (any `sort` but `"random"`).
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
  claims: [
    { text: "Sharks don't get cancer" },
    { text: "The Eiffel Tower is 330m tall", sourceUrl: "https://example.com/paris-guide" },
  ],
});
for (const r of results) {
  if (r.status === "completed") {
    console.log(r.claim, "→", r.verification!.verdict);
  } else {
    console.log(r.claim, "→", r.status); // needs_input | failed | timeout
  }
}
```

A `failed` item with no `status_detail` is one whose poll answered something
waiting will not change for that claim: the verification was removed under its
account's retention period (HTTP 410, see [Retention](#retention)), the task
was not found (404), or the answer came in another API version. Every other
failure carries a `status_detail`.

A verify takes ~90 seconds, so show your users where it is. `onProgress` fires
once per poll while the run is going — it takes the `taskId` as well, because
the batch helper round-robins several ids in one loop:

```ts
await client.verifyAndWait(
  { claim: "Sharks don't get cancer" },
  { onProgress: (taskId, p) => console.log(`${p.step} — step ${p.index} of ${p.total}`) },
);
// framing — step 1 of 5
// research — step 2 of 5
// ...
```

`p.step` is one of `starting` / `framing` / `research` / `debate` /
`adjudication` / `conclusion`. `p.index` is stage **position**, not elapsed
work — the stages are uneven, so a bar driven by it sits on `research` for
roughly half the run. A throw inside your callback never breaks the poll.

Every waiter takes its wait options as the second argument:

```ts
await client.wait(task, { timeoutMs: 180_000, onProgress });
await client.verifyAndWait({ claim }, { timeoutMs: 180_000, onProgress });
await client.verifyBatchAndWait({ claims }, { timeoutMs: 180_000, onProgress });
await client.reviewAndWait({ text: draft }, { timeoutMs: 600_000, onUpdate });
await client.citecheckAndWait({ text: draft }, { timeoutMs: 600_000, onUpdate });
```

`timeoutMs` is the wait's deadline: 300 s by default for verifications, 10
minutes for reviews and citation checks. Every wait starts it after the submit
(review and citation waits since 3.0; before, their budget included the
submit). With `0` or less a wait submits normally and polls once.
The verification waits call `onProgress(taskId, progress)`; review and citation
waits call `onUpdate(body)` with the whole changed body. Passing `timeoutMs` /
`onProgress` inside the `verifyAndWait` / `verifyBatchAndWait` input, as 2.x
did, still works and is deprecated; when both are given, the second argument
wins field by field.

Prefer **webhooks** for production async flows (no long-lived HTTP connection);
prefer **polling** for scripts and request/response handlers where awaiting is
fine. For full control over the loop, call `getStatus(taskId)` yourself — it's a
single non-blocking poll.

## Stopping a run

Stop a run you no longer need: three calls, one per kind of work. None sends a
body or an `Idempotency-Key`; cancelling is safe to repeat, so a failed attempt
is retried like any other request.

```ts
const accepted = await client.verify({ claim: "..." });
const out = await client.cancel(accepted.task_id); // { task_id, cancelled, status }

const review = await client.cancelReview(reviewId); // the review, as getReview returns it
const check = await client.cancelCitecheck(citecheckId); // the check, as getCitecheck returns it
```

- **`cancel(taskId)`** answers for every run of yours, whatever its state.
  `cancelled: true` means the run is cancelled (`status: "cancelled"`), by this
  call or an earlier one, so a repeat, or a retry after a lost response,
  answers `true` again. `cancelled: false` means it was not cancelled and
  nothing changed: `status` is the run's status, normally `completed` (the
  verification exists and was charged as usual) or `failed` (not charged). A
  task that `select` already resolved answers `cancelled: false` with
  `needs_input`: cancel the task ids `select` returned. A cancelled
  verification is not charged and saves nothing. Reading it afterwards with
  `getStatus` returns the status `"cancelled"`, and `wait` throws the error
  for a failed run with `failureClass` `"cancelled"` and `retryable` `false`.
- **`cancelReview(reviewId)`** stops the review and the deep checks it
  started, and returns the full view with `status: "cancelled"`; a review that
  had already finished is returned unchanged. A review's deep checks cannot be
  cancelled on their own: `cancel` on one throws a `LenzError` with
  `statusCode` 409 and `code` `"use_review_cancel"` (not retryable). Cancel
  the review instead.
- **`cancelCitecheck(citecheckId)`** does the same for a citation check.

A review is charged only for what it delivered before the cancel (the quick
checks it served, the deep checks that finished, the citations it checked); the
rest is refunded or never charged. A citation check is charged only for the
citations it checked; the rest are refunded.

An unknown id, another account's, or (for `cancel`) the task of a run started
on the website throws `LenzNotFoundError` (404); a purged review or check
throws `LenzGoneError` (410). An empty id, `.` or `..` throws before any request
is sent.

### Aborting a call

Every method takes a `signal` (see [Configuration](#configuration)). When it
fires, the call stops where it is (a request, a retry sleep, a poll, the items
of a `listAll`) and throws `LenzAbortError`:

```ts
import { LenzAbortError } from "lenz-io";

try {
  await client.verifyAndWait({ claim }, { signal: AbortSignal.timeout(60_000) });
} catch (e) {
  if (e instanceof LenzAbortError && e.taskId) await client.cancel(e.taskId);
  else throw e;
}
```

- `LenzAbortError` is not a `LenzError` (an abort is your decision, not an API
  answer), its `name` is `"AbortError"`, and its `cause` is the signal's
  `reason` (a `TimeoutError` for `AbortSignal.timeout(ms)`, which bounds a
  whole call, retries and polls included).
- **Nothing is cancelled on the server** unless a wait asks for it with
  `cancelOnAbort: true` (below). Work the server accepted keeps running and is
  charged if it completes. Stop it with `cancel`, `cancelReview` or
  `cancelCitecheck`, as above.
- It carries what the call knew: `idempotencyKey` when the request was keyed
  (resend with it to get the same answer, or the submit's receipt, back
  instead of starting the work again), and once the work was accepted,
  `taskId`, `batchId` and `taskIds` (every accepted task, in input order),
  `reviewId` or `citecheckId`. A call with `idempotency: false` carries no
  key; if it was aborted during the submit, there is no safe way to find the
  task (`verifications.list` may show it).
- A client copy made with a signal (`withOptions({ signal })`) is dead once the
  signal fires: every later call on it throws `LenzAbortError`. Make such a
  copy per request, and cancel through the client you made it from.

### Cancel the run when the caller goes away

The waits (`wait`, `verifyAndWait`, `verifyBatchAndWait`, `reviewAndWait`,
`citecheckAndWait`) take `cancelOnAbort: true` (since 3.1; default `false`).
When the signal fires after the run was accepted, the wait sends the matching
cancel itself, then throws the same `LenzAbortError`:

```ts
export async function POST(request: Request): Promise<Response> {
  const { text } = (await request.json()) as { text: string };
  const review = await client.reviewAndWait(
    { text },
    { signal: request.signal, cancelOnAbort: true },
  );
  return Response.json(review);
}
```

- The signal must fire when your caller goes away. Where your framework hands
  you a `Request` whose `signal` fires on a client disconnect (Bun does),
  pass `request.signal`. On Cloudflare Workers, `request.signal` needs the
  `enable_request_signal` compatibility flag, and a disconnect may end the
  invocation before the cancel leaves: send the cancel yourself inside
  `ctx.waitUntil`, or do not rely on this. Express has no `request.signal`:
  make an `AbortController`, call `controller.abort()` on `res.on("close", …)`
  when `!res.writableFinished`, and pass `controller.signal`.
- The cancel is `cancel` for a verification (one per task a batch accepted and
  not yet seen to end, sent concurrently), `cancelReview` for a review and
  `cancelCitecheck` for a citation check. It is best effort: one attempt each,
  no retry, all within 5 s, after which the abort is thrown whatever the
  cancels did. So the abort is thrown up to 5 s after the signal fires: with
  `AbortSignal.timeout(ms)`, the call can overrun `ms` by up to 5 s.
- A cancel that fails, times out, or finds the run already ended is reported
  to the client's `logger.warn` with the job id only, never thrown. Without a
  logger it is silent.
- What is charged: a cancelled verification is not charged; a cancelled review
  or citation check is still charged for what it had delivered (only the rest
  is refunded); a run that completed before the cancel reached it is billed as
  a completed run.
- An abort during the submit has nothing to cancel: resend with the error's
  `idempotencyKey` to find the run, as above. A `*AndWait` called with a
  signal that has already fired sends nothing; `wait(taskId, …)` already has
  the id, so it sends the cancel, then throws with `taskId`.
- The wait's own `timeoutMs` running out is not an abort and never cancels the
  run. A signal you pass, `AbortSignal.timeout(ms)` included, is an abort.
- It is an option of one wait, not of `withOptions` (which throws if given
  `true`): a copy's `signal` firing cancels the run only for the waits called
  with `cancelOnAbort: true`.

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
against 2.x keeps compiling and reading the same fields, except for the
differences listed under Breaking in the [changelog](CHANGELOG.md) and the
steps under its Migrating section (the API must answer `2026-10-11`; code
that reads raw bodies, and webhook receivers on lenz-io older than 2.21.0,
need updating first). The raw bodies (`LenzError.body`, a
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

Lenz signs each delivery with HMAC-SHA256 over the raw body. `LenzWebhooks`
verifies the signature, rejects a payload outside the replay window, and
returns a typed event. Two ways to call it, by runtime:

- **`await webhooks.unwrap(request)`** takes a standard `Request` and verifies
  with WebCrypto. Use it on Cloudflare Workers, Deno, Bun, Vercel Edge,
  Next.js route handlers, Hono, and any other framework that gives you a
  `Request`. It needs no Node built-in. `await webhooks.parseAsync(rawBody,
headers)` is the same for a framework that hands you the body (a string or
  bytes) and the headers instead.
- **`webhooks.parse(rawBody, headers)`** is synchronous and uses Node's
  `crypto`. Use it on Node servers that give you the raw body (Express with
  `express.raw`). On a runtime without Node's `crypto` it throws an error that
  points you to `unwrap`.

Both throw the same `LenzWebhookSignatureError` for a missing or wrong
signature, a body that is not a JSON object, or a stale `delivered_at`.

```ts
// Next.js: app/api/lenz-webhook/route.ts
import { LenzWebhooks } from "lenz-io";

export async function POST(request: Request) {
  // Built inside the handler: `next build` imports this module without the secret.
  const webhooks = new LenzWebhooks({ secret: process.env.LENZ_WEBHOOK_SECRET! });
  const event = await webhooks.unwrap(request); // throws LenzWebhookSignatureError
  // ...handle the event (below)...
  return Response.json({ received: "ok" });
}
```

```ts
// Hono, on Workers, Deno or Bun
app.post("/webhook", async (c) => {
  const event = await new LenzWebhooks({ secret: c.env.LENZ_WEBHOOK_SECRET }).unwrap(c.req.raw);
  // ...
  return c.json({ received: "ok" });
});
```

Do not read the body (`request.json()`, `request.text()`) before `unwrap`: the
signature covers the exact bytes sent, and a body can be read once.

Handling the event, here on Node with Express:

```ts
import { LenzWebhooks, isEvent } from "lenz-io";

const webhooks = new LenzWebhooks({ secret: "whsec_..." });

// In your Express handler (use express.raw() to get rawBody as Buffer):
app.post("/lenz-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const event = webhooks.parse(req.body, req.headers as Record<string, string>);
  // isEvent narrows on the event name AND the member it promises, so a
  // malformed payload under a known name is never taken for a real one.
  if (isEvent(event, "verification.completed")) {
    const r = event.verification.result;
    // r.verdict, r.lenz_score, r.confidence, ...
  } else if (isEvent(event, "verification.needs_input")) {
    // …surface candidate claims, call client.select(taskId, ...) to resolve
  } else if (isEvent(event, "verification.failed")) {
    // failure.code is WHERE the pipeline stopped; failure_class is WHY
    // (closed set) and retryable tells you what to do about it.
    if (event.failure?.retryable) {
      resubmitLater(event.taskId); // transient provider outage
    } else {
      logPermanentFailure(event.taskId, event.failure?.code);
    }
  } else if (isEvent(event, "verification.cancelled")) {
    // Stopped elsewhere (the website's Stop button, another process): nothing
    // to retry. Sent for work submitted under 2026-10-11; older work arrives
    // as verification.failed with failure class "cancelled".
    markCancelled(event.taskId);
  } else if (isEvent(event, "review.completed")) {
    // Dedupe on eventId: a retry of the same delivery keeps it.
    if (!alreadyHandled(event.eventId)) {
      for (const i of event.review.issues) flagIssue(i.claim, i.verdict, i.suggested_rewrite);
    }
  } else if (isEvent(event, "citecheck.completed")) {
    for (const c of event.citecheck.citation_issues) flagCitation(c);
  }
  // Any other event (one you do not recognise, or a malformed one): ignore
  // it. New kinds are added without a major release.
  res.status(200).send();
});
```

`verification.cancelled`, `review.cancelled` and `citecheck.cancelled` (a task
cancelled elsewhere) narrow with `isEvent`; each carries the cancelled
`verification` / `review` / `citecheck` and its `eventId`, nothing more. They are sent only for work submitted under API version
2026-10-11; a cancellation of older work keeps arriving as `*.failed` with
failure class `cancelled`.

`review.completed` and `review.failed` carry the whole review under `review`,
as `client.getReview` returns it, and `citecheck.*` the whole check under
`citecheck`; a review's own deep checks fire no `verification.*` events.
Dedupe on `eventId`, which stays the same across retries while `attempt`
changes. Every event carries `eventId` when its payload does (all of them,
for work started with 3.x); the original shape of `verification.*` events
has none.

See [`examples/core/nextjs-webhook.ts`](examples/core/nextjs-webhook.ts) (Next.js),
[`examples/core/hono-webhook.ts`](examples/core/hono-webhook.ts) (Hono) and
[`examples/core/express-webhook.ts`](examples/core/express-webhook.ts) (Express)
for runnable receivers, and [`examples/core/verify-llm-output.ts`](examples/core/verify-llm-output.ts)
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
support tickets, and `retryable`: `true` when sending the same request again
later can succeed (a network failure, a transport timeout, a 429, a 5xx, a
409 `idempotency_conflict` or `verification_not_ready`), `false` when it
cannot (any other 4xx), `null` when unknown.

An error from a call that sent an `Idempotency-Key` carries it as
`idempotencyKey` (`undefined` otherwise). Sending the same request again is
safe only with that key: pass `idempotencyKey: exc.idempotencyKey` back. A
plain new call mints a new key, and if the first one reached the server, the
work runs (and is charged) twice.

```ts
import {
  LenzAuthError,
  LenzConnectionError,
  LenzNotFoundError,
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
  } else if (exc instanceof LenzNotFoundError) {
    // HTTP 404: nothing with that id is visible to this key. Check the id;
    // retrying will not help.
  } else if (exc instanceof LenzConnectionError) {
    // No HTTP answer after the automatic retries: a network failure, or
    // (LenzRequestTimeoutError, a subclass) one attempt ran past timeoutMs.
    // exc.cause is the underlying fetch error. The request may have reached
    // the server: resend with the same key so it cannot run twice.
    await client.verifyAndWait({ claim: "...", idempotencyKey: exc.idempotencyKey });
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
right move; older servers leave it `null`. A verification, review or citation
check cancelled elsewhere (the website's Stop button, another process) ends a
wait the same way: `failureClass` is `"cancelled"` and `retryable` is `false`.
Reading it with `getStatus` / `getReview` / `getCitecheck` returns the status
`"cancelled"` and does not throw.

`LenzConnectionError` and `LenzUpstreamUnavailableError` are subclasses of
`LenzAPIError`, so a 2.x handler for it still catches them. A
`LenzRequestTimeoutError` (one HTTP attempt took too long) is not a
`LenzTimeoutError`, which means a wait (`wait`, `*AndWait`) reached its
deadline while the job kept running on the server: read it later, do not
resubmit it.

`wait`, `verifyAndWait` and `verifyBatchAndWait` stop at once when a poll
answers an error waiting cannot change: `wait` throws it (401, 403, 404,
`LenzApiVersionError`). In a batch, a 404 or an answer in another API version
for one claim makes that claim read `"failed"` while the others keep being
polled; a 401 or 403 is about the key, so `verifyBatchAndWait` throws it. A
5xx, a 429 or a network drop is polled through. No poll runs past the wait's
`timeoutMs`; once it is spent, the claims still running read `"timeout"`
(`wait` throws `LenzTimeoutError`).

A read of a verification removed under its account's retention period throws
`LenzGoneError` (HTTP 410, `code` `"purged"`, with `purgedAt`), and `wait` /
`verifyAndWait` stop on it instead of polling to the deadline. See
[Retention](#retention).

A successful response (status below 400) that names an API version other
than `2026-10-11` in its `X-Lenz-API-Version` header (for example
`2026-05-13`, as an older stored replay of an idempotent call can) is not
parsed: the call throws `LenzApiVersionError` with `servedVersion` (the
version named), `expectedVersion` (`"2026-10-11"`, both since 3.2),
`apiVersion` (the same as `servedVersion`), `statusCode` and `body` (as sent);
its message names the version the API answered. If it persists, contact
support with the request id; lenz-io 2.x reads both versions. An idempotent
request first sent with 2.x (before lenz.io served `2026-10-11`) and replayed
with the same key is answered this way: finish such work with 2.x, and never
change the key to get past it, which would run the call again. A response with
no such header is not checked, and neither are webhook events.

An **error** response (400 or above) in another version throws its own error,
the one its status and body call for (a `LenzQuotaExceededError` with its
balance, a `LenzRateLimitError` with its `retryAfter`, ...), retried like any
other, with the version it named in `servedVersion` (since 3.2; 3.0 and 3.1
threw `LenzApiVersionError` for it, hiding the balance or the wait).
`verifications.delete` still throws a 404 in another version rather than
reading it as already deleted.

**`body` and `code`.** `err.body` is the parsed JSON body of the error
response exactly as sent (`null` or `{}` when there was none): the source of
truth, every other field is read from it. `err.code` is the server's
machine-readable code, `""` when there is none. By default it is the code
lenz-io 2.x reported for that call, which left some codes out (`not_found`,
`not_authenticated` on the review calls, ...) and renamed a few (a blank
`assess` item reads `blank_item`). On a client made with
`legacyAliases: false` it is exactly the body's `code` (since 3.2):
`not_found`, `idempotency_conflict`, `validation_error`, `blank_input`,
`not_authenticated`, ... The error's class and its other fields are the same
either way.

**`retryAfter`** is the wait the response stated, in whole seconds. Where it
comes from depends on the error:

| Error                                                                                                       | `retryAfter` read from, first match                                                                | Unstated |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| `LenzRateLimitError` (429)                                                                                  | the `Retry-After` header, then the body's `reset_in_seconds`, `retry_after_seconds`, `retry_after` | `0`      |
| `LenzAPIError` (any 5xx), `LenzUpstreamUnavailableError` (503 `upstream_unavailable` / `capacity`) included | the body's `retry_after`, then `retry_after_seconds`, then the `Retry-After` header                | `null`   |

The client's own retries (429, 5xx and a 409 still in flight) sleep the
`Retry-After` header first, then the body's `reset_in_seconds`,
`retry_after`, `retry_after_seconds`, whatever the status, up to 60 s. A
longer stated wait on a 429 or a typed 503 throws at once with it on
`retryAfter`; on any other 5xx the client keeps to its own backoff.

**`headers`** (since 3.2): the error response's headers as a plain object,
names in lower case (`err.headers?.["retry-after"]`); `undefined` when there
was no HTTP answer or the SDK raised the error itself. **`servedVersion`**
(since 3.2): the `X-Lenz-API-Version` the error response named, `""` when it
named none.

A 2xx answer whose body is not JSON (a proxy's or captive portal's page, a
body cut short) throws `LenzInvalidResponseError`, a `LenzAPIError` with the
real `statusCode`, the `requestId` and `bodyText` (the first 1000 characters
as received); `retryable` is `null`, so resend a paid call only with its
`idempotencyKey`. An empty or blank body counts as not JSON; only a 204, a
205 or a `Content-Length: 0` answer reads as `{}`. So does (since 3.2) a body
that is JSON but not an object (`null`, a list, a number, a string), where
every Lenz endpoint answers with an object: `bodyText` holds it, and its
message says "not a JSON object". `statusCode` 0 means the request got no HTTP
answer at all (`LenzConnectionError`). Before 3.2 a body that is not JSON threw
the runtime's `SyntaxError`, and one that is JSON but not an object failed
later with a `TypeError`.

A blank input is refused before anything is sent (since 3.2): `verify` /
`verifyAndWait` with no `claim` (or one of only whitespace), and `assess` with
no `claim`, an empty `claims` list or a blank item in it, throw
`LenzValidationError` with the sentence and `code` the API's 422 would have
given (`"Text is required."`, `claims[1] is required.`), `statusCode` 0 and
no `body`.

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
  await client.verifyAndWait({ claim: "..." }, { timeoutMs: 30000 });
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

Every call that runs or charges for work sends an `Idempotency-Key` by
default: `verify`, `verifyAndWait`, `verifyBatch`, `verifyBatchAndWait`,
`select`, `assess`, `extract`, `ask.send`, `review` and `citecheck`. The key
is random per call and reused across that call's own retries, so a network
drop or a client timeout doesn't start a duplicate verification or charge a
second credit. It is never derived from the request: the same text sent again
in a new call is a new request. Pin a key with `idempotencyKey: "..."` (so a
retry from another process replays too), or opt out with
`idempotency: false` (on `review`, `citecheck` and their `*AndWait` helpers
since 3.2; they always sent one before). A non-empty `idempotencyKey` wins over
`idempotency: false`. Without a key, a retried submit can run (and charge)
twice: opt out only when your caller already dedupes, or with `maxRetries: 0`.

```ts
const reply = await client.ask.send(verificationId, {
  message: "Which source says that?",
  idempotencyKey: `${conversationId}:turn-4`,
});
```

A resend with the same key within 24 hours replays the first answer (the same
receipt, review or reply) instead of running the call again. A resend while
the first call is still running is answered 409 (`body.code`
`idempotency_conflict`); the client waits and asks again with the same key
and body, within the call's retries and timeout. If the first call is still
running after that, it throws that `LenzError` (`statusCode` 409,
`retryable: true`): send it again later with the same key
(`idempotencyKey: err.idempotencyKey`), never with a new one, which would run
the call a second time.

`review` and `citecheck` (and their waits) differ here: a 409
`idempotency_conflict` that names the job (`review_id` / `citecheck_id`)
means the first submit with that key created it, so the call returns it as a
`ReviewStarted` / `CitecheckStarted` (`status` `"queued"`, `raw` the 409's
body) instead of waiting or throwing. Read or wait for it by its id as usual.
A submit sent without a key never gets such a 409.

`cancel`, `cancelReview` and `cancelCitecheck` send none: cancelling again
returns the run as it stands, so a repeat is harmless.

Every error of a call that sent a key carries it as `err.idempotencyKey`,
including the timeout of a `*AndWait` (resending it with that key returns the
work already started). A plain new call mints a new key and can run twice. On `ask.send`,
asking the same question again in a new call is a new turn.

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

Pass `language: "auto"` on `assess`, `verify`, `verifyAndWait`, `review`,
`reviewAndWait`, `extract` or `ask.send` and the answer comes back in the
language of the text you submitted (for a review, one language for the whole
draft). A concrete code such as `"es"` always wins, and omitting `language`
still means English. On `ask.send`, `"auto"` uses the language of the claim
being discussed. On `extract`, the claims are written in the language of the
text (of the fetched page when `text` is a single URL); a short or undetectable
text gives English, and the result's `language` is the code that was used. Pass
it on to `assess` or `verify` to keep a chain in one language, rather than
sending `"auto"` again on short extracted claims. `verifyBatch` and `citecheck`
do not accept `"auto"` (the API answers 422, as for any unsupported language).
A review of a draft that is only a link decides its language once the page is
read: until then its `language` reads `"auto"`, and a page that cannot be read
leaves English.

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
  logger: console, // optional: retries (debug), verifyAndWait's task id (info), a cancelOnAbort cancel that did not cancel (warn); silent without one
});
```

`timeoutMs` (a finite number of ms above 0) is the timeout of one HTTP attempt;
`maxRetries` (a whole number, 0 or more) is how many times a failed request is
retried. Any other value throws an `Error` when the client is made.

A custom `fetch` is called with the attempt's `signal` in its `init`. The
timeout and a caller's `signal` work by aborting it, so a `fetch` you pass must
honour `init.signal` (every runtime's own `fetch` does); one that drops it
cannot be timed out.

A key is visible ASCII with nothing inside it: one with a space, a line break,
another control character or a non-ASCII character inside it throws
`LenzAuthError` when the client (or a `withOptions` copy) is made, before any
request (since 3.2; before, every call failed on it). Whitespace around a key
is dropped. The message never contains the key.

A text containing a lone UTF-16 surrogate (half of an emoji cut by a
`slice`) is sent with each one replaced by U+FFFD; valid pairs are unchanged.

Environment variables:

- `LENZ_API_KEY` — read if `apiKey` is not passed (or is `undefined`). An explicit `apiKey: ""` (or one of only whitespace) means no key and never reads the environment: a call that needs a key throws `LenzAuthError`. A server holding several users' keys makes its client with `apiKey: ""` and gives each request its user's key with `withOptions({ apiKey })` (see [Using lenz-io from a server that forwards per-user credentials](#using-lenz-io-from-a-server-that-forwards-per-user-credentials)).
- `LENZ_BASE_URL` — read if `baseUrl` is not passed.

### Per-call options

Every method takes request options for one call: in its options argument
(`verify(input, options)`, `getStatus(taskId, options)`, `usage(options)`, …),
or merged into the options object it already takes (the waits' options,
`getReview`'s `{ view }`, `verifications.list`'s `{ page, pageSize }`,
`verifications.related`'s `{ limit }`):

```ts
await client.assess({ claim }, { timeoutMs: 20_000, maxRetries: 0 });
await client.verify({ claim }, { signal, headers: { "X-Trace-Id": traceId } });
await client.getReview(reviewId, { view: "issues", signal });
```

| Option       | What it does                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`     | Stops the call: every request, retry sleep and poll it makes. Throws `LenzAbortError` (see [Aborting a call](#aborting-a-call)).                   |
| `timeoutMs`  | The timeout of one HTTP attempt, in ms; each retry gets it again.                                                                                  |
| `maxRetries` | How many times a failed request is retried.                                                                                                        |
| `headers`    | Extra request headers. A `User-Agent` or `Accept` here replaces the client's. `null` removes one a `withOptions` copy set; `undefined` is ignored. |

What the options bound, per method:

| Methods                                                                                                                                                                          | `timeoutMs`                                                                                                                         | `maxRetries`                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain calls (`verify`, `verifyBatch`, `select`, `getStatus`, `cancel*`, `review`, `citecheck`, `getReview`, `getCitecheck`, `usage`, `verifications.*`, `ask.*`, `library.list`) | each attempt (default: the client's, 30 s)                                                                                          | each request's retries                                                                                                                          |
| `extract`, `assess`                                                                                                                                                              | each attempt; used as given (so is a copy's), even below the 150 s / 100 s these wait at least when the timeout is the client's own | each request's retries                                                                                                                          |
| Waits (`wait`, `verifyAndWait`, `verifyBatchAndWait`, `reviewAndWait`, `citecheckAndWait`)                                                                                       | stays the wait's whole budget; a poll's attempt timeout is the client's (or the copy's), cut at what is left                        | the submit's; `wait` takes none (it throws). Verification polls keep the client's retries; review and citation-check polls are one attempt each |
| `verifications.listAll`, `library.listAll`                                                                                                                                       | each page request (options checked when `listAll` is called)                                                                        | each page request's retries                                                                                                                     |
| `withOptions`                                                                                                                                                                    | every call made through the copy                                                                                                    | every call made through the copy                                                                                                                |

The waits also take `cancelOnAbort: true`: when the `signal` fires after the
run was accepted, the run is cancelled on the server too (see
[Cancel the run when the caller goes away](#cancel-the-run-when-the-caller-goes-away)).

For one call, the call's value wins, then the deprecated `timeoutMs` inside an
`extract` / `assess` input, then a `withOptions` copy's, then the client's.
Headers merge (case does not matter; the call's value wins), the others
replace. `extract` and `assess` wait at least 150 s and 100 s when the
timeout is the client's own (`new Lenz({ timeoutMs })` or the default); a
`timeoutMs` given for the call or on a `withOptions` copy is used as given
(3.1 and earlier raised a copy's to the minimum too). Below the minimum it can
end a call the server is still running; a retry with the same idempotency key
then replays it rather than running it twice. Invalid values (a `timeoutMs` that is
not a finite number above 0, a `maxRetries` that is not a whole number from 0,
a timeout above 2,147,483,647 ms (the longest a timer can hold), a header name
that is not a valid token, a header value that is not a string or `null`, or
one that is not visible ASCII with spaces and tabs only between visible
characters) throw an `Error` before any request. `X-Lenz-API-Version`, `Idempotency-Key` (use `idempotencyKey`),
`Authorization` (use `apiKey`), `Content-Type`, `Content-Length`, `Host` and
`Transfer-Encoding` cannot be set as options.

`client.withOptions(options)` returns a copy of the client whose options apply
to every call made through it. The copy is cheap: it shares the `fetch`, key,
base URL and logger, keeps your subclass and any method you replaced, and
leaves the original untouched. A copy's `timeoutMs` is also the attempt timeout
of its waits' polls. A copy of a copy starts from the first copy's options: its
headers merge over them, its signal is added to the first copy's, and its
`timeoutMs` / `maxRetries` replace them. A call reads its options once, when it
is made: changing the objects you passed afterwards changes nothing, for every
page of a `listAll` and every poll of a wait too.

A copy is made without running your constructor, so it cannot carry
JavaScript `#private` fields: a subclass method that reads one throws a
`TypeError` on a copy (a wait then ends with that error). A subclass that
keeps state in `#private` fields should not be copied with `withOptions`;
pass the options per call instead, or keep that state in ordinary properties.

```ts
const quick = client.withOptions({ timeoutMs: 10_000, maxRetries: 1 });

// One copy per incoming request: the call stops when the caller goes away.
export async function POST(request: Request): Promise<Response> {
  const { claim } = (await request.json()) as { claim: string };
  const perRequest = client.withOptions({ signal: request.signal });
  return Response.json(await perRequest.assess({ claim }));
}
```

`withOptions` also takes `apiKey`: a copy that sends another key (or OAuth
access token) on the same transport, for a server that calls Lenz for several
accounts. Only when `apiKey` is absent does the copy keep the client's key;
given as `undefined`, `null`, an empty or a whitespace-only string (a tenant
with no key), the copy has no key, and a call that needs one throws
`LenzAuthError` before sending. A copy never reads `LENZ_API_KEY`. A key with
a space, a control character or a non-ASCII character inside it throws
`LenzAuthError` when the copy is made. An option name `withOptions` does not take
(`apikey`, `api_key`, ...) throws.

```ts
const client = new Lenz({ apiKey: process.env.LENZ_API_KEY });
const forTenant = client.withOptions({ apiKey: tenant.lenzKey });
await forTenant.assess({ claim });
```

An OAuth access token for the Lenz API works wherever the API key goes: pass it as `apiKey` or in `LENZ_API_KEY`.

### Results as the API sends them (`legacyAliases`)

3.x results also carry the names and values 2.x returned, computed from the
`2026-10-11` response (see [Newer field names](#newer-field-names)).
`new Lenz({ legacyAliases: false })` turns that off: each result is exactly
the body the API sent. The default is `true`, so 3.x behaviour is unchanged.
It is set on the client; a `withOptions` copy keeps it (and throws if given
it). The result types are unchanged; with `false`, these are not added:

| Result                                                                                                                                                                         | Not added with `legacyAliases: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A verification (`verifications.get`, `list` / `listAll` items, `library.list` items, `wait` / `verifyAndWait`, a batch result's `verification`, a review row's `verification`) | `modified_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getStatus` (also a batch result's `status_detail` and a needs-input error's `payload`)                                                                                        | on a pause, each option's `text` (options carry `claim` only); on `failed`, the flat `error`, `failure_reason`, `failure_class`, `retryable`, `docs_url`, `hint` and `failure.failure_reason`; on `cancelled`, the same flat fields and the `failure` block built when the API sent none                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `assess`                                                                                                                                                                       | on a failed row, `verdict: "Error"` and `confidence: "low"` (both stay `null`), and on every row `error_code`, `hint`, `identified_claims`, `candidate_claims`, `failure.failure_reason`; at the top, `error`, `error_code`, `candidate_claims`, `status`, `failure.failure_reason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `extract`                                                                                                                                                                      | `claim`, `identified_claims`, `candidate_claims`, `locations`, and `status` stays `no_checkable_claim` (not `not_a_claim`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `verifyBatch` / `select` receipts, `verifyBatchAndWait` results                                                                                                                | each item's `claim_text`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `usage`                                                                                                                                                                        | `credits.bonus`, `quota_resets_at` and the `verify` / `ask` / `assess` blocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getReview`, `reviewAndWait`, `cancelReview`                                                                                                                                   | `failure_reason` in every failure block (the review's, `failures`, `issues`, each claim row's assessment and verification, each citation row's check, `citation_issues`, `citation_failures`); on an assessment, `identified_claims`, `error_code`, `hint`; in `summary`, `claim_limit_reached` and the second name of `citation_limit_reached` / `citation_limit_exceeded`; and the defaults for keys the body lacks (`[]` for `citations`, `citation_issues`, `citation_failures`; `null` for `more_claims`, `more_claim_locations`, `more_citations`, rows' `positions`, `suggested_edits`, `suggested_rewrite`, `missing_quote`, the summary's citation counts and `policy.max_citations`; `0` for `summary.citation_issues`; `false` for `policy.suggest_edits`) |
| `getCitecheck`, `citecheckAndWait`, `cancelCitecheck`                                                                                                                          | `failure_reason` in every failure block, the second name of the citation limit, and the `[]` / `null` defaults for `citations`, `citation_issues`, `citation_failures`, `more_citations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Errors (their classes and fields, `ReviewFailedError` / `CitecheckFailedError`
included), webhook events and the requests sent are the same either way, with
two exceptions: the `partial` of a `ReviewTimeoutError` /
`CitecheckTimeoutError` (the last body the wait saw) is that body as the API
sent it, and `err.code` is exactly the `code` of the response body (since 3.2;
see [Errors](#errors)).

**The body as received: `raw`** (since 3.2). Whatever `legacyAliases` says,
each result carries `raw`: the JSON object it was read from, exactly as
received, with none of the names or defaults the SDK adds. It is a getter, not
an own enumerable key, so it does not show in `JSON.stringify`, `Object.keys`,
a spread or a deep-equal, and each read is a fresh deep copy (change it
freely).

```ts
const out = await client.assess({ claims: ["A.", "B."] });
out.raw; // { claims: [...], more_claims: [...], ... } as sent
```

Nested objects hold their own part of the body (since 3.2, as on the Python
SDK):

```ts
out.claims[0].raw; // that row's object
const status = await client.getStatus(taskId);
status.result?.raw; // the verification's object
```

Covered: every result that is one answer's body (`verify`, `verifyBatch`,
`select`, `getStatus`, `cancel`, `extract`, `assess`, `usage`,
`verifications.get` / `list` / `getCertificate` / `related`, `ask.history` /
`ask.send`, `library.list`, `review`, `citecheck`, `getReview`,
`getCitecheck`, `cancelReview`, `cancelCitecheck`, and what `reviewAndWait` /
`citecheckAndWait` return: the final poll's body), and every object nested in
one that the body holds at the same place (assess rows and their `failure`,
a status's `result`, review rows, their `assessment` / `verification` and the
`summary`, citation rows, the items of a list page and of `listAll`, ...;
lists themselves carry none). A wait's verification (`wait`,
`verifyAndWait`, and each `verification` of a `verifyBatchAndWait` row) holds
the verification as the final poll sent it; a row's `status_detail` holds that
poll's body. A `review` / `citecheck` receipt settled by a 409 that names the
job holds that 409's body. Not covered: a `verifyBatchAndWait` row itself (the
SDK builds it), and an object the SDK added (a default, a 2.x block). An
object that carries its own `raw` key keeps it.

## Using lenz-io from a server that forwards per-user credentials

A gateway, an MCP server or any backend that calls Lenz on behalf of its own
users, each with their own Lenz API key or OAuth access token:

```ts
import { Lenz, LenzError } from "lenz-io";

// One client for the process. No key of its own, and LENZ_API_KEY is never read.
const lenz = new Lenz({
  apiKey: "",
  legacyAliases: false, // results and error codes exactly as sent
  maxRetries: 0, // you own the retry budget
});

export async function check(userToken: string, text: string, signal: AbortSignal) {
  const client = lenz.withOptions({ apiKey: userToken, timeoutMs: 20_000, signal });
  try {
    const out = await client.assess({ claim: text });
    return out.raw; // the API's JSON object, as received
  } catch (err) {
    if (err instanceof LenzError) {
      return { error: err.code, status: err.statusCode, body: err.body };
    }
    throw err;
  }
}
```

- **Per-user keys**: `withOptions({ apiKey })` per request, on the same
  client. A copy never reads `LENZ_API_KEY`; an empty or whitespace-only key,
  `undefined` or `null` gives a copy with no key, and a call that needs one
  throws `LenzAuthError` before sending. A key with a space, a control
  character or a non-ASCII character inside it throws `LenzAuthError` when
  the copy is made. Copies are cheap and independent: make one per request.
- **`legacyAliases: false`** is a constructor option only (`withOptions`
  throws if given it): every copy reads like its client. Results are what the
  API sent, and `err.code` is the body's `code`.
- **Headers**, highest first: the call's `headers`, then the copy's (a copy
  of a copy merges over the first), then the client's defaults
  (`User-Agent: lenz-io-node/<version>`, `Accept: application/json`), which a
  `User-Agent` or `Accept` in `headers` replaces. Names match in any casing.
- **Reserved headers**: `Authorization` (from the key), `Idempotency-Key`
  (`idempotencyKey` / `idempotency`), `Content-Type` and `X-Lenz-API-Version`
  are set by the SDK, and `headers` refuses them (with `Content-Length`,
  `Host` and `Transfer-Encoding`), in any casing.
- **Timeouts**: a `timeoutMs` on the copy or the call is used as given, also
  on `assess` and `extract` (only the client's own timeout is raised to their
  100 s / 150 s minimum). A custom `fetch` must honour `init.signal`.
- **Retries**: `maxRetries: 0` when your caller has its own deadline or retry
  budget; the SDK then sends each request once. A resend should reuse
  `err.idempotencyKey`.
- **Raw bodies**: `result.raw` is the JSON object a result was read from (see
  [Results as the API sends them](#results-as-the-api-sends-them-legacyaliases));
  `err.body` is an error's, `err.headers` its response headers, and
  `err.retryAfter` the parsed wait (see [Errors](#errors) for which wins).
- **Errors as text**: `String(err)` is the message plus `Cause:`, `Fix:`,
  `Docs:` and `Request ID:` lines; the SDK never puts the key in it, but a
  422's text can quote the input. For a structured answer, forward `code`,
  `statusCode`, `retryable`, `retryAfter` and `requestId` instead.

## Compatibility

- Node 22.12+ (22, 24)
- ESM + CJS dual exports
- TypeScript types included
- Runs on Node 22.12+ and on edge runtimes with no Node built-ins: the `workerd`, `edge-light` and `deno` export conditions resolve to the main build, which imports none, ahead of the `browser` one (which has no webhook receiver). Tested: Cloudflare Workers (`workerd`, without the Node compatibility flag), Deno and Bun. Vercel Edge and Next.js edge runtime are supported through the `edge-light` condition but not tested in a real Next.js build. Verify webhooks there with `await webhooks.unwrap(request)`; the synchronous `parse` needs Node. Bun and Node use the main build. The client needs `globalThis.fetch` (every runtime above has it; pass `fetch` in the options otherwise)

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
