/**
 * `TaskStatus.candidates` and `TaskStatus.similar_claims` are deprecated,
 * not removed: consumer code that reads them must keep compiling until the
 * planned removal. `npm run type` covers this file (tsconfig includes test/),
 * so dropping either field fails the typecheck, not just this test.
 */

import { describe, expect, it } from "vitest";

import type { SimilarVerification, TaskStatus } from "../src/index.js";

describe("deprecated TaskStatus fields", () => {
  it("still type-check and read as empty when the server omits them", () => {
    const status: TaskStatus = { status: "needs_input", reason: "multi_claim", claims: [] };
    const candidates: string[] = status.candidates ?? [];
    const similar: SimilarVerification[] = status.similar_claims ?? [];
    expect(candidates).toEqual([]);
    expect(similar).toEqual([]);
  });

  it("still accept the keys from an older server", () => {
    const status: TaskStatus = {
      status: "needs_input",
      reason: "multi_claim",
      claims: [],
      candidates: [],
      similar_claims: [],
    };
    expect(status.candidates).toEqual([]);
    expect(status.similar_claims).toEqual([]);
  });
});
