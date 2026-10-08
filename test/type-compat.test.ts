/**
 * The previous release's types still fit (`types/compat.ts`), compiled on
 * its own with `tsc --strict`, as a user's project would compile it.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

it("code written against 2.20.0's types compiles under tsc --strict", () => {
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const args = [
    tsc,
    "--strict",
    "--noEmit",
    "--skipLibCheck",
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--types",
    "node",
    join(ROOT, "test", "types", "compat.ts"),
  ];
  let output = "";
  try {
    execFileSync(process.execPath, args, { cwd: ROOT, encoding: "utf-8", stdio: "pipe" });
  } catch (exc) {
    output = String((exc as { stdout?: string }).stdout ?? exc);
  }
  expect(output).toBe("");
}, 60_000);
