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

describe("index.browser runtime exports", () => {
  /**
   * Bundles the package the way a browser bundler does (esbuild with
   * `platform: "browser"`, resolving `lenz-io` through package.json's
   * `browser` export condition), then imports the bundle and compares every
   * error class it exports with the Node entry's.
   */
  it("exports every error class the Node entry exports, as working constructors", async () => {
    const { build } = await import("esbuild");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(
      (await import("node:fs")).readFileSync(join(root, "package.json"), "utf-8"),
    ) as { exports: { ".": { browser: { default: string } } } };

    const dir = mkdtempSync(join(tmpdir(), "lenz-browser-"));
    try {
      const out = join(dir, "bundle.mjs");
      await build({
        stdin: { contents: 'export * from "lenz-io";', resolveDir: root, loader: "ts" },
        bundle: true,
        platform: "browser",
        format: "esm",
        write: true,
        outfile: out,
        logLevel: "silent",
        // `lenz-io` resolves through package.json's `browser` condition, to
        // the source of the file it names (dist is built after the tests).
        plugins: [
          {
            name: "browser-condition",
            setup(b) {
              b.onResolve({ filter: /^lenz-io$/ }, () => ({
                path: join(
                  root,
                  "src",
                  pkg.exports["."].browser.default
                    .replace(/^\.\/dist\//, "")
                    .replace(/\.js$/, ".ts"),
                ),
              }));
            },
          },
        ],
      });
      writeFileSync(join(dir, "package.json"), "{}");
      const browser = (await import(pathToFileURL(out).href)) as Record<string, unknown>;
      const node = (await import("../src/index.js")) as Record<string, unknown>;
      const errorNames = (mod: Record<string, unknown>) =>
        Object.keys(mod)
          .filter((k) => typeof mod[k] === "function" && /^[A-Z].*Error$/.test(k))
          .sort();
      expect(errorNames(browser)).toEqual(errorNames(node));
      expect(errorNames(browser)).toContain("LenzUpstreamUnavailableError");
      const Base = browser["LenzError"] as new (ctx?: object) => Error;
      for (const name of errorNames(browser)) {
        if (name === "LenzError") continue;
        const Ctor = browser[name] as { prototype: object };
        expect(Ctor.prototype instanceof Base, name).toBe(true);
      }
      // isEvent, which needs no crypto, is in the browser entry too.
      const isEvent = browser["isEvent"] as (e: unknown, k: string) => boolean;
      expect(typeof isEvent).toBe("function");
      expect(isEvent({ event: "review.completed", raw: {} }, "review.completed")).toBe(false);
      expect(
        isEvent(
          {
            event: "verification.failed",
            taskId: "t",
            raw: { verification: { status: "failed", task_id: "t" } },
            verification: { status: "failed", task_id: "t" },
          },
          "verification.failed",
        ),
      ).toBe(true);
      // The bundle carries no Node-only import.
      const text = (await import("node:fs")).readFileSync(out, "utf-8");
      expect(text).not.toMatch(/from\s+["']node:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
