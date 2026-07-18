import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actorId, domainId, intendId } from "../../src/governance/domain.js";
import { InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { createCmlMcpHttpServer } from "../../src/mcp/http.js";

describe("cml-mcp Streamable HTTP JSON transport", () => {
  let tempDir: string;
  let obsidianBin: string;
  let vaultRoot: string;
  let repo: InMemoryGovernanceRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "cml-mcp-http-"));
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
} else if (command === "search") {
  console.log("match\\t" + flags.query);
} else {
  console.error("unknown command " + command);
  process.exit(1);
}
`
    );
    chmodSync(obsidianBin, 0o755);

    repo = new InMemoryGovernanceRepository();
    await repo.registerScope("default");
    await repo.registerActor({
      name: "mcp-http-agent",
      role: "agent",
      provider: "openai-codex",
      capabilityNamespace: "mcp-http-test",
      defaultScope: "default",
    });
    await repo.registerDomain({
      name: "test-domain",
      scope: "default",
      concern: "MCP HTTP interpretation reads",
    });
    await repo.createIntent({
      scope: "default",
      description: "MCP HTTP mandate",
      source: "test",
      status: "active",
    });

    server = createCmlMcpHttpServer({
      repository: repo,
      defaultActor: "mcp-http-agent",
      obsidianBin,
      token: "test-token",
      allowedOrigins: ["https://allowed.example"],
      env: { ...process.env, FAKE_OBSIDIAN_ROOT: vaultRoot },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function post(message: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer test-token",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        ...headers,
      },
      body: JSON.stringify(message),
    });
  }

  it("initializes over authenticated HTTP POST", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
    });
  });

  it("returns 202 for accepted notifications", async () => {
    const response = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("rejects missing bearer auth", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects disallowed origins", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Origin: "https://evil.example" }
    );
    expect(response.status).toBe(403);
  });

  it("exposes ordered tool calls over HTTP POST", async () => {
    const write = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "vault_write",
        arguments: {
          intent: 1,
          path: "99_engine/smoke/http.md",
          content: "hello http",
        },
      },
    });
    expect(write.status).toBe(200);
    const writeBody = await write.json();
    expect(writeBody.result.structuredContent.ok).toBe(true);

    const read = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "vault_read",
        arguments: {
          path: "99_engine/smoke/http.md",
        },
      },
    });
    const readBody = await read.json();
    expect(readBody.result.structuredContent).toMatchObject({
      ok: true,
      data: { data: "hello http" },
    });
  });

  it("exposes full interpretation reads over HTTP POST", async () => {
    await repo.createInterpretation({
      intentId: intendId(1),
      domainId: domainId(1),
      actorId: actorId(1),
      title: "Transport diagnosis",
      scopeAssumption: "Full interpretation body visible to MCP clients.",
      alignment: "aligned",
      status: "proposed",
      sourceRef: "test",
    });

    const list = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "interpret_list",
        arguments: {
          intentId: 1,
        },
      },
    });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.result.structuredContent).toMatchObject({
      ok: true,
      data: [
        {
          id: 1,
          title: "Transport diagnosis",
          scopeAssumption: "Full interpretation body visible to MCP clients.",
        },
      ],
    });

    const get = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "interpret_get",
        arguments: {
          id: 1,
        },
      },
    });
    const getBody = await get.json();
    expect(getBody.result.structuredContent).toMatchObject({
      ok: true,
      data: {
        id: 1,
        title: "Transport diagnosis",
        scopeAssumption: "Full interpretation body visible to MCP clients.",
      },
    });

    const alias = await post({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "interpretation_list",
        arguments: {
          intentId: 1,
        },
      },
    });
    const aliasBody = await alias.json();
    expect(aliasBody.result.structuredContent).toMatchObject({
      ok: true,
      data: [
        {
          id: 1,
          title: "Transport diagnosis",
        },
      ],
    });
  });

  it("does not expose server-sent event GET in the MVP", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: {
        "Authorization": "Bearer test-token",
        "Accept": "text/event-stream",
      },
    });
    expect(response.status).toBe(405);
  });
});
