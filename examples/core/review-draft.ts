/**
 * Review a draft in one call: Lenz reads its claims, gives each a quick
 * verdict, deep-checks the doubtful ones and returns the issues, with
 * suggested rewrites.
 *
 *   export LENZ_API_KEY=lenz_...
 *   npx tsx examples/core/review-draft.ts
 *
 * Takes 2-4 minutes. Credits: 1 per claim assessed, plus 10 per deep check
 * (5 at depth "low"); `review.credits.charged` says what it cost.
 */

import { Lenz, ReviewFailedError, ReviewTimeoutError } from "lenz-io";

const draft = `
The EU AI Act entered into force on 1 August 2024, and its obligations for
general-purpose models applied from 2 August 2025. Fines for prohibited
practices reach 7% of global annual turnover.
`;

async function main(): Promise<void> {
  const client = new Lenz();
  try {
    const review = await client.reviewAndWait(
      { text: draft, suggestEdits: true },
      {
        // The quick verdicts land before the deep checks: show them as they come.
        onUpdate: (r) => console.log(`... ${r.status}: ${r.claims.length} claim(s) read`),
      },
    );
    console.log(`Outcome: ${review.outcome}`); // clean | issues_found | incomplete | unchecked
    for (const issue of review.issues) {
      console.log(`- ${issue.verdict} (${issue.confidence}): ${issue.claim}`);
      if (issue.suggested_rewrite) console.log(`  Suggested rewrite: ${issue.suggested_rewrite}`);
    }
    for (const row of review.claims) {
      if (row.assessment?.status === "failed") {
        console.log(`  Not checked: ${row.claim} (${row.assessment.failure?.code})`);
      }
    }
    console.log(`Credits charged: ${review.credits.charged}`);
  } catch (exc) {
    if (exc instanceof ReviewTimeoutError) {
      // Still running on the server: read it later, never resubmit it.
      console.log(`Still running; read it later with client.getReview("${exc.reviewId}")`);
    } else if (exc instanceof ReviewFailedError) {
      console.log(`Review failed: ${exc.review.failure?.code} (${exc.hint})`);
    } else {
      throw exc;
    }
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
