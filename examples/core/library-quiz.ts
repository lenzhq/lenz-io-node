/**
 * Keyless public-library reads — the pattern behind the open-source
 * FactOrFiction quiz demo (https://play.lenz.io).
 *
 * `library.list` needs no API key, so this runs in Node, the browser, Deno,
 * or edge runtimes. `curated=true` returns the LLM-curated, trivia-worthy
 * subset; `verdict` filters by label; `sort: "random"` shuffles.
 *
 *   npx tsx examples/core/library-quiz.ts
 */
import { Lenz } from "lenz-io";

async function main() {
  // No apiKey — the library reads are public.
  const lenz = new Lenz();

  // A round of true/false quiz claims, curated and shuffled.
  const round = await lenz.library.list({
    curated: true,
    sort: "random",
    verdict: "True,False",
  });

  for (const item of round.items.slice(0, 5)) {
    console.log(`\n${item.claim}`);
    console.log(`  verdict: ${item.verdict}  (lenz_score: ${item.lenz_score ?? "n/a"})`);
    console.log(`  ${item.executive_summary}`);
    // Link to the full verification on lenz.io — library items carry no
    // url/slug, so build it from the verification_id.
    console.log(`  https://lenz.io/c/${item.verification_id}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
