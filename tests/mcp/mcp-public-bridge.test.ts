import { AddressInfo } from "node:net";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash, generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCmlPublicMcpBridge } from "../../src/mcp/public-bridge.js";

describe("cml public MCP bridge", () => {
  let upstream: Server;
  let bridge: Server;
  let upstreamUrl: string;
  let baseUrl: string;
  let upstreamCalls: unknown[];

  beforeEach(async () => {
    upstreamCalls = [];
    upstream = createServer((request, response) => {
      void handleUpstream(request, response, upstreamCalls);
    });
    await listen(upstream);
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;

    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      upstreamToken: "internal-token",
      publicToken: "public-token",
      allowedTools: new Set([
        "ui_manifest",
        "ui_runtime_get",
        "operator_state_get",
        "status",
        "intent_get",
        "intent_list",
        "interpret_get",
        "interpret_list",
        "interpretation_get",
        "interpretation_list",
        "report_list",
        "vault_read",
        "vault_search",
      ]),
      allowedOrigins: new Set(["https://chatgpt.example"]),
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await close(bridge);
    await close(upstream);
  });

  async function post(message: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer public-token",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        ...headers,
      },
      body: JSON.stringify(message),
    });
  }

  async function postRoot(message: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer public-token",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        ...headers,
      },
      body: JSON.stringify(message),
    });
  }

  it("serves a public health check without auth", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "cml-public-mcp-bridge",
    });
  });

  it("requires bearer auth for MCP calls", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("rejects disallowed browser origins before forwarding", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Origin: "https://not-allowed.example" }
    );
    expect(response.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("filters tools/list to the public read-only surface", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "ui_manifest",
      "ui_runtime_get",
      "operator_state_get",
      "status",
      "interpret_get",
      "interpret_list",
      "interpretation_get",
      "interpretation_list",
      "vault_search",
    ]);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("accepts the public base URL as an MCP endpoint alias", async () => {
    const response = await postRoot({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "ui_manifest",
      "ui_runtime_get",
      "operator_state_get",
      "status",
      "interpret_get",
      "interpret_list",
      "interpretation_get",
      "interpretation_list",
      "vault_search",
    ]);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("forwards allowed tool calls with the internal upstream token", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "vault_search", arguments: { query: "reading partner" } },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.structuredContent).toMatchObject({
      ok: true,
      data: { query: "reading partner" },
    });
    expect(upstreamCalls).toMatchObject([
      {
        authorization: "Bearer internal-token",
        message: {
          method: "tools/call",
          params: { name: "vault_search" },
        },
      },
    ]);
  });

  it("blocks mutation tools locally without touching upstream", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "vault_write", arguments: { path: "unsafe.md", content: "nope" } },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "TOOL_NOT_EXPOSED" },
      },
    });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("strips client-supplied invocation role context unless the bridge profile injects it", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "vault_search",
        arguments: {
          actor: "cml-resolver",
          query: "contracts",
          assumedRole: "project-advisor",
          invokedSkillRef: "99_engine/skills/something.md",
          policyRef: "99_engine/roles/project-advisor/POLICY.md",
          governingContractKey: "role:project-advisor",
        },
      },
    });
    expect(response.status).toBe(200);
    expect(upstreamCalls).toMatchObject([
      {
        message: {
          params: {
            name: "vault_search",
            arguments: {
              actor: "cml-resolver",
              query: "contracts",
            },
          },
        },
      },
    ]);
    const forwarded = upstreamCalls[0] as { message: { params: { arguments: Record<string, unknown> } } };
    expect(forwarded.message.params.arguments).not.toHaveProperty("assumedRole");
    expect(forwarded.message.params.arguments).not.toHaveProperty("invokedSkillRef");
    expect(forwarded.message.params.arguments).not.toHaveProperty("policyRef");
    expect(forwarded.message.params.arguments).not.toHaveProperty("governingContractKey");
  });

  it("injects a required stable actor for scoped bridge profiles", async () => {
    await close(bridge);
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      upstreamToken: "internal-token",
      publicToken: "public-token",
      allowedTools: new Set(["vault_search"]),
      allowedOrigins: new Set(),
      requiredActor: "review-partner",
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const response = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "vault_search", arguments: { query: "AI Act" } },
    });
    expect(response.status).toBe(200);
    expect(upstreamCalls).toMatchObject([
      {
        message: {
          params: {
            arguments: {
              actor: "review-partner",
              query: "AI Act",
            },
          },
        },
      },
    ]);
  });

  it("rejects actor substitution for scoped bridge profiles", async () => {
    await close(bridge);
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      publicToken: "public-token",
      allowedTools: new Set(["vault_search"]),
      allowedOrigins: new Set(),
      requiredActor: "review-partner",
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const response = await post({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "vault_search", arguments: { actor: "build-agent", query: "AI Act" } },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "ACTOR_NOT_PERMITTED" },
      },
    });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("accepts OAuth bearer tokens and maps subject claims to actors", async () => {
    await close(bridge);
    const oauth = createOAuthFixture({ sub: "github|123456", aud: "cml-mcp" });
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      upstreamToken: "internal-token",
      allowedTools: new Set(["vault_search"]),
      allowedOrigins: new Set(),
      oauth: {
        issuer: oauth.issuer,
        audience: "cml-mcp",
        jwksUrl: oauth.jwksUrl,
        subjectActorMap: new Map([["github|123456", "pilot-user"]]),
        fetch: oauth.fetch,
      },
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 70,
        method: "tools/call",
        params: { name: "vault_search", arguments: { actor: null, query: "contracts" } },
      },
      { Authorization: `Bearer ${oauth.token}` }
    );
    expect(response.status).toBe(200);
    expect(upstreamCalls).toMatchObject([
      {
        authorization: "Bearer internal-token",
        message: {
          params: {
            name: "vault_search",
            arguments: {
              actor: "pilot-user",
              query: "contracts",
            },
          },
        },
      },
    ]);
  });

  it("maps verified OAuth group claims to actors", async () => {
    await close(bridge);
    const oauth = createOAuthFixture({ sub: "user-with-group", aud: "cml-mcp", groups: ["pilot-builders"] });
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      allowedTools: new Set(["vault_search"]),
      allowedOrigins: new Set(),
      oauth: {
        issuer: oauth.issuer,
        audience: "cml-mcp",
        jwksUrl: oauth.jwksUrl,
        groupActorMap: new Map([["pilot-builders", "pilot-agent"]]),
        fetch: oauth.fetch,
      },
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 71,
        method: "tools/call",
        params: { name: "vault_search", arguments: { query: "pilot" } },
      },
      { Authorization: `Bearer ${oauth.token}` }
    );
    expect(response.status).toBe(200);
    expect(upstreamCalls).toMatchObject([
      {
        message: {
          params: {
            arguments: {
              actor: "pilot-agent",
              query: "pilot",
            },
          },
        },
      },
    ]);
  });

  it("rejects invalid OAuth bearer tokens before forwarding", async () => {
    await close(bridge);
    const oauth = createOAuthFixture({ sub: "github|123456", aud: "cml-mcp" });
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      allowedTools: new Set(["vault_search"]),
      allowedOrigins: new Set(),
      oauth: {
        issuer: oauth.issuer,
        audience: "cml-mcp",
        jwksUrl: oauth.jwksUrl,
        subjectActorMap: new Map([["github|123456", "pilot-user"]]),
        fetch: oauth.fetch,
      },
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const missing = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 72, method: "tools/list" }),
    });
    expect(missing.status).toBe(401);

    const invalid = await post(
      { jsonrpc: "2.0", id: 73, method: "tools/list" },
      { Authorization: "Bearer not-a-jwt" }
    );
    expect(invalid.status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("advertises universal MCP OAuth resource metadata and challenges", async () => {
    await close(bridge);
    const oauth = createOAuthFixture({ sub: "github|123456", aud: "https://mcp.example/mcp" });
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      allowedTools: new Set(["vault_search"]),
      allowedOrigins: new Set(),
      oauth: {
        issuer: oauth.issuer,
        resource: "https://mcp.example/mcp",
        protectedResourceMetadataUrl: "https://mcp.example/.well-known/oauth-protected-resource",
        jwks: oauth.jwks,
        scopesSupported: ["cml:read"],
        defaultActor: "pilot-user",
      },
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      resource: "https://mcp.example/mcp",
      authorization_servers: [oauth.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["cml:read"],
    });

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 75, method: "tools/list" }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"'
    );
    expect(upstreamCalls).toHaveLength(0);
  });

  it("runs a universal pilot OAuth code flow without vendor-specific clients", async () => {
    await close(bridge);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const issuer = "https://mcp.example";
    const resource = "https://mcp.example/mcp";
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      allowedTools: new Set(["vault_search"]),
      allowedOrigins: new Set(),
      oauth: {
        issuer,
        resource,
        audience: resource,
        scopesSupported: ["cml:read"],
        defaultActor: "pilot-user",
        pilotIssuer: {
          privateKeyPem,
          keyId: "pilot-key",
          authorizationSecret: "pilot-secret",
          subject: "pilot-user",
          scopes: ["cml:read"],
        },
      },
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const metadata = await fetch(`${baseUrl}/.well-known/openid-configuration`);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      issuer,
      service_documentation: expect.stringContaining("pilot OAuth issuer"),
    });

    const registration = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Universal MCP client",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "client_secret_post",
      }),
    });
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string; client_secret: string };

    const verifier = "test-verifier-for-pilot-oauth-flow";
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const authorization = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://client.example/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource,
        scope: "cml:read",
        state: "state-123",
        authorization_secret: "pilot-secret",
      }),
    });
    expect(authorization.status).toBe(302);
    const redirect = new URL(authorization.headers.get("location") ?? "");
    expect(redirect.origin + redirect.pathname).toBe("https://client.example/callback");
    expect(redirect.searchParams.get("state")).toBe("state-123");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        client_secret: client.client_secret,
        code: code ?? "",
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource,
      }),
    });
    expect(token.status).toBe(200);
    const issued = await token.json() as { access_token: string; refresh_token: string };
    expect(issued.access_token).toBeTruthy();
    expect(issued.refresh_token).toBeTruthy();

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 76,
        method: "tools/call",
        params: { name: "vault_search", arguments: { query: "pilot" } },
      },
      { Authorization: `Bearer ${issued.access_token}` }
    );
    expect(response.status).toBe(200);
    expect(upstreamCalls).toMatchObject([
      {
        message: {
          params: {
            arguments: {
              actor: "pilot-user",
              query: "pilot",
            },
          },
        },
      },
    ]);
  });

  it("blocks actor spoofing when OAuth actor mapping is active", async () => {
    await close(bridge);
    const oauth = createOAuthFixture({ sub: "github|123456", aud: "cml-mcp" });
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      allowedTools: new Set(["vault_search"]),
      allowedOrigins: new Set(),
      oauth: {
        issuer: oauth.issuer,
        audience: "cml-mcp",
        jwksUrl: oauth.jwksUrl,
        subjectActorMap: new Map([["github|123456", "pilot-user"]]),
        fetch: oauth.fetch,
      },
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 74,
        method: "tools/call",
        params: { name: "vault_search", arguments: { actor: "other-actor", query: "contracts" } },
      },
      { Authorization: `Bearer ${oauth.token}` }
    );
    const body = await response.json();
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "ACTOR_NOT_PERMITTED" },
      },
    });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("allows scoped vault writes only with an intent mandate and permitted path", async () => {
    await close(bridge);
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      publicToken: "public-token",
      allowedTools: new Set(["vault_write", "vault_append"]),
      allowedOrigins: new Set(),
      requiredActor: "review-partner",
      writableExactPaths: new Set([
        "99_engine/skills/ai-regulation-review-partner/INVOCATION-SCOPES.md",
        "00_intake/external/ai-regulation-reading-pack/progress/reading-progress-tracker.md",
      ]),
      writablePathPrefixes: ["01_atoms/"],
      writablePathSuffixes: [".md"],
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const response = await post({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "vault_append",
        arguments: {
          intent: 33,
          path: "99_engine/skills/ai-regulation-review-partner/INVOCATION-SCOPES.md",
          content: "- 2026-04-26 | smoke | test | ok",
        },
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.structuredContent.ok).toBe(true);
    expect(upstreamCalls).toMatchObject([
      {
        message: {
          params: {
            name: "vault_append",
            arguments: {
              actor: "review-partner",
              intent: 33,
              path: "99_engine/skills/ai-regulation-review-partner/INVOCATION-SCOPES.md",
            },
          },
        },
      },
    ]);
  });

  it("blocks scoped vault mutations without an intent or outside writable paths", async () => {
    await close(bridge);
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      publicToken: "public-token",
      allowedTools: new Set(["vault_write", "vault_move", "vault_delete"]),
      allowedOrigins: new Set(),
      requiredActor: "review-partner",
      writablePathPrefixes: ["01_atoms/"],
      writablePathSuffixes: [".md"],
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const missingIntent = await post({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "vault_write",
        arguments: {
          path: "01_atoms/2026-04-26-smoke.md",
          content: "candidate",
        },
      },
    });
    const missingIntentBody = await missingIntent.json();
    expect(missingIntentBody.result.structuredContent.error.code).toBe("INTENT_REQUIRED");

    const moveMissingIntent = await post({
      jsonrpc: "2.0",
      id: 81,
      method: "tools/call",
      params: {
        name: "vault_move",
        arguments: {
          path: "01_atoms/2026-04-26-smoke.md",
          to: "01_atoms/2026-04-26-smoke-renamed.md",
        },
      },
    });
    const moveMissingIntentBody = await moveMissingIntent.json();
    expect(moveMissingIntentBody.result.structuredContent.error.code).toBe("INTENT_REQUIRED");

    const deleteMissingIntent = await post({
      jsonrpc: "2.0",
      id: 82,
      method: "tools/call",
      params: {
        name: "vault_delete",
        arguments: {
          path: "01_atoms/2026-04-26-smoke.md",
        },
      },
    });
    const deleteMissingIntentBody = await deleteMissingIntent.json();
    expect(deleteMissingIntentBody.result.structuredContent.error.code).toBe("INTENT_REQUIRED");

    const outsidePath = await post({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "vault_write",
        arguments: {
          intent: 33,
          path: "99_engine/AGENTS.md",
          content: "nope",
        },
      },
    });
    const outsidePathBody = await outsidePath.json();
    expect(outsidePathBody.result.structuredContent.error.code).toBe("PATH_NOT_PERMITTED");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("allows trusted scoped bridge profiles to write any normalized path when explicitly configured", async () => {
    await close(bridge);
    bridge = createCmlPublicMcpBridge({
      upstreamUrl,
      publicToken: "public-token",
      allowedTools: new Set(["vault_write"]),
      allowedOrigins: new Set(),
      requiredActor: "chatgpt-project-advisor",
      assumedRole: "project-advisor",
      governingContractKey: "role:project-advisor",
      allowAllWritablePaths: true,
    });
    await listen(bridge);
    baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

    const response = await post({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "vault_write",
        arguments: {
          intent: 35,
          path: "99_engine/project-advisor-smoke.md",
          content: "ok",
        },
      },
    });
    expect(response.status).toBe(200);
    expect(upstreamCalls).toMatchObject([
      {
        message: {
          params: {
            name: "vault_write",
            arguments: {
              actor: "chatgpt-project-advisor",
              assumedRole: "project-advisor",
              governingContractKey: "role:project-advisor",
              intent: 35,
              path: "99_engine/project-advisor-smoke.md",
            },
          },
        },
      },
    ]);
  });
});

