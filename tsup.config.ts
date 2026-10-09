import { defineConfig, type Options } from "tsup";

const common: Options = {
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  target: "node20",
  // Keep class names as written: esbuild renames a class that refers to
  // itself (`_LenzQuotaExceededError`), and every error's `name` is its
  // class's name.
  keepNames: true,
};

// One build per entry, so each declaration file declares exactly what its
// own JavaScript exports: the browser entry's types never name the webhook
// receiver its bundle leaves out.
export default defineConfig([
  // The main build cleans dist/ first, leaving the browser build's files.
  { ...common, entry: ["src/index.ts"], clean: ["**/*", "!index.browser.*"] },
  { ...common, entry: ["src/index.browser.ts"], clean: false },
]);
