/**
 * `npx lenz-io init` — config merging, arg parsing, and the write path.
 *
 * The merge tests carry the most weight. A developer's MCP config routinely
 * holds several servers, and a setup tool that replaced the file would be
 * actively destructive on exactly the machines it exists to help.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENTS,
  SHARED,
  buildServerConfig,
  credentialFor,
  mergeConfig,
  parseArgs,
  run,
} from "../src/cli.js";

/**
 * Pinned literals shared with `lenz init` in the Python SDK.
 *
 * The two commands are a stated parity pair, and the existing parity test
 * covered the server block — the thing that never drifted — while SETUP_URL
 * sat at the pre-rename /welcome/setup and printed a 404 on every successful
 * run. tests/test_cli_init.py asserts this same table.
 */
describe("parity with the Python SDK", () => {
  it("pins the shared constants", () => {
    expect(SHARED.MCP_SERVER_URL).toBe("https://lenz.io/mcp");
    expect(SHARED.CONSOLE_URL).toBe("https://lenz.io/api-integration");
    expect(SHARED.SETUP_URL).toBe("https://lenz.io/setup");
    expect(SHARED.KEY_ENV_VAR).toBe("LENZ_API_KEY");
  });

  it("pins the per-client placeholder syntax", () => {
    expect(SHARED.PLACEHOLDERS["claude-code"]).toBe("${LENZ_API_KEY}");
    expect(SHARED.PLACEHOLDERS.cursor).toBe("${env:LENZ_API_KEY}");
    expect(SHARED.PLACEHOLDERS["claude-desktop"]).toBeNull();
  });

  it("writes the same server block both SDKs write", () => {
    expect(buildServerConfig("k")).toEqual({
      type: "http",
      url: "https://lenz.io/mcp",
      headers: { Authorization: "Bearer k" },
    });
  });
});

describe("buildServerConfig", () => {
  it("points at the remote MCP server with a bearer key", () => {
    const cfg = buildServerConfig("lenz_abc") as Record<string, unknown>;
    expect(cfg.type).toBe("http");
    expect(cfg.url).toBe("https://lenz.io/mcp");
    expect((cfg.headers as Record<string, string>).Authorization).toBe("Bearer lenz_abc");
  });
});

describe("mergeConfig", () => {
  it("creates the mcpServers block when there is no config yet", () => {
    const merged = mergeConfig(null, "lenz_abc") as Record<string, any>;
    expect(Object.keys(merged.mcpServers)).toEqual(["lenz"]);
  });

  it("preserves other servers", () => {
    const existing = {
      mcpServers: {
        github: { type: "http", url: "https://example.com/mcp" },
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      },
    };

    const merged = mergeConfig(existing, "lenz_abc") as Record<string, any>;

    expect(Object.keys(merged.mcpServers).sort()).toEqual(["filesystem", "github", "lenz"]);
    expect(merged.mcpServers.github.url).toBe("https://example.com/mcp");
  });

  it("preserves unrelated top-level keys", () => {
    const merged = mergeConfig({ theme: "dark", mcpServers: {} }, "k") as Record<string, any>;
    expect(merged.theme).toBe("dark");
  });

  it("replaces a previous lenz entry rather than duplicating it", () => {
    const existing = { mcpServers: { lenz: { type: "http", url: "old", headers: {} } } };

    const merged = mergeConfig(existing, "lenz_new") as Record<string, any>;

    expect(merged.mcpServers.lenz.url).toBe("https://lenz.io/mcp");
    expect(merged.mcpServers.lenz.headers.Authorization).toBe("Bearer lenz_new");
  });

  it("survives a malformed mcpServers value", () => {
    const merged = mergeConfig({ mcpServers: "nonsense" }, "k") as Record<string, any>;
    expect(merged.mcpServers.lenz).toBeDefined();
  });
});

