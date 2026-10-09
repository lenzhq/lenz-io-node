/**
 * Check a draft's citations: does each source it cites say what the draft
 * says it does?
 *
 *   export LENZ_API_KEY=lenz_...
 *   npx tsx examples/core/citecheck.ts
 *
 * Credits: 1 per citation checked. A citation that could not be checked is
 * not charged.
 */

import { CitecheckFailedError, CitecheckTimeoutError, Lenz } from "lenz-io";

const draft = `
Water boils at 100 degrees Celsius at sea level
(https://en.wikipedia.org/wiki/Boiling_point). Diamond sensors can measure
temperature inside a living cell (doi:10.1038/nature12373).
`;

async function main(): Promise<void> {
  const client = new Lenz();
  try {
    // A draft: its links and DOIs are read from the text.
    const check = await client.citecheckAndWait({ text: draft, maxCitations: 10 });
    console.log(`Outcome: ${check.outcome}`); // clean | issues_found | incomplete | unchecked
    for (const c of check.citation_issues) {
      console.log(`- ${c.finding}: ${c.cited_url ?? c.doi} for "${c.statement}"`);
    }
    for (const f of check.citation_failures) {
      console.log(`  Not checked: ${f.cited_url ?? f.doi}`);
    }
    if (check.more_citations?.length) {
      console.log(`${check.more_citations.length} more citation(s) found but not checked`);
    }

    // Or the statement-source pairs yourself: each is checked as it is.
    const pairs = await client.citecheckAndWait({
      pairs: [
        {
          statement: "Water boils at 100 degrees Celsius at sea level.",
          url: "https://en.wikipedia.org/wiki/Boiling_point",
        },
        {
          statement: "Diamond sensors can measure temperature in a living cell.",
          doi: "10.1038/nature12373",
          citedYear: "2013",
        },
      ],
    });
    console.log(`Pairs outcome: ${pairs.outcome}`);
  } catch (exc) {
    if (exc instanceof CitecheckTimeoutError) {
      console.log(`Still running; read it later with client.getCitecheck("${exc.citecheckId}")`);
    } else if (exc instanceof CitecheckFailedError) {
      console.log(`Check failed: ${exc.citecheck.failure?.code} (${exc.hint})`);
    } else {
      throw exc;
    }
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
