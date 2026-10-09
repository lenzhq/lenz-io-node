/**
 * Edge entry point for `lenz-io`: Cloudflare Workers, Deno, Vercel Edge and
 * other runtimes without Node built-ins.
 *
 * The same API as the main entry (`./index.ts`). Nothing reachable from here
 * imports a `node:*` module or uses `Buffer`, so it loads where Node's
 * built-ins do not exist; the webhook receiver works there through
 * `await webhooks.unwrap(request)` / `parseAsync`, which verify with WebCrypto.
 * The synchronous `parse` needs Node's `crypto` and says so when it is absent.
 *
 * Resolved through the `workerd`, `worker`, `edge-light` and `deno` export
 * conditions in package.json. `test/edge-load.test.ts` bundles this file for a
 * platform with no built-ins and fails on any `node:` or `Buffer` in the output.
 */

export * from "./index.js";
