/**
 * Code a user wrote against 2.x, unchanged: it must compile against this
 * release under `tsc --strict` (`type-compat.test.ts`). Never run; every
 * function only has to type-check.
 */

import {
  Lenz,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzValidationError,
  LenzWebhooks,
  type AssessClaim,
  type BatchItemResult,
  type ExtractedClaim,
  type ReviewFailureBlock,
  type TaskStatus,
  type Verification,
} from "../../src/index.js";

export async function extractThenAssess(client: Lenz, text: string): Promise<string[]> {
  const out = await client.extract({ text });
  const claims = out.identified_claims?.length ? out.identified_claims : [out.claim!];
  if (out.status === "not_a_claim") return [];
  const located = out.locations ?? null;
  const res = await client.assess({ claims });
  const rows: AssessClaim[] = res.claims;
  const failed = rows.filter((r) => r.verdict === "Error" || r.confidence === "low");
  const codes: Array<string | null | undefined> = failed.map((r) => r.error_code);
  const more: string[] = rows.flatMap((r) => r.identified_claims ?? []);
  void located;
  void codes;
  return [...more, res.error ?? "", res.error_code ?? ""];
}

export async function verifyFlow(client: Lenz): Promise<string | null> {
  const receipt = await client.verify({ claim: "x", webhookUrl: "" });
  const taskId: string = receipt.task_id;
  void taskId;
  const batch = await client.verifyBatch({ claims: [{ claim: "a" }] });
  const firstText: string | undefined = batch.items[0]?.claim_text;
  void firstText;
  const status: TaskStatus = await client.getStatus(receipt.task_id);
  if (status.status === "failed") {
    const reason: string | undefined = status.failure_reason;
    const sentence: string | undefined = status.error;
    void reason;
    void sentence;
  }
  if (status.status === "needs_input") {
    const options: string[] = (status.claims ?? []).map((c) => c.text ?? "");
    void options;
  }
  const v: Verification = await client.verifications.get("v");
  const results: BatchItemResult[] = await client.verifyBatchAndWait({ claims: [{ claim: "a" }] });
  void results.map((r) => r.claim_text);
  return v.modified_at ?? null;
}

export async function usageFlow(client: Lenz): Promise<number> {
  const u = await client.usage();
  const resets: string | null = u.quota_resets_at;
  void resets;
  return (
    u.verify.quota_remaining + u.verify.bonus + (u.verify.credits ?? 0) + (u.credits.bonus ?? 0)
  );
}

export async function reviewFlow(client: Lenz): Promise<boolean | null> {
  const review = await client.reviewAndWait({ text: "x" });
  const reached: boolean | null = review.summary.claim_limit_reached;
  const rowCodes = review.claims.map((row) => row.assessment?.error_code ?? null);
  void rowCodes;
  return reached;
}

export function errorsFlow(err: unknown): number | null {
  if (err instanceof LenzRateLimitError) return err.resetInSeconds ?? err.retryAfter;
  if (err instanceof LenzQuotaExceededError) return err.remaining ?? err.creditsRemaining;
  if (err instanceof LenzValidationError) return err.errors.length + err.code.length;
  return null;
}

export function webhookFlow(hooks: LenzWebhooks, body: string, sig: string): string {
  const event = hooks.parse(body, { "X-Lenz-Signature": sig });
  if (event.event === "verification.failed" && "error" in event) return String(event.error);
  if (event.event === "verification.completed" && "result" in event) {
    return String((event.result as Verification).modified_at);
  }
  return event.taskId;
}

// Written against 2.21.0: the newer names it added, read from either form.
export async function twoTwentyOneFlow(client: Lenz, hooks: LenzWebhooks): Promise<string[]> {
  const out = await client.extract({ text: "x" });
  const claims: ExtractedClaim[] = out.claims ?? [];
  const res = await client.assess({ claim: "x", language: "auto" });
  const failures: Array<ReviewFailureBlock | null | undefined> = res.claims.map((r) =>
    r.status === "failed" ? r.failure : null,
  );
  const more: string[] = res.claims.flatMap((r) => r.more_claims ?? []);
  const receipt = await client.verify({ claim: "x", language: "auto" });
  const status: TaskStatus = await client.getStatus(receipt.task_id);
  const code: string | null | undefined = status.failure?.code;
  const batch = await client.verifyBatch({ claims: [{ claim: "a" }] });
  const claimOf: string | null | undefined = batch.items[0]?.claim;
  const v: Verification = await client.verifications.get("v");
  const done: string | null | undefined = v.completed_at;
  const review = await client.reviewAndWait({ text: "x" });
  const found: number | null | undefined = review.summary.claims_found;
  const exceeded: boolean | null | undefined = review.summary.claim_limit_exceeded;
  const reply = await client.ask.send("v", { message: "why?", language: "auto" });
  const event = hooks.parse("", { "X-Lenz-Signature": "" });
  if (event.event === "verification.failed" && "failure" in event) void event.failure?.code;
  if (event.event === "verification.completed" && "verification" in event) {
    void event.verification?.status;
  }
  void failures;
  void found;
  void exceeded;
  void reply;
  return [...claims.map((c) => c.claim), ...more, code ?? "", claimOf ?? "", done ?? ""];
}
