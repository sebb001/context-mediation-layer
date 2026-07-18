import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixtureSchemaUrl = new URL("../fixtures/governance-schema.sql", import.meta.url);

describe("cml-mcp stdio", () => {
  let tempDir: string;
  let dbPath: string;
  let obsidianBin: string;
  let vaultRoot: string;

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: process.cwd(), stdio: "pipe" });
    tempDir = mkdtempSync(join(tmpdir(), "cml-mcp-stdio-"));
    dbPath = join(tempDir, "cml.sqlite");
    obsidianBin = join(tempDir, "fake-obsidian-cli.mjs");
    vaultRoot = join(tempDir, "vault");
    writeFileSync(
      obsidianBin,
      `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.env.FAKE_OBSIDIAN_ROOT;
const [command, ...args] = process.argv.slice(2);
const flags = Object.fromEntries(args.map((arg) => {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? [arg, true] : [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
}));
const source = flags.path ? join(root, flags.path) : undefined;

if (command === "create") {
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, flags.content ?? "");
  console.log("created");
} else if (command === "read") {
  process.stdout.write(readFileSync(source, "utf8"));
} else {
  console.error("unknown command " + command);
  process.exit(1);
}
`
    );
    chmodSync(obsidianBin, 0o755);

    const db = new DatabaseSync(dbPath);
    db.exec(readFileSync(process.env.CML_SCHEMA_SQL ?? fixtureSchemaUrl, "utf8"));
    db.prepare("INSERT INTO scopes (name, description) VALUES ('default', 'Default')").run();
    db.prepare(
      `INSERT INTO actors (id, name, role, provider, capability_namespace, default_scope)
       VALUES (22, 'mcp-agent', 'agent', 'openai-codex', 'mcp-test', 'default')`
    ).run();
    db.prepare(
      `INSERT INTO intents (id, scope, description, status, source)
       VALUES (33, 'default', 'MCP stdio mandate', 'active', 'test')`
    ).run();
    db.close();
  }, 30000);

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("serializes ordered write/read calls over stdio", async () => {
    const child = spawn("node", ["dist/mcp/index.js"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CML_DB_PATH: dbPath,
        CML_OBSIDIAN_BIN: obsidianBin,
        FAKE_OBSIDIAN_ROOT: vaultRoot,
      },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vault_write", arguments: { actor: "mcp-agent", intent: 33, path: "99_engine/smoke/stdio.md", content: "ordered" } } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vault_read", arguments: { actor: "mcp-agent", path: "99_engine/smoke/stdio.md" } } });
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(exitCode).toBe(0);
    const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const byId = Object.fromEntries(responses.map((response) => [response.id, response]));
    expect(byId[2].result.structuredContent.ok).toBe(true);
    expect(byId[3].result.structuredContent).toMatchObject({
      ok: true,
      data: { data: "ordered" },
    });
  });
});
