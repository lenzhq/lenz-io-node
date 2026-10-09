# Changelog

All notable changes to this SDK are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [Unreleased]

Major release (3.0.0). The SDK now speaks the API's `2026-10-11` response
shape, in which every field, status and error code has one name. Code written
against 2.x keeps compiling and reading the same fields with the same values
(they are deprecated, see "Deprecated"), except for the breaking changes
below (a status union gains `"cancelled"`, which an exhaustive `switch` over it
must handle). Some upgrades need a change first: see "Migrating".

> **Upgrading from 2.x.** Must: run Node 22.12 or later; move webhook
> receivers to lenz-io 2.21.0 or later before any sender moves to 3.0 (a 2.21
> receiver parses a `review.cancelled` or `citecheck.cancelled` event without
> its `review` / `reviewId` or `citecheck` / `citecheckId`: branch on
> `event.event` for every `*.cancelled` event until the receiver is on 3.0);
> treat the status `cancelled` as terminal and handle the `*.cancelled` webhook
> events; update code that reads raw response
> bodies; re-record recorded 2.x response fixtures; finish an idempotent
> request first sent with 2.x with 2.x (its replay answers
> `LenzApiVersionError` in 3.x; never change the key to get past it). May:
> move off the deprecated names, which keep working. Details: "Migrating".
> The 2.x input forms (wait options inside the `verifyAndWait` /
> `verifyBatchAndWait` input, snake_case batch-item and citation-pair fields)
> still work and are deprecated.

### Breaking

- **3.0 reads only the API's `2026-10-11` response shape for its own calls**
  (lenz.io serves it from 2026-10-11). Every request sends
  `X-Lenz-API-Version: 2026-10-11` (`API_VERSION`, typed `string`); 2.x sent
  `2026-05-13`. The header is always this release's: a value a call's own
  headers carry for it is replaced. A response in the earlier shape is not
  read: when a response (success or error) names a version other than
  `2026-10-11` in its `X-Lenz-API-Version` header, the call throws the new
  `LenzApiVersionError` (extends `LenzError`; `apiVersion` is the version
  named, `statusCode` the status, `body` the body as sent) instead of
  parsing it. A response with no such header is not checked, and neither is
  a webhook. Webhooks are the exception: `LenzWebhooks` still parses events of both shapes, because a
  receiver is sent events for work started by any client on the account,
  including older ones.
- **Webhooks of calls made with 3.0 arrive in the newer shape.** The API
  sends each webhook in the version of the request that asked for it, so a
  `verify`, `verifyBatch`, `select`, `review` or `citecheck` made with this
  release is answered by `verification.*` events with `event_id` and the
  verification under `verification`, and by `review.*` / `citecheck.*`
  events without `task_id`. Parse them with `LenzWebhooks` from 2.21.0 or
  later (which reads both shapes and fills the 2.x names), or read both
  shapes yourself; a receiver on 2.20.0 or older, or one that reads the raw
  JSON, must be updated before its sender moves to 3.0.
- **`cancelled` is a status of its own.** A task stopped elsewhere (the
  website's Stop button, another process) reads `status: "cancelled"` in
  `2026-10-11`; the earlier shape said `failed` with failure class
  `cancelled`. Waits end on it instead of polling to their deadline: `wait`,
  `verifyAndWait`, `reviewAndWait` and `citecheckAndWait` throw the same
  error class with the same failure fields as 2.x for the same task
  (`LenzPipelineError`, `ReviewFailedError`, `CitecheckFailedError`:
  `failureClass` `"cancelled"`, `retryable` `false`; a live verification's
  message reads "Cancelled." where 2.x said "Pipeline stopped at:
  cancelled"), and a batch item reads `"failed"`. `getStatus`, `getReview`
  and `getCitecheck` return the cancelled status without throwing; a
  cancelled task status carries the deprecated 2.x fields (`error`,
  `failure_reason`, `failure_class` `"cancelled"`, `retryable` `false`,
  `docs_url`). `TaskStatus.status`, `ReviewStatus` and `CitecheckStatus` gain
  `"cancelled"`, so an exhaustive `switch` or a `Record<Status, …>` over them
  needs the new case. The events `verification.cancelled`, `review.cancelled`
  and `citecheck.cancelled` are sent only for work submitted under
  `2026-10-11`; a cancellation of older work keeps arriving as `*.failed`.
- **Node 20 is no longer supported** (it is end-of-life): `engines.node` is
  `>=22.12.0`, and CI runs Node 22 and 24.
- **A webhook event's `raw` is the payload as delivered**, in whichever shape
  the API sent.
- **What the API now words or sends differently**, which no client can
  rebuild:
  - a failed check's `error` (and the `LenzPipelineError` message built from
    it) reads "Pipeline stopped at: <code>" or its fixed sentence; a failure
    read back from storage said "Pipeline stopped: <code>." in 2.x. A
    `task_error` reads "Pipeline failed." and a `task_stuck` "The task was
    never completed and has been marked failed.", where 2.x said one of
    several sentences for each;
  - the 409 `verification_failed` from `verifications.get` carries the run's
    own `hint` (and so `fix`), where 2.x sometimes carried a generic one; a
    failed poll read back from storage can carry a `hint` 2.x left out;
  - some other hints and 4xx messages are worded anew (an unparseable body,
    a failed review's hint);
  - `AssessResponse.status` on a list in which every row failed is the
    value the API sends (the recorded all-failed list says
    `no_checkable_claim`), not one computed from the rows; read each row's
    `status` and `failure`;
  - a review row's `hint` is the fixed compound-claim sentence (or `null`),
    not the hint stored with the review;
  - a review row stored without a failure block reads one, where 2.x read
    `failure: null`; a review's deep check's `modified_at` is computed from
    `completed_at` by the 2.x rule instead of read as stored;
  - an extraction the API first read as not a claim and then found one in
    says `status: "ready"` (2.x: `"not_a_claim"`);
  - `verify`'s receipt has no `chain_id`; the `taskId` of a `review.*` /
    `citecheck.*` webhook event is the review / citation-check id (dedupe on
    `eventId`); a repeated `verify` answered from the first one is a 202
    (the SDK returns the same receipt either way).
- **A subclass of `LenzError` that declares its own `retryable` or
  `idempotencyKey`** (rare) now overrides a member of `LenzError`: under
  `noImplicitOverride` it needs the `override` modifier (TS4114), and an
  `idempotencyKey` declared without an initializer needs `declare` (TS2612).
  The runtime is unaffected.
- `webhookUrl` keeps its meaning on every method: on `verify` and
  `verifyBatch` an unset, empty or blank one is left out of the request (your
  credential's default URL); on `review` and `citecheck` `""` still means no
  webhook for this call.

### Changed

Intentional behaviour changes; apart from these and "Breaking", nothing that
worked on 2.21 behaves differently:

- **Per-request timeouts and retry counts are checked before any request.**
  A `timeoutMs` must be a number of ms above 0 and at most 2,147,483,647 (the
  longest a timer can hold), and a `maxRetries` a whole number, 0 or more,
  wherever they are given: `new Lenz()`, the deprecated `timeoutMs` inside an
  `extract` / `assess` input, and the new request options and `withOptions`.
  Any other value throws an `Error`, including some that worked in 2.21: a
  numeric string (`timeoutMs: "30000"`, `maxRetries: "3"`, taken as its
  number) and a fractional retry count (`maxRetries: 1.5`, rounded down).
  The rest did not work before: a timeout of 0 or less, `NaN`, `Infinity` or
  above that limit ended every attempt at once; a negative or `NaN` retry
  count sent no request, and `Infinity` retried without end.
  `null` (or `undefined`) on the constructor or an input still means "not
  given", as before. A wait's budget is not affected: `timeoutMs` of 0 or less
  on a wait still polls once.
- **A wait ends at once on an error that is neither a Lenz error nor a
  transport failure** (a body that broke off or did not decode): an
  override's `TypeError`, say. 2.x waited through it to the deadline and
  threw a timeout. 5xx, 429 and network failures are polled through as
  before.
- **`retryAfter` is capped at 2,147,483 seconds** (on `LenzAPIError` and its
  subclasses, and on `LenzRateLimitError`), the longest wait a timer can hold
  in ms, so code that sleeps `retryAfter * 1000` cannot overflow `setTimeout`.
  A huge stated `Retry-After` (say `1e300`) was passed through in 2.21. A
  value that is not a number still reads `null` (`0` on a 429, as before).
- **Cancel answers are checked**: `cancel` throws `LenzAPIError` when the
  answer names another task or carries no `status`; `cancelReview` and
  `cancelCitecheck` when it is not the job asked for (its id, a status and its
  three lists).
- **An empty `idempotencyKey` on `review`, `citecheck`, `reviewAndWait` or
  `citecheckAndWait` mints a key**, as an omitted one does; 2.x sent an empty
  `Idempotency-Key`, which left the job unkeyed so a retry could start a
  second one.
- **A cancelled task status carries a `failure` block** (`code` and
  `failure_class` `"cancelled"`, `retryable` `false`, the cancelled docs
  link), on `getStatus`, a batch item's `status_detail` and a
  `verification.cancelled` event's `verification`, as 2.21 built it for a run
  cancelled while it was running (2.21 had none for one read back from
  storage).
- **Webhook verification**: `verifySignature` refuses an empty secret, and a
  signature header that arrives as an array (Node's `req.headers` for a
  header sent twice) now reads as its first element on `parse` and
  `parseAsync` alike (2.21 always failed it as a mismatch).
- **A transport timeout's `fix` text** reads "The request may have reached
  the server: resend it with the same key …" for a keyed call, else "Retry. If
  it persists, raise timeoutMs or check the network …", so `String(err)`
  differs from 2.21's.
- **Header order**: `X-Lenz-API-Version` is now sent after the method's own
  headers (set last, over any spelling a call's headers carry); 2.21 sent it
  second, after `User-Agent`. Values are unchanged.
- **The browser export condition has its own declarations**
  (`dist/index.browser.d.ts`), which name only what the browser build
  exports: code that imports `LenzWebhooks`, `verifySignature` or
  `verifySignatureAsync` under the `browser` condition now fails to type-check
  instead of failing in the bundler.
- **Error class names survive bundling**: `LenzQuotaExceededError`'s `name`
  was `_LenzQuotaExceededError` in the built package (2.21 too).
- **`reviewAndWait` and `citecheckAndWait` start their `timeoutMs` after the
  submit**, as `verifyAndWait`, `verifyBatchAndWait` and the Python SDK's
  review and citation-check waits do. The submit is no longer cut at the
  wait's budget: it makes its attempts with the client's `timeoutMs` and its
  retries, and the budget covers the polls from the moment the job is
  accepted. A `timeoutMs` of 0 or less now submits normally and reads the job
  once (it used to give the submit a 0 ms timer).
- **Every id in a request path is sent as one encoded path segment**, and an
  empty id, `.` or `..` is refused locally with a plain `Error` before any
  request (`getStatus`, `select`, `verifications.*` and `ask.*` used to send an
  empty id to the server and get an API error back). Ordinary ids are sent
  exactly as before. `verifications.getCertificate`, `verifications.related`
  and `ask.history` now reject their promise on a bad id instead of throwing
  synchronously. A `verifyAndWait`, `verifyBatchAndWait`, `reviewAndWait` or
  `citecheckAndWait` whose acceptance body carries such an id (empty, `.` or
  `..`) throws `LenzAPIError` at once, after the submit alone, instead of
  polling to its deadline.
- **`verifyBatch` / `verifyBatchAndWait` and `ask.send` send an
  `Idempotency-Key` by default**, like `verify`, `assess`, `extract` and
  `select` already did: a random key per call, reused across that call's own
  retries, so a retried batch or question is not run (and charged) twice. A
  key you pass wins; `idempotency: false` sends none. The request body is
  unchanged.
- **An in-flight 409 (`idempotency_conflict`) is retried inside the call**:
  when a call that sent an `Idempotency-Key` (its own or yours) meets the
  first request with that key still running, the client waits (the stated
  `Retry-After`, else its usual backoff) and asks again with the same key and
  body, within `maxRetries` and the call's timeout. 2.x threw the 409 at
  once. If it still conflicts, the same error is thrown (class, `code` and
  message as in 2.x), with `retryable: true`. A `review` or `citecheck` 409
  that names the job is still returned as its receipt at once.
- **`wait`, `verifyAndWait` and `verifyBatchAndWait` stop at once on an error
  waiting cannot change** (401, 403, 404, `LenzApiVersionError`): `wait`
  throws it, where 2.x polled on to a `LenzTimeoutError` at the deadline. In
  a batch, a 404 or an answer in another API version for one claim makes
  that claim read `"failed"` (no `status_detail`) and the others keep being
  polled, while a 401 or 403 (the key's, not the claim's) throws
  `LenzAuthError` from `verifyBatchAndWait`. A 5xx, a 429 and a network drop
  are polled through as before.
- **No poll runs past the wait's deadline**: each poll request is cut to the
  time the wait has left, and once it is spent the wait stops polling (the
  claims still running read `"timeout"`, `wait` throws `LenzTimeoutError`).
  2.x made one more poll after sleeping the remaining time, with the client's
  full request timeout. A wait given no time at all (`timeoutMs: 0`) still
  looks once, as in 2.x.
- **Network failures and transport timeouts throw subclasses of the class
  they threw in 2.x**: `LenzConnectionError` and, for a timeout,
  `LenzRequestTimeoutError`, both `LenzAPIError`s. A timeout's message reads
  `<METHOD> <path> timed out after <n>ms (<k> attempts).` instead of the raw
  `AbortError: …`; a body that stalls past the timeout keeps its message.
  **A 404 throws `LenzNotFoundError`** (a `LenzError`, as before) whose `fix`
  says to check the id rather than to retry; its message is unchanged.
- **The client no longer prints `[lenz-io] Submitted task: …`** to the
  console on every `verifyAndWait`. Pass a `logger` to get it (see Added).

- **The newer names are the way to read a response**: `claims`, `status` and
  `failure`, `claim`, `more_claims`, `completed_at`, `claim_limit_exceeded`,
  `citation_limit_exceeded`, `credits` with `costs`, `failure.code`. See
  "Newer field names" in the README.
- No exported type was narrowed, removed or made required, and every 2.x
  field reads the value it had in 2.x (apart from the differences listed
  under Breaking and the `failure` values below), computed from the newer
  response with its 2.x meaning: a failed `assess` row still reads `verdict: "Error"` and
  `confidence: "low"`, `extract`'s `status` reads `not_a_claim`, and a
  failure's `failure_reason` / `error_code` say `not_a_claim` (`verify`,
  `extract`) or `no_claim` (`assess`, `review`) where `failure.code` says
  `no_checkable_claim`.

- On a `verification.completed` event, `verification.result` has the same
  defaults as `result` (a field the payload leaves out reads as `result`
  reads it); `raw` stays as delivered.
- **`failure` values on the newer `*.failed` events come from the server.**
  2.21 built a failed event's `failure` block (and a verification event's
  `verification.failure`) from the original flat payload, which carries no
  sentence, docs link or hint, so `failure.detail`, `failure.docs_url` and
  `failure.hint` read `null`. On an event in the newer shape they are the
  server's own (`detail` its sentence, `docs_url` the error page, `hint` when it
  has one), and a run that stopped with no failure code reads `failure.code`
  `""` (and `failure_reason` `""`) where 2.21 read `null`. A verification
  event's `verification` also carries the flat fields a `getStatus` read
  derives from that block (`error`, `docs_url`, `hint`).

### Added

- **Per-call request options.** Every method takes `signal`, `timeoutMs`,
  `maxRetries` and `headers` for one call (the `RequestOptions` type): in a new
  trailing options argument (`verify(input, options)`, `getStatus(taskId,
options)`, `usage(options)`, …), or merged into the options object a method
  already takes (the waits' options, `getReview`'s `{ view }`,
  `verifications.list` / `listAll`'s `{ page }`, `verifications.related`'s
  `{ limit }`). `timeoutMs` is one HTTP attempt's timeout; on `extract` and
  `assess` a value given for the call is used as given, even below the 150 s /
  100 s floor that still applies to an inherited timeout. On the waits
  `timeoutMs` stays the wait's budget, `signal` and `headers` reach the submit
  and every poll, and `maxRetries` is the submit's (`wait` takes none).
  `headers` merge without regard to case (a name set again keeps its place);
  `null` removes one a copy set; a `User-Agent` or `Accept` replaces the
  client's; the headers the client sets itself (`X-Lenz-API-Version`,
  `Idempotency-Key`, `Authorization`, `Content-Type`, `Content-Length`, `Host`,
  `Transfer-Encoding`) are refused, and so are a name that is not a valid token
  and a value that is not visible ASCII with spaces and tabs only between
  visible characters, before any request. A call reads its options once,
  when it is made (every page of a `listAll` and every poll of a wait use that
  copy). `wait` takes no `maxRetries` and throws when given one (TypeScript
  already refused it). A call made
  without options sends exactly what it sent before. New types: `RequestOptions`, `GetStatusOptions`
  (`getStatus`'s options, with the waits' `deadlineAt`), `VerifyAndWaitOptions`
  (`verifyAndWait` / `verifyBatchAndWait`); `WaitOptions`,
  `ReviewAndWaitOptions` and `CitecheckAndWaitOptions` gain `signal` and
  `headers` (the last two, and `VerifyAndWaitOptions`, `maxRetries`).
