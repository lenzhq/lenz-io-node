/**
 * Lenz quickstart — the canonical four-primitive integration.
 *
 *   export LENZ_API_KEY=lenz_...
 *   npx tsx examples/core/quickstart.ts
 *
 * The pattern: `extract` pulls claims out of any text, ONE `assess` call
 * returns a fast 3-model verdict on each of them (up to 20 per call, one
 * row per claim), `verify` escalates the low-confidence rows to the full
 * 8-model panel with citations, and `ask` lets you follow up on a
 * verification.
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
  const claims = out.identified_claims?.length ? out.identified_claims : [out.claim ?? ""];
  console.log(`Extracted ${claims.length} claims:`);
  for (const c of claims) console.log(`  - ${c}`);
  console.log("");

  // 2. assess — ONE call over the extracted claims (up to 20), one row per
  //    claim in the same order (~10-25s, sync). A row with verdict "Error"
  //    has error_code + hint; a compound item lists the rest of its claims
  //    in identified_claims.
  const quick = (await client.assess({ claims })).claims;
  for (const c of quick) {
    console.log(
      `  ${(c.verdict ?? "").padEnd(12)}  conf=${(c.confidence ?? "").padEnd(7)}  ${c.claim}`,
    );
    if (c.hint) console.log(`      hint: ${c.hint}`);
  }
  console.log("");

  // 3. verify — escalate the low-confidence rows to the full 8-model panel
  //    for citations + audit. The demo claim is pre-cached, so it stands in
  //    when nothing came back low-confidence and the demo stays fast.
  const doubtful = quick
    .filter((c) => c.verdict !== "Error" && c.confidence === "low")
    .map((c) => ({ claim: c.claim ?? "" }));
  const results = await client.verifyBatchAndWait({
    claims: doubtful.length ? doubtful : [{ claim: "Sharks don't get cancer" }],
  });
  let deepId: string | null = null;
  for (const r of results) {
    if (r.status !== "completed") {
      console.log(`${r.claim_text} → ${r.status}`); // needs_input | failed | timeout
      continue;
    }
    const v = r.verification!;
    deepId ??= v.verification_id ?? null;
    console.log(`Verdict: ${v.verdict} (lenz_score ${v.lenz_score}, confidence ${v.confidence})`);
    console.log(`Summary: ${v.executive_summary}`);
    console.log("");
    console.log("Top sources:");
    for (const source of (v.sources ?? []).slice(0, 3)) {
      console.log(`  - ${source.title}`);
      console.log(`    ${source.url}`);
    }
  }

  // 4. ask — follow-up question on a verification
  if (deepId) {
    const reply = await client.ask.send(deepId, {
      message: "Which source is strongest?",
    });
    console.log("");
    console.log("Q: Which source is strongest?");
    console.log(`A: ${reply.content}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
