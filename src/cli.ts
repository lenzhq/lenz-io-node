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
 * The key is never persisted anywhere but the client's own config file — no
 * dotfile of ours, no cache, no telemetry.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Lenz } from "./index.js";
import { VERSION } from "./_version.js";

const MCP_SERVER_URL = "https://lenz.io/mcp";
const CONSOLE_URL = "https://lenz.io/api-integration";
const SETUP_URL = "https://lenz.io/welcome/setup";

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
const CLIENTS: Record<ClientId, ClientSpec> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    configPath: (cwd) => join(cwd, ".mcp.json"),
    after: "Restart your Claude Code session so the server loads.",
  },
  "claude-desktop": {
    id: "claude-desktop",
    label: "Claude Desktop",
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
  },
};

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
  -k, --key <key>     API key. Defaults to $LENZ_API_KEY.
                      Get one at ${CONSOLE_URL}
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

/** Write atomically: a crash mid-write must not leave a truncated config. */
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(tmpdir(), `lenz-mcp-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
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
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: "",
    client: "claude-code",
    apiKey: process.env.LENZ_API_KEY || "",
    print: false,
    verify: true,
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
      case "-k":
      case "--key":
        out.apiKey = argv[++i] || "";
        break;
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
    return args.help || !args.command ? 0 : 0;
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
    // paste and fill in themselves.
    const key = args.apiKey || "${LENZ_API_KEY}";
    process.stdout.write(`${JSON.stringify(mergeConfig(null, key), null, 2)}\n`);
    return 0;
  }

  if (!args.apiKey) {
    process.stderr.write(
      `No API key. Pass -k <key> or set LENZ_API_KEY.\nGet one at ${CONSOLE_URL}\n`,
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

  writeJson(path, mergeConfig(existing, args.apiKey));
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