- **`client.withOptions(options)`**: a copy of the client whose request
  options apply to every call made through it. It shares the `fetch`, key,
  base URL and logger, keeps a subclass and replaced methods, and leaves the
  original unchanged. A call's own options win over the copy's.
- **`LenzAbortError`**, thrown when a call's `signal` (or a copy's) fires:
  during a request, a retry sleep, a poll, or between the items of a
  `listAll`. It is not a `LenzError` (code that retries every `LenzError` does
  not retry an abort); its `name` is `"AbortError"` and its `cause` the
  signal's `reason`. It carries the request's `idempotencyKey` when it was
  keyed, and the `taskId`, `batchId` and `taskIds`, `reviewId` or
  `citecheckId` once the server had accepted the work. Nothing is cancelled
  on the server: call `cancel`, `cancelReview` or `cancelCitecheck`.
- **Webhooks on edge runtimes.** `await webhooks.unwrap(request)` takes a
  standard `Request`, reads the raw body once and `X-Lenz-Signature`, and
  verifies with WebCrypto. `await webhooks.parseAsync(rawBody, headers)` is the
  same for a framework that hands you the body and headers. Both return the
  same event as `parse` and throw the same `LenzWebhookSignatureError` for every
  bad input (missing, malformed or wrong signature, a body that is not JSON or
  not an object, a stale `delivered_at`). `verifySignatureAsync(rawBody,
signature, secret)` is the low-level counterpart of `verifySignature`.
- **The package loads with no Node built-ins.** The webhook code no longer
  imports `node:crypto` or `node:buffer` when the module loads, and nothing
  else in the package uses a Node built-in or `Buffer`. The synchronous
  `parse` and `verifySignature` still work on Node, and throw a clear error
  pointing to `unwrap` on a runtime without Node's `crypto`. Their results are
  unchanged, with the two corrections listed under "Changed" (an empty secret,
  an array signature header).
- **Export conditions `workerd`, `edge-light` and `deno`**, listed before
  `browser`, resolve to the main build (`dist/index.js`), which exports the
  whole API, webhook receiver included, so these runtimes skip the `browser`
  build that omits it. `import`, `require` and `browser` resolve as before.
  Tested in Cloudflare Workers (workerd, without Node compatibility), Deno and
  Bun; Vercel Edge is covered by the `edge-light` condition but not tested in a
  real Next.js build.
- `parse` / `parseAsync` copy the body once before verifying, so a caller
  that reuses its buffer cannot change what is parsed after the signature
  checked. A body that is not a string or bytes (an object left by a body
  parser, `null`, `undefined`) still throws a `TypeError`, as in 2.21; its
  message now says what was expected.
- `unwrap` throws a clear error when the request's body was already read.
- The generated `Idempotency-Key` falls back to `getRandomValues` where
  `crypto.randomUUID` is missing (insecure browser origins, Hermes).
- Examples for a Next.js route handler and a Hono app
  (`examples/core/nextjs-webhook.ts`, `examples/core/hono-webhook.ts`).

- **`cancel(taskId)`, `cancelReview(reviewId)` and `cancelCitecheck(citecheckId)`
  stop a run** (`POST /verify/{task_id}/cancel`, `/reviews/{review_id}/cancel`,
  `/citechecks/{citecheck_id}/cancel`). `cancel` returns the new exported
  `CancelResult` (`{ task_id, cancelled, status }`): `cancelled: true` when
  the run is cancelled (by this call or an earlier one), `cancelled: false`
  with the run's status (normally `completed` or `failed`) when it is not. `cancelReview` and `cancelCitecheck` return the review and
  the check as `getReview` and `getCitecheck` read them, `status: "cancelled"`
  or unchanged when finished. A cancelled verification is not charged; a review
  or citation check keeps charged what it delivered before the cancel. The calls send no
  body and no `Idempotency-Key` (cancelling twice is harmless) and are
  retried on 5xx, 429 and dropped connections like any request. `cancel` on a
  review's deep check throws a `LenzError` with `statusCode` 409 and `code`
  `"use_review_cancel"`, which is not retried: cancel the review. A 404 throws
  `LenzNotFoundError` with `code` `"not_found"`. Requires the API version
  `2026-10-11`.
- **`verification.cancelled`, `review.cancelled` and `citecheck.cancelled`
  webhook events are typed** (`VerificationCancelled`, `ReviewCancelled`,
  `CitecheckCancelled`; `isEvent` narrows on them). Each carries the cancelled
  `verification` / `review` / `citecheck` and its `eventId`, nothing more.
- **`verifyAndWait(input, opts)` and `verifyBatchAndWait(input, opts)`** take
  their wait options (`WaitOptions`: `timeoutMs`, `onProgress`) as a second
  argument, as `wait`, `reviewAndWait` and `citecheckAndWait` already did.
  Same meaning as the in-input fields (the deadline starts after the submit;
  `0` or less polls once); when both are given, the second argument wins
  field by field. Nothing new is sent.
- **camelCase batch-item and citation-pair inputs**: a `verifyBatch` /
  `verifyBatchAndWait` item takes `sourceUrl` and `webhookUrl`; a `citecheck`
  pair takes `citedTitle`, `citedAuthors`, `citedYear` and `citedJournal`.
  Inputs are camelCase; outputs keep the API's names. Each camelCase field is
  sent under its API name, so the request is the one the snake_case form
  sends. Giving both spellings of a field with different values throws an
  `Error` naming both before anything is sent; equal values are fine
  (`Object.is`, arrays element by element). On a batch item a value 2.x
  ignored counts as not given (`undefined`, `null`, an empty `sourceUrl`, an
  empty or blank `webhookUrl`); on a pair only `undefined` does.
- **`VerifyBatchItem`** is exported from both entry points.
- **`LenzNotFoundError`** (404), **`LenzConnectionError`** and
  **`LenzRequestTimeoutError`** (see Changed). `LenzRequestTimeoutError` is
  one HTTP attempt that took too long; `LenzTimeoutError` remains a wait that
  reached its deadline while the job kept running.
- **`retryable` on every error** (`boolean | null`, set when the error is
  built): `true` for a network failure, a transport timeout, a 429, a 5xx
  or a 409 `idempotency_conflict` / `verification_not_ready`, `false` for
  any other 4xx and for `LenzApiVersionError`, `null` when
  unknown; a boolean the response body states wins. A failed run
  (`LenzPipelineError`, `ReviewFailedError`, `CitecheckFailedError`) keeps
  the server's value, `null` when it stated none, as in 2.x.
- **An optional second argument to `getStatus`**, the wait's budget (the
  per-request timeout and deadline). The waits poll through the public
  `getStatus`, as in 2.x, so an override (a subclass, a test double) is used;
  an override may ignore the argument and the wait still ends at its
  deadline.
- **`idempotencyKey` on every error of a call that sent one**
  (`string | undefined`), the timeout of a `*AndWait` included. A resend is
  safe only with that key: pass `idempotencyKey: err.idempotencyKey` back. A
  plain new call mints a new key and, if the first request reached the
  server, runs (and charges) twice. A response body that breaks off after the
  headers still throws the runtime's own error, as in 2.x (its class is
  unchanged); on a keyed call it carries `idempotencyKey` too.
