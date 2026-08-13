#!/usr/bin/env node
/**
 * `npx lenz-io init` — wire Lenz into an MCP client.
 *
 * This CLI's job is CONFIGURATION, not API calls. It writes the MCP server
 * block into the chosen client's config file and verifies the key with one
 * authenticated request. The Python package's `lenz` command is the other
 * half — that one calls the API from a shell. Two tools, one character apart
 * in name, so each says which it is in its help output.
 *
 *   npx lenz-io init --claude-code -k lenz_...
 *   npx lenz-io init --cursor
 *   npx lenz-io init --print          # emit the JSON, touch nothing
 *
 * Nothing is stored anywhere of ours — no dotfile, no cache, no telemetry.
 * And by default the key is not written into the PROJECT configs either: they
 * get a `${LENZ_API_KEY}` reference, because `.mcp.json` is a file its own
 * documentation tells teams to commit. `--write-key` is the opt-out.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Lenz } from "./index.js";
import { VERSION } from "./_version.js";

/**
 * Values this CLI shares with `lenz init` in the Python SDK.
 *
 * Exported as one object so a parity test can pin them. They drifted once
 * already — SETUP_URL was left at the pre-rename /welcome/setup here while the
 * Python side had /setup — and a stale URL printed on the last line of a
 * successful run is exactly the kind of thing no test was looking at.
 * Change these in both repos in the same pass.
 */
export const SHARED = {
  MCP_SERVER_URL: "https://lenz.io/mcp",
  CONSOLE_URL: "https://lenz.io/api-integration",
  SETUP_URL: "https://lenz.io/setup",
  KEY_ENV_VAR: "LENZ_API_KEY",
  /** Per-client, because the syntaxes are not interchangeable. */
  PLACEHOLDERS: {
    "claude-code": "${LENZ_API_KEY}",
    cursor: "${env:LENZ_API_KEY}",
    "claude-desktop": null,
  },
} as const;

const MCP_SERVER_URL = SHARED.MCP_SERVER_URL;
const CONSOLE_URL = SHARED.CONSOLE_URL;
const SETUP_URL = SHARED.SETUP_URL;

/** The environment variable both SDKs read, and the one the placeholders name. */
const KEY_ENV_VAR = SHARED.KEY_ENV_VAR;

type ClientId = "claude-code" | "claude-desktop" | "cursor";

interface ClientSpec {
  id: ClientId;
  label: string;
  /**
   * Where the MCP config lives, or null when this platform is unsupported.
   * Takes the working directory rather than reading process.cwd() so the
   * project-scoped clients are testable — vitest workers cannot chdir.
   */
  configPath: (cwd: string) => string | null;
  /** Human-readable note printed after a successful write. */
  after: string;
  /**
   * How THIS client spells an environment-variable reference inside a config
   * value, or null when it cannot resolve one at all.
   *
   * The syntaxes are not the same and are not interchangeable: Claude Code
   * takes `${VAR}`, Cursor takes `${env:VAR}`. Writing one into the other
   * produces a header containing that literal text and a puzzling 401.
   */
  keyPlaceholder: string | null;
}

/**
 * Config locations per client and platform.
 *
 * Claude Code and Cursor are project-scoped by default: writing into the
 * current directory is both what those tools expect and the least surprising
 * thing a one-liner can do — it cannot silently change behaviour in every
 * other project on the machine. Claude Desktop has no project concept, so
 * its config is necessarily global.
 */
export const CLIENTS: Record<ClientId, ClientSpec> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    configPath: (cwd) => join(cwd, ".mcp.json"),
    after: "Restart your Claude Code session so the server loads.",
    keyPlaceholder: SHARED.PLACEHOLDERS["claude-code"],
  },
  "claude-desktop": {
    id: "claude-desktop",
    label: "Claude Desktop",
    // Global, and the only client that gets the literal key. It is launched
    // from the desktop rather than a shell, so it does not inherit an
    // exported LENZ_API_KEY and a placeholder would simply never resolve.
    keyPlaceholder: null,
    configPath: () => {
      if (process.platform === "darwin") {
        return join(
          homedir(),
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        );
      }
      if (process.platform === "win32") {
        const appData = process.env.APPDATA;
        return appData ? join(appData, "Claude", "claude_desktop_config.json") : null;
      }
      // Linux builds are unofficial but do exist and follow XDG.
      const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
      return join(xdg, "Claude", "claude_desktop_config.json");
    },
    after: "Quit and reopen Claude Desktop — it only reads the config at launch.",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    configPath: (cwd) => join(cwd, ".cursor", "mcp.json"),
    after: "Reload the Cursor window so the server loads.",
    // Cursor's syntax is ${env:VAR}, NOT ${VAR}. Not interchangeable.
    keyPlaceholder: SHARED.PLACEHOLDERS.cursor,
  },
};

