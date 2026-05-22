/**
 * Lenz quickstart — the canonical four-primitive integration.
 *
 *   export LENZ_API_KEY=lenz_...
 *   npx tsx examples/core/quickstart.ts
 *
 * The pattern: `extract` pulls claims out of any text, `assess` returns
 * a fast 3-model verdict on each, `verify` escalates the low-confidence
 * ones to the full 7-model panel with citations, and `ask` lets you
 * follow up on a verification.
 *
 * The demo claim is pre-cached, so the verify call returns in ~1.5s.
 * Your own claims hit the full pipeline (~60-90s) — use webhooks for
 * production async flows.
 */

import { Lenz } from "lenz-io";

async function main(): Promise<void> {
  const client = new Lenz();

  // 1. extract — pull verifiable claims out of any text (free)
  const out = await client.extract({
    text: "Sharks don't get cancer. The Eiffel Tower is 330m tall.",
  });
  const claims = out.identified_claims ?? [];
  console.log(`Extracted ${claims.length} claims:`);
  for (const c of claims) console.log(`  - ${c}`);
  console.log("");

  // 2. assess — fast 3-model verdict on each (~10s, sync)
  const quick = await client.assess({ text: "Sharks don't get cancer" });
  for (const c of quick.claims) {
    console.log(`  ${(c.verdict ?? "").padEnd(12)}  conf=${(c.confidence ?? "").padEnd(7)}  ${c.claim}`);
  }
  console.log("");

  // 3. verify — escalate to the full 7-model panel for citations + audit
  const v = await client.verifyAndWait({ claim: "Sharks don't get cancer" });
  console.log(`Verdict: ${v.verdict} (lenz_score ${v.lenz_score}, confidence ${v.confidence})`);
  console.log(`Summary: ${v.executive_summary}`);
  console.log("");
  console.log("Top sources:");
  for (const source of (v.sources ?? []).slice(0, 3)) {
    console.log(`  - ${source.title}`);
    console.log(`    ${source.url}`);
  }

  // 4. ask — follow-up question on the verification
  if (v.verification_id) {
    const reply = await client.ask.send(v.verification_id, {
      message: "Which source is strongest?",
    });
    console.log("");
    console.log("Q: Which source is strongest?");
    console.log(`A: ${reply.reply}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