- **The underlying `fetch` error as the native `cause`** of a
  `LenzConnectionError`; the string `cause_` line is unchanged.
- **Every error class from the browser entry**: `LenzUpstreamUnavailableError`
  and the new classes were missing from it.
- **`logger` option** on `new Lenz({ logger })` (`LenzLogger`: optional
  `debug`, `info`, `warn`; `console` fits): retries go to `debug`, the
  `verifyAndWait` task id to `info`. Silent without one. A logger method
  that throws, or returns a promise that rejects, never breaks a call.
- **`idempotency` option** on `verifyBatch`, `verifyBatchAndWait` and
  `ask.send`.
- **`isEvent(event, kind)`** narrows a parsed webhook event without a cast,
  only when the event's name is `kind` and the members the narrowed type
  requires were parsed: a `verification.*` event's `verification` with a
  string `task_id` and the kind's own `status` (on `verification.completed`,
  `"completed"` with an object `result`); a review's or citation check's id,
  `status`, lists, `summary` and `credits`; a certificate's `coverage`. A
  malformed event under a known name never narrows. `WebhookEventMap` names
  the narrowed types. It needs no crypto, so the browser entry exports it
  too. **`eventId`** (optional) on every webhook event, from the payload's
  `event_id` in either shape.
- **`verifications.listAll()` and `library.listAll(filters)`**: every item
  across pages, as an `AsyncIterable`, one page request at a time. The page
  size is read from each response and the start page is honoured (one below
  1 throws when `listAll` is called). The walk stops after a short or empty
  page, a page that reaches `total`, or one with no usable `page_size`, and
  a response for another page than the one asked for ends it without being
  yielded. `sort: "random"` is refused when `listAll` is called.
- **`Verdict`, `Confidence` and `Depth` types**, and the `verdict` /
  `confidence` fields typed plain `string` (verifications, list items,
  related verifications, `assess` rows) now name their values
  (`Verdict | (string & {})`), so an editor completes them; any string
  still fits.
- README: a "First call" section, and runnable `review` and `citecheck`
  examples (`examples/core/review-draft.ts`, `examples/core/citecheck.ts`),
  type-checked with the other examples by `npm run type`.

### Deprecated

Kept in 3.x with their 2.x values, so 2.x code runs and compiles unchanged;
they will be removed in a future major release. Move to the newer names when
convenient. Editors strike them through (`@deprecated` names the
replacement).