describe("parseArgs", () => {
  it("defaults to Claude Code", () => {
    expect(parseArgs(["init"]).client).toBe("claude-code");
  });

  it("treats --claude as Claude Code", () => {
    expect(parseArgs(["init", "--claude"]).client).toBe("claude-code");
  });

  it("reads the key from a flag", () => {
    expect(parseArgs(["init", "-k", "lenz_flag"]).apiKey).toBe("lenz_flag");
    expect(parseArgs(["init", "--key", "lenz_long"]).apiKey).toBe("lenz_long");
  });

  it("falls back to LENZ_API_KEY", () => {
    vi.stubEnv("LENZ_API_KEY", "lenz_env");
    expect(parseArgs(["init"]).apiKey).toBe("lenz_env");
    vi.unstubAllEnvs();
  });

  it("lets the flag beat the environment", () => {
    vi.stubEnv("LENZ_API_KEY", "lenz_env");
    expect(parseArgs(["init", "-k", "lenz_flag"]).apiKey).toBe("lenz_flag");
    vi.unstubAllEnvs();
  });
});

describe("run", () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    // The working directory is passed in rather than chdir'd into: vitest
    // workers cannot chdir, and an injectable cwd is the better shape anyway.
    dir = mkdtempSync(join(tmpdir(), "lenz-cli-"));
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      out.push(String(s));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      err.push(String(s));
      return true;
    });
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes .mcp.json for Claude Code", async () => {
    const code = await run(["init", "-k", "lenz_abc", "--no-verify"], { cwd: dir });

    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(written.mcpServers.lenz.url).toBe("https://lenz.io/mcp");
  });

  it("writes .cursor/mcp.json for Cursor, creating the directory", async () => {
    const code = await run(["init", "--cursor", "-k", "lenz_abc", "--no-verify"], { cwd: dir });

    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8"));
    expect(written.mcpServers.lenz.url).toBe("https://lenz.io/mcp");
  });

  it("merges into an existing config instead of replacing it", async () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { github: { type: "http", url: "https://example.com" } } }),
    );

    await run(["init", "-k", "lenz_abc", "--no-verify"], { cwd: dir });

    const written = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(written.mcpServers.github.url).toBe("https://example.com");
    expect(written.mcpServers.lenz).toBeDefined();
  });

  it("refuses to overwrite a config it cannot parse", async () => {
    writeFileSync(join(dir, ".mcp.json"), "{ this is not json");

    const code = await run(["init", "-k", "lenz_abc", "--no-verify"], { cwd: dir });

    expect(code).toBe(1);
    expect(err.join("")).toContain("not valid JSON");
    // The unreadable file is left exactly as it was.
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe("{ this is not json");
  });

  it("--print emits the config and writes nothing", async () => {
    const code = await run(["init", "--print"], { cwd: dir });

    expect(code).toBe(0);
    const printed = JSON.parse(out.join(""));
    // No key given → a placeholder to fill in, not a broken empty string.
    expect(printed.mcpServers.lenz.headers.Authorization).toBe("Bearer ${LENZ_API_KEY}");
    expect(() => readFileSync(join(dir, ".mcp.json"), "utf8")).toThrow();
  });

  it("errors without a key rather than writing a broken config", async () => {
    const code = await run(["init", "--no-verify"], { cwd: dir });

    expect(code).toBe(1);
    expect(err.join("")).toContain("No API key");
    expect(() => readFileSync(join(dir, ".mcp.json"), "utf8")).toThrow();
  });

  it("says which CLI this is in --help", async () => {
    await run(["--help"], { cwd: dir });
    const help = out.join("");
    expect(help).toContain("WIRES Lenz into your agent");
    expect(help).toContain("CALLS the API from your shell");
  });
});

/**
 * Where the key ends up.
 *
 * `.mcp.json` is a project file whose own documentation says to commit it —
 * "Check .mcp.json into version control so everyone on your team gets the same
 * MCP tools and services." A setup tool that puts a live credential there by
 * default is handing the user a leak, so project-scoped clients get an env-var
 * reference and only --write-key opts out.
 */
