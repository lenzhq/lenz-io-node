# Changelog

All notable changes to this SDK are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [Unreleased]

### Added
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
- `lenz_score` (numeric 0–10) flattened to the top level (was nested
  under `verdict.score`).
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