| Where                                                                              | Deprecated (2.x name)                                              | Read instead                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `extract`                                                                          | `claim`                                                            | `claims[0].claim`                                                                |
|                                                                                    | `identified_claims`                                                | `claims`                                                                         |
|                                                                                    | `locations`                                                        | `claims[i].positions`                                                            |
|                                                                                    | `candidate_claims`                                                 | none (always `[]`)                                                               |
| `assess` row                                                                       | `verdict: "Error"`, `confidence: "low"` on a failed row            | `status === "failed"`                                                            |
|                                                                                    | `error_code`                                                       | `failure.code`                                                                   |
|                                                                                    | `hint`                                                             | `failure.hint` on a failed row; `more_claims` on a completed compound row        |
|                                                                                    | `identified_claims`                                                | `more_claims`                                                                    |
|                                                                                    | `candidate_claims`                                                 | none (always `[]`)                                                               |
| `assess` body                                                                      | `error`                                                            | `failure.detail`                                                                 |
|                                                                                    | `error_code`                                                       | `failure.code`                                                                   |
|                                                                                    | `candidate_claims`                                                 | none (always `[]`)                                                               |
| `verifyBatch` / `select` receipt, `verifyBatchAndWait`                             | `claim_text`                                                       | `claim`                                                                          |
| `needs_input` options                                                              | `text`                                                             | `claim`                                                                          |
| Verifications (`get`, `list`, `library`, a status `result`, a review's deep check) | `modified_at`                                                      | `completed_at`                                                                   |
| `getStatus` / `wait` on a failed run                                               | `error`                                                            | `failure.detail`                                                                 |
|                                                                                    | `failure_reason`                                                   | `failure.code`                                                                   |
|                                                                                    | `failure_class`, `retryable`, `docs_url`, `hint`                   | `failure.failure_class`, `failure.retryable`, `failure.docs_url`, `failure.hint` |
|                                                                                    | `candidates`, `similar_claims` (typed only; the API sends neither) | `claims` for `candidates`; none for `similar_claims`                             |
| `usage()`                                                                          | `verify`, `ask`, `assess` blocks                                   | `credits` and `costs` (divide `credits.remaining` by the cost)                   |
|                                                                                    | per-block `credits`                                                | the block's `bonus`                                                              |
|                                                                                    | `credits.bonus`                                                    | `credits.extra`                                                                  |
|                                                                                    | `quota_resets_at`                                                  | `credits.resets_at`                                                              |
| Reviews and citation checks                                                        | `failure.failure_reason` (every failure block)                     | `failure.code`                                                                   |
|                                                                                    | assessment `error_code`, `hint`                                    | assessment `failure.code`, `failure.hint`                                        |
|                                                                                    | assessment `identified_claims`                                     | `more_claims`                                                                    |
|                                                                                    | summary `claim_limit_reached`                                      | `claim_limit_exceeded`                                                           |
|                                                                                    | summary `citation_limit_reached`                                   | `citation_limit_exceeded`                                                        |
| `verification.failed` webhook                                                      | `error`                                                            | `failure.code`                                                                   |
|                                                                                    | `failureClass`, `retryable`                                        | `failure.failure_class`, `failure.retryable`                                     |
| `verification.completed` webhook                                                   | `result`                                                           | `verification.result`                                                            |
| Errors                                                                             | `LenzRateLimitError.resetInSeconds`                                | `retryAfter`                                                                     |
|                                                                                    | `LenzQuotaExceededError.creditsRemaining` (still warns once)       | `remaining`                                                                      |
|                                                                                    | `ReviewFailedError.errorCode`                                      | `review.failure.code`                                                            |
|                                                                                    | `CitecheckFailedError.errorCode`                                   | `citecheck.failure.code`                                                         |
| `verifyBatch` items                                                                | `idempotency_key` (never sent; no effect)                          | `idempotencyKey` on the batch                                                    |
|                                                                                    | `source_url`, `webhook_url`                                        | `sourceUrl`, `webhookUrl`                                                        |
| `citecheck` pairs                                                                  | `cited_title`, `cited_authors`, `cited_year`, `cited_journal`      | `citedTitle`, `citedAuthors`, `citedYear`, `citedJournal`                        |
| `verifyAndWait` / `verifyBatchAndWait` input                                       | `timeoutMs`, `onProgress`                                          | the same fields in the second argument                                           |
| `extract` / `assess` input                                                         | `timeoutMs`                                                        | `timeoutMs` in the options argument (`extract(input, { timeoutMs })`)            |

`creditsRemaining`, which earlier releases said would be removed in 3.0, is
kept, and its one-time console warning now says "a future major release".
Values that keep their 2.x wording while `failure.code` says
`no_checkable_claim`: `extract`'s `status` (`not_a_claim`), `failure_reason`
and `error_code`.

### Migrating

**Required**

- **The API must answer `2026-10-11`.** 3.0 asks for it and reads only that
  shape; a response naming another version throws `LenzApiVersionError`.
  Stay on 2.x against an API that does not serve it yet.
- **Webhook receivers on lenz-io older than 2.21.0, or that read the raw
  JSON, upgrade before any sender moves to 3.0.** Calls made with 3.0 are
  delivered in the newer shape (see Breaking).
- **Code that reads raw bodies** (`err.body`, or the JSON of a response you
  fetched yourself) reads the API's own shape: `err.body.detail` is a
  sentence, not a list, so read the error's own `errors`; `doc_url` is
  `docs_url`, `reset_in_seconds` and `retry_after_seconds` are
  `retry_after`, and there is no `error` key (read `code`).
- **Tests with recorded 2.x response bodies** are re-recorded against the
  newer shape: a recorded body in the earlier shape is refused
  (`LenzApiVersionError`) when it carries its version header, and is not
  guaranteed to read correctly when it does not.
- **An idempotent request first sent before lenz.io served `2026-10-11`**
  and replayed later with the same `Idempotency-Key` is answered in the
  version it was first answered in, which 3.x refuses
  (`LenzApiVersionError`). Finish such work with 2.x; never change the key to
  get past it, which would run the call a second time. In practice none
  remain at release: replays last 24 hours, and the API has stored both
  shapes for every request since its versioning release on 2026-10-09.
- **Treat `cancelled` as terminal** in your own loops over `getStatus`,
  `getReview` and `getCitecheck`, and in `onUpdate` callbacks: it is the
  status of a task cancelled elsewhere, and a loop that stops only on
  `completed` and `failed` polls forever. Widen exhaustive `switch`es and
  `Record<Status, …>` tables over `TaskStatus["status"]`, `ReviewStatus` and
  `CitecheckStatus`.
- **Handle `*.cancelled` in webhook receivers.** For work submitted with 3.x
  the events arrive as `verification.cancelled`, `review.cancelled` and
  `citecheck.cancelled`. A 2.21 receiver parses them only as the base event
  (branch on `event.event` there); this release types them.
- Node 22.12 or later.

**Optional**

- Move off the deprecated names, using the newer ones listed under "Newer
  field names" in the README. They keep working and compiling.

Error classes keep every field they had in 2.x (`code` is `""` where 2.x had
none, a schema error's message is "Validation failed" and its `errors` the
field items, `resetInSeconds` reads the daily limit's wait). Their `body` is
the body as the API sent it.

## [2.21.0] - 2026-10-09

Minor release. Existing code keeps working unchanged; nothing to do on
upgrade.

### Added

- **`language: "auto"`** on `assess`, `verify`, `verifyAndWait` and
  `ask.send`. The SDK sends the string as given, so this is documentation and
  tests only. The answer comes back in the
  language of the submitted text; on `ask.send`, in the language of the claim
  being discussed. A concrete code always wins; omitting `language` still means
  English. On `assess` with a `claims` list, one language is chosen for the
  whole request (the language most items agree on, else English); name a code
  for a list in mixed languages. `extract`, `verifyBatch`, `citecheck` and
  `review` do not accept `"auto"`.

- **Reads both forms of the API's responses.** The API is adding a newer
  response form with one name for each field across every endpoint, chosen
  per request by the `X-Lenz-API-Version` header. This release still sends
  `2026-05-13` and gets the original form; every method and webhook parser
  now also reads the newer one, and returns both sets of names from either:
  - `ExtractedClaims.claims`: every claim as `{ claim, positions }`, always a
    list (new `ExtractedClaim` type).
  - `AssessClaim.status` (`completed` | `failed`), `AssessClaim.failure`,
    `AssessClaim.more_claims`; `AssessResponse.status` and
    `AssessResponse.failure`.
  - `TaskStatus.failure`, and `failure` / `verification` on
    `verification.*` webhook events.
  - `claim` on `verifyBatch` / `select` receipt items, on `BatchItemResult`
    and on `needs_input` options (`CandidateClaim`).
  - `completed_at` on verifications (sent by the newer form only).
  - `ReviewSummary.claims_found`, `claim_limit_exceeded` and
    `citation_limit_exceeded` (also on `CitecheckSummary`).
  - `code` and `detail` on every failure block (`ReviewFailureBlock`),
    `ReviewAssessment.more_claims`, `Citecheck.language`.
- A failure's `code` says `no_checkable_claim` where the original fields say
  `not_a_claim` / `no_claim`.

### Deprecated

- The original names, kept with their original meaning whichever form
  arrives, so existing code behaves exactly as before: a failed `assess` row
  still reads `verdict: "Error"`, `confidence: "low"` and `error_code`;
  `extract`'s `status` still reads `not_a_claim`; `claim` /
  `identified_claims` / `locations` on `extract`; `claim_text`; option
  `text`; `error`, `failure_reason` and the flat failure fields on a failed
  `TaskStatus`; `modified_at` (computed from `created_at` and `completed_at`
  by its later-calendar-day rule); `claim_limit_reached` /
  `citation_limit_reached`; the `/me/usage` per-capability blocks,
  `credits.bonus` and `quota_resets_at` (recomputed from `credits` and
  `costs`); `VerificationFailed.error`. Only `raw` on a webhook event and
  `LenzError.body` show the wire form as sent.
- A response in the original form is returned exactly as before: no key is
  added under an original name and no value changes. It only gains the newer
  names it lacks (`AssessResponse.status` reads `ok`, `no_checkable_claim` or
  `error`).
- On the newer form of `review.*` / `citecheck.*` webhook events, which carry
  no `task_id`, the event's `taskId` is the review / citation-check id.

### When the newer form is served

These differences come from the server and show only when a call is answered
in the newer form (this release does not ask for it):

- Sentences are reworded: a failed verification's `error` (and the
  `LenzPipelineError` message built from it), `/assess`'s `error`, some
  `hint`s.
- Some 422 codes are renamed (`blank_item` is `blank_input`), every 422 has a
  `code` (`validation_error` for a schema error) and an `errors` list, and
  its `detail` is a sentence, so `LenzValidationError.message` reads that
  sentence instead of "Validation failed".
- `/verify`'s receipt has no `chain_id`; a review row carries no stored
  `hint`.

### Changed

- **`verify` and `verifyBatch` no longer send `webhook_url: ""`** when no
  webhook URL is set; the field is omitted. The API treats the two the same
  on these endpoints (the key's default URL). `review` and `citecheck` are
  unchanged: there `""` means "no webhook" and is still sent.

### Fixed

- **Correction to the 2.9.0 and 2.14.0 entries:** the 2026-11-29 removal
  announced for `credits.bonus`, the per-capability `credits` field and the
  `verify` / `ask` / `assess` blocks of `/me/usage` is cancelled. The fields
  stay deprecated and are kept for existing callers. The README, the type
  docs and `openapi.json` no longer give a date.

### Docs

- `openapi.json` resynced from the API: the `X-Lenz-API-Version` request
  header and response header, `language: "auto"`, a documented error body on
  every operation, and the `/verify/batch` and `/select` receipts as `202`.

## [2.20.0] - 2026-10-05

### Added

- **`AssessResponse.more_claims`**: `assess({ claim })` on a text that makes
  more than 20 claims checks the 20 most check-worthy and lists the rest here,
  unchecked and free, most check-worthy first. Send them back with
  `assess({ claims })`, 20 a call. `[]` on the list form and on a text with
  20 claims or fewer; absent from older servers (read `more_claims ?? []`).

### Changed

- **`extract` finds up to 100 claims** (an API change; was 20). The README's
  extract → assess example now sends them to `assess` 20 a call: a list of
  more than 20 is refused with a 422.
- **Node 18 is no longer supported** (it reached end-of-life on 2025-04-30);
  the minimum is now Node 20.19, the final Node 20 line (`engines.node`,
  `package-lock.json`, the CI matrix, the README's Compatibility list).
  Node 20 itself reached end-of-life on 2026-04-30 and support for it will be
  dropped in a later release. Shipped as a minor, not a major: nothing in the
  public surface (`src/index.ts`) changed.

### Docs

- `openapi.json` resynced from the API: besides `more_claims`, it picks up
  the copy that changed since the last sync (a cached answer is free; extract
  finds up to 100 claims).

## [2.19.0] - 2026-09-30

### Added

- **Automatic idempotency keys on `extract`, `select` and `verify`**, as
  `assess` and `verifyAndWait` already did: a random `Idempotency-Key` per
  call, reused across that call's own retries, so a retry after a network drop
  or a client timeout replays the first response instead of running (and
  charging for) the call twice. Never derived from the request body. Pin your
  own with `idempotencyKey`, or send none with `idempotency: false` (both new
  on `ExtractInput` and `SelectInput`; `idempotency` is new on `VerifyInput`).
  `ask.send` is unchanged: it sends a key only when you pass one.

### Changed

- **A verdict served from the server's cache is free** (an API change; the
  SDK code is unchanged). A `verify`, `assess` or `review` claim that gets back
  a verdict checked in the last hour is no longer charged, so a tool that
  resends the same request pays once. A citation judged from the server's
  judgment cache is refunded like an unchecked one. The exception is a
  `verify` that issues a business plan a new warranty certificate, still
  charged at the requested depth.
- **`assess` waits up to 100s** (was 45s), both forms. The server's `/assess`
  budget is now 90s, so a long text can answer in up to 90s instead of failing
  early with a 503; the SDK waits 10s longer than the server works. A per-call
  `timeoutMs`, or a longer client-wide one, still wins.
- **`extract` waits up to 150s** (was 90s) per attempt.
- **`wait` and `verifyAndWait` default to a 300s deadline** (was 120s), and
  **`verifyBatchAndWait` to 300s** (was 180s). On the deadline they behave as
  before: `LenzTimeoutError` with the resumable `taskId` (or `"timeout"` rows
  for a batch).

## [2.18.0] - 2026-09-30

### Added

- **`review({ suggestEdits: true })`**: for each claim whose deep check
  suggests a rewrite, the smallest edits to the draft that make it say what
  the rewrite says, in the draft's own language, as
  `ReviewClaim.suggested_edits` (copied on `ReviewIssue.suggested_edits`): a
  `SuggestedEdits` block (`status`, `edits`) of `SuggestedEdit` spans
  (`position`, `start`, `end`, `text`, `replacement`) of the text you sent.
  `review.policy.suggest_edits` (`EscalationPolicy`) echoes the option. Leave it out and the request,
  and what its idempotency key covers, are exactly as before; a body without
  the keys reads them as `null` / `false`. Needs a server that knows the
  option: an older one refuses it with a 422.
- **`assess({ suggestRewrite: true })`**, sent as `suggest_rewrite`, and
  `AssessClaim.suggested_rewrite` on every row: the claim with its wrong part
  corrected, when the check found it `False` or `Mostly False` with high
  confidence; `null` when not asked, outside that, or when there is no
  correction to write. Both forms (`claim` and `claims`), per row, no extra
  credit. It is written from the quick check's reasoning and is not itself
  verified: review it, or run it through `verify`, before using it. Leave it
  out and the request, and what its idempotency key covers, are exactly as
  before; a row without the key reads it as absent. Needs a server that knows
  the option: an older one refuses it with a 422.

### Changed

- **Review: `suggested_rewrite` also from the quick check.** An issue's
  `suggested_rewrite` comes from the claim's deep check when it has one;
  otherwise, when the review asked for suggested edits (`suggestEdits: true`),
  from the quick check, for a claim found `False` or `Mostly False` with high
  confidence. Likewise `suggested_edits` now also appears on claim rows that
  stayed on the quick verdict. The issue's `source` (`assessment` |
  `verification`) says which check it came from. The quick check's rewrite is
  also on each claim row as `ReviewAssessment.suggested_rewrite` (new;
  `null` when not asked, when there is none, and from a server that predates
  it).
- **`suggested_rewrite` on a verification answers the same question the
  claim answers** (an API change; the SDK code is unchanged). It may replace
  the claim's subject when the subject is the wrong part ("Venus is the
  closest planet" becomes "Mercury is the closest planet"), negates the claim
  when the evidence establishes it is false but names no right answer, and
  stays `null` when the evidence only finds no support.
- **`partly_supported` is no longer a citation issue** (an API change; the SDK
  code is unchanged). The row stays in `citations` with `is_issue` false, and
  is left out of `citation_issues` and `summary.citation_issues`, so on its own
  it no longer makes `outcome` `issues_found`.

`review` can check a draft's citations, and `citecheck` runs that check on
its own, on a draft or on statement-source pairs: does each linked source (a
URL or a DOI) say what the draft says it does? Nothing the SDK already sends changes:
leave `maxCitations` and `locate` out and the request is exactly what 2.17.0 sends. A
review body without the citation keys reads with the new keys at their
defaults. `extract` can also say where the text makes each claim.

### Added

- **`client.review({ text, maxCitations: N })`** (1-20), sent inside the
  API's `escalate` object as `escalate.max_citations`: the draft's first N
  citations are checked. Omitted or `0` sends nothing and checks none.
  `reviewAndWait` takes it too.
- **`client.citecheck`, `client.getCitecheck` and `client.citecheckAndWait`**
  for `POST /citecheck` and `GET /citechecks/{citecheck_id}`: the citation
  check on its own. `citecheck({ text | pairs, maxCitations?, language?,
webhookUrl?, idempotencyKey? })` takes a draft (its first `maxCitations`,
  1-20, are checked) or 1 to 20 statement-source pairs (`CitationPair`:
  `statement` and one of `url` or `doi`, with optional `quotes` and, for a
  DOI, what the reference gives); exactly one of the two, and `maxCitations`
  with pairs throws before any request. `language` is the language Lenz
  writes the reasoning in (English when omitted); hints are always in English.
  The body is a `Citecheck`, with the
  review's citation rows, `summary`, `credits` and `more_citations`.
  `citecheckAndWait` throws `CitecheckFailedError` (a `LenzPipelineError`) or
  `CitecheckTimeoutError` (a `LenzTimeoutError`, with `partial`).
  `citecheck.completed` / `citecheck.failed` webhooks parse into
  `CitecheckCompleted` / `CitecheckFailed`.
- **`maxAssessments: 0`**: a review that checks no claim, e.g. a review of the
  draft's citations only.
- **The citation types.** `ReviewFull.citations` (one `ReviewCitation` per
  citation: `reference`, `cited_url`, `doi`, `statement`, `quotes`,
  `position`, the derived `result` and the `check`), and on both views
  `citation_issues` (`ReviewCitationIssue`, most serious first) and
  `citation_failures` (`ReviewCitationFailure`). On a quote finding,
  `missing_quote` (on the check and on the issue) is the excerpt that was not
  found. `ReviewSummary` gains
  `citations_found`, `citations_selected`, `citation_limit`,
  `citation_limit_reached`, `citation_checks` (`checked`, `unchecked`,
  `failed`), `citation_issues` and `citations_skipped`; `EscalationPolicy`
  gains `max_citations`. `more_claims` and `more_citations`
  (`ReviewMoreCitation`: `index`, `reference`, `cited_url`, `doi`,
  `sentence`, `position`) list what the draft holds past `maxAssessments`
  and `maxCitations`: found but not checked; `null` until the draft is read.
  A citation's `position` is a `Position` (below) whose `text` is `null`: the
  row carries the statement. Also exported:
  `ReviewCitationCheck`, `ReviewCitationResult`,
  `ReviewCitationRecord`, `ReviewCitationDifference`,
  `ReviewCitationCheckCounts`, and the unions `ReviewCitationFinding`,
  `ReviewCitationSource` and `ReviewCitationUncheckedReason` (an open set).
- **Defaults for a body without the citation keys.** `getReview`,
  `reviewAndWait` and the `review.*` webhook events fill the citation keys a
  review body does not carry (`[]` for the lists, `null` for the counts,
  `more_claims`, `more_citations` and the policy's `max_citations`, `0` for
  `citation_issues`), so the types
  hold for every review body. A key the server sent is never changed.
- **`client.extract({ text, locate: true })`**: only the claims that could be
  traced directly back to the text are returned, and `locations` says where
  the text makes each one. A claim found nowhere in the text, or found with a
  different figure, is left out; a list that ends up empty answers
  `status: "not_a_claim"`. Locating adds a few seconds. If the claims cannot
  be located, `locations` is `null` and the list is returned unfiltered.
  `locate` defaults to `false`; it is sent only when you set it, so an
  explicit `false` is sent and an omitted value leaves the API's default in
  charge.
- **`ExtractedClaims.locations`** (`ClaimLocation[] | null`): one entry per
  returned claim, in the order of `identified_claims` (one entry for a single
  `claim`); `[]` when every claim was left out; `null` when `locate` was not
  set, when the extraction found no claims, or
  when the claims could not be located. A `ClaimLocation` is the `claim`
  (exactly as in `claim` / `identified_claims`) and its `positions`: every
  place the text makes it, in text order, 1 to 10 (`Position[] | null`:
  `null` only when that claim could not be placed; on `extract` every
  returned claim is placed).
- **`Position`**, one type for claim and citation positions:
  `{ start: number | null; end: number | null; text: string | null }`.
  `start` and `end` (exclusive) count Unicode **code points** in the text as
  sent; both are `null` when the text was a URL. `text` is the passage as it
  appears in the text, and `null` on a citation's position (its row carries
  the statement). JavaScript's `text.slice(start, end)` counts UTF-16 units
  and shifts after an emoji; slice with
  `Array.from(text).slice(start, end).join("")`. `ClaimLocation` and
  `Position` are exported.
