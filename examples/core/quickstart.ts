/**
 * Lenz quickstart — verify a single claim and print the verdict.
 *
 *   export LENZ_API_KEY=lenz_...
 *   npx tsx examples/core/quickstart.ts
 *
 * Expected output:
 *   Verdict: false (score 2, confidence 0.92)
 *   Top sources:
 *    - National Cancer Institute …
 *    - …
 *
 * This example uses a pre-cached claim, so the call returns in ~1.5s.
 * Verify your own text and the full pipeline runs (~60-90s).
 */

import { Lenz } from "lenz-io";

async function main(): Promise<void> {
  const client = new Lenz();

  const v = await client.verifyAndWait({ claim: "Sharks don't get cancer" });

  console.log(`Verdict: ${v.verdict?.label} (score ${v.verdict?.score}, confidence ${v.verdict?.confidence})`);
  console.log("");
  console.log(`Claim: ${v.claim}`);
  console.log(`Summary: ${v.executive_summary}`);
  console.log("");
  console.log("Top sources:");
  for (const source of (v.sources ?? []).slice(0, 3)) {
    console.log(`  - ${source.title}`);
    console.log(`    ${source.url}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
