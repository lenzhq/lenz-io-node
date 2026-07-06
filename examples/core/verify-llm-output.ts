/**
 * Extract claims from an LLM response, assess them, escalate the doubtful ones.
 *
 * The headline integration story: your model emits an answer, Lenz pulls
 * the verifiable claims out of it (`extract`), gives you a fast verdict
 * on each (`assess`), and you escalate only the low-confidence ones to
 * the full 8-model pipeline (`verify`). Cheaper and faster than
 * verifying every claim outright.
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

  // Step 1: assess everything in one sync call (~5-10s for the whole batch).
  // `/assess` runs framing internally, so passing the raw LLM output is
  // equivalent to `extract` -> per-claim `assess` but in one trip.
  const quick = await client.assess({ text: LLM_OUTPUT });
  console.log(`Assessed ${quick.claims.length} claims:\n`);
  for (const c of quick.claims) {
    console.log(
      `  ${(c.verdict ?? "").padEnd(12)}  conf=${(c.confidence ?? "").padEnd(7)}  ${c.claim}`,
    );
  }
  console.log("");

  // Step 2: escalate low-confidence claims to the full pipeline.
  // `assess` and `verify` share a result cache server-side, so a claim
  // that already has a deep verification surfaces immediately via
  // `verification_url` and you can skip the escalation.
  const doubtful = quick.claims.filter((c) => c.confidence === "low");
  console.log(`Escalating ${doubtful.length} low-confidence claims to full verification:\n`);
  for (const c of doubtful) {
    const v = await client.verifyAndWait({ claim: c.claim ?? "", timeoutMs: 120_000 });
    const verdict = (v.verdict ?? "").toUpperCase().padEnd(14);
    console.log(`${verdict} (lenz_score ${v.lenz_score}) ${c.claim}`);
    const verdictLower = (v.verdict ?? "").toLowerCase();
    if ((verdictLower === "false" || verdictLower === "misleading") && v.sources?.[0]) {
      console.log(`  ↳ ${v.sources[0].title}`);
      console.log(`    ${v.sources[0].url}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
