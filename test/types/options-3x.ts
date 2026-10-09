/**
 * Every request-options form of 3.0 compiles, and the `getReview` overloads
 * still pick the right result (`type-compat.test.ts`). Never run.
 */

import {
  Lenz,
  LenzAbortError,
  type GetStatusOptions,
  type RequestOptions,
  type ReviewFull,
  type ReviewIssues,
  type VerifyAndWaitOptions,
} from "../../src/index.js";

export async function everyForm(client: Lenz): Promise<void> {
  const signal = AbortSignal.timeout(20_000);
  const o: RequestOptions = { signal, timeoutMs: 5_000, maxRetries: 1, headers: { "X-A": "1" } };
  const removes: RequestOptions = { headers: { "X-A": null, "X-B": undefined } };

  await client.verify({ claim: "a" }, o);
  await client.verifyBatch({ claims: [{ claim: "a" }] }, o);
  await client.extract({ text: "a" }, o);
  await client.assess({ claim: "a" }, { signal });
  await client.select("t", { claims: ["a"] }, o);
  const status: GetStatusOptions = { ...o, deadlineAt: Date.now() + 1_000 };
  await client.getStatus("t", status);
  await client.cancel("t", o);
  await client.usage(removes);
  await client.review({ text: "a" }, o);
  await client.citecheck({ text: "a" }, o);
  await client.getCitecheck("c", o);
  await client.cancelReview("r", o);
  await client.cancelCitecheck("c", o);

  // getReview: the overloads, with the request options merged in.
  const issues: ReviewIssues = await client.getReview("r", { view: "issues", signal });
  const full: ReviewFull = await client.getReview("r", { signal });
  const fullToo: ReviewFull = await client.getReview("r", { view: "full", ...o });
  const plain: ReviewFull = await client.getReview("r");
  const either: ReviewFull | ReviewIssues = await client.getReview("r", {
    view: Math.random() > 0.5 ? "issues" : "full",
    signal,
  });
  void [issues, full, fullToo, plain, either];

  // Waits: the request fields join the wait options; timeoutMs stays the budget.
  const waitOpts: VerifyAndWaitOptions = { timeoutMs: 60_000, signal, headers: {}, maxRetries: 0 };
  await client.verifyAndWait({ claim: "a" }, waitOpts);
  await client.verifyBatchAndWait({ claims: [{ claim: "a" }] }, waitOpts);
  await client.wait("t", { timeoutMs: 60_000, signal, headers: { "X-A": "1" } });
  await client.reviewAndWait({ text: "a" }, { signal, maxRetries: 2, onUpdate: () => {} });
  await client.citecheckAndWait({ text: "a" }, { signal, headers: { "X-A": "1" } });

  // Namespaces.
  await client.verifications.list({ page: 2, ...o });
  for await (const v of client.verifications.listAll({ page: 1, signal })) void v;
  await client.verifications.get("v", o);
  await client.verifications.getCertificate("v", o);
  await client.verifications.delete("v", o);
  await client.verifications.related("v", { limit: 3, ...o });
  await client.ask.history("v", o);
  await client.ask.send("v", { message: "m" }, o);
  await client.ask.reset("v", o);
  await client.library.list({ search: "s" }, o);
  for await (const item of client.library.listAll({}, { signal })) void item;

  // withOptions keeps the type it was called on.
  class Mine extends Lenz {}
  const mine: Mine = new Mine().withOptions({ signal });
  const copy: Lenz = client.withOptions(o).withOptions({ headers: { "X-A": null } });
  void [mine, copy];

  try {
    await client.verifyAndWait({ claim: "a" }, { signal });
  } catch (e) {
    if (e instanceof LenzAbortError) {
      const known: Array<string | undefined> = [
        e.idempotencyKey,
        e.taskId,
        e.batchId,
        e.reviewId,
        e.citecheckId,
      ];
      const ids: string[] | undefined = e.taskIds;
      const name: string = e.name;
      void [known, ids, name, e.cause];
      if (e.taskId) await client.cancel(e.taskId);
    }
  }
}

// @ts-expect-error wait() takes no maxRetries (the polls keep the client's).
export const noRetriesOnWait = (c: Lenz) => c.wait("t", { maxRetries: 1 });
