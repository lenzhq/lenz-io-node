/**
 * Extract claims from an LLM response, assess them in one call, escalate the
 * doubtful ones.
 *
 * The headline integration story: your model emits an answer, Lenz pulls
 * the verifiable claims out of it (`extract`), gives you a fast verdict on
 * every one of them in a single trip (`assess({ claims })` — up to 20 per
 * call, one row per claim, same order), and you escalate only the
 * low-confidence rows to the full multi-model pipeline (`verifyBatchAndWait`).
 * Cheaper and faster than verifying every claim outright.
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

  // Step 1: extract — pull the verifiable claims out of the answer (free).
  const out = await client.extract({ text: LLM_OUTPUT });
  const claims = out.identified_claims?.length ? out.identified_claims : [out.claim ?? ""];
  console.log(`Extracted ${claims.length} claims.\n`);

  // Step 2: assess — ONE sync call over all of them (~10-25s for the list).
  // Exactly one row comes back per claim, in the order sent. A row with
  // verdict "Error" had no verdict: error_code says why and hint says what
  // to send next; a compound item is assessed on its main claim and lists
  // the rest in identified_claims. Error rows are free.
  const quick = (await client.assess({ claims })).claims;
  console.log(`Assessed ${quick.length} claims:\n`);
  for (const c of quick) {
    console.log(
      `  ${(c.verdict ?? "").padEnd(12)}  conf=${(c.confidence ?? "").padEnd(7)}  ${c.claim}`,
    );
    if (c.verdict === "Error") console.log(`      ${c.error_code}: ${c.hint}`);
    else if (c.identified_claims?.length) console.log(`      also found: ${c.identified_claims}`);
  }
  console.log("");

  // Step 3: verify — escalate the low-confidence rows to the full pipeline,
  // all in parallel. `assess` and `verify` share a result cache server-side,
  // so a claim that already has a deep verification surfaces immediately via
  // `verification_url` and you can skip the escalation.
  const doubtful = quick
    .filter((c) => c.verdict !== "Error" && c.confidence === "low")
    .map((c) => ({ claim: c.claim ?? "" }));
  console.log(`Escalating ${doubtful.length} low-confidence claims to full verification:\n`);
  const results = doubtful.length
    ? await client.verifyBatchAndWait({ claims: doubtful, timeoutMs: 180_000 })
    : [];
  for (const r of results) {
    if (r.status !== "completed") {
      console.log(`${r.status.toUpperCase().padEnd(14)} ${r.claim_text}`); // needs_input | failed | timeout
      continue;
    }
    const v = r.verification!;
    const verdict = (v.verdict ?? "").toUpperCase().padEnd(14);
    console.log(`${verdict} (lenz_score ${v.lenz_score}) ${v.claim}`);
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
