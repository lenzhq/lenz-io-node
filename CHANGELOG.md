# Changelog

All notable changes to this SDK are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

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
