/**
 * The recorded API responses (`test/fixtures/shapes/canonical/`) and the
 * method that reads each one's endpoint, shared by the tests that read them.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Lenz } from "../../src/index.js";

export const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "shapes",
  "canonical",
);

export interface Recorded {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** One call per recording: the type its result has, and how to make it. */
export type Call = [type: string, run: (c: Lenz) => Promise<unknown>];

/** The calls whose endpoint answered `name` (a 2xx recording). */
export function callsFor(name: string, body: Record<string, unknown>): Call[] | "skip" | undefined {
  if (name.startsWith("account__oauth_") || name === "account__api_root") return "skip";
  if (name.startsWith("account__webhook_secret_")) return "skip"; // no SDK method reads it
  if (name === "verify__delete_200" || name === "account__ask_reset") return "skip"; // boolean
  if (name.startsWith("assess__")) return [["AssessResponse", (c) => c.assess({ claim: "x" })]];
  if (name.startsWith("extract__")) {
    return [["ExtractedClaims", (c) => c.extract({ text: "x", locate: name.includes("locate") })]];
  }
  if (name.startsWith("verify__batch_")) {
    return [["BatchAccepted", (c) => c.verifyBatch({ claims: [{ claim: "a" }, { claim: "b" }] })]];
  }
  if (name === "verify__select_202") {
    return [["BatchAccepted", (c) => c.select("t", { claims: ["a"] })]];
  }
  if (name.startsWith("verify__cancel_200")) return [["CancelResult", (c) => c.cancel("t")]];
  if (
    name.startsWith("verify__submit_202") ||
    name === "verify__stored_replay_202" ||
    name === "verify__idempotency_key_replay" ||
    name.startsWith("verify__implicit_")
  ) {
    return [["TaskAccepted", (c) => c.verify({ claim: "a" })]];
  }
  if (
    name.startsWith("verify__status_") ||
    name.startsWith("verify__stored_progress_") ||
    /__poll(_|$)/.test(name)
  ) {
    const calls: Call[] = [["TaskStatus", (c) => c.getStatus("t")]];
    if (body["status"] === "completed") {
      calls.push(["Verification", (c) => c.wait("t", { timeoutMs: 50 })]);
    }
    return calls;
  }
  if (name.startsWith("verify__verification_")) {
    return [["Verification", (c) => c.verifications.get("v")]];
  }
  if (name.startsWith("verify__list_")) {
    return [["VerificationList", (c) => c.verifications.list()]];
  }
  if (name.startsWith("account__me_usage_") || name.startsWith("account__api_version_header_")) {
    return [["Usage", (c) => c.usage()]];
  }
  if (name.startsWith("account__library_")) return [["LibraryList", (c) => c.library.list()]];
  if (name.startsWith("account__ask_history_")) {
    return [["AskHistory", (c) => c.ask.history("v")]];
  }
  if (name.startsWith("account__ask_send")) {
    return [["AskReply", (c) => c.ask.send("v", { message: "x" })]];
  }
  if (
    name.startsWith("review__receipt_") ||
    name === "review__idempotent_replay_202" ||
    name === "review__stored_replay_202"
  ) {
    return [["ReviewStarted", (c) => c.review({ text: "x" })]];
  }
  if (name.startsWith("review__cancel_200")) {
    return [["ReviewFull", (c) => c.cancelReview(String(body["review_id"]))]];
  }
  if (name.startsWith("review__get_")) {
    return body["view"] === "issues"
      ? [["ReviewIssues", (c) => c.getReview("r", { view: "issues" })]]
      : [["ReviewFull", (c) => c.getReview("r")]];
  }
  if (name.startsWith("citecheck__receipt_") || name === "citecheck__idempotent_replay_202") {
    return [["CitecheckStarted", (c) => c.citecheck({ text: "x" })]];
  }
  if (name.startsWith("citecheck__cancel_200")) {
    return [["Citecheck", (c) => c.cancelCitecheck(String(body["citecheck_id"]))]];
  }
  if (name.startsWith("citecheck__get_")) return [["Citecheck", (c) => c.getCitecheck("c")]];
  return undefined;
}

export function fetchFor(r: Recorded): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    })) as unknown as typeof fetch;
}
