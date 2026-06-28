/**
 * Multi-language output — Spanish verification.
 *
 *   export LENZ_API_KEY=lenz_...
 *   npx tsx examples/core/verify-spanish.ts
 *
 * The same API and same SDK; pass `language: "es"` (or any of the 12
 * supported codes: en, es, de, fr, it, pt, nl, sv, da, no, fi, bg) and
 * the response's free-form prose comes back in that language. Verdict
 * labels (True / Mostly True / Mixed / Mostly False / False) stay English so SDK
 * consumers can branch on them deterministically.
 */

import { Lenz } from "lenz-io";

async function main(): Promise<void> {
  const client = new Lenz();

  const v = await client.verifyAndWait({
    claim: "La Tierra es plana",
    language: "es",
  });

  console.log(`verdict: ${v.verdict}`); // 'False' (English enum)
  console.log(`language: ${v.language}`); // 'es'
  console.log(`claim: ${v.claim}`); // 'La Tierra es plana'
  console.log(`executive_summary: ${v.executive_summary}`); // Spanish prose
}

void main();
