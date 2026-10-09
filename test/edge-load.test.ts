/**
 * The package loads where Node's built-ins do not exist.
 *
 * Bundles `src/index.ts` for a browser-like platform, where esbuild
 * refuses any `node:*` import, then checks the output for a built-in's name
 * or a `Buffer` reference, runs it with `process` and `require` absent, and
 * resolves it through the package's export conditions the way each edge
 * runtime does.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function bundleEdge(): Promise<string> {
  const result = await build({
    entryPoints: [join(ROOT, "src", "index.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "Lenz",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

describe("the main entry as an edge runtime loads it", () => {
  it("bundles for a platform with no Node built-ins", async () => {
    await expect(bundleEdge()).resolves.toBeTypeOf("string");
  });

  it("names no node: specifier and no Buffer", async () => {
    const text = await bundleEdge();
    expect(text).not.toMatch(/node:/);
    expect(text).not.toMatch(/\bBuffer\b/);
    expect(text).not.toMatch(/\brequire\(/);
  });

  it("exports LenzWebhooks, Lenz and isEvent", async () => {
    const text = await bundleEdge();
    const g: Record<string, unknown> = {
      crypto: globalThis.crypto,
      TextEncoder,
      TextDecoder,
      Request,
      Response,
      Headers,
      URL,
      URLSearchParams,
      AbortController,
      setTimeout,
      clearTimeout,
      console,
    };
    const ctx = vm.createContext(g);
    vm.runInContext(text, ctx);
    const lib = (ctx as { Lenz: Record<string, unknown> }).Lenz;
    expect(typeof lib["LenzWebhooks"]).toBe("function");
    expect(typeof lib["Lenz"]).toBe("function");
    expect(typeof lib["isEvent"]).toBe("function");
    expect(typeof lib["verifySignature"]).toBe("function");
  });

  it("with no process, parse says to use unwrap and unwrap works", async () => {
    const text = await bundleEdge();
    const ctx = vm.createContext({
      crypto: globalThis.crypto,
      TextEncoder,
      TextDecoder,
      Request,
      Response,
      Headers,
      URL,
      URLSearchParams,
      AbortController,
      setTimeout,
      clearTimeout,
      console,
    });
    vm.runInContext(text, ctx);
    const out = vm.runInContext(
      `(async () => {
        const hooks = new Lenz.LenzWebhooks({ secret: "s" });
        const body = JSON.stringify({ event: "x.y", task_id: "t1" });
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s"),
          { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
        const sig = "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
        let parseError = "";
        try { hooks.parse(body, { "X-Lenz-Signature": sig }); } catch (e) { parseError = String(e.message); }
        const event = await hooks.unwrap(new Request("https://x.test/", {
          method: "POST", headers: { "X-Lenz-Signature": sig }, body }));
        return JSON.stringify({ parseError, taskId: event.taskId });
      })()`,
      ctx,
    ) as Promise<string>;
    const { parseError, taskId } = JSON.parse(await out) as { parseError: string; taskId: string };
    expect(taskId).toBe("t1");
    expect(parseError).toMatch(/unwrap|parseAsync/);
    expect(parseError).toMatch(/Node 22\.12 or later/);
  });
});

describe("package.json exports", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
    exports: { ".": Record<string, { types: string; default: string }> };
  };
  const dot = pkg.exports["."];

  it("lists the edge conditions before browser, import and require", () => {
    expect(Object.keys(dot)).toEqual([
      "workerd",
      "edge-light",
      "deno",
      "browser",
      "import",
      "require",
    ]);
  });

  it("does not catch browser Web Workers with a `worker` condition", () => {
    expect(dot).not.toHaveProperty("worker");
  });

  it("sends every edge condition to the ESM build, which has no browser-only omissions", () => {
    for (const k of ["workerd", "edge-light", "deno"]) {
      expect(dot[k]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    }
  });

  it("leaves browser, import and require where they were", () => {
    expect(dot["browser"]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.browser.js",
    });
    expect(dot["import"]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    expect(dot["require"]).toEqual({ types: "./dist/index.d.cts", default: "./dist/index.cjs" });
  });
});
