# Changelog

All notable changes to this SDK are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [Unreleased]

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
