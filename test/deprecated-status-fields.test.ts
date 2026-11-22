/**
 * `TaskStatus.candidates` is deprecated, not removed: consumer code that reads
 * it must keep compiling. `npm run type` covers this file (tsconfig includes test/),
 * so dropping the field fails the typecheck, not just this test.
 */

import { describe, expect, it } from "vitest";

import type { TaskStatus } from "../src/index.js";

describe("deprecated TaskStatus fields", () => {
  it("still type-check and read as empty when the server omits them", () => {
    const status: TaskStatus = { status: "needs_input", reason: "multi_claim", claims: [] };
    const candidates: string[] = status.candidates ?? [];
    expect(candidates).toEqual([]);
  });

  it("still accept the keys from an older server", () => {
    const status: TaskStatus = {
      status: "needs_input",
      reason: "multi_claim",
      claims: [],
      candidates: [],
    };
    expect(status.candidates).toEqual([]);
  });
});