- **Review claim rows say where the draft makes each claim.** A review now
  checks only the claims traced directly back to the draft: a claim found
  nowhere in it, or found with a different figure, is left out, as
  `extract({ locate: true })` does. Each `ReviewClaim` gains `positions`
  (`Position[] | null`): every place the draft makes the claim, in text
  order, at most 10, with `start` and `end` in code points of `text` as sent,
  the same shape as a citation's `position` (slice as above). For a URL
  draft `start` / `end` are `null` and `text` carries the passage, as
  `extract` does for a URL. `null` when the claim could not be located, or
  once a zero-retention draft is gone.
- **`more_claim_locations`** on both review views (`ClaimLocation[] | null`):
  one `{ claim, positions }` per `more_claims` string, same order
  (`more_claims` stays `string[]`). `null` until the draft is read. A body
  without either key (an older API) reads both as `null`; a key the server
  sent is never changed.

### Fixed

- **`ReviewFailureBlock.failure_reason`** is `string | null`: the API can
  send `null` when a stored failure names no specific cause. A failed review
  or citation check with a `null` reason reads, and `ReviewFailedError` /
  `CitecheckFailedError` carry an empty `errorCode`.

### Deprecated

- **`similar_claims`** and **`candidates`** on `TaskStatus` (JSDoc
  `@deprecated`). `similar_claims` belonged to the `duplicate_found` reason,
  which was never raised for API tasks; `candidates` has always been empty
  since its producer was retired. The API no longer sends either key, and
  both fields stay optional, so code that reads them keeps compiling.
  Removal is planned for 2026-11-29.
- Docs: `multi_claim` is the only `needs_input` reason; `duplicate_found` is
  gone from the documented values.

## [2.17.0] - 2026-09-26

`review`: the whole extract → assess → verify recipe on a draft in one call.
And a new optional field on every verification, single or listed,
`suggested_rewrite`. Nothing the SDK already sends changes, and 2.16.0 keeps
working against the current API; `review` needs an API that serves
`POST /review`.

### Added

- **`client.review`, `client.getReview` and `client.reviewAndWait`** for
  `POST /review`: the whole extract → assess → verify recipe on a draft in
  one async call. `review({ text, verdicts?, confidence?, maxAssessments?,
maxVerifications?, depth?, language?, webhookUrl?, visibility?,
idempotencyKey? })` returns `{ review_id, status: "queued" }`; the flat
  options are sent as the request's `escalate` policy, and only the ones you
  set. `webhookUrl` omitted or `null` uses the credential's default URL, `""`
  sends no webhook for this review. `getReview(id)` returns a `ReviewFull`
  and `getReview(id, { view: "issues" })` a `ReviewIssues` (no `claims`).
  `reviewAndWait(params, { timeoutMs?, onUpdate? })` polls on the review's
  `poll_after_seconds` (never tighter than 5 s), calls `onUpdate` on every
  poll that changed the review, and throws `ReviewFailedError` (a
  `LenzPipelineError` carrying `reviewId`, `errorCode`, `hint`, `review`) or
  `ReviewTimeoutError` (a `LenzTimeoutError` carrying `reviewId` and
  `partial`). `review` always sends an `Idempotency-Key`: a resend with the
  same key within 24 hours returns the same review, and a new key is a new
  review; a retried submit that meets the first attempt's review still being
  created (409 `idempotency_conflict` naming its `review_id`) returns that
  receipt. `reviewAndWait`'s deadline bounds the submit as well as the polls,
  a failed poll waits what the server stated (at most 60 s), and a 2xx that
  is not a review counts as a failed poll. Needs an API that serves
  `POST /review`; an older one answers 404.
- **Review types**: `ReviewFull`, `ReviewIssues`, `ReviewEnvelope`,
  `ReviewClaim`, `ReviewIssue`, `ReviewFailure`, `ReviewAssessment`,
  `ReviewVerification`, `ReviewResult`, `ReviewSummary`, `ReviewCredits`,
  `ReviewFailureBlock`, `EscalationPolicy`, `Escalation`, `ReviewStarted`,
  `ReviewInput`, and the `VerdictLabel`, `ConfidenceBand`, `ReviewStatus`,
  `ReviewOutcome` and `EscalationDisposition` unions. `issues` and
  `failures` are always arrays.
- **`review.completed` / `review.failed` webhooks**: `LenzWebhooks.parse`
  returns a `ReviewCompleted` / `ReviewFailed` (with `eventId`, `reviewId`
  and the whole `review`) in the `WebhookEvent` union. Dedupe on `eventId`;
  ignore events you do not recognise.
- **A 429 `review_in_flight`** (the account already has its maximum number
  of reviews running) throws `LenzRateLimitError` at once, with `retryAfter`
  read from `Retry-After` or the body's `retry_after_seconds`, instead of
  sleeping the wait inside the call.

- **`suggested_rewrite` on `Verification` and `VerificationListItem`**, a
  string or `null`: a suggested rewrite of `claim` that the verification's
  findings support, to use in place of the original sentence. It has not been
  verified itself: before using it, review it or run it through
  `client.verify({ claim })`. It is `null` for a true claim, when no
  correction is established, and on verifications that predate the field,
  and absent on responses from an API that predates it, so read it as
  `v.suggested_rewrite ?? null`. It is on every verification, single or
  listed: `verifications.get`, `verifications.list`, `library.list`,
  `verifyAndWait`, `wait`, and the `verification.completed` webhook's
  `result`. It is not on `assess` rows. Types only; earlier SDK versions
  ignore the key and keep working.
- **`LenzAPIError.retryAfter`**: the seconds a 5xx's `Retry-After` (or body
  `retry_after`) asked to wait, or `null`. It moved up from
  `LenzUpstreamUnavailableError`, which still has it.

### Changed

- A request's timeout now covers reading the response body, not only its
  headers: a successful body that stalls throws `LenzAPIError` at
  `timeoutMs`, and a stalled error body keeps its status with an empty body.
- A stated wait in the body's `retry_after_seconds` is read like
  `retry_after`, for the retry ladder and for `retryAfter` on a typed 503.
- `VerifyBatchItem.claim` and `.text` accept `null`, so a review's
  `claims[].claim` passes straight into `verifyBatchAndWait`.

## [2.16.0] - 2026-09-24

A new error, `LenzGoneError`, for a verification removed by its account's
retention period, and a new coverage reason, `account`. Nothing the SDK sends
changes, and 2.15.0 keeps working against the current API.

### Added

- **`LenzGoneError` for a verification that is no longer available.** An
  account on Pro or Scale can set a retention period; a verification older
  than it answers HTTP 410 with `code` `"purged"` on every read. The SDK now
  throws `LenzGoneError` (a `LenzError`) carrying `code` and `purgedAt`,
  instead of a plain `LenzError`. `wait`, `verifyAndWait` and
  `verifyBatchAndWait` stop polling a task that answers 410 rather than
  retrying it until the deadline; in a batch, such an item reads `"failed"`
  with no `status_detail`. The certificate of a covered verification stays
  available.
- **`"account"` in `CoverageReason`**: the account turned certificates off.
  It applies to checks submitted after the change; a verification that
  already carries a certificate keeps it. Types only: the `CoverageReason`
  union gained a member, so an exhaustive `switch` over it needs a case for
  `"account"`; older versions read the value fine, since `reasons` stays
  `string[]` on the wire.

### Changed

- **The 401 fix hint is neutral about the credential.** It used to say only
  "Generate a new key", which is the wrong advice for a key that was mistyped
  or left out. It now reads: "Your credential is missing, invalid or expired.
  Check the key you passed, or get a new one at https://lenz.io/api-credentials."
  The error class and its fields are unchanged.

## [2.15.0] - 2026-09-17

Two new optional fields on every `assess` row, `rationale` and `dissent`
(below). Nothing the SDK sends changes, and 2.14.0 keeps working against the
current API.

### Added

- **`rationale` and `dissent` on `AssessClaim`**, the two optional notes the
  API now returns on every `assess` row. `rationale` is the reasoning of a
  reviewer who agrees with the panel's verdict; `dissent`, when set, is the
  reasoning of the reviewer farthest from it. Both are reviewers' notes, not
  checked sources; for sourced evidence, call `verify`. Both are optional:
  an `"Error"` row carries `null`, and a response the API replays from before
  it added them carries neither key. Types only; earlier SDK versions ignore
  the two keys and keep working.

## [2.14.0] - 2026-09-15

Two behaviour changes — an opt-in `Idempotency-Key` on `ask.send`, and typed
errors for the 409s `verifications.get` answers on a task id — and a new name
for the non-expiring balance, `credits.extra` (all below); the rest is docs.
The only new parsing is that 409 error body and `credits.extra`, and 2.13.0
keeps working against the current API.

### Added

- **`LenzVerificationNotReadyError`**, thrown by `verifications.get` when it
  is handed the `taskId` of a run that is still processing or waiting for
  input (a 409 with `code` `verification_not_ready`). It carries `taskId`,
  `status` and the server's `hint`, which is also its `fix`. A run that
  failed throws `LenzPipelineError` from the same call (`code`
  `verification_failed`), carrying `taskId`, `failureReason`,
  `failureClass`, `retryable` and `hint`. Both used to surface as a generic
  `LenzError` whose advice was to retry and file an issue, which is wrong for
  both. Every other 409 is still a plain `LenzError`. Against an older API
  the call behaves as before.
- **`idempotencyKey`** on `AskSendInput`, sent as the `Idempotency-Key`
  header. With a key, a retry of a question that already got a reply replays
  that reply instead of spending a second credit and leaving the question plus
  a second answer in the conversation that `ask.history` returns and the next
  turn reads as context; a retry sent while the first call is still running
  gets a 409. `ask.send` never generates a key for you and never derives one
  from the message, unlike `assess`: a reply depends on the conversation so
  far, so asking the same question again is a normal thing to do. A call
  without a key behaves exactly as before.
- **`UsageCredits.extra`**: the non-expiring part of the balance, credits
  from grants and top-ups that are spent only once the monthly allowance is
  gone. It is the new name of `UsageCredits.bonus` and carries the same
  number. `usage()` fills whichever of the two the server did not send, so
  both read correctly against any server version.

### Deprecated

- **`UsageCredits.bonus`** (JSDoc `@deprecated`), the old name of
  `UsageCredits.extra`. The API removes it on 2026-11-29, along with the
  per-capability `credits` alias.

### Changed

- **`Usage.plan` is `"pro"` for the Pro plan.** The API renamed the slug on
  2026-09-15; it was `"developer"`. Nothing in the SDK branches on it, so the
  change is the JSDoc and the test fixture. If your code compares `plan` to
  `"developer"`, compare it to `"pro"` (or read `plan_label`, which has read
  `"Pro"` throughout).

## [2.13.0] - 2026-09-15

One behaviour change, `extract`'s default timeout (below); the rest is docs.
Nothing the SDK sends or parses changes, and 2.12.0 keeps working against
the current API.

### Added

- **`timeoutMs`** on `ExtractInput`: a per-call HTTP timeout, like the one
  `assess` takes.

### Deprecated

- **`candidate_claims`** on `ExtractedClaims`, `AssessClaim` and
  `AssessResponse`, and **`candidates`** on `TaskStatus` (JSDoc
  `@deprecated`). The API has sent them empty since 2026-09-12, when
  `/assess` stopped returning `error_code: "ambiguous"` and `/verify` stopped
  pausing with `reason: "clarification_required"` (a vague input is now
  checked on its most likely reading). The fields stay because the keys
  still arrive.

### Changed

- **`extract` waits up to 90s per attempt by default** instead of the client's 30s. The
  slowest extractions take 30-60s, and on a client timeout the SDK re-sent
  the call, which ran the same extraction again. A longer client-wide
  `timeoutMs` is never shortened.
- Docs: `assess`'s 45s default is described as covering both forms, as it
  has since 2.12.0 (README and `AssessInput.timeoutMs`).
- Docs: `ambiguous` and `clarification_required` are gone from the
  documented values. The `/assess` row causes are `no_claim` /
  `framing_failed` / `upstream_unavailable` / `timeout`, and the `needs_input`
  reasons are `multi_claim` / `duplicate_found`. `Assessment` describes the
  current panel (Reviewers A–C, plus D and E when they disagree) and the
  older specialist panelists; `Source.snippet` is the passage around the
  quote, in the page's language; a single `assess` text answers with up to
  20 rows.
