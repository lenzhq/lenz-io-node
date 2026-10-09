#!/usr/bin/env node
// Packs the package, installs the tarball into a scratch project and runs the
// signed-webhook check where the package is meant to load without Node
// built-ins: workerd (Miniflare, Node compatibility off), Deno and Bun, plus
// Node itself. Each runtime also reports which build `lenz-io` resolved to.
//
//   npm run build && node scripts/edge-check.mjs [--only workerd|node|bun|deno]...
//
// A runtime that is not installed is skipped, unless it is named with --only or
// listed in EDGE_REQUIRE (comma-separated), where a missing one fails the run.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleWorker, signed, withWorker } from "../test/edge/workerd.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const only = process.argv.slice(2).flatMap((a, i, all) => (all[i - 1] === "--only" ? [a] : []));
const required = new Set([...only, ...(process.env.EDGE_REQUIRE ?? "").split(",").filter(Boolean)]);
const wanted = (name) => only.length === 0 || only.includes(name);

const work = mkdtempSync(join(tmpdir(), "lenz-edge-"));
const project = join(work, "project");
const failures = [];

function have(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

function report(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function install() {
  const out = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], {
    cwd: ROOT,
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .pop();
  execFileSync("mkdir", ["-p", project]);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "edge-check", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", join(work, out)], {
    cwd: project,
  });
  cpSync(join(ROOT, "test", "edge", "check.mjs"), join(project, "check.mjs"));
}

function runtime(name, cmd, args, expectBuild) {
  if (!wanted(name)) return;
  if (!have(cmd)) {
    if (required.has(name)) report(name, false, `${cmd} is not installed`);
    else console.log(`SKIP ${name}: ${cmd} is not installed`);
    return;
  }
  const r = spawnSync(cmd, args, { cwd: project, encoding: "utf-8" });
  const resolved = /resolved=(\S+)/.exec(r.stdout)?.[1] ?? "";
  const ok = r.status === 0 && resolved.endsWith(expectBuild);
  const version = spawnSync(cmd, ["--version"], { encoding: "utf-8" }).stdout.trim().split("\n")[0];
  report(name, ok, ok ? `${version}, resolved ${expectBuild}` : `${r.stdout}${r.stderr}`.trim());
}

async function workerd() {
  if (!wanted("workerd")) return;
  try {
    const { code, inputs } = await bundleWorker({ resolveDir: project });
    if (/node:|\bBuffer\b/.test(code))
      throw new Error("the bundle names a Node built-in or Buffer");
    if (!inputs.some((f) => f.endsWith("lenz-io/dist/index.edge.js"))) {
      throw new Error("the workerd condition did not resolve to index.edge.js");
    }
    await withWorker(code, async (fetch) => {
      const body = JSON.stringify({
        event: "review.completed",
        task_id: "t_edge",
        attempt: 1,
        delivered_at: new Date().toISOString(),
      });
      const ok = await fetch("http://worker.test/", {
        method: "POST",
        headers: { "X-Lenz-Signature": signed(body) },
        body,
      });
      const reply = await ok.json();
      if (
        ok.status !== 200 ||
        reply.event !== "review.completed" ||
        reply.taskId !== "t_edge" ||
        reply.hasProcess
      ) {
        throw new Error(JSON.stringify(reply));
      }
      const bad = await fetch("http://worker.test/", {
        method: "POST",
        headers: { "X-Lenz-Signature": signed(body, "x") },
        body,
      });
      if (bad.status !== 400) throw new Error(`a forged request answered ${bad.status}`);
    });
    report("workerd", true, "Miniflare, Node compatibility off, resolved index.edge.js");
  } catch (e) {
    report("workerd", false, String(e?.stack ?? e));
  }
}

try {
  install();
  await workerd();
  runtime("node", "node", ["check.mjs"], "dist/index.js");
  if (wanted("node")) {
    const cjs = spawnSync(
      "node",
      [
        "-e",
        `const {LenzWebhooks}=require("lenz-io");const h=new LenzWebhooks({secret:"s"});` +
          `const b=JSON.stringify({event:"x.y",task_id:"t"});` +
          `const sig="sha256="+require("node:crypto").createHmac("sha256","s").update(b).digest("hex");` +
          `if(h.parse(b,{"X-Lenz-Signature":sig}).taskId!=="t")process.exit(1)`,
      ],
      { cwd: project, encoding: "utf-8" },
    );
    report("node (require, sync parse)", cjs.status === 0, cjs.stderr.trim());
  }
  runtime("bun", "bun", ["check.mjs"], "dist/index.js");
  runtime(
    "deno",
    process.env.DENO_BIN ?? "deno",
    ["run", "--allow-read", "--allow-env", "check.mjs"],
    "dist/index.edge.js",
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`edge check failed: ${failures.join(", ")}`);
  process.exit(1);
}
