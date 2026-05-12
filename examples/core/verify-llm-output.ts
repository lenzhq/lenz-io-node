/**
 * Extract claims from an LLM response and verify the ones that matter.
 *
 * The headline integration story: your model emits an answer, Lenz pulls
 * the verifiable claims out of it, then you verify the ones you care
 * about and surface, suppress, or flag the output.
 *
 *   export LENZ_API_KEY=lenz_...
 *   npx tsx examples/core/verify-llm-output.ts
 */

import { Lenz } from "lenz-io";

const LLM_OUTPUT = `
The Eiffel Tower was completed in 1889 and stands 330 meters tall.
It was originally intended to be a temporary structure for the World's Fair.
Today it receives roughly 7 million visitors per year.
`;

async function main(): Promise<void> {
  const client = new Lenz();

  // Step 1: extract the verifiable claims (free; ~3s)
  const extracted = await client.extract({ text: LLM_OUTPUT });
  const claims = extracted.identified_claims ?? [];
  console.log(`Extracted ${claims.length} claims:`);
  for (const c of claims) console.log(`  - ${c}`);
  console.log("");

  // Step 2: verify each one. In production, fan-out with verifyBatch.
  for (const claimText of claims) {
    const v = await client.verifyAndWait({ claim: claimText, timeoutMs: 120_000 });
    const label = (v.verdict?.label ?? "").toUpperCase().padEnd(14);
    console.log(`${label}  ${claimText}`);
    if ((v.verdict?.label === "false" || v.verdict?.label === "mostly_false") && v.sources?.[0]) {
      console.log(`  ↳ ${v.sources[0].title}`);
      console.log(`    ${v.sources[0].url}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
