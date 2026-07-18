#!/usr/bin/env node

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { CmlMcpServer, CmlMcpServerOptions } from "./server.js";

interface CmlMcpHttpServerOptions extends CmlMcpServerOptions {
  token?: string;
  allowInsecure?: boolean;
  allowedOrigins?: string[];
  endpointPath?: string;
  maxBodyBytes?: number;
}

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26"]);

export function createCmlMcpHttpServer(options: CmlMcpHttpServerOptions = {}): Server {
  const endpointPath = options.endpointPath ?? "/mcp";
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const mcpServer = new CmlMcpServer(options);

  return createServer((request, response) => {
    void handleRequest(request, response, {
      ...options,
      endpointPath,
      maxBodyBytes,
      mcpServer,
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CmlMcpHttpServerOptions & {
    endpointPath: string;
    maxBodyBytes: number;
    mcpServer: CmlMcpServer;
  }
): Promise<void> {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/health") {
      writeJson(response, 200, { ok: true, service: "cml-mcp-http" });
      return;
    }
    if (requestUrl.pathname !== options.endpointPath) {
      writeJson(response, 404, jsonRpcError(null, -32004, "Not found"));
      return;
    }
    if (!isAllowedOrigin(request, options.allowedOrigins ?? [])) {
      writeJson(response, 403, jsonRpcError(null, -32003, "Forbidden origin"));
      return;
    }
    if (!isAuthorized(request, options)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      writeJson(response, 401, jsonRpcError(null, -32001, "Unauthorized"));
      return;
    }
    const protocolVersion = request.headers["mcp-protocol-version"];
    if (typeof protocolVersion === "string" && !SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) {
      writeJson(response, 400, jsonRpcError(null, -32000, `Unsupported MCP protocol version: ${protocolVersion}`));
      return;
    }
    if (request.method === "GET" || request.method === "DELETE") {
      response.setHeader("Allow", "POST");
      writeJson(response, 405, jsonRpcError(null, -32005, `${request.method} is not enabled; this server uses JSON-response POST only`));
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      writeJson(response, 405, jsonRpcError(null, -32005, "Method not allowed"));
      return;
    }
    const accept = request.headers.accept ?? "";
    if (accept && !accept.includes("application/json") && !accept.includes("*/*")) {
      writeJson(response, 406, jsonRpcError(null, -32006, "Client must accept application/json responses"));
      return;
    }

    const body = await readRequestBody(request, options.maxBodyBytes);
    const message = JSON.parse(body);
    const mcpResponse = await options.mcpServer.handle(message);
    if (!mcpResponse) {
      response.writeHead(202);
      response.end();
      return;
    }
    writeJson(response, 200, mcpResponse);
  } catch (error) {
    writeJson(response, 400, jsonRpcError(null, -32700, error instanceof Error ? error.message : String(error)));
  }
}

function readRequestBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function isAllowedOrigin(request: IncomingMessage, allowedOrigins: string[]): boolean {
  const origin = request.headers.origin;
  if (origin == null) return true;
  if (typeof origin !== "string") return false;
  return allowedOrigins.includes(origin);
}

function isAuthorized(request: IncomingMessage, options: CmlMcpHttpServerOptions): boolean {
  if (options.allowInsecure) return true;
  if (!options.token) return false;
  const authorization = request.headers.authorization;
  return authorization === `Bearer ${options.token}`;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function jsonRpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CML_MCP_HTTP_PORT must be a valid port");
  return port;
}

function main(): void {
  const token = process.env.CML_MCP_TOKEN;
  const allowInsecure = process.env.CML_MCP_ALLOW_INSECURE === "1";
  if (!token && !allowInsecure) {
    throw new Error("Set CML_MCP_TOKEN before starting cml-mcp-http");
  }
  const host = process.env.CML_MCP_HTTP_HOST ?? "127.0.0.1";
  const port = parsePort(process.env.CML_MCP_HTTP_PORT);
  const server = createCmlMcpHttpServer({
    dbPath: process.env.CML_DB_PATH,
    defaultActor: process.env.CML_ACTOR,
    defaultActorId: process.env.CML_ACTOR_ID ? Number(process.env.CML_ACTOR_ID) : undefined,
    obsidianBin: process.env.CML_OBSIDIAN_BIN,
    vaultName: process.env.CML_OBSIDIAN_VAULT,
    vaultRoot: process.env.CML_VAULT_ROOT,
    token,
    allowInsecure,
    allowedOrigins: parseList(process.env.CML_MCP_ALLOWED_ORIGINS),
  });
  server.listen(port, host, () => {
    process.stderr.write(`cml-mcp-http listening on http://${host}:${port}/mcp\n`);
  });
}

if (process.argv[1]?.endsWith("/mcp/http.js")) {
  main();
}