/**
 * What actually goes in the Authorization header.
 *
 * Project-scoped configs get an env-var reference rather than the key itself,
 * because `.mcp.json` is a file its own documentation tells teams to commit:
 * "Check .mcp.json into version control so everyone on your team gets the same
 * MCP tools and services." A setup tool whose happy path puts a live
 * credential in a tracked file is handing the user a leak, so the default is
 * the reference and `--write-key` is the opt-out for a private checkout.
 */
export function credentialFor(
  spec: ClientSpec,
  apiKey: string,
  writeKey: boolean,
): { value: string; isPlaceholder: boolean } {
  if (spec.keyPlaceholder && !writeKey) {
    return { value: spec.keyPlaceholder, isPlaceholder: true };
  }
  return { value: apiKey, isPlaceholder: false };
}

const USAGE = `lenz-io ${VERSION}

  Wire Lenz fact-checking into an MCP client.

Usage
  npx lenz-io init [client] [options]

Clients
  --claude-code       write .mcp.json in this project (default)
  --claude-desktop    write the global Claude Desktop config
  --cursor            write .cursor/mcp.json in this project
  --print             print the config JSON and exit, writing nothing

Options
  -k, --key <key>     API key. Defaults to $${KEY_ENV_VAR}.
                      Get one at ${CONSOLE_URL}
  --write-key         write the key itself into the config file. Off by
                      default: project configs are commonly committed, so
                      they get a $${KEY_ENV_VAR} reference instead.
  --no-verify         skip the authenticated ping
  -h, --help          show this help
  -v, --version       show the version

Two Lenz CLIs, two jobs
  npx lenz-io init    WIRES Lenz into your agent (this one)
  lenz                CALLS the API from your shell
                      pipx install "lenz-io[cli]"
`;

export function buildServerConfig(apiKey: string): Record<string, unknown> {
  return {
    type: "http",
    url: MCP_SERVER_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
}

/**
 * Merge the Lenz server into an existing MCP config.
 *
 * Merges rather than overwrites, and this is the whole reason the function
 * exists separately: a developer's config routinely holds several servers,
 * and a setup tool that replaced the file would be actively destructive on
 * exactly the machines it is meant to help. Only the `lenz` key is touched.
 */
export function mergeConfig(existing: unknown, apiKey: string): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const servers =
    base.mcpServers && typeof base.mcpServers === "object" && !Array.isArray(base.mcpServers)
      ? { ...(base.mcpServers as Record<string, unknown>) }
      : {};

  servers.lenz = buildServerConfig(apiKey);
  base.mcpServers = servers;
  return base;
}

function readExisting(path: string): unknown {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Refuse rather than guess. Overwriting a file we cannot parse could
    // discard servers the user configured by hand, and they would have no
    // way to get them back.
    throw new Error(
      `${path} exists but is not valid JSON. Fix or move it, then re-run — ` +
        `refusing to overwrite a config we cannot read.`,
    );
  }
}

/**
 * Write atomically: a crash mid-write must not leave a truncated config.
 *
 * The temp file goes in the TARGET's directory, not os.tmpdir(). rename() is
 * only atomic within one filesystem and fails outright with EXDEV across two —
 * and /tmp is a separate filesystem on most Linux distros and in every
 * container, so a tmpdir staging file works on a Mac and breaks everywhere
 * else. Failing there would also strand a file containing a live API key in a
 * world-readable directory, hence the unlink on the error path.
 *
 * mode 0o600 because this file holds a credential: the default 0o666 & ~umask
 * leaves it readable by every account on the machine.
 */
