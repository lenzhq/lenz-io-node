/**
 * Async submit + poll — get a verification result without webhooks.
 *
 *   export LENZ_API_KEY=lenz_...
 *   npx tsx examples/core/async-poll.ts
 *
 * `verify()` returns immediately with a task_id; the pipeline runs async
 * (~60-90s for a cold claim). `wait()` blocks on that task until it lands —
 * the polling counterpart to a webhook. Use this in scripts and
 * request/response handlers where awaiting is fine; use webhooks for
 * production async flows.
 *
 * For full control you can drive the loop yourself with
 * `client.getStatus(taskId)` (a single non-blocking poll) — `wait()` just
 * does that loop for you with sensible backoff.
 */

import { Lenz } from "lenz-io";

async function main(): Promise<void> {
  const client = new Lenz();

  // 1. Submit — returns a task_id immediately, pipeline runs async.
  const task = await client.verify({ claim: "Sharks don't get cancer" });
  console.log(`Submitted: ${task.task_id}`);

  // 2. Block on the task until it terminates. Accepts the TaskAccepted
  //    object directly, or you could pass task.task_id.
  const verification = await client.wait(task, { timeoutMs: 180_000 });

  console.log(`Verdict: ${verification.verdict} (lenz_score ${verification.lenz_score})`);
  console.log(`Summary: ${verification.executive_summary}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
