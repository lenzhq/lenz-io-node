/**
 * Since 3.2, a top-level call's result has `httpStatus: number` and
 * `headers: Record<string, string>` (`Result<T>`), so an adapter reads them
 * with no guard; nested objects, a wait's verification and a batch wait's
 * rows keep them optional. Compiled by `type-compat.test.ts`; never run.
 */

import {
  Lenz,
  type Result,
  type ResultMeta,
  type TaskAccepted,
  type Verification,
} from "../../src/index.js";

function meta(m: ResultMeta): [number, Record<string, string>] {
  return [m.httpStatus, m.headers];
}

export async function topLevel(c: Lenz): Promise<void> {
  meta(await c.verify({ claim: "a" }));
  meta(await c.extract({ text: "a" }));
  meta(await c.assess({ claim: "a" }));
  meta(await c.select("t1", { claims: ["a"] }));
  meta(await c.cancel("t1"));
  meta(await c.usage());
  meta(await c.review({ text: "Draft." }));
  meta(await c.getReview("r1"));
  meta(await c.getReview("r1", { view: "issues" }));
  meta(await c.cancelReview("r1"));
  meta(await c.reviewAndWait({ text: "Draft." }));
  meta(await c.citecheck({ text: "Draft." }));
  meta(await c.getCitecheck("c1"));
  meta(await c.cancelCitecheck("c1"));
  meta(await c.citecheckAndWait({ text: "Draft." }));
  meta(await c.verifications.get("abcd1234"));
  meta(await c.verifications.list());
  meta(await c.verifications.getCertificate("abcd1234"));
  meta(await c.verifications.related("abcd1234"));
  meta(await c.library.list());
  meta(await c.ask.history("abcd1234"));
  meta(await c.ask.send("abcd1234", { message: "why?" }));

  // A Result is still the plain type, for code that names it.
  const task: TaskAccepted = await c.verify({ claim: "a" });
  void task;
  const typed: Result<TaskAccepted> = await c.verify({ claim: "a" });
  const status: number = typed.httpStatus;
  const location: string | undefined = typed.headers["location"];
  void status;
  void location;
}

export async function nestedStayOptional(c: Lenz): Promise<void> {
  const out = await c.assess({ claim: "a" });
  // @ts-expect-error -- a row is nested: its httpStatus is optional.
  meta(out.claims[0]!);
  const v: Verification = await c.wait("t1");
  // @ts-expect-error -- a wait's verification is nested in the final poll.
  meta(v);
  const rows = await c.verifyBatchAndWait({ claims: [{ claim: "a" }] });
  void rows;
}
