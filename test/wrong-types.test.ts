/**
 * A JSON object whose fields have the wrong type where the SDK reads them
 * (`claims: "x"`, `claims: [42]`, `status: 42`, ...) ends in a `LenzError`,
 * never a `TypeError` from inside the SDK: every field of every recorded
 * answer (`test/fixtures/shapes/canonical/`), at any depth, is replaced in
 * turn by a value of each other JSON type and read through the method for
 * its endpoint, with `legacyAliases` on and off. The SDK does not validate
 * fields it does not read: such an answer is returned as sent. Where it does
 * read one (a batch receipt's `items`, a completed status's `result`), the
 * error is a `LenzInvalidResponseError`: `success-metadata-and-usage-errors.test.ts` pins those.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Lenz, LenzError } from "../src/index.js";
import { type Call, callsFor, DIR, type Recorded } from "./support/recorded-calls.js";

type Json = unknown;

/** Every path in `value` (keys, and `[i]` indexes as numbers). */
function paths(
  value: Json,
  path: Array<string | number> = [],
  out: Array<Array<string | number>> = [],
) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      out.push([...path, i]);
      paths(v, [...path, i], out);
    });
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push([...path, k]);
      paths(v, [...path, k], out);
    }
  }
  return out;
}

/** `body` with the value at `path` replaced. */
function replaced(body: Json, path: Array<string | number>, value: Json): Json {
  const copy = JSON.parse(JSON.stringify(body)) as Record<string | number, unknown>;
  let node: Record<string | number, unknown> = copy;
  for (const step of path.slice(0, -1)) node = node[step] as Record<string | number, unknown>;
  node[path[path.length - 1]!] = value;
  return copy;
}

const WRONG: Json[] = ["x", 42, true, [42], ["x"], { x: 1 }, null];

function typeOf(v: Json): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

/** A shape-level key for a path: indexes collapse, so each field is tried once per call. */
function shapeKey(name: string, type: string, path: Array<string | number>): string {
  const prefix = name.split("__")[0];
  return `${prefix}:${type}:${path.map((p) => (typeof p === "number" ? "[]" : p)).join(".")}`;
}

function fetchOf(status: number, headers: Record<string, string>, body: Json): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
}

describe("a field of the wrong type", () => {
  it("never surfaces as a foreign error", async () => {
    const foreign: string[] = [];
    const seen = new Set<string>();
    for (const file of readdirSync(DIR).sort()) {
      const name = file.replace(/\.json$/, "");
      if (name.startsWith("webhook__")) continue;
      const r = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Recorded;
      const status = r.status ?? 200;
      if (status >= 400) continue;
      const body = (r.body ?? {}) as Record<string, unknown>;
      const calls = callsFor(name, body);
      if (!calls || calls === "skip") continue;
      for (const [type, run] of calls as Call[]) {
        for (const path of paths(body)) {
          const key = shapeKey(name, type, path);
          if (seen.has(key)) continue;
          seen.add(key);
          let current: Json = body;
          for (const step of path) current = (current as Record<string | number, unknown>)[step];
          for (const wrong of WRONG) {
            if (typeOf(wrong) === typeOf(current)) continue;
            const mutated = replaced(body, path, wrong);
            for (const legacyAliases of [true, false]) {
              const client = new Lenz({
                apiKey: "lenz_t",
                fetch: fetchOf(status, r.headers ?? {}, mutated),
                maxRetries: 0,
                legacyAliases,
              });
              try {
                await run(client);
              } catch (exc) {
                if (!(exc instanceof LenzError)) {
                  foreign.push(
                    `${key} = ${JSON.stringify(wrong)} (aliases ${legacyAliases}): ${String(exc)}`,
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(foreign).toEqual([]);
  }, 300_000);
});
