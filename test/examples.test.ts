/**
 * The examples never send a claim they do not have: a row without `claim`
 * (a failed or claimless assess row) is filtered out before `verify*`, as
 * the README does, rather than sent as `claim: ""`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "core");

it.each(readdirSync(DIR).filter((f) => f.endsWith(".ts")))(
  "%s never sends an empty claim",
  (file) => {
    const text = readFileSync(join(DIR, file), "utf-8");
    expect(text).not.toMatch(/claim:\s*[\w.]+\.claim\s*\?\?\s*""/);
  },
);
