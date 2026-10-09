/**
 * The published build, built here into a scratch directory with the
 * package's own tsup config:
 *
 * - for every export condition in package.json, every value its `.d.ts`
 *   declares exists in the JavaScript that condition resolves to (a browser
 *   consumer is never told about a name its bundle lacks);
 * - every exported error class keeps its name after bundling (`err.name`).
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Target {
  types: string;
  default: string;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
  exports: { ".": Record<string, Target> };
};

let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lenz-dist-"));
  const { build } = await import("tsup");
  // The package's own config (tsup.config.ts), written to the scratch dir.
  await build({ outDir: join(dir, "dist"), silent: true, sourcemap: false });
  cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The value (not type-only) names a declaration file exports. */
function declaredValues(file: string): string[] {
  const program = ts.createProgram([file], {
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file)!;
  const module = checker.getSymbolAtLocation(source)!;
  return checker
    .getExportsOfModule(module)
    .filter((s) => {
      const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
      return (target.flags & ts.SymbolFlags.Value) !== 0;
    })
    .map((s) => s.getName())
    .sort();
}

async function loadJs(file: string, condition: string): Promise<Record<string, unknown>> {
  if (condition === "require")
    return createRequire(import.meta.url)(file) as Record<string, unknown>;
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

describe("the built package", () => {
  for (const [condition, target] of Object.entries(pkg.exports["."])) {
    it(`${condition}: every value its types declare exists in its JavaScript`, async () => {
      const types = join(dir, target.types);
      const js = join(dir, target.default);
      expect(existsSync(types), target.types).toBe(true);
      expect(existsSync(js), target.default).toBe(true);
      const declared = declaredValues(types);
      expect(declared.length).toBeGreaterThan(20);
      const mod = await loadJs(js, condition);
      const missing = declared.filter((name) => !(name in mod));
      expect(missing).toEqual([]);
    }, 60_000);
  }

  it("the browser condition declares no webhook receiver", () => {
    const browser = pkg.exports["."]["browser"]!;
    const declared = declaredValues(join(dir, browser.types));
    expect(declared).not.toContain("LenzWebhooks");
    expect(declared).not.toContain("verifySignatureAsync");
  }, 60_000);

  for (const entry of ["index.js", "index.cjs", "index.browser.js"]) {
    it(`${entry}: every exported error class keeps its name`, async () => {
      const file = join(dir, "dist", entry);
      const mod = await loadJs(file, entry.endsWith(".cjs") ? "require" : "import");
      const errors = Object.keys(mod).filter(
        (k) => typeof mod[k] === "function" && /^[A-Z].*Error$/.test(k),
      );
      expect(errors.length).toBeGreaterThan(15);
      for (const name of errors) {
        const Ctor = mod[name] as { name: string };
        expect(Ctor.name, name).toBe(name);
      }
      const Quota = mod["LenzQuotaExceededError"] as new (ctx: object) => Error;
      expect(new Quota({ message: "x" }).name).toBe("LenzQuotaExceededError");
      const Abort = mod["LenzAbortError"] as new () => Error;
      expect(new Abort().name).toBe("AbortError");
    });
  }
});
