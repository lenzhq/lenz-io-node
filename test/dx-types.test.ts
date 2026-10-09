/**
 * 3.0 typed values (B6): the verdict and confidence fields typed plain
 * `string` in 2.x name their known values (completion in an editor) and
 * still accept any string, so 2.x code compiles unchanged. Checked by
 * `tsc --noEmit` (`expectTypeOf`) and at run time where it can be.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AssessClaim,
  Confidence,
  ConfidenceBand,
  Depth,
  LenzLogger,
  LenzOptions,
  SimilarVerification,
  Verdict,
  VerdictLabel,
  Verification,
  VerificationListItem,
} from "../src/index.js";
import type * as Browser from "../src/index.browser.js";

type Open = string & NonNullable<unknown>;

describe("B6: verdict and confidence name their values", () => {
  it("Verdict, Confidence and Depth are the closed sets", () => {
    expectTypeOf<Verdict>().toEqualTypeOf<VerdictLabel | "Error">();
    expectTypeOf<Confidence>().toEqualTypeOf<ConfidenceBand>();
    expectTypeOf<Depth>().toEqualTypeOf<"standard" | "low">();
    const all: Verdict[] = ["True", "Mostly True", "Mixed", "Mostly False", "False", "Error"];
    expect(all).toHaveLength(6);
  });

  it("the plain-string fields are the closed set plus any string", () => {
    expectTypeOf<Verification["verdict"]>().toEqualTypeOf<Verdict | Open | undefined>();
    expectTypeOf<Verification["confidence"]>().toEqualTypeOf<Confidence | Open | undefined>();
    expectTypeOf<AssessClaim["verdict"]>().toEqualTypeOf<Verdict | Open | undefined>();
    expectTypeOf<AssessClaim["confidence"]>().toEqualTypeOf<Confidence | Open | undefined>();
    expectTypeOf<VerificationListItem["verdict"]>().toEqualTypeOf<Verdict | Open | undefined>();
    expectTypeOf<SimilarVerification["confidence"]>().toEqualTypeOf<
      Confidence | Open | undefined
    >();
  });

  it("2.x code that treats them as strings still compiles", () => {
    const row: AssessClaim = { verdict: "Something new", confidence: "very high" };
    const s: string | undefined = row.verdict;
    expect(s?.toUpperCase()).toBe("SOMETHING NEW");
  });

  it("the browser entry names the same types, and LenzLogger", () => {
    expectTypeOf<Browser.Verdict>().toEqualTypeOf<Verdict>();
    expectTypeOf<Browser.Confidence>().toEqualTypeOf<Confidence>();
    expectTypeOf<Browser.Depth>().toEqualTypeOf<Depth>();
    expectTypeOf<Browser.LenzLogger>().toEqualTypeOf<LenzLogger>();
    expectTypeOf<LenzOptions["logger"]>().toEqualTypeOf<LenzLogger | undefined>();
    const logger: LenzLogger = console;
    expect(typeof logger.info).toBe("function");
  });
});