async function handleUpstream(request: IncomingMessage, response: ServerResponse, calls: unknown[]): Promise<void> {
  const raw = await readBody(request);
  const message = JSON.parse(raw);
  calls.push({
    authorization: request.headers.authorization,
    message,
  });
  if (message.method === "tools/list") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "ui_manifest", description: "UI manifest" },
          { name: "ui_runtime_get", description: "UI runtime" },
          { name: "operator_state_get", description: "Operator state" },
          { name: "status", description: "Status" },
          { name: "interpret_get", description: "Get interpretation" },
          { name: "interpret_list", description: "List interpretations" },
          { name: "interpretation_get", description: "Get interpretation alias" },
          { name: "interpretation_list", description: "List interpretations alias" },
          { name: "vault_write", description: "Write" },
          { name: "vault_search", description: "Search" },
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
  if (message.method === "tools/call" && ["vault_write", "vault_append"].includes(message.params?.name)) {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: "write ok" }],
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

function createOAuthFixture(claims: Record<string, unknown>): {
  issuer: string;
  jwksUrl: string;
  jwks: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>;
  token: string;
  fetch: typeof fetch;
} {
  const issuer = "https://issuer.example";
  const jwksUrl = "https://issuer.example/jwks.json";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey & { kid?: string; alg?: string; use?: string };
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    { alg: "RS256", kid: "test-key", typ: "JWT" },
    { iss: issuer, exp: now + 300, iat: now, ...claims },
    privateKey
  );
  return {
    issuer,
    jwksUrl,
    jwks: [jwk],
    token,
    fetch: (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href === jwksUrl) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      if (href === `${issuer}/.well-known/openid-configuration`) {
        return new Response(JSON.stringify({ issuer, jwks_uri: jwksUrl }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
}

function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, privateKey: KeyObject): string {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedClaims = base64Url(JSON.stringify(claims));
  const payload = `${encodedHeader}.${encodedClaims}`;
  const signature = sign("RSA-SHA256", Buffer.from(payload), privateKey);
  return `${payload}.${base64Url(signature)}`;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
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
