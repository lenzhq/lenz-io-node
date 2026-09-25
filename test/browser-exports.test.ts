/**
 * The browser entry re-exports the same TYPES as the Node one, the webhook
 * event shapes included (the runtime `LenzWebhooks` stays Node-only).
 * A missing re-export fails `tsc --noEmit`, which runs this file.
 */

import { describe, expect, it } from "vitest";

import type {
  CertificateTimestamped,
  ReviewCompleted,
  ReviewEvent,
  ReviewEventBase,
  ReviewFailed,
} from "../src/index.browser.js";

describe("index.browser type re-exports", () => {
  it("names the review webhook events and CertificateTimestamped", () => {
    const names: Array<
      | CertificateTimestamped["event"]
      | ReviewCompleted["event"]
      | ReviewFailed["event"]
      | ReviewEvent["event"]
      | ReviewEventBase["event"]
    > = ["certificate.timestamped", "review.completed", "review.failed"];
    expect(names).toHaveLength(3);
  });
});
