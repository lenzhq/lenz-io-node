import { defineConfig } from "tsup";

export default defineConfig({
  // cli.ts is the `npx lenz-io init` binary (package.json#bin). ESM-only
  // via the shebang in the source; it is never imported as a library.
  entry: ["src/index.ts", "src/index.browser.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node18",
});
