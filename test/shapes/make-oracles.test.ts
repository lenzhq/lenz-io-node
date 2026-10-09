/**
 * Writes `fixtures/shapes/oracle/`: what a given build of the SDK hands a
 * caller for each `legacy/` recording (`scenarios.ts`). Run against the
 * PREVIOUS release, once, when recordings are added:
 *
 *   npm pack lenz-io@<previous> && tar xzf lenz-io-<previous>.tgz
 *   LENZ_ORACLE_SDK=$PWD/package/dist/index.js npx vitest run test/shapes/make-oracles.test.ts
 *
 * Writes only missing oracles unless `LENZ_ORACLE_OVERWRITE=1`. Skipped when
 * `LENZ_ORACLE_SDK` is unset (every normal run).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { it } from "vitest";

import { hasScenario, runScenario, type Recorded, type SdkUnderTest } from "./scenarios.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "shapes");
const SDK = process.env["LENZ_ORACLE_SDK"];

it.skipIf(!SDK)(
  "writes the oracle of every legacy recording",
  async () => {
    const sdk = (await import(pathToFileURL(SDK!).href)) as unknown as SdkUnderTest;
    const overwrite = process.env["LENZ_ORACLE_OVERWRITE"] === "1";
    for (const dir of ["legacy", "older"]) {
      for (const file of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".json"))) {
        const name = file.slice(0, -5);
        if (!hasScenario(name)) continue;
        const out = join(ROOT, "oracle", file);
        if (existsSync(out) && !overwrite) continue;
        const recorded = JSON.parse(readFileSync(join(ROOT, dir, file), "utf-8")) as Recorded;
        const snap = await runScenario(sdk, name, recorded);
        writeFileSync(out, JSON.stringify(snap, null, 2) + "\n");
      }
    }
  },
  120_000,
);
