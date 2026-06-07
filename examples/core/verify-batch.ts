/**
 * Verify several claims in parallel and wait for all of them.
 *
 *   export LENZ_API_KEY=lenz_...
 *   npx tsx examples/core/verify-batch.ts
 *
 * `verifyBatchAndWait` fans out up to 20 claims in one call, polls every one
 * to completion, and returns a `BatchItemResult` per claim — in input order.
 * It never throws because one claim failed: inspect each item's `status`
 * ("completed" | "needs_input" | "failed" | "timeout").
 */

import { Lenz } from "lenz-io";

async function main(): Promise<void> {
  const client = new Lenz();

  const results = await client.verifyBatchAndWait({
    claims: [
      { text: "Sharks don't get cancer" },
      { text: "The Eiffel Tower is 330m tall" },
      { text: "Humans only use 10% of their brains" },
    ],
    timeoutMs: 180_000,
  });

  for (const r of results) {
    if (r.status === "completed" && r.verification) {
      console.log(
        `[completed] ${r.claim_text} → ${r.verification.verdict} (${r.verification.lenz_score})`,
      );
    } else if (r.status === "failed") {
      const d = r.status_detail;
      const reason = (d?.error || d?.failure_detail) ?? "unknown";
      console.log(`[failed]    ${r.claim_text} → ${reason}`);
    } else {
      // needs_input (resolve with client.select) or timeout (poll later)
      console.log(`[${r.status}] ${r.claim_text}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
