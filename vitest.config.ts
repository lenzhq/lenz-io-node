import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest's defaults plus `.claude/` — agent worktrees under that directory
    // are full checkouts of this repo, so a bare `vitest run` there collects a
    // second, stale copy of every spec (335 tests instead of 177) and reports
    // coverage that blends two versions of the SDK. CI never sees it (fresh
    // checkout, `.claude/` is untracked); local runs do, which is worse — it is
    // the local number people read before pushing.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    coverage: {
      provider: "v8",
      // `text` prints the table into the job log so a reviewer can see which
      // lines are uncovered without re-running anything; `lcov` leaves an
      // artifact for editor gutters and any future tooling.
      reporter: ["text", "lcov"],
      include: ["src/**"],
      // Report on every file under `include`, not just the ones a test
      // imported. This is load-bearing: `index.browser.ts` has no test
      // touching it, and without `all` it would vanish from the report
      // entirely rather than showing up as the 0% it is.
      all: true,
      // Floors, not targets. Measured 2026-09-02 at 91.88% statements /
      // 84.75% branches / 98.41% functions; these sit a few points below so
      // the gate answers "did this get worse", never "is this good enough".
      //
      // Branch coverage carries as much weight as lines here. A line counts as
      // covered the moment it executes once, so an `if` whose `else` is never
      // taken still reads green — and a client library is mostly branches:
      // retries, error mapping, optional parameters, pagination.
      //
      // Treat these as a ratchet: when the measured number pulls away, raise
      // them. A floor that can never fire is decoration.
      thresholds: {
        lines: 88,
        statements: 88,
        branches: 80,
        functions: 95,
      },
    },
  },
});