function writeJson(path: string, data: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.lenz-mcp-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

async function verifyKey(apiKey: string): Promise<string> {
  const client = new Lenz({ apiKey });
  const usage = await client.usage();
  const remaining = (usage as { verify?: { remaining?: number } }).verify?.remaining;
  return typeof remaining === "number" ? `${remaining} verify calls remaining` : "key accepted";
}

interface ParsedArgs {
  command: string;
  client: ClientId;
  apiKey: string;
  print: boolean;
  verify: boolean;
  writeKey: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: "",
    client: "claude-code",
    apiKey: process.env[KEY_ENV_VAR] || "",
    print: false,
    verify: true,
    writeKey: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    // noUncheckedIndexedAccess is on: index reads are string | undefined.
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--claude-code":
      case "--claude": // the common shorthand; Code is the likelier of the two
        out.client = "claude-code";
        break;
      case "--claude-desktop":
        out.client = "claude-desktop";
        break;
      case "--cursor":
        out.client = "cursor";
        break;
      case "--print":
        out.print = true;
        break;
      case "--no-verify":
        out.verify = false;
        break;
      case "--write-key":
        out.writeKey = true;
        break;
      case "-k":
      case "--key": {
        // Only consume the next token if it looks like a value. `-k` with
        // nothing after it used to blank a perfectly good $LENZ_API_KEY and
        // then report "No API key", which points at the wrong problem.
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          out.apiKey = next;
          i++;
        }
        break;
      }
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-v":
      case "--version":
        out.version = true;
        break;
      default:
        if (!arg.startsWith("-") && !out.command) out.command = arg;
    }
  }
  return out;
}

export interface RunOptions {
  /** Working directory for project-scoped clients. Injectable for tests. */
  cwd?: string;
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<number> {
  const args = parseArgs(argv);
  const cwd = opts.cwd ?? process.cwd();

  if (args.help || (!args.command && !args.version)) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.command !== "init") {
    process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`);
    return 1;
  }

  const spec = CLIENTS[args.client];

  if (args.print) {
    // No key required: the point of --print is to hand someone a config they
    // paste and fill in themselves. Whatever it prints must be what a write
    // for the same client would produce, or --print stops being a preview.
    const credential = args.apiKey
      ? credentialFor(spec, args.apiKey, args.writeKey).value
      : (spec.keyPlaceholder ?? `\${${KEY_ENV_VAR}}`);
    process.stdout.write(`${JSON.stringify(mergeConfig(null, credential), null, 2)}\n`);
    return 0;
  }

  if (!args.apiKey) {
    process.stderr.write(
      `No API key. Pass -k <key> or set ${KEY_ENV_VAR}.\nGet one at ${CONSOLE_URL}\n`,
    );
    return 1;
  }

  const path = spec.configPath(cwd);
  if (!path) {
    process.stderr.write(
      `Can't locate ${spec.label}'s config on this platform (${process.platform}).\n` +
        `Run with --print and paste the JSON in yourself.\n`,
    );
    return 1;
  }

  let existing: unknown;
  try {
    existing = readExisting(path);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const credential = credentialFor(spec, args.apiKey, args.writeKey);
  writeJson(path, mergeConfig(existing, credential.value));
  process.stdout.write(`Wrote Lenz MCP server to ${path}\n`);

  if (args.verify) {
    try {
      const summary = await verifyKey(args.apiKey);
      process.stdout.write(`Key verified — ${summary}.\n`);
    } catch (err) {
      // The config is already written and correct; only the key is in doubt.
      // Say which of the two failed so the user doesn't go re-running init.
      process.stderr.write(
        `Config written, but the key did not authenticate: ${(err as Error).message}\n` +
          `Check it at ${CONSOLE_URL}, then edit ${path}.\n`,
      );
      return 1;
    }
  }

  if (credential.isPlaceholder) {
    // Without this the run reads as finished — "Wrote the config, key
    // verified" — while the client still has nothing to authenticate with.
    // The export is the remaining step, so it goes above the restart note.
    process.stdout.write(
      `\nThat config references $${KEY_ENV_VAR} instead of storing your key, ` +
        `because ${basename(path)} lives in your project and is commonly committed.\n` +
        `Export the key where your client will see it:\n\n` +
        `  export ${KEY_ENV_VAR}=${args.apiKey}\n\n` +
        `Add that to your shell profile to make it stick, ` +
        `or re-run with --write-key to put the key in the file instead.\n\n`,
    );
  }

  process.stdout.write(`${spec.after}\nMore setup notes: ${SETUP_URL}\n`);
  return 0;
}

// Only self-execute as a binary, so the module stays importable by tests.
if (process.argv[1] && /lenz-io(\.(m|c)?js)?$|cli\.(m|c)?js$/.test(process.argv[1])) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    });
}