- The demo claim is no longer described as pre-cached: the API's verdict
  cache now lasts an hour, so it answers in seconds only when someone
  verified it within the hour.
- Release smoke: the `/verify` check runs the quickstart claim at
  `depth: "low"` with a 150s budget instead of expecting a cache hit inside
  30s, which a 1-hour cache no longer guarantees.

## [2.12.0] - 2026-09-06

**`assess` now defends against being charged twice for a call you never
received.** Two changes that belong together. Lockstep release with Python
2.12.0.

The single form used the 30s client default while a list call got 45s. The
server runs framing and then a 3-model panel inside one synchronous request
and divides a single time budget between them, so a single-claim call can take
as long as a list one — and when it overran, the client timed out _after_ the
server had charged it. `assess` sent no `Idempotency-Key`, so the retry
charged again.

Both forms now wait up to 45s (or your client's `timeoutMs` when it is
longer), and every `assess` call carries an auto-generated key that is reused
across this client's own retries.

Works against any server version: the key is simply honoured by newer servers
and ignored by older ones, and a longer timeout only ever waits longer.

### Added

- **`AssessInput.idempotency` / `AssessInput.idempotencyKey`** — same shape
  as `VerifyAndWaitInput`. On by default, generating a random key per
  invocation that is reused across retries. Pin your own to make a retry from
  another process replay too, or pass `idempotency: false` to send none.

  Deliberately random rather than derived from the claim text: an identical
  claim sent an hour later is a new question, and a content-derived key would
  replay the first answer for 24h.

- **`timeout`** joins the row `error_code` vocabulary — the call ran out of
  its time budget before that item was done. It is free, and worth resending
  as-is; sending fewer items per call makes it less likely.

### Changed

- **`assess({ claim })` waits up to 45s**, not 30s — the same floor the list
  form already had, and still never shorter than a longer `timeoutMs`.
- **The row `error_code` set is documented as OPEN.** Branch on the values you
  know and fall through on the rest; surface `hint` to humans, since it is
  written per cause and stays correct as causes are added.

## [2.11.0] - 2026-09-03

**`progress` on `GET /verify/status` is now a documented object.** It was
previously an untyped bag whose contents were a server implementation detail,
so nothing about it was safe to depend on. It now carries five typed fields —
`step`, `index`, `total`, `elapsed_seconds`, `poll_after_seconds` — and this
SDK types them. Lockstep release with Python 2.11.0.

Works against any server version: an older server simply never sends
`index` / `total` / `poll_after_seconds`, and the SDK falls back to its own
backoff ladder.

### Added

- **`Progress`** — `step`, `index`, `total`, `elapsed_seconds`,
  `poll_after_seconds`. `step` is one of `starting` / `framing` / `research` /
  `debate` / `adjudication` / `conclusion`; `index` is the 1-based stage
  position out of `total`. Typed `string`, not a union, so a stage the server
  adds later passes through.
- **`onProgress` on `verifyAndWait`, `wait` and `verifyBatchAndWait`** —
  called as `onProgress(taskId, progress)` once per poll while a run is still
  going. It takes the `taskId` because the batch helper round-robins several
  ids in one loop. Without this the stage is invisible to anyone using the
  documented happy path, since these helpers do the polling. A throw inside
  your callback is swallowed and never breaks the poll.
- **Honouring `progress.poll_after_seconds`** — the poll loop uses the
  server's suggested interval in place of the fixed 2/4/8s ladder when it is
  present and within bounds. A batch waits the shortest hint in flight.
- **`TaskStatus.task_id`** — echoed by the server on every status shape.
- **`TaskStatus.docs_url`** — on a `failed` status, the page explaining that
  `failure_class`.

### Changed

- **`TaskStatus.progress` is `Progress | undefined`, was
  `Record<string, unknown>`.** Compile-time narrowing only — the runtime value
  is unchanged and no JavaScript caller is affected. TypeScript users indexing
  arbitrary keys off `progress` now get a build error; read the named fields
  instead.
- **A completed status body no longer carries a `progress` key at all** (the
  server omits unset fields). It was `{}` before, so `status.progress` is now
  `undefined` on a terminal body rather than an empty object.

**Covered verification: the warranty block and the certificate.** Qualifying
verdicts on paid Developer and Scale plans carry a contractual warranty from
Lenz. This release types the `coverage` block that says whether a given verdict
carries it, and adds `getCertificate()` to download the signed, timestamped
document. Lockstep release with Python 2.12.0.

**Not yet live.** The server gates all of this behind a flag that is off, so
`coverage` is absent from every response until Lenz enables it. Nothing here
breaks against a server that has never heard of the feature.

### Added — covered verification

- **`Coverage`** on `Verification.coverage` — `status`, `reasons`,
  `certificate_id`, `certificate_url`, `as_of`, `currency`, `cap`,
  `aggregate`, `terms_version`. Absent when Lenz is not operating the
  warranty, and on unauthenticated calls.
- **`Certificate`** and **`client.verifications.getCertificate(id)`** — the
  signed record, byte-identical to the public document, with `leaf`,
  `signature`, `anchors` (an eIDAS-qualified RFC 3161 timestamp plus an
  OpenTimestamps receipt), and `verifier_url` / `keys_url` so you can check it
  with the published open-source verifier **without involving Lenz**.
- **`CoverageStatus`** and **`CoverageReason`** unions, exported for
  exhaustive matching. The fields themselves stay `string` / `string[]` so the
  SDK never rejects a value the server adds after this release was cut.
- **`CertificateTimestamped`** — the `certificate.timestamped` webhook event, typed.
  **This is the event to publish on, not `verification.completed`.** The
  warranty requires the certificate's timestamp to PRECEDE what you publish or
  send, so a pipeline keyed on `completed` races the anchor and can put the
  statement out before cover exists. It carries `coverage` instead of
  `result` — it reports a timestamp landing, not a verdict being produced.

### Notes for callers — covered verification

- **`coverage === undefined` and `status === "uncovered"` are different
  facts.** The first means Lenz is not operating the warranty, or you called
  without a key; the second means it IS operating and this verdict did not
  qualify — `reasons` says why. Do not conflate them.
- **The money fields are three, not two.** `currency` is ISO 4217 and the
  amounts are integers in **major units** — `cap: 10000` means ten thousand,
  not a hundred. They are contract figures, not amounts a payment processor
  charges. Read `currency`; do not assume EUR.
- **A 404 from `getCertificate()` is not a reliable "not covered" signal** —
  it is also what you get for a verification with no certificate for your
  account. Check `coverage?.status` first.
- A **withdrawn** certificate is still returned, with `withdrawn_at` set. It is
  the record of what was warranted, and use before the withdrawal notice can
  still be covered.

## [2.10.0] - 2026-09-01

One input vocabulary: **`text` is a document, `claim` is a claim.** `extract`
takes `text`; `assess`, `verify`, batch items and `select` take `claim` /
`claims`. And `assess` takes a list: **`assess({ claims })`** checks up to 20
claims in one call, one row per claim. Lockstep release with Python 2.10.0.

Every existing call still serialises to the wire keys it always has, so it
works against any server version. `assess({ claims })` is the one new request
shape: it needs the server that accepts it (an earlier server answers 422).

### Added

- **`AssessInput.claim`** — `client.assess({ claim })`. `text` keeps working
  as an alias; `claim` wins if both are given.
- **`AssessInput.claims`** — `client.assess({ claims })`. Up to 20 claims per
  call, sent as `claims` on the wire; exactly one `AssessClaim` comes back per
  item, in the order sent. Mutually exclusive with `claim` / `text` — giving
  both throws `LenzValidationError` before any request is made. A compound
  item is assessed on its main claim; an item without a verdict comes back in
  position as `verdict: "Error"`, free, and says why.
- **`AssessClaim.error_code` / `candidate_claims` / `identified_claims` /
  `hint`** — on every row, both forms. `error_code` is set only on an
  `Error` row (`no_claim` | `ambiguous` | `framing_failed` |
  `upstream_unavailable`, the last being the retryable one);
  `candidate_claims` carries the readings when it was `ambiguous`;
  `identified_claims` lists the other claims found in the item that were not
  assessed; `hint` is one sentence on what to send next, set on every `Error`
  row and on a row with non-empty `identified_claims`.
- **`AssessInput.timeoutMs`** — per-call HTTP timeout on `assess`. A list
  call waits at least 45s when it is omitted (the client default is 30s); the
  single form keeps the client's timeout.
