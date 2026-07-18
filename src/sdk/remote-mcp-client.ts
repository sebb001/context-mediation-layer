type JsonRpcId = string | number | null;

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface RemoteMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface RemoteMcpToolResult<T = unknown> {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: T;
  isError?: boolean;
}

export interface CmlRemoteMcpClientOptions {
  url: string;
  token?: string;
  actor?: string;
  protocolVersion?: string;
  fetchImpl?: typeof fetch;
}

export class CmlRemoteMcpError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown) {
    super(message);
    this.name = "CmlRemoteMcpError";
  }
}

export class CmlRemoteMcpClient {
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;
  private readonly protocolVersion: string;

  constructor(private readonly options: CmlRemoteMcpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.protocolVersion = options.protocolVersion ?? "2025-11-25";
  }

  initialize(): Promise<{
    protocolVersion: string;
    capabilities: Record<string, unknown>;
    serverInfo?: Record<string, unknown>;
  }> {
    return this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "cml-remote-mcp-client", version: "0.1.0" },
    });
  }

  async listTools(): Promise<RemoteMcpTool[]> {
    const result = await this.request<{ tools: RemoteMcpTool[] }>("tools/list");
    return result.tools;
  }

  callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<RemoteMcpToolResult<T>> {
    return this.request("tools/call", {
      name,
      arguments: this.withDefaultActor(args),
    });
  }

  get status() {
    return () => this.callTool("status");
  }

  get intent() {
    return {
      get: (id: number) => this.callTool("intent_get", { id }),
      list: (params: { scope?: string; status?: string; limit?: number; offset?: number } = {}) =>
        this.callTool("intent_list", params),
    };
  }

  get report() {
    return {
      list: (params: { scope?: string; kind?: string; intentId?: number; domainId?: number; actorId?: number; limit?: number; offset?: number } = {}) =>
        this.callTool("report_list", params),
    };
  }

  get vault() {
    return {
      read: (params: { path: string }) => this.callTool("vault_read", params),
      search: (params: { query: string; path?: string; limit?: number; format?: "text" | "json" }) =>
        this.callTool("vault_search", params),
    };
  }

  private async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const response = await this.fetchImpl(this.options.url, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": this.protocolVersion,
        ...(this.options.token ? { "Authorization": `Bearer ${this.options.token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params ? { params } : {}),
      }),
    });

    const rawBody = await response.text();
    const body = rawBody ? JSON.parse(rawBody) as JsonRpcResponse<T> : undefined;
    if (!response.ok) {
      throw new CmlRemoteMcpError("HTTP_ERROR", `MCP request failed with HTTP ${response.status}`, body);
    }
    if (!body) {
      throw new CmlRemoteMcpError("EMPTY_RESPONSE", "MCP server returned an empty response");
    }
    if (body.error) {
      throw new CmlRemoteMcpError(String(body.error.code), body.error.message, body.error.data);
    }
    if (body.result == null) {
      throw new CmlRemoteMcpError("MISSING_RESULT", "MCP server response did not include a result");
    }
    return body.result;
  }

  private withDefaultActor(args: Record<string, unknown>): Record<string, unknown> {
    if (!this.options.actor || args.actor != null) return args;
    return { actor: this.options.actor, ...args };
  }
}
