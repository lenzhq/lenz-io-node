/**
 * Runs the package in a real workerd (Cloudflare Workers' runtime) through
 * Miniflare, with Node compatibility OFF: no `process`, no `node:*` modules.
 *
 * The worker is bundled the way Wrangler bundles one: esbuild, the `workerd`,
 * `worker` and `browser` conditions, no Node built-ins. `resolveDir` is the
 * directory whose `node_modules/lenz-io` the worker imports (a packed install,
 * to test the package's exports map), or `alias` points `lenz-io` at a file.
 */

import { createHmac } from "node:crypto";

import { build } from "esbuild";
import { Miniflare } from "miniflare";

export const SECRET = "whsec_edge_check";

const WORKER = `
import { LenzWebhooks, isEvent } from "lenz-io";

export default {
  async fetch(request, env) {
    const hooks = new LenzWebhooks({ secret: env.SECRET });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/sync") {
        hooks.parse(await request.text(), request.headers);
        return Response.json({ ok: true });
      }
      const event = await hooks.unwrap(request);
      return Response.json({
        ok: true,
        event: event.event,
        taskId: event.taskId,
        narrowed: isEvent(event, "verification.completed"),
        hasProcess: typeof process !== "undefined",
      });
    } catch (e) {
      return Response.json(
        { ok: false, name: e.name, message: e.message },
        { status: e.name === "LenzWebhookSignatureError" ? 400 : 500 },
      );
    }
  },
};
`;

/**
 * Bundle the worker: `{ code, inputs }` (the files that went in). The build fails
 * if the bundle needs a Node built-in.
 */
export async function bundleWorker({ resolveDir, alias }) {
  const result = await build({
    stdin: { contents: WORKER, resolveDir, loader: "js", sourcefile: "worker.js" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    alias: alias ? { "lenz-io": alias } : undefined,
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  return { code: result.outputFiles[0].text, inputs: Object.keys(result.metafile.inputs) };
}

export function signed(body, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Start workerd with the bundle; `run(dispatchFetch)` gets a fetch into the worker. */
export async function withWorker(script, run) {
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2025-09-01",
    compatibilityFlags: [],
    bindings: { SECRET },
  });
  try {
    await mf.ready;
    return await run((url, init) => mf.dispatchFetch(url, init));
  } finally {
    await mf.dispose();
  }
}
