import { AddressInfo } from "node:net";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCmlPublicMcpBridge } from "../../src/mcp/public-bridge.js";
import { CmlRemoteMcpClient, CmlRemoteMcpError } from "../../src/sdk/remote-mcp-client.js";

describe("CmlRemoteMcpClient", () => {
  let upstream: Server;
  let bridge: Server;
  let baseUrl: string;
  let upstreamCalls: unknown[];

  beforeEach(async () => {
    upstreamCalls = [];
    upstream = createServer((request, response) => {
      void handleUpstream(request, response, upstreamCalls);
    });
    await listen(upstream);
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;

    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      upstreamToken: "internal-token",
      publicToken: "public-token",
      allowedTools: new Set(["status", "intent_get", "intent_list", "report_list", "vault_read", "vault_search"]),
      allowedOrigins: new Set(),
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}/mcp`;
  });

  afterEach(async () => {
    await close(bridge);
    await close(upstream);
  });

  function client(actor = "sdk-remote-agent") {
    return new CmlRemoteMcpClient({
      url: baseUrl,
      token: "public-token",
      actor,
    });
  }

  it("initializes and lists only public tools", async () => {
    const epi = client();
    await expect(epi.initialize()).resolves.toMatchObject({
      protocolVersion: "2025-11-25",
    });
    await expect(epi.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "status" }),
      expect.objectContaining({ name: "vault_search" }),
    ]);
  });

  it("injects the stable actor into tool calls", async () => {
    const result = await client().vault.search({ query: "reading partner", limit: 5 });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        actor: "sdk-remote-agent",
        query: "reading partner",
        limit: 5,
      },
    });
  });

  it("lets explicit actor arguments override the client default", async () => {
    const result = await client("default-agent").vault.search({ actor: "explicit-agent", query: "contract" } as any);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        actor: "explicit-agent",
        query: "contract",
      },
    });
  });

  it("surfaces bearer auth failures as typed errors", async () => {
    const epi = new CmlRemoteMcpClient({
      url: baseUrl,
      token: "wrong-token",
      actor: "sdk-remote-agent",
    });
    await expect(epi.listTools()).rejects.toMatchObject({
      name: "CmlRemoteMcpError",
      code: "HTTP_ERROR",
    } satisfies Partial<CmlRemoteMcpError>);
  });

  it("keeps public mutation tools blocked by the bridge", async () => {
    const result = await client().callTool("vault_write", {
      intent: 33,
      path: "99_engine/smoke/blocked.md",
      content: "blocked",
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "TOOL_NOT_EXPOSED" },
      },
    });
    expect(upstreamCalls).not.toContainEqual(expect.objectContaining({
      message: expect.objectContaining({
        params: expect.objectContaining({ name: "vault_write" }),
      }),
    }));
  });
});

async function handleUpstream(request: IncomingMessage, response: ServerResponse, calls: unknown[]): Promise<void> {
  const raw = await readBody(request);
  const message = JSON.parse(raw);
  calls.push({
    authorization: request.headers.authorization,
    message,
  });
  if (message.method === "initialize") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cml-test" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "status", description: "Status" },
          { name: "vault_search", description: "Search" },
          { name: "vault_write", description: "Write" },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call" && message.params?.name === "vault_search") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: "search ok" }],
        structuredContent: {
          ok: true,
          data: message.params.arguments,
        },
      },
    });
    return;
  }
  writeJson(response, 500, { ok: false });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
