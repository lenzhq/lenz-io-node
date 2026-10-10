/**
 * Every recorded API response (`test/fixtures/shapes/canonical/`, imported
 * from the API's contract goldens) goes through the method that reads its
 * endpoint, with `legacyAliases` on and off. Two guards:
 *
 * 1. No call ends in an error that is not the SDK's own (`LenzError`): a
 *    recorded answer never surfaces as a `TypeError` from deep inside.
 * 2. Every field the result holds as `null` is typed to accept `null`: each
 *    such path is written as a typed assignment of `null` and the file is
 *    compiled with `tsc --strict`. A field the types do not declare at all is
 *    not checked here.
 *
 * Webhook recordings are not covered: their types are the events'. The
 * original-shape (`2026-05-13`) recordings of client calls are not read by
 * 3.x at all (a success in that version throws `LenzApiVersionError`).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { Lenz, LenzError } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "test", "fixtures", "shapes", "canonical");

interface Recorded {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Nulls left out of the types on purpose, each documented on its field: an
 * assess row's `verdict` and `confidence` are `null` on a failed row only with
 * `legacyAliases: false` (by default they read `"Error"` / `"low"`), and a
 * review failure block's `docs_url` can be `null`. Typing them `| null` would
 * break code that reads them as strings, which `test/types/compat.ts` forbids.
 */
const NOT_TYPED_NULL = new Set([
  "AssessResponse.claims.[].verdict",
  "AssessResponse.claims.[].confidence",
  // A failure block's page: typed `string` since 2.x, and the type-compat
  // promise (no field widens to include null) holds it there. Documented.
  "ReviewFull.failures.[].failure.docs_url",
  "ReviewFull.claims.[].assessment.failure.docs_url",
]);

/** One call per recording: the type its result has, and how to make it. */
type Call = [type: string, run: (c: Lenz) => Promise<unknown>];

/** The calls whose endpoint answered `name` (a 2xx recording). */
function callsFor(name: string, body: Record<string, unknown>): Call[] | "skip" | undefined {
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

function fetchFor(r: Recorded): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    })) as unknown as typeof fetch;
}

/** Every path (`["claims", "[]", "error_code"]`) at which `value` holds `null`. */
function nullPaths(value: unknown, path: string[] = [], out: string[][] = []): string[][] {
  if (value === null) out.push(path);
  else if (Array.isArray(value)) value.forEach((v) => nullPaths(v, [...path, "[]"], out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) nullPaths(v, [...path, k], out);
  }
  return out;
}

it("every recorded answer reads without a foreign error, and its nulls are typed", async () => {
  const unmapped: string[] = [];
  const foreign: string[] = [];
  const paths = new Map<string, string[]>(); // `${type}:${path}` -> path
  for (const file of readdirSync(DIR).sort()) {
    const name = file.replace(/\.json$/, "");
    if (name.startsWith("webhook__")) continue;
    const r = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Recorded;
    const body = (r.body ?? {}) as Record<string, unknown>;
    const calls = (r.status ?? 200) < 400 ? callsFor(name, body) : undefined;
    if (calls === "skip") continue;
    // An error answer: the method its prefix names must throw a LenzError.
    const runs: Call[] =
      calls ?? ((r.status ?? 200) >= 400 ? [["", (c) => errorCall(c, name)]] : []);
    if (runs.length === 0) unmapped.push(name);
    for (const legacyAliases of [true, false]) {
      for (const [type, run] of runs) {
        const client = new Lenz({
          apiKey: "lenz_t",
          fetch: fetchFor(r),
          maxRetries: 0,
          legacyAliases,
        });
        let out: unknown;
        try {
          out = await run(client);
        } catch (exc) {
          if (!(exc instanceof LenzError)) foreign.push(`${name}: ${String(exc)}`);
          continue;
        }
        if (!type) continue;
        for (const p of nullPaths(out)) paths.set(`${type}:${p.join(".")}`, [type, ...p]);
      }
    }
  }
  expect(unmapped).toEqual([]);
  expect(foreign).toEqual([]);

  // One typed assignment of `null` per path, compiled as a user's code is.
  const lines = [...paths.values()].map((p, i) => {
    const [type, ...keys] = p;
    let t = `L.${type}`;
    for (const k of keys) t = `At<${t}, ${JSON.stringify(k)}>`;
    return `export const p${i}: ${t} = null; // ${p.join(".")}`;
  });
  const dir = mkdtempSync(join(tmpdir(), "lenz-null-fields-"));
  const file = join(dir, "nulls.ts");
  writeFileSync(
    file,
    [
      `import type * as L from ${JSON.stringify(join(ROOT, "src", "index.ts"))};`,
      "type NN<T> = Exclude<T, null | undefined>;",
      // A key the types do not declare is not checked here (`unknown`).
      'type At<T, K> = K extends "[]" ? (NN<T> extends readonly (infer U)[] ? U : unknown) : K extends keyof NN<T> ? NN<T>[K] : unknown;',
      ...lines,
    ].join("\n"),
  );
  let output = "";
  try {
    execFileSync(
      process.execPath,
      [
        join(ROOT, "node_modules", "typescript", "bin", "tsc"),
        "--strict",
        "--noEmit",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--allowImportingTsExtensions",
        file,
      ],
      { cwd: ROOT, encoding: "utf-8", stdio: "pipe" },
    );
  } catch (exc) {
    output = String((exc as { stdout?: string }).stdout ?? exc);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Each failing line names its path in a comment: report the paths.
  const failing = [...output.matchAll(/nulls\.ts\((\d+),/g)].map(
    (m) => lines[Number(m[1]) - 4]?.split("// ")[1] ?? m[0],
  );
  const untyped = [...new Set(failing)].filter((p) => !NOT_TYPED_NULL.has(p));
  expect(untyped, output.slice(0, 2000)).toEqual([]);
}, 120_000);

/** The call whose endpoint answered an error recording. */
function errorCall(client: Lenz, name: string): Promise<unknown> {
  if (name.startsWith("assess__")) return client.assess({ claim: "x" });
  if (name.startsWith("extract__")) return client.extract({ text: "x" });
  if (name.startsWith("review__get_")) return client.getReview("r");
  if (name.startsWith("review__cancel_")) return client.cancelReview("r");
  if (name.startsWith("review__")) return client.review({ text: "x" });
  if (name.startsWith("citecheck__get_")) return client.getCitecheck("c");
  if (name.startsWith("citecheck__cancel_")) return client.cancelCitecheck("c");
  if (name.startsWith("citecheck__")) return client.citecheck({ text: "x" });
  if (name.startsWith("verify__batch_")) return client.verifyBatch({ claims: [{ claim: "a" }] });
  if (name.startsWith("verify__select_")) return client.select("t", { claims: ["a"] });
  if (name.startsWith("verify__cancel_")) return client.cancel("t");
  if (name.startsWith("verify__verification_")) return client.verifications.get("v");
  if (name.startsWith("verify__status_")) return client.getStatus("t");
  if (name.startsWith("account__ask_")) return client.ask.history("v");
  if (name.startsWith("account__library_")) return client.library.list();
  if (name.startsWith("account__")) return client.usage();
  return client.verify({ claim: "a" });
}
