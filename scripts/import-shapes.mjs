#!/usr/bin/env node
//
// Imports the API's recorded responses (both versions) into
// test/fixtures/shapes/{legacy,canonical}/.
//
//   node scripts/import-shapes.mjs <goldens-dir>
//
// <goldens-dir> holds `legacy/<name>.json` and `canonical/<name>.json`, one
// recording per endpoint and outcome: `{status, headers, body}` for a
// response, `{payload, ...}` / `{request: {body}}` for a webhook, or an
// object of such records (several calls in one case), which becomes one
// fixture per call (`<name>__<call>`).
//
// Run-specific values are recorded as placeholders that keep their shape
// (`<task_id#1:hex32>`, `<created_at#2:ts:+00:00:us>`): the number is the
// value's identity within the file. This script replaces each with a fixed
// value of that shape, and gives a placeholder in the newer-shape file the
// SAME value as its counterpart in the original-shape file (found by its
// position in the body, else by its field name and order), so the two files
// describe the same response. Timestamps keep what the SDK derives from
// them: an original-shape `modified_at` is set a calendar day after the rest,
// every other time falls on one day.
//
// Fixtures are written as `{status, headers?, body}` (only the headers a
// client acts on) or `{payload}` for a webhook.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "test", "fixtures", "shapes");

const src = process.argv[2];
if (!src || !existsSync(join(src, "legacy"))) {
  console.error("usage: node scripts/import-shapes.mjs <goldens-dir with legacy/ and canonical/>");
  process.exit(1);
}

const TOKEN = /<([A-Za-z_0-9]*)#(\d+):([^>"]*)>/g;
const WHOLE = /^<([A-Za-z_0-9]*)#(\d+):([^>"]*)>$/;

/** Every placeholder occurrence: `{path, ordinal, label, kind}`, in document order. */
function occurrences(value, path = "", out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => occurrences(v, `${path}.${i}`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) occurrences(v, `${path}.${k}`, out);
  } else if (typeof value === "string") {
    for (const m of value.matchAll(TOKEN)) {
      out.push({ path, ordinal: m[2], label: m[1], kind: m[3] });
    }
  }
  return out;
}

/** Per ordinal: its first non-empty label and every path it sits at. */
function ordinals(occ) {
  const map = new Map();
  for (const o of occ) {
    if (!map.has(o.ordinal)) map.set(o.ordinal, { label: o.label, paths: [], kind: o.kind });
    const e = map.get(o.ordinal);
    if (!e.label && o.label) e.label = o.label;
    e.paths.push(o.path);
  }
  return map;
}

/** Field names that hold the same value in the two shapes. */
const LABEL_GROUP = {
  completed_at: "finished",
  modified_at: "finished",
  resets_at: "resets",
  quota_resets_at: "resets",
};
const group = (label) => LABEL_GROUP[label] ?? label;

/** Paths that name the same field in the two shapes. */
function legacyPathsFor(path) {
  return [
    path,
    path.replace(/\.completed_at$/, ".modified_at"),
    path.replace(/^\.payload\.verification\./, ".payload."),
    path.replace(/\.credits\.resets_at$/, ".quota_resets_at"),
  ];
}

function hexFor(seed, n) {
  let h = "";
  for (let i = 0; h.length < n; i++) {
    h += createHash("sha256").update(`${seed}:${i}`).digest("hex");
  }
  return h.slice(0, n);
}

const BASE = Date.UTC(2026, 2, 14, 9, 0, 0); // a fixed day

/** A fixed value of the placeholder's shape. `id` is a stable identity. */
function realize(kind, id, instant) {
  const prefixed = /^([a-z]+)_hex(\d+)$/.exec(kind);
  if (prefixed) return `${prefixed[1]}_${hexFor(id, Number(prefixed[2]))}`;
  const hex = /^hex(\d+)$/.exec(kind);
  if (hex) return hexFor(id, Number(hex[1]));
  if (kind === "int") return 100 + (Number(id.split("#").pop()) || 0);
  const s = /^str:(\d+)$/.exec(kind);
  if (s) return hexFor(id, Number(s[1]));
  if (kind === "uuid") {
    const h = hexFor(id, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  if (kind === "date") return new Date(instant).toISOString().slice(0, 10);
  const ts = /^ts:([^:]+(?::\d\d)?):(\w+)$/.exec(kind);
  if (ts) {
    const [, offset, precision] = ts;
    const iso = new Date(instant).toISOString(); // ...THH:MM:SS.mmmZ
    const whole = iso.slice(0, 19);
    const ms = iso.slice(20, 23);
    const micro = ms === "234" ? "567" : "456";
    const frac = precision === "us" ? `.${ms}${micro}` : precision === "ms" ? `.${ms}` : "";
    return `${whole}${frac}${offset === "Z" ? "Z" : offset}`;
  }
  throw new Error(`unknown placeholder kind ${kind}`);
}

/** Replace every placeholder in `value` through `valueOf(ordinal, kind)`. */
function substitute(value, valueOf) {
  if (Array.isArray(value)) return value.map((v) => substitute(v, valueOf));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, valueOf)]));
  }
  if (typeof value !== "string") return value;
  const whole = WHOLE.exec(value);
  if (whole) return valueOf(whole[2], whole[3]);
  return value.replace(TOKEN, (_m, _label, ordinal, kind) => String(valueOf(ordinal, kind)));
}