describe("credential placement", () => {
  let dir: string;
  let out: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lenz-cli-key-"));
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      out.push(String(s));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const readCfg = (...parts: string[]) => JSON.parse(readFileSync(join(dir, ...parts), "utf8"));

  it("keeps the key out of Claude Code's project config", async () => {
    await run(["init", "-k", "lenz_secret", "--no-verify"], { cwd: dir });

    const raw = readFileSync(join(dir, ".mcp.json"), "utf8");
    expect(readCfg(".mcp.json").mcpServers.lenz.headers.Authorization).toBe(
      "Bearer ${LENZ_API_KEY}",
    );
    expect(raw).not.toContain("lenz_secret");
  });

  it("uses Cursor's ${env:VAR} syntax, which is not Claude Code's", async () => {
    // Writing ${LENZ_API_KEY} here would not expand — Cursor would send that
    // literal text as the bearer token and 401 with no clue why.
    await run(["init", "--cursor", "-k", "lenz_secret", "--no-verify"], { cwd: dir });

    expect(readCfg(".cursor", "mcp.json").mcpServers.lenz.headers.Authorization).toBe(
      "Bearer ${env:LENZ_API_KEY}",
    );
  });

  it("tells the user to export the variable, with the key to export", async () => {
    await run(["init", "-k", "lenz_secret", "--no-verify"], { cwd: dir });

    // Otherwise the run reads as finished while the client still has nothing
    // to authenticate with.
    expect(out.join("")).toContain("export LENZ_API_KEY=lenz_secret");
  });

  it("--write-key puts the key in the file for a private checkout", async () => {
    await run(["init", "-k", "lenz_secret", "--write-key", "--no-verify"], { cwd: dir });

    expect(readCfg(".mcp.json").mcpServers.lenz.headers.Authorization).toBe("Bearer lenz_secret");
    expect(out.join("")).not.toContain("export LENZ_API_KEY");
  });

  it("writes the literal key for Claude Desktop, which cannot expand one", () => {
    // Global config, and the app is launched from the desktop rather than a
    // shell, so it never sees an exported variable — a placeholder there is
    // simply broken. Asserted through credentialFor rather than a real write:
    // the path is an absolute one under the true home directory on every
    // platform, and a test that has to skip itself on macOS is not a test.
    const credential = credentialFor(CLIENTS["claude-desktop"], "lenz_secret", false);

    expect(credential.value).toBe("lenz_secret");
    expect(credential.isPlaceholder).toBe(false);
  });

  it("--print previews exactly what a write would produce", async () => {
    await run(["init", "--cursor", "-k", "lenz_secret", "--print"], { cwd: dir });

    // A preview that differs from the write is worse than no preview.
    expect(JSON.parse(out.join("")).mcpServers.lenz.headers.Authorization).toBe(
      "Bearer ${env:LENZ_API_KEY}",
    );
  });
});

describe("the write path", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lenz-cli-write-"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("stages the temp file beside the target, not in os.tmpdir()", async () => {
    // rename() is atomic only within one filesystem and fails with EXDEV
    // across two. /tmp is a separate filesystem on most Linux distros and in
    // every container, so staging there works on a Mac and breaks in CI.
    await run(["init", "--cursor", "-k", "lenz_abc", "--no-verify"], { cwd: dir });

    expect(readdirSync(join(dir, ".cursor"))).toEqual(["mcp.json"]);
  });

  it("writes the config 0600, because it can hold a credential", async () => {
    if (process.platform === "win32") return; // POSIX modes only

    await run(["init", "-k", "lenz_abc", "--write-key", "--no-verify"], { cwd: dir });

    expect(statSync(join(dir, ".mcp.json")).mode & 0o777).toBe(0o600);
  });
});
