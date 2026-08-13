/**
 * `npx lenz-io init` — config merging, arg parsing, and the write path.
 *
 * The merge tests carry the most weight. A developer's MCP config routinely
 * holds several servers, and a setup tool that replaced the file would be
 * actively destructive on exactly the machines it exists to help.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServerConfig, mergeConfig, parseArgs, run } from "../src/cli.js";

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
    expect(written.mcpServers.lenz.headers.Authorization).toBe("Bearer lenz_abc");
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
