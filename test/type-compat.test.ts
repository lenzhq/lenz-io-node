/**
 * The previous release's types still fit (`types/compat.ts`), code written
 * against it compiles unchanged (`types/user-code-2x.ts`, and its subclass
 * and instance overrides, `types/overrides-2x.ts`), and every 3.0
 * request-options form compiles (`types/options-3x.ts`), each compiled on
 * its own with `tsc --strict`, as a user's project would; and `Result<T>` on
 * top-level results (`types/result-meta-3x.ts`) and a 3.2 override of a
 * method that returns one (`types/overrides-3x.ts`).
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

it.each([
  "compat.ts",
  "user-code-2x.ts",
  "overrides-2x.ts",
  "options-3x.ts",
  "result-meta-3x.ts",
  "overrides-3x.ts",
])(
  "%s compiles under tsc --strict",
  (file) => {
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
      join(ROOT, "test", "types", file),
    ];
    let output = "";
    try {
      execFileSync(process.execPath, args, { cwd: ROOT, encoding: "utf-8", stdio: "pipe" });
    } catch (exc) {
      output = String((exc as { stdout?: string }).stdout ?? exc);
    }
    expect(output).toBe("");
  },
  60_000,
);
