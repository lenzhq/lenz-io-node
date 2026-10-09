/**
 * A real workerd run (Miniflare, Node compatibility off): the worker imports
 * the package, receives a signed request and answers with the parsed event.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error plain ESM helper, shared with scripts/edge-check.mjs
import { bundleWorker, signed, withWorker } from "./edge/workerd.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Reply = {
  ok: boolean;
  event?: string;
  taskId?: string;
  narrowed?: boolean;
  hasProcess?: boolean;
  name?: string;
  message?: string;
};

describe("workerd, Node compatibility off", () => {
  it("verifies a signed request and returns the parsed event", async () => {
    const { code: script } = (await bundleWorker({
      resolveDir: ROOT,
      alias: join(ROOT, "src", "index.ts"),
    })) as { code: string };
    expect(script).not.toMatch(/node:/);

    await withWorker(
      script,
      async (fetch: (url: string, init?: RequestInit) => Promise<Response>) => {
        const body = JSON.stringify({
          event: "verification.completed",
          task_id: "t_edge",
          attempt: 1,
          delivered_at: new Date().toISOString(),
          result: { verdict: "True" },
        });
        const ok = await fetch("http://worker.test/", {
          method: "POST",
          headers: { "X-Lenz-Signature": signed(body) },
          body,
        });
        const reply = (await ok.json()) as Reply;
        expect(ok.status).toBe(200);
        expect(reply).toMatchObject({
          ok: true,
          event: "verification.completed",
          taskId: "t_edge",
        });
        expect(reply.hasProcess).toBe(false);

        const forged = await fetch("http://worker.test/", {
          method: "POST",
          headers: { "X-Lenz-Signature": signed(body, "whsec_other") },
          body,
        });
        expect(forged.status).toBe(400);
        expect(await forged.json()).toMatchObject({
          ok: false,
          name: "LenzWebhookSignatureError",
          message: "Webhook signature mismatch",
        });

        const unsigned = await fetch("http://worker.test/", { method: "POST", body });
        expect(((await unsigned.json()) as Reply).message).toBe("Missing webhook signature");

        // The synchronous parse needs Node's crypto: here it says to use unwrap.
        const sync = await fetch("http://worker.test/sync", {
          method: "POST",
          headers: { "X-Lenz-Signature": signed(body) },
          body,
        });
        expect(sync.status).toBe(500);
        expect(((await sync.json()) as Reply).message).toMatch(/unwrap/);
      },
    );
  }, 60_000);
});