- **`hint`** on the `needs_input` interrupt: `TaskStatus.hint`,
  `LenzNeedsInputError.hint` and `VerificationNeedsInput.hint` (lifted out of
  the webhook's `needs_input` block) carry the server's one-sentence
  resolution hint for `multi_claim` / `clarification_required`; a `failed`
  status with `failure_reason: not_a_claim` carries it too
  (`LenzPipelineError.hint`). `""` when an older server omits it.
- **`VerifyInput.text`** — an explicit alias for `claim` on `verify` /
  `verifyAndWait`. `claim` is no longer a required property at the type
  level (one of the two is required at runtime, as before).
- **`VerifyBatchItem.claim`** — batch items take `claim`; `text` stays as an
  alias. Items keep serialising to `text` on the wire.
- **`SelectInput.claims`** — `client.select(taskId, { claims })`. `texts`
  keeps working as an alias. The empty-selection error now names `claims`.

### Changed

- **The documented ladder** is now `extract` → one `assess({ claims })` over
  the extracted claims → `verifyBatchAndWait` for the low-confidence rows →
  `ask`. The README, the module headers and both core examples follow it;
  `verify-llm-output.ts` no longer assesses the whole document in one string.
- The shared contract fixture `assess_claims_list.json` (identical in the
  Python SDK) pins the list form's row shape; the `AssessClaim` and
  `TaskStatus` keysets carry the new fields.

## [2.9.0] - 2026-08-29

One weighted credit pool replaces six per-endpoint quotas; `extract` takes a
`focus`; `verify` takes a `depth`. Lockstep release with Python 2.9.0 and the
server-side pool.

### Added

- **`Usage.credits`** (`UsageCredits`) — the account's balance: `total`,
  `used`, `remaining`, the non-expiring `bonus` bucket, and `resets_at`. This
  is the authoritative number; every billable call spends from it.
- **`Usage.costs`** — `Record<string, number>`, credits per call keyed by
  **capability** at its default price (`verify` 10, `assess` 1, `ask` 1,
  `extract` 0). Read the weight from here rather than hard-coding it; a new
  capability arrives as a new key. Capability names and nothing else, so it is
  safe to iterate.
- **`Usage.cost_options`** — prices that depend on a request **parameter**,
  nested capability → parameter → value:
  `{ verify: { depth: { standard: 10, low: 5 } } }`. Every capability here also
  appears in `costs` at its default, so reading only `costs` is imprecise but
  never wrong. Nested rather than flat so a future parameter adds a key under
  its capability instead of a new top-level entry. Every level is optional at
  the type level because every level is optional at runtime — a server
  predating the field sends `{}`, and the `costs` default is the right
  fallback.
  - The low-depth price is a **price, not a capability**: there is deliberately
    no `verify_low` block beside `usage.verify`, because it would report the
    same balance in a second unit.
  - **You are charged for the depth you REQUESTED, not the one you were
    served.** A `low` request answered from a cached `standard` verdict still
    costs 5.
- **`Usage.plan_label`** — the tier as display copy (`"Developer"`), beside the
  stable `plan` slug. Two fields on purpose: `plan` is what you branch on,
  `plan_label` is copy and may be reworded.

- **`UsageCapacity.bonus`** — the non-expiring bucket in that capability's
  unit, floored by its cost (5 bonus credits is `assess.bonus === 5` and
  `verify.bonus === 0`).
- **`LenzQuotaExceededError.creditBalance` and `.cost`** — the 402 rejection
  in pool units: credits you hold (server field `credits_remaining`) and
  credits the refused call would have taken (`cost`, scaled for a batch).
  Together they separate "you hold 4 credits and this verification costs 10"
  from "you hold nothing". `null` when the server omits them, matching
  `remaining`.
  - `cost` is **depth-aware**, not a fixed multiple: a rejected
    `depth: "low"` verify reports 5, and a rejected batch that mixes depths
    reports its real summed total. Read it rather than multiplying `requested`
    by an assumed price.

- **`focus` on `extract`.** An optional hint of at most 300 characters —
  `focus: "market size, growth and competitors"` — that narrows the result to
  the claims it names. A focus can only SELECT from the claims the extractor
  found: it cannot add a claim, reword one, reorder them, change the output
  language, or change what counts as a claim, so a claim you get back is one
  an unfocused call would have returned too, verbatim. Omitted when empty, so
  the request body is unchanged for callers who don't use it. There is no
  client-side length check — the server's 422 is the contract, and a cap
  duplicated here would drift from it.
- **`ExtractStatus`** — `"ready" | "not_a_claim" | "no_match"`, with the same
  open-ended arm as `FailureClass` so a future status doesn't break the build.
  `ExtractedClaims.status` widens from `string` to it, which is
  source-compatible.
- **`no_match`** — the status when the text HAS claims but none fall within
  your `focus`. It is a successful answer, not an error, and it is never the
  unfocused list in disguise: `identified_claims` is empty and `claim` is
  `""`. Widen the focus and call again.

- **`depth` on `verify` / `verifyBatch`** (and their `AndWait` helpers) —
  `"standard"` (server default) or `"low"`. `"low"` runs a shallower check:
  fewer sources, faster, and **half the credits** — same models throughout;
  it is not a model downgrade. `VerifyBatchInput`
  takes a batch-wide `depth`; each `VerifyBatchItem` may set its own `depth`
  to override it, exactly like `visibility`. Omitted from the request body
  when unset, so existing callers stay byte-identical on the wire and keep
  working against a server that does not know the field yet.
- **`Verification.depth`** — echoes the depth the verdict was actually
  produced with. A `"low"` request served from the result cache reads back
  `"standard"`. Absent on servers that predate the field.

### Changed

- **`openapi.json` refreshed**, which also catches up on server changes that
  were never re-snapshotted after 2.8.0: `failure_class` / `retryable` on the
  status schema, the 502/503 error rows, and a `/extract` 200 response schema
  where the vendored spec previously had none. No SDK behaviour depends on it —
  the file is documentation and generator input.

- **The `verify` / `ask` / `assess` blocks are now projections of the one
  pool**, not separate allowances — spending on any capability moves all
  three. Each is `credits` divided by that capability's cost, flooring, and
  `quota_used` is derived as `quota_total - quota_remaining` so
  `used + remaining === total` still holds in every block. Reading them needs
  no code change; the numbers now move together.

### Deprecated

- **The per-capability blocks `usage.verify` / `ask` / `assess`, and
  `UsageCapacity.credits`,** are removed together on
  **2026-11-29** — one date, one release, rather than two breaking changes
  months apart. Both are marked `@deprecated`, so editors strike them through
  and name the replacement.
  - The blocks are two floor divisions of `credits` by `costs`:
    `Math.floor(credits.remaining / costs[capability])`. Two capabilities at
    the same price emit identical objects (`ask` and `assess` are both 1
    credit), because there is one balance behind all of them.
  - `UsageCapacity.credits` is an alias of `bonus` and is now optional
    (`credits?: number`). It never meant the pool: before the pool existed it
    meant that capability's one-off top-up balance, which is exactly what
    `bonus` reports.

### Notes

- The deprecated `creditsRemaining` accessor still aliases `remaining` and is
  still removed in 3.0. It is deliberately **not** wired to the server's new
  `credits_remaining` field: that one is the pool balance and reads in a
  different unit — hence the separate `creditBalance`. Its JSDoc and its
  warning now say so.
- `LenzQuotaExceededError.remaining` / `.requested` are unchanged and stay in
  the capability's own unit (verifications, asks, assesses).

## [2.8.0] - 2026-08-21

The server now says WHY a verification failed and states honest waits when it
is overloaded; the SDK types both. Lockstep release with Python 2.8.0.

### Added

- **`failure_class` + `retryable` on failed verifications.** `TaskStatus`
  (plus the new `FailureClass` union), the `VerificationFailed` webhook event
  (`failureClass` / `retryable`), and `LenzPipelineError` all carry the WHY
  (closed set: `upstream_unavailable` | `insufficient_evidence` |
  `invalid_input` | `cancelled` | `internal`) and the derived retry signal
  (true iff `upstream_unavailable` — resubmitting the same claim is the right
  move). Older servers omit both; the fields default rather than break.
- **`LenzUpstreamUnavailableError`** — a `LenzAPIError` subclass for 503s with
  `code` `upstream_unavailable` (model/search providers exhausted; the request
  was not charged) or `capacity` (submission shed at the door; nothing was
  accepted). Carries `retryAfter`.

### Changed

- **A 503 that Lenz itself typed — body `code` `upstream_unavailable` or
  `capacity` — and that asks for more than 60s now throws immediately**, as
  `LenzUpstreamUnavailableError` carrying the true `retryAfter`, instead of
  silently burning the 1s/2s/4s backoff ladder against a server that asked
  for 90-120s. That is the same rule 429 has always had. The decision is
  gated on the body code, not on the status number:
  - typed 503, stated wait ≤ 60s → still slept through and retried (unchanged);
  - **untyped 503** — an ordinary proxy / load-balancer / maintenance
    response with no Lenz `code` — → **backoff ladder, exactly as before**,
    however long a `Retry-After` it states;
  - every other 5xx → backoff ladder, unchanged.

  If you relied on long-stated-wait typed 503s being retried blindly, catch
  `LenzUpstreamUnavailableError` (existing `instanceof LenzAPIError` checks
  keep matching it).

- The stated wait is now also read from the 503 body's `retry_after` key
  (previously only the `Retry-After` header and the 429 body's
  `reset_in_seconds`), so a proxy that strips headers can't demote an honest
  wait to blind backoff.

### Fixed

- `LenzPipelineError` from the empty-result completed state now sets `taskId`
  (parity with Python, which always did).
- Contract fixtures refreshed to the live failed-status body; added the
  `verification.failed` webhook payload and both 503 envelopes (shared
  byte-identically with the Python SDK, as ever). The runtime `KEYSETS` in
  the contract test caught up with `src/types.ts` (`Verification.visibility`,
  `AssessResponse.error_code`/`candidate_claims`, `AssessClaim.language`,
  `VerificationListItem.language`).
- `VerificationFailed.failureClass` is typed as the exported `FailureClass`
  union rather than a bare `string`, matching `TaskStatus.failure_class`.

## [2.7.1] - 2026-08-15

### Fixed

- **`library.list` no longer offers the `popular` sort.** The server retired
  the view counter and its popularity sort (Lenz #273) and silently coerces
  `sort=popular` to `recent`, so the option was dead in the type. Removing it
  from the `sort` union is a compile-time correction only — a caller that
  still sends `"popular"` (e.g. from JS) keeps getting `recent` ordering from
  the server, same as before.
- Refreshed the `openapi.json` snapshot (doc-only server drift: /extract
  enumeration semantics, /verify body-keyed idempotency, the errors table).

## [2.7.0] - 2026-08-10

Quota errors are now a first-class, typed condition instead of an
authorization failure. Released in lockstep with `lenz-io` 2.7.0 for Python —
the two SDKs are a stated parity invariant.

### Changed

- **Out-of-credits throws `LenzQuotaExceededError`, not `LenzAuthError`.** The
  API moved these rejections from HTTP 403 to **402**; 402 already mapped to
  `LenzQuotaExceededError` here, so the class you catch changes the moment the
  server ships. Previously a developer who ran out of credits was told _"This
  key doesn't have access to that resource"_ and pointed at `/docs/auth`.

  **Breaking-ish:** `LenzQuotaExceededError` does not extend `LenzAuthError`.
  If you were catching the auth error to handle an empty balance, catch the
  quota error instead.

- **`Retry-After` is clamped at 60s** (`MAX_RETRY_AFTER_SLEEP`). The `/extract`
  daily cap sends seconds-until-UTC-midnight, so the old behavior could block a
  call for most of a day — three times over, once per retry — and that sleep
  sits outside the `AbortController`, so `timeoutMs` did not bound it. Past the
  clamp the two retryable statuses now differ:
  - **429** throws immediately with the true `retryAfter`. Schedule the work;
    don't sit in it.
  - **5xx** falls back to the normal backoff ladder and keeps retrying — the
    server is down, not throttling you, and a maintenance-window
    `Retry-After: 3600` shouldn't become an hour-long sleep _or_ abort a call
    that backoff might still satisfy.

  Note the clamp bounds a single sleep, not the call: a 429 stating 60s can
  still sleep 60s on each of `maxRetries` attempts.

- **The retry ladder now reads `reset_in_seconds` from the body** when no
  `Retry-After` header is present, matching the Python SDK. Previously Node
  burned the whole ladder on a 429 whose wait was body-only where Python
  raised on the first call.

- **`LenzRateLimitError.retryAfter` now reads `reset_in_seconds`** from the
  body when the `Retry-After` header is absent. The previously-read
  `retry_after` body key was an SDK invention the server has never sent.
  An empty header no longer coerces to `0` via `Number("")`.

- **Two server `code` values were retired** (server-side change, affects every
  SDK version): `insufficient_credits` and `no_chat_credits` are now plain
  `no_credits`. Both named the endpoint you called rather than what went
  wrong. **A branch on either string stops matching silently** — read
  `remaining` instead.

### Added

- **`LenzError.code`** — the server's machine-readable error code, on the base
  class so 402, 403 and 429 all carry it. `""` when the server sent none.
- **`LenzQuotaExceededError.upgradeUrl`** — where the wall lifts. No rejection
  used to carry a URL at all.
- **`LenzQuotaExceededError.remaining` / `.resetsAt` / `.requested`.**
  `remaining` is **nullable**: `null` means the server didn't report a
  balance, `0` means it reported an empty one. The server omits these rather
  than sending `null`, so the distinction survives the wire.
- **`LenzRateLimitError.limit` / `.resetInSeconds` / `.upgradeUrl`.** The
  server sends `upgrade_url` on 429 as well as 402 — someone hitting the daily
  `/extract` cap also wants to know a paid plan raises it.
- **`MAX_RETRY_AFTER_SLEEP`** is exported.

### Deprecated

- **`LenzQuotaExceededError.creditsRemaining`** — use `remaining`. The old
  property was zero-defaulted and the server never sent the field it read, so
  it was always `0`. It is now an accessor that reads and writes through to
  `remaining` (still assignable, so nothing breaks under strict mode or
  `tsc`), logging a deprecation warning once per process. Removed in 3.0.

  One behavioral note: as a prototype accessor rather than an own enumerable
  property, it no longer appears in `JSON.stringify(err)`, `{...err}` or
  `Object.keys(err)`. A log pipeline that serialized the error loses a field
  that was always `0`; read `remaining` instead.

## [2.6.0] - 2026-08-05

### Added

- **`key_finding` on verdict payloads.** `Verification` and
  `VerificationListItem` gain `key_finding?: string` — one declarative
  sentence stating the most important fact the analysis established (e.g.
  _"Water boils at 100°C at standard atmospheric pressure."_), written by the
  verification pipeline's conclusion step. Empty string on legacy claims that
  pre-date the field.

## [2.5.0] - 2026-07-23

### Changed

- **`verifications.related()` is now keyless.** The server opened the endpoint
  to anonymous callers (same optional-Bearer model as `verifications.get`);
  the client-side auth guard is dropped accordingly. A configured key is still
  sent, so owners keep seeing related lists for their own verifications.

### Added

- **Claim visibility on submit.** `verify` / `verifyAndWait` / `verifyBatch` /
  `verifyBatchAndWait` accept `visibility: "private"` (default, owner-only) or
  `"unlisted"` (readable by `verification_id` and at the `/c/` URL, but never
  listed in the Library or search). Batch items may set per-item `visibility`
  to override the batch-wide default. Omitted → private (byte-identical bodies
  for existing callers). `Verification.visibility` returns
  `"private" | "unlisted" | "public"` for read-back (`"public"` is read-only,
  for genuinely listed claims).
- **`library.list` filters.** `curated` — restrict to one or more named curated
  collections (e.g. `["trivia"]`); `verdict` — comma-separated verdict labels
  (e.g. `"True,False"`); and `sort: "random"` for a shuffled page.
- **`usage()` now reports `has_webhook_secret`** — whether a webhook signing
  secret is configured for the API key.

### Changed

- **Isomorphic / browser-safe build.** The SDK now bundles cleanly for browsers,
  Deno, and edge runtimes. A `browser` export condition serves a webhooks-free
  entry point; `randomUUID` uses the WebCrypto global with a lazy `node:crypto`
  fallback (Node 18); the constructor's `process.env` reads are guarded.
  Non-breaking — Node still imports `LenzWebhooks` / `verifySignature` from the
  package root.

## [2.3.0] — 2026-07-06

### Changed

- **Docs corrected to match the API.** The Lenz Score range is 1–10 (was
  documented 0–10); the full pipeline is 8 models across 5 stages (was
  "7-model"); public stage names are Framing → Research → Debate →
  Panel Review → Conclusion (README, `types.ts` JSDoc, examples).
  No runtime or API changes — documentation only.

## [2.2.0] — 2026-06-29

### Changed

- **Verdict scale is now 5-point.** `verdict` values are
  `"True" | "Mostly True" | "Mixed" | "Mostly False" | "False" | "Error"`
  (was 4-point with `"Misleading"`). `verdict` remains a plain `string` for
  forward compatibility — no type changes — but consumers branching on the
  literal `"Misleading"` should map it to `"Mixed"` / `"Mostly False"`.

## [2.1.0] — 2026-06-26

### Added

- **`AssessResponse.error_code` and `AssessResponse.candidate_claims`.** When
  `claims` is empty, `error_code` disambiguates why: `'ambiguous'` (the input
  was vague but framing produced specific readings, returned in
  `candidate_claims`) vs `'no_claim'` (genuinely not a checkable claim). Both
  fields are optional, so older servers that don't send them degrade to the
  plain `error` message.

### Fixed

- **Bearer sent on optional-auth endpoints when keyed.** `verifications.get`
  now opts into bearer auth so the owning caller can retrieve their own
  private/hidden claims; purely public reads (`library.list`) stay anonymous so
  a key never reaches an endpoint that doesn't need it.

## [2.0.0] — 2026-06-25

Both changes below are breaking vs `1.2.0`.

### Changed

- **BREAKING: `GET /me/usage` is now per-capability.** `client.usage()` returns
  `plan`, `quota_resets_at`, and a `verify` / `ask` / `assess` / `extract` block
  instead of the flat `credits_used` / `credits_total` / `credits_resets_at` /
  `extract_*`. Each quota-backed capability (`UsageCapacity`) separates the
  recurring monthly `quota_*` from one-off top-up `credits`, with
  `remaining = quota_remaining + credits`. `assess` is quota-only (`credits`
  always 0). New exported types: `UsageCapacity`, `UsageExtract` (and the
  reshaped `Usage`). Migrate: `u.credits_total` → `u.verify.quota_total`,
  `u.credits_used` → `u.verify.quota_used`, and read `u.verify.remaining` for
  usable capacity.
- **BREAKING: `client.select()` resolves a multi-claim interrupt with one or
  more claims.** It now takes `{ texts: string[] }` (was `{ text }` /
  `{ claimIndex }`) and returns a `BatchAccepted` — each selected claim fans out
  into its own pipeline, so poll each `items[].task_id`. Every text must match a
  claim offered in the prior status (server-validated). On a rare mid-fan-out
  enqueue failure the server returns the partial set plus `partial: true` (still
  HTTP 202); `partial` is not on the `BatchAccepted` type but is present on the
  response object at runtime.

## [1.2.0] — 2026-06-07

Polling ergonomics. The async path (`verify()` → poll) is now first-class and
discoverable, not just a webhook fallback. Parallel verification (unlocked by the
server dropping its per-user single-flight lock) gets a dedicated batch-and-wait
helper.

### Added

- `client.wait(task)` → `Verification`. Blocks on an already-submitted task until
  it terminates. Accepts a `task_id` string **or** a `TaskAccepted`, so
  `client.wait(await client.verify({ claim }))` reads naturally. `verifyAndWait` is
  now `wait(verify(...))` internally (behavior unchanged).
- `client.verifyBatchAndWait({ claims })` → `BatchItemResult[]`. Fans out a batch
  and polls every item to completion, one result per claim in input order. Never
  throws on a per-item outcome — inspect each `BatchItemResult.status`
  (`completed` | `needs_input` | `failed` | `timeout`). Per-item poll failures use
  `Promise.allSettled` so one transport error doesn't abort the batch.
- `BatchItemResult` type (`task_id`, `claim_text`, `status`, `verification`,
  `status_detail`).
- `TaskStatus.error` — the server's failed-status responses carry the diagnostic
  under `error`; it's now a typed field.

### Fixed

- Failed verifications now surface the real diagnostic. The server sends
  `{"status": "failed", "error": "..."}`, but the SDK only read
  `failure_reason`/`failure_detail`, so `LenzPipelineError` reported "unknown". The
  failed path now reads `error || failure_detail || failure_reason`.

## [1.1.0] — 2026-05-28

API privacy redesign. The server now treats every API claim as private
by default and never leaks another customer's verification_id back on
a cache-hit. SDK changes align the typed surface with the new server
contract.

### Removed

- `Verification.url`, `Verification.visibility` — API claims are
  private and referenced by `verification_id` only. Cache-hit on
  someone else's claim is transparent: the customer always sees their
  own `verification_id`.
- `VerificationListItem.url`, `VerificationListItem.visibility` —
  same reasoning at the list-item layer.
- `client.verifications.setVisibility(...)` method — the underlying
  endpoint is gone. The property is `undefined` at runtime.
- `visibility` field from `VerifyInput`, `VerifyBatchInput`, and
  per-item `VerifyBatchItem` — server rejects it as unknown.

### Migration

If you were reading `verification.url`, the URL is no longer part of
the API surface. Reference verifications by `verification_id`.
`verification.visibility` was always `'private'` for any API-created
claim — the field had zero information value and is now removed.

If you were calling `client.verifications.setVisibility(...)`,
remove those calls.

## [1.0.2] — 2026-05-27

### Fixed

- `AskReply` interface now matches the server contract. Pre-1.0.2 it
  declared a single `reply: string` field that **never matched the
  wire** — `POST /ask/{verification_id}` returns
  `{role, content, created_at}` (see `lenz/api/public_authed.py:1804-1811`
  in the main repo). JS users could read `.content` at runtime (TS
  interfaces are erased), but TypeScript autocomplete pointed at the
  wrong field. 1.0.2 aligns the interface:

  ```ts
  interface AskReply {
    role?: string; // 'expert' on every reply
    content?: string; // the reply text
    created_at?: string;
  }
  ```

### Migration

If your code reads `.reply`, switch to `.content` — it's the same data
that was already coming over the wire, just now properly typed. Code
that read `.reply` at runtime was always getting `undefined`, so
functional impact is limited to "code that worked by accident now
works on purpose."

### Notes

Skipping `1.0.1` to keep the Node and Python SDK version numbers
aligned (Python had a 1.0.1 patch for a top-level re-export gap that
the Node SDK didn't share; mirroring the version stream from this
point keeps the docs simpler).

## [1.0.0] — 2026-05-27

First stable release. The pre-1.0 RC series (`1.0.0-rc.1` … `1.0.0-rc.12`) is
now considered superseded; consumers should upgrade. No breaking changes vs
the final RC — see entries below for the multi-language additions that
landed in this cut.

### Added

- **Multi-language API support** (12 languages). Optional `language?: string`
  field on the six request shapes: `VerifyInput`, `VerifyBatchInput`,
  `VerifyBatchItem` (per-item), `AssessInput`, `ExtractInput`, `AskSendInput`.
  Supported codes: `en` (default), `es`, `de`, `fr`, `it`, `pt`, `nl`, `sv`,
  `da`, `no`, `fi`, `bg`. Verdict / domain / status enum values stay English
  regardless of language; only free-form prose follows the request. Omit
  the field for byte-identical wire format with prior English callers.
- `VerifyBatchItem` interface — type-only shape for `verifyBatch` items,
  enabling IDE autocompletion on per-item `language` and other fields.
  Runtime still accepts plain objects.
- `AskSendInput` interface for `client.ask.send(...)` — gains optional
  `language` to override the claim's stored language on a single reply.
- `language?: string` on `Verification`, `VerificationListItem`,
  `LibraryItem`, and `AssessClaim` response shapes. Always populated by
  the server when the SDK is current; kept optional for resilience.
- `client.assess({ text })` — new sync verb that returns a fast 3-model
  panel verdict in ~5-10s. Mirrors the new `POST /api/v1/assess` server
  endpoint.
- `AssessClaim`, `AssessResponse`, `AssessInput` types for the assess
  response shape.
- `AskMessage` interface (`role`, `content`, `created_at`) —
  `AskHistory.messages` is now `AskMessage[]` instead of
  `Array<Record<string, unknown>>`.
- `confidence` (categorical: `"high"` | `"medium"` | `"low"`) at the
  top level of every claim-shaped response. Replaces the numeric
  `verdict.confidence` (0–1) — the numeric form is no longer in the
  public API; the SDK exposes only the categorical label.
- `lenz_score` (integer 0–10) flattened to the top level (was nested
  under `verdict.score` as a float). The server-side DB column is now
  `IntegerField` and OpenAPI declares `"type": "integer"`. TypeScript
  `number | null` is unchanged (TS has no separate int type), but
  consumers that branch on fractional values should update; the
  conclusion-step LLM was already constrained to integers and no
  fractional value ever existed in production.
- Contract test (`test/contract.test.ts`) — re-validates 6 frozen
  server-response fixtures with strict no-extra-keys walker, sharing
  the same fixture JSON the Python SDK validates against.

### Changed (breaking)

- `client.followup.*` → `client.ask.*`; URL paths
  `/verifications/{id}/follow-up` → `/ask/{id}`.
- `FollowupHistory` → `AskHistory`, `FollowupReply` → `AskReply`.
- `Verdict` block flattened — was `verification.verdict.label/.score/.confidence`,
  now `verification.verdict` (string), `verification.confidence`
  (categorical), `verification.lenz_score`.
- `ExtractedClaims.atomic_claim` → `ExtractedClaims.claim`.
- `SimilarVerification.verdict_label` → `verdict`; `score` → `lenz_score`;
  added `confidence`.
- `TaskStatus.candidate_claims` → `candidates`.
- `client.library.get(id)` removed — use `client.verifications.get(id)`,
  which now accepts anon callers and returns the same `Verification`
  shape for any non-hidden public claim.

### Removed

- `Verdict` interface (no consumers after the flatten).
- `published_at` field — use `created_at` + `modified_at` instead.
- `FollowupHistory` / `FollowupReply` / `Verdict` exports.
- `Source.stance` — the per-source SUPPORT/REFUTE/NEUTRAL label is gone
  from the server response. Research is now purely evidence-gathering;
  adjudication owns the verdict. See
  `lenzhq/lenz@b9419e50` for the server-side change.

## [1.0.0-rc.1] — 2026-05-13

First public release candidate. Targets Lenz Public API v1
(`X-Lenz-API-Version: 2026-05-13`).

### Added

- `Lenz` client with marquee top-level methods (`verify`, `verifyAndWait`,
  `verifyBatch`, `extract`, `select`, `getStatus`, `usage`) and resource
  namespaces (`verifications`, `followup`, `library`).
- `verifyAndWait()` — submit + poll with exponential backoff
  (2s/4s/8s cap 10s), auto-idempotency by default, 120s default timeout.
- Typed exception hierarchy with `cause` + `fix` + `docUrl` + `requestId`
  on every error; HTTP status → exception mapping is single-source and
  mirrored in the Python SDK.
- `LenzWebhooks` stateful handler — HMAC-SHA256 signature verification,
  5-minute replay window, typed event union
  (`VerificationCompleted` / `VerificationFailed` / `VerificationNeedsInput`).
- Auto-retry on 5xx and 429 with `Retry-After` honored.
- `X-Lenz-API-Version` pinned at SDK release date; uses global `fetch` with
  keep-alive.
- `LENZ_API_KEY` and `LENZ_BASE_URL` environment variables.
- ESM + CJS dual exports via tsup. TypeScript declarations included.
- Node 18+ support.
- 57 unit tests covering construction, verb dispatch, namespaces,
  `verifyAndWait` state machine, idempotency, auto-retry, webhook
  parsing, error mapping.