function realizePair(name, legacy, canonical) {
  const lOrd = ordinals(occurrences(legacy));
  const cOrd = ordinals(occurrences(canonical));
  // Original shape: one instant / identity per ordinal.
  // The cases named for the `modified_at` rule keep what they are named for:
  // created a few minutes before midnight UTC and finished just after it, or
  // finished hours later on the same day.
  const crosses = name.includes("crosses_midnight_by_minutes");
  const sameDay = name.includes("same_day_hours_apart");
  const lInstant = new Map();
  let i = 0;
  for (const [o, e] of lOrd) {
    i += 1;
    if (crosses && e.label === "created_at") lInstant.set(o, Date.UTC(2026, 2, 14, 23, 58, 1, 123));
    else if (crosses && e.label === "modified_at")
      lInstant.set(o, Date.UTC(2026, 2, 15, 0, 3, 2, 234));
    // `modified_at` is set only when the run finished on a later UTC day.
    else lInstant.set(o, BASE + (e.label === "modified_at" ? 86_400_000 : 0) + i * 61_000);
  }
  const lValue = (o, kind) => realize(kind, `${name}#L${o}`, lInstant.get(o));

  // Newer shape: the counterpart's value, by position, then by field name.
  const legacyAt = new Map();
  for (const occ of occurrences(legacy)) {
    if (!legacyAt.has(occ.path)) legacyAt.set(occ.path, occ.ordinal);
  }
  const used = new Set();
  const counterpart = new Map();
  for (const [o, e] of cOrd) {
    for (const p of e.paths) {
      const hit = legacyPathsFor(p)
        .map((lp) => legacyAt.get(lp))
        .find((lo) => lo !== undefined && !used.has(lo));
      if (hit !== undefined) {
        counterpart.set(o, hit);
        used.add(hit);
        break;
      }
    }
  }
  for (const [o, e] of cOrd) {
    if (counterpart.has(o)) continue;
    const hit = [...lOrd].find(
      ([lo, le]) => !used.has(lo) && le.label && group(le.label) === group(e.label),
    );
    if (hit) {
      counterpart.set(o, hit[0]);
      used.add(hit[0]);
    }
  }
  let fresh = 0;
  const cInstant = new Map();
  const cValue = (o, kind) => {
    const lo = counterpart.get(o);
    if (lo !== undefined) return realize(kind, `${name}#L${lo}`, lInstant.get(lo));
    if (!cInstant.has(o)) {
      const finished = group(cOrd.get(o)?.label ?? "") === "finished";
      cInstant.set(
        o,
        sameDay && finished
          ? Date.UTC(2026, 2, 14, 17, 30, 2, 234)
          : BASE + 3_600_000 + ++fresh * 61_000,
      );
    }
    return realize(kind, `${name}#C${o}`, cInstant.get(o));
  };
  return [substitute(legacy, lValue), substitute(canonical, cValue)];
}

/** The headers a client acts on. */
const KEPT_HEADERS = ["Retry-After"];

function isResponse(r) {
  return r && typeof r === "object" && "status" in r && "body" in r;
}

function webhookBody(r) {
  if (r && typeof r === "object") {
    if (r.payload && typeof r.payload === "object") return r.payload;
    if (r.request && typeof r.request === "object" && r.request.body) return r.request.body;
  }
  return null;
}

/** One fixture per recorded call: `[suffix, fixture]`. */
function fixtures(record) {
  if (isResponse(record)) return [["", toFixture(record)]];
  const hook = webhookBody(record);
  if (hook) return [["", { payload: hook }]];
  return Object.entries(record).flatMap(([k, v]) => {
    if (isResponse(v)) return [[`__${k}`, toFixture(v)]];
    return [];
  });
}

function toFixture(r) {
  const out = { status: r.status };
  const headers = {};
  for (const h of KEPT_HEADERS) if (r.headers?.[h] !== undefined) headers[h] = r.headers[h];
  if (Object.keys(headers).length) out.headers = headers;
  out.body = r.body;
  return out;
}

// Recordings no SDK method reads (keep in step with `hasScenario` in
// test/shapes/scenarios.ts): OAuth, the web app's own routes, the API's index,
// the webhook-secret read, routes answered in HTML.
const NOT_SDK =
  /^(account__oauth_|errors__oauth_|errors__web_|errors__method_not_allowed_|account__api_root$|account__webhook_secret_oauth$|review__delete_not_a_route$|errors__not_found_route$)/;

const names = readdirSync(join(src, "legacy"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .filter((n) => !NOT_SDK.test(n))
  .filter((n) => existsSync(join(src, "canonical", `${n}.json`)))
  .sort();

for (const dir of ["legacy", "canonical"]) mkdirSync(join(OUT, dir), { recursive: true });
let written = 0;
for (const name of names) {
  const legacy = JSON.parse(readFileSync(join(src, "legacy", `${name}.json`), "utf-8"));
  const canonical = JSON.parse(readFileSync(join(src, "canonical", `${name}.json`), "utf-8"));
  const [l, c] = realizePair(name, legacy, canonical);
  const lf = new Map(fixtures(l));
  for (const [suffix, cf] of fixtures(c)) {
    const lfix = lf.get(suffix);
    if (!lfix) continue;
    const file = `${name}${suffix}.json`;
    writeFileSync(join(OUT, "legacy", file), JSON.stringify(lfix, null, 2) + "\n");
    writeFileSync(join(OUT, "canonical", file), JSON.stringify(cf, null, 2) + "\n");
    written += 1;
  }
}
console.log(`import-shapes: wrote ${written} pairs`);
