/**
 * Multi-language output — answer in the language of the text.
 *
 *   export LENZ_API_KEY=lenz_...
 *   npx tsx examples/core/verify-auto.ts
 *
 * Pass `language: "auto"` on `assess`, `verify`, `verifyAndWait` or
 * `ask.send` and the answer comes back in the language of the submitted
 * text (for `ask.send`, the language of the claim being discussed). A
 * concrete code such as "es" always wins; omit `language` for English.
 * `extract`, `verifyBatch`, `citecheck` and `review` do not accept "auto".
 */

import { Lenz } from "lenz-io";

async function main(): Promise<void> {
  const client = new Lenz();

  const v = await client.verifyAndWait({
    claim: "Die Erde ist flach",
    language: "auto",
  });

  console.log(`verdict: ${v.verdict}`); // 'False' (English enum)
  console.log(`language: ${v.language}`); // 'de'
  console.log(`executive_summary: ${v.executive_summary}`); // German prose
}

void main();
