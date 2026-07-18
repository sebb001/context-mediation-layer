#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { dirname } from "node:path";

interface PublicBridgeOptions {
  upstreamUrl: string;
  upstreamToken?: string;
  publicToken?: string;
  allowInsecure?: boolean;
  allowedTools: Set<string>;
  allowedOrigins: Set<string>;
  requiredActor?: string;
  writableExactPaths?: Set<string>;
  writablePathPrefixes?: string[];
  writablePathSuffixes?: string[];
  allowAllWritablePaths?: boolean;
  assumedRole?: string;
  invokedSkillRef?: string;
  policyRef?: string;
  governingContractKey?: string;
  allowClientInvocationContext?: boolean;
  maxBodyBytes?: number;
  oauth?: OAuthOptions;
}

interface OAuthOptions {
  issuer: string;
  audience?: string;
  resource?: string;
  protectedResourceMetadataUrl?: string;
  jwksUrl?: string;
  jwks?: JsonWebKeyRecord[];
  scopesSupported?: string[];
  subjectActorMap?: Map<string, string>;
  groupActorMap?: Map<string, string>;
  defaultActor?: string;
  allowedAlgorithms?: Set<string>;
  pilotIssuer?: PilotOAuthIssuerOptions;
  fetch?: typeof fetch;
  now?: () => number;
}

interface PilotOAuthIssuerOptions {
  privateKeyPem: string;
  keyId: string;
  authorizationSecret: string;
  clientStorePath?: string;
  subject: string;
  groups?: string[];
  scopes: string[];
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  groups?: string[];
  roles?: string[];
  scope?: string;
}

type AuthResult =
  | { ok: true; actor?: string }
  | { ok: false; code: string; message: string };

type JsonWebKeyRecord = JsonWebKey & { kid?: string; alg?: string };

interface PilotOAuthClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "client_secret_basic" | "client_secret_post" | "none";
  created_at: number;
}

interface PilotRefreshToken {
  token_hash: string;
  client_id: string;
  subject: string;
  scope: string;
  expires_at: number;
}

interface PilotOAuthStore {
  clients: PilotOAuthClient[];
  refresh_tokens: PilotRefreshToken[];
}

interface PilotAuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope: string;
  subject: string;
  expiresAt: number;
}

const DEFAULT_ALLOWED_TOOLS = [
  "ui_manifest",
  "ui_runtime_get",
  "operator_state_get",
  "actor_get",
  "actor_list",
  "role_get",
  "role_list",
  "role_binding_list",
  "status",
  "intent_get",
  "intent_list",
  "interpret_get",
  "interpret_list",
  "interpretation_get",
  "interpretation_list",
  "report_list",
  "contract_get",
  "contract_list",
  "actor_type_get",
  "actor_type_list",
  "vault_read",
  "vault_search",
];

const VAULT_MUTATION_TOOLS = new Set(["vault_write", "vault_append", "vault_move", "vault_delete"]);
const DEFAULT_OAUTH_SCOPES = ["cml:read"];
const pilotAuthorizationCodes = new Map<string, PilotAuthorizationCode>();
const memoryPilotStore: PilotOAuthStore = { clients: [], refresh_tokens: [] };

export function createCmlPublicMcpBridge(options: PublicBridgeOptions): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, {
      ...options,
      maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: PublicBridgeOptions & { maxBodyBytes: number }
): Promise<void> {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/health") {
      writeJson(response, 200, { ok: true, service: "cml-public-mcp-bridge" });
      return;
    }
    if (isProtectedResourceMetadataPath(requestUrl.pathname) && options.oauth) {
      writeJson(response, 200, protectedResourceMetadata(request, options.oauth));
      return;
    }
    if (options.oauth?.pilotIssuer && await handlePilotOAuthRequest(request, response, requestUrl, options.oauth, options.maxBodyBytes)) {
      return;
    }
    if (!isMcpEndpointPath(requestUrl.pathname)) {
      writeJson(response, 404, jsonRpcError(null, -32004, "Not found"));
      return;
    }
    if (!isAllowedOrigin(request, options.allowedOrigins)) {
      writeJson(response, 403, jsonRpcError(null, -32003, "Forbidden origin"));
      return;
    }
    const auth = await authorizeRequest(request, options);
    if (!auth.ok) {
      response.setHeader("WWW-Authenticate", authenticateHeader(request, options, auth));
      writeJson(response, 401, jsonRpcError(null, -32001, auth.message));
      return;
    }
    if (request.method === "GET" || request.method === "DELETE") {
      response.setHeader("Allow", "POST");
      writeJson(response, 405, jsonRpcError(null, -32005, `${request.method} is not enabled; this bridge uses JSON-response POST only`));
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      writeJson(response, 405, jsonRpcError(null, -32005, "Method not allowed"));
      return;
    }

    const rawBody = await readRequestBody(request, options.maxBodyBytes);
    const message = JSON.parse(rawBody);
    const blocked = validateAllowedTool(message, options.allowedTools);
    if (blocked) {
      writeJson(response, 200, blocked);
      return;
    }
    const authorized = authorizeAndNormalizeMessage(message, options, auth.actor);
    if (authorized.blocked) {
      writeJson(response, 200, authorized.blocked);
      return;
    }

    const upstream = await fetch(options.upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders(request, options),
      body: JSON.stringify(authorized.message),
    });
    if (upstream.status === 202) {
      response.writeHead(202);
      response.end();
      return;
    }
    const body = await upstream.json();
    writeJson(response, upstream.status, filterToolList(body, options.allowedTools));
  } catch (error) {
    writeJson(response, 400, jsonRpcError(null, -32700, error instanceof Error ? error.message : String(error)));
  }
}

function authorizeAndNormalizeMessage(
  message: unknown,
  options: PublicBridgeOptions,
  authenticatedActor?: string
): { message: unknown; blocked?: Record<string, unknown> } {
  if (!isRecord(message)) return { message };
  if (message.method !== "tools/call") return { message };
  const params = isRecord(message.params) ? message.params : {};
  const name = typeof params.name === "string" ? params.name : "";
  const args = isRecord(params.arguments) ? params.arguments : {};
  const actorResult = applyRequiredActor(args, authenticatedActor ?? options.requiredActor);
  if (actorResult.blocked) {
    return { message, blocked: toolPolicyError(message, actorResult.blocked.code, actorResult.blocked.message) };
  }
  const pathResult = validateWritablePath(name, actorResult.args, options);
  if (pathResult) {
    return { message, blocked: toolPolicyError(message, pathResult.code, pathResult.message) };
  }
  return {
    message: {
      ...message,
      params: {
        ...params,
        arguments: applyInvocationContext(actorResult.args, options),
      },
    },
  };
}

function applyInvocationContext(args: Record<string, unknown>, options: PublicBridgeOptions): Record<string, unknown> {
  const baseArgs = options.allowClientInvocationContext ? args : stripClientInvocationContext(args);
  return {
    ...baseArgs,
    ...(options.assumedRole ? { assumedRole: options.assumedRole } : {}),
    ...(options.invokedSkillRef ? { invokedSkillRef: options.invokedSkillRef } : {}),
    ...(options.policyRef ? { policyRef: options.policyRef } : {}),
    ...(options.governingContractKey ? { governingContractKey: options.governingContractKey } : {}),
  };
}

function stripClientInvocationContext(args: Record<string, unknown>): Record<string, unknown> {
  const { assumedRole, invokedSkillRef, policyRef, governingContractKey, ...rest } = args;
  return rest;
}

function applyRequiredActor(
  args: Record<string, unknown>,
  requiredActor: string | undefined
): { args: Record<string, unknown>; blocked?: { code: string; message: string } } {
  if (!requiredActor) return { args };
  const actor = args.actor;
  if (actor != null && actor !== requiredActor) {
    return {
      args,
      blocked: {
        code: "ACTOR_NOT_PERMITTED",
        message: `This public CML bridge is scoped to actor '${requiredActor}'.`,
      },
    };
  }
  return { args: { ...args, actor: requiredActor } };
}

function validateWritablePath(
  name: string,
  args: Record<string, unknown>,
  options: PublicBridgeOptions
): { code: string; message: string } | undefined {
  if (!VAULT_MUTATION_TOOLS.has(name)) return undefined;
  if (!Number.isInteger(args.intent)) {
    return {
      code: "INTENT_REQUIRED",
      message: `Tool '${name}' requires an integer intent mandate.`,
    };
  }
  const path = typeof args.path === "string" ? normalizeVaultPath(args.path) : undefined;
  if (!path) {
    return {
      code: "PATH_REQUIRED",
      message: `Tool '${name}' requires a vault-relative path.`,
    };
  }
  if (!isWritablePath(path, options)) {
    return {
      code: "PATH_NOT_PERMITTED",
      message: `Path '${path}' is not writable through this public CML bridge.`,
    };
  }
  if (name === "vault_move") {
    const destination = typeof args.to === "string" ? normalizeVaultPath(args.to) : undefined;
    if (!destination || !isWritablePath(destination, options)) {
      return {
        code: "PATH_NOT_PERMITTED",
        message: "Move destination is not writable through this public CML bridge.",
      };
    }
  }
  return undefined;
}

function isWritablePath(path: string, options: PublicBridgeOptions): boolean {
  if (options.allowAllWritablePaths) return true;
  const exactPaths = options.writableExactPaths ?? new Set<string>();
  const prefixes = options.writablePathPrefixes ?? [];
  const suffixes = options.writablePathSuffixes ?? [];
  const exact = exactPaths.has(path);
  const prefixed = prefixes.some((prefix) => path.startsWith(prefix));
  const suffixed = suffixes.length === 0 || suffixes.some((suffix) => path.endsWith(suffix));
  return (exact || prefixed) && suffixed;
}

function normalizeVaultPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (parts.length === 0 || parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return normalized;
}

function validateAllowedTool(message: unknown, allowedTools: Set<string>): Record<string, unknown> | undefined {
  if (!isRecord(message)) return undefined;
  if (message.method !== "tools/call") return undefined;
  const params = isRecord(message.params) ? message.params : {};
  const name = typeof params.name === "string" ? params.name : "";
  if (allowedTools.has(name)) return undefined;
  return toolPolicyError(message, "TOOL_NOT_EXPOSED", `Tool '${name}' is not exposed by the public CML bridge.`);
}

function toolPolicyError(message: Record<string, unknown>, code: string, errorMessage: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: toJsonRpcId(message.id),
    result: {
      content: [{ type: "text", text: errorMessage }],
      structuredContent: {
        ok: false,
        error: {
          code,
          message: errorMessage,
        },
      },
      isError: true,
    },
  };
}

function filterToolList(body: unknown, allowedTools: Set<string>): unknown {
  if (!isRecord(body)) return body;
  if (!isRecord(body.result)) return body;
  const tools = body.result.tools;
  if (!Array.isArray(tools)) return body;
  return {
    ...body,
    result: {
      ...body.result,
      tools: tools.filter((tool) => isRecord(tool) && typeof tool.name === "string" && allowedTools.has(tool.name)),
    },
  };
}

function upstreamHeaders(request: IncomingMessage, options: PublicBridgeOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  const protocolVersion = request.headers["mcp-protocol-version"];
  if (typeof protocolVersion === "string") headers["MCP-Protocol-Version"] = protocolVersion;
  if (options.upstreamToken) headers.Authorization = `Bearer ${options.upstreamToken}`;
  return headers;
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

function isAllowedOrigin(request: IncomingMessage, allowedOrigins: Set<string>): boolean {
  const origin = request.headers.origin;
  if (origin == null || allowedOrigins.size === 0) return true;
  if (typeof origin !== "string") return false;
  return allowedOrigins.has(origin);
}

function isProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp";
}

function isMcpEndpointPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname === "/";
}

function protectedResourceMetadata(request: IncomingMessage, options: OAuthOptions): Record<string, unknown> {
  return {
    resource: oauthResource(request, options),
    authorization_servers: [trimTrailingSlash(options.issuer)],
    bearer_methods_supported: ["header"],
    scopes_supported: options.scopesSupported ?? DEFAULT_OAUTH_SCOPES,
    resource_name: "CML Public MCP",
    ...(options.pilotIssuer ? { service_documentation: "CML pilot OAuth issuer; replace with production identity for non-pilot deployments." } : {}),
  };
}

function authenticateHeader(
  request: IncomingMessage,
  options: PublicBridgeOptions,
  auth: Extract<AuthResult, { ok: false }>
): string {
  if (!options.oauth) return "Bearer";
  const params = [
    ["realm", "CML"],
    ["error", auth.code === "OAUTH_TOKEN_REQUIRED" ? "invalid_request" : "invalid_token"],
    ["error_description", auth.message],
    ["resource_metadata", oauthProtectedResourceMetadataUrl(request, options.oauth)],
  ];
  const scopes = (options.oauth.scopesSupported ?? DEFAULT_OAUTH_SCOPES).join(" ");
  if (scopes) params.push(["scope", scopes]);
  return `Bearer ${params.map(([key, value]) => `${key}="${headerEscape(value)}"`).join(", ")}`;
}

function oauthResource(request: IncomingMessage, options: OAuthOptions): string {
  return options.resource ?? `${requestOrigin(request)}/mcp`;
}

function oauthProtectedResourceMetadataUrl(request: IncomingMessage, options: OAuthOptions): string {
  return options.protectedResourceMetadataUrl ?? `${requestOrigin(request)}/.well-known/oauth-protected-resource`;
}

function requestOrigin(request: IncomingMessage): string {
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const proto = forwardedProto ?? "http";
  const host = forwardedHost ?? firstHeader(request.headers.host) ?? "localhost";
  return `${proto}://${host}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function headerEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function authorizeRequest(request: IncomingMessage, options: PublicBridgeOptions): Promise<AuthResult> {
  if (options.oauth) return authorizeOAuthRequest(request, options.oauth);
  if (options.allowInsecure) return { ok: true };
  if (!options.publicToken) return { ok: false, code: "UNAUTHORIZED", message: "Unauthorized" };
  return request.headers.authorization === `Bearer ${options.publicToken}`
    ? { ok: true }
    : { ok: false, code: "UNAUTHORIZED", message: "Unauthorized" };
}

async function authorizeOAuthRequest(request: IncomingMessage, options: OAuthOptions): Promise<AuthResult> {
  const token = readBearerToken(request);
  if (!token) return { ok: false, code: "OAUTH_TOKEN_REQUIRED", message: "OAuth bearer token required" };
  const result = await verifyOAuthJwt(token, options);
  if (!result.ok) return { ok: false, code: result.code, message: "Invalid OAuth bearer token" };
  const actor = mapOAuthActor(result.claims, options);
  if (!actor) return { ok: false, code: "OAUTH_ACTOR_NOT_MAPPED", message: "OAuth token is not mapped to a CML actor" };
  return { ok: true, actor };
}

function readBearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

async function verifyOAuthJwt(
  token: string,
  options: OAuthOptions
): Promise<{ ok: true; claims: JwtClaims } | { ok: false; code: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, code: "JWT_MALFORMED" };

  const header = parseJwtPart<JwtHeader>(parts[0]);
  const claims = parseJwtPart<JwtClaims>(parts[1]);
  if (!header || !claims) return { ok: false, code: "JWT_MALFORMED" };

  const allowedAlgorithms = options.allowedAlgorithms ?? new Set(["RS256"]);
  if (!allowedAlgorithms.has(header.alg)) return { ok: false, code: "JWT_ALGORITHM_NOT_ALLOWED" };
  if (claims.iss !== options.issuer) return { ok: false, code: "JWT_ISSUER_MISMATCH" };
  const expectedAudience = options.audience ?? options.resource;
  if (expectedAudience && !audienceMatches(claims.aud, expectedAudience)) return { ok: false, code: "JWT_AUDIENCE_MISMATCH" };

  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  if (claims.exp != null && claims.exp <= now) return { ok: false, code: "JWT_EXPIRED" };
  if (claims.nbf != null && claims.nbf > now) return { ok: false, code: "JWT_NOT_YET_VALID" };

  const keys = await fetchJwks(options);
  const key = selectJwksKey(keys, header);
  if (!key) return { ok: false, code: "JWT_KEY_NOT_FOUND" };
  if (!verifyJwtSignature(parts[0], parts[1], parts[2], header.alg, key)) {
    return { ok: false, code: "JWT_SIGNATURE_INVALID" };
  }
  return { ok: true, claims };
}

function parseJwtPart<T>(part: string): T | undefined {
  try {
    const json = Buffer.from(base64UrlToBase64(part), "base64").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

function base64UrlToBase64(value: string): string {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function audienceMatches(actual: string | string[] | undefined, expected: string): boolean {
  return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
}

async function fetchJwks(options: OAuthOptions): Promise<JsonWebKeyRecord[]> {
  if (options.jwks) return options.jwks;
  if (options.pilotIssuer) return pilotJwks(options.pilotIssuer);
  const jwksUrl = options.jwksUrl ?? await discoverJwksUrl(options);
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(jwksUrl);
  if (!response.ok) throw new Error("Could not fetch OAuth JWKS");
  const body = await response.json();
  if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error("OAuth JWKS response must include keys");
  return body.keys.filter(isRecord) as JsonWebKeyRecord[];
}

async function discoverJwksUrl(options: OAuthOptions): Promise<string> {
  const issuer = options.issuer.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error("Could not fetch OAuth discovery document");
  const body = await response.json();
  if (!isRecord(body) || typeof body.jwks_uri !== "string") throw new Error("OAuth discovery document must include jwks_uri");
  return body.jwks_uri;
}

function selectJwksKey(keys: JsonWebKeyRecord[], header: JwtHeader): JsonWebKeyRecord | undefined {
  if (header.kid) {
    const byKid = keys.find((key) => key.kid === header.kid);
    if (byKid) return byKid;
  }
  return keys.find((key) => !key.alg || key.alg === header.alg);
}

function verifyJwtSignature(header: string, payload: string, signature: string, algorithm: string, key: JsonWebKeyRecord): boolean {
  if (algorithm !== "RS256") return false;
  const keyObject = createPublicKey({ key, format: "jwk" });
  return verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    keyObject,
    Buffer.from(base64UrlToBase64(signature), "base64")
  );
}

function mapOAuthActor(claims: JwtClaims, options: OAuthOptions): string | undefined {
  const subjectMap = options.subjectActorMap ?? new Map<string, string>();
  if (claims.sub) {
    const direct = subjectMap.get(claims.sub);
    if (direct) return direct;
    if (claims.iss) {
      const issuerScoped = subjectMap.get(`${claims.iss}|${claims.sub}`);
      if (issuerScoped) return issuerScoped;
    }
  }

  const groupMap = options.groupActorMap ?? new Map<string, string>();
  for (const group of oauthGroups(claims)) {
    const actor = groupMap.get(group);
    if (actor) return actor;
  }

  return options.defaultActor;
}

function oauthGroups(claims: JwtClaims): string[] {
  const groups = [
    ...(Array.isArray(claims.groups) ? claims.groups : []),
    ...(Array.isArray(claims.roles) ? claims.roles : []),
    ...(typeof claims.scope === "string" ? claims.scope.split(/\s+/) : []),
  ];
  return groups.filter(Boolean);
}

async function handlePilotOAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  options: OAuthOptions,
  maxBodyBytes: number
): Promise<boolean> {
  if (requestUrl.pathname === "/.well-known/oauth-authorization-server" || requestUrl.pathname === "/.well-known/openid-configuration") {
    writeJson(response, 200, authorizationServerMetadata(options));
    return true;
  }
  if (requestUrl.pathname === "/jwks.json") {
    writeJson(response, 200, { keys: pilotJwks(options.pilotIssuer!) });
    return true;
  }
  if (requestUrl.pathname === "/register") {
    await handlePilotRegistration(request, response, options, maxBodyBytes);
    return true;
  }
  if (requestUrl.pathname === "/authorize") {
    await handlePilotAuthorization(request, response, requestUrl, options, maxBodyBytes);
    return true;
  }
  if (requestUrl.pathname === "/token") {
    await handlePilotToken(request, response, options, maxBodyBytes);
    return true;
  }
  return false;
}

function authorizationServerMetadata(options: OAuthOptions): Record<string, unknown> {
  const issuer = trimTrailingSlash(options.issuer);
  const scopes = options.scopesSupported ?? options.pilotIssuer?.scopes ?? DEFAULT_OAUTH_SCOPES;
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    jwks_uri: `${issuer}/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    scopes_supported: scopes,
    resource_indicators_supported: true,
    ...(options.pilotIssuer ? { service_documentation: "CML pilot OAuth issuer; replace with production identity for non-pilot deployments." } : {}),
  };
}

async function handlePilotRegistration(
  request: IncomingMessage,
  response: ServerResponse,
  options: OAuthOptions,
  maxBodyBytes: number
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writeOAuthError(response, 405, "invalid_request", "Dynamic client registration requires POST");
    return;
  }
  const body = JSON.parse(await readRequestBody(request, maxBodyBytes));
  if (!isRecord(body) || !Array.isArray(body.redirect_uris)) {
    writeOAuthError(response, 400, "invalid_client_metadata", "redirect_uris must be provided");
    return;
  }
  const redirectUris = body.redirect_uris.filter((uri): uri is string => typeof uri === "string");
  if (redirectUris.length === 0 || redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
    writeOAuthError(response, 400, "invalid_redirect_uri", "redirect_uris must be HTTPS or localhost URLs");
    return;
  }
  const authMethod = typeof body.token_endpoint_auth_method === "string"
    ? body.token_endpoint_auth_method
    : "client_secret_basic";
  if (!["client_secret_basic", "client_secret_post", "none"].includes(authMethod)) {
    writeOAuthError(response, 400, "invalid_client_metadata", "Unsupported token_endpoint_auth_method");
    return;
  }

  const store = readPilotStore(options.pilotIssuer!);
  const client: PilotOAuthClient = {
    client_id: `cml_${randomToken(18)}`,
    ...(authMethod === "none" ? {} : { client_secret: randomToken(32) }),
    client_name: typeof body.client_name === "string" ? body.client_name : "MCP client",
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod as PilotOAuthClient["token_endpoint_auth_method"],
    created_at: Math.floor(Date.now() / 1000),
  };
  store.clients.push(client);
  writePilotStore(options.pilotIssuer!, store);

  writeOAuthJson(response, 201, {
    client_id: client.client_id,
    ...(client.client_secret ? { client_secret: client.client_secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: client.created_at,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: client.token_endpoint_auth_method,
  });
}

async function handlePilotAuthorization(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  options: OAuthOptions,
  maxBodyBytes: number
): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    writeHtml(response, 405, "Method not allowed");
    return;
  }
  const params = request.method === "POST"
    ? new URLSearchParams(await readRequestBody(request, maxBodyBytes))
    : requestUrl.searchParams;
  const authorization = validatePilotAuthorizationParams(params, options);
  if ("error" in authorization) {
    writeHtml(response, 400, authorization.error);
    return;
  }

  if (request.method === "GET") {
    writeHtml(response, 200, pilotAuthorizationForm(params));
    return;
  }

  const submittedSecret = params.get("authorization_secret") ?? "";
  if (!safeEqual(submittedSecret, options.pilotIssuer!.authorizationSecret)) {
    writeHtml(response, 401, pilotAuthorizationForm(params, "Access key did not match."));
    return;
  }

  const code = randomToken(32);
  pilotAuthorizationCodes.set(code, {
    clientId: authorization.client.client_id,
    redirectUri: authorization.redirectUri,
    codeChallenge: authorization.codeChallenge,
    resource: authorization.resource,
    scope: authorization.scope,
    subject: options.pilotIssuer!.subject,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  const redirect = new URL(authorization.redirectUri);
  redirect.searchParams.set("code", code);
  if (authorization.state) redirect.searchParams.set("state", authorization.state);
  response.writeHead(302, {
    "Cache-Control": "no-store",
    "Location": redirect.toString(),
  });
  response.end();
}

function validatePilotAuthorizationParams(
  params: URLSearchParams,
  options: OAuthOptions
): {
  client: PilotOAuthClient;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope: string;
  state?: string;
} | { error: string } {
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const responseType = params.get("response_type");
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");
  if (!clientId || !redirectUri || responseType !== "code") return { error: "Invalid authorization request." };
  if (!codeChallenge || codeChallengeMethod !== "S256") return { error: "PKCE S256 is required." };
  const client = readPilotStore(options.pilotIssuer!).clients.find((record) => record.client_id === clientId);
  if (!client) return { error: "OAuth client is not registered." };
  if (!client.redirect_uris.includes(redirectUri)) return { error: "Redirect URI is not registered for this client." };
  const resource = params.get("resource") ?? undefined;
  if (resource && resource !== options.resource) return { error: "Requested OAuth resource is not this MCP server." };
  const scope = requestedScope(params.get("scope"), options);
  if (!scope) return { error: "Requested OAuth scope is not supported." };
  return {
    client,
    redirectUri,
    codeChallenge,
    resource,
    scope,
    state: params.get("state") ?? undefined,
  };
}

async function handlePilotToken(
  request: IncomingMessage,
  response: ServerResponse,
  options: OAuthOptions,
  maxBodyBytes: number
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writeOAuthError(response, 405, "invalid_request", "Token endpoint requires POST");
    return;
  }
  const params = new URLSearchParams(await readRequestBody(request, maxBodyBytes));
  const grantType = params.get("grant_type");
  const clientResult = authenticatePilotClient(request, params, options);
  if ("error" in clientResult) {
    writeOAuthError(response, 401, "invalid_client", clientResult.error);
    return;
  }

  if (grantType === "authorization_code") {
    await handlePilotAuthorizationCodeToken(response, params, options, clientResult.client);
    return;
  }
  if (grantType === "refresh_token") {
    await handlePilotRefreshToken(response, params, options, clientResult.client);
    return;
  }
  writeOAuthError(response, 400, "unsupported_grant_type", "Unsupported grant_type");
}

async function handlePilotAuthorizationCodeToken(
  response: ServerResponse,
  params: URLSearchParams,
  options: OAuthOptions,
  client: PilotOAuthClient
): Promise<void> {
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const verifier = params.get("code_verifier");
  if (!code || !redirectUri || !verifier) {
    writeOAuthError(response, 400, "invalid_request", "code, redirect_uri, and code_verifier are required");
    return;
  }
  const authorization = pilotAuthorizationCodes.get(code);
  pilotAuthorizationCodes.delete(code);
  const now = Math.floor(Date.now() / 1000);
  if (!authorization || authorization.clientId !== client.client_id || authorization.redirectUri !== redirectUri || authorization.expiresAt <= now) {
    writeOAuthError(response, 400, "invalid_grant", "Authorization code is invalid or expired");
    return;
  }
  if (!pkceMatches(verifier, authorization.codeChallenge)) {
    writeOAuthError(response, 400, "invalid_grant", "PKCE verifier did not match");
    return;
  }
  const requestedResource = params.get("resource");
  if (requestedResource && requestedResource !== (authorization.resource ?? options.resource)) {
    writeOAuthError(response, 400, "invalid_target", "Requested resource does not match authorization code");
    return;
  }
  issuePilotTokens(response, options, client, authorization.subject, authorization.scope);
}

async function handlePilotRefreshToken(
  response: ServerResponse,
  params: URLSearchParams,
  options: OAuthOptions,
  client: PilotOAuthClient
): Promise<void> {
  const refreshToken = params.get("refresh_token");
  if (!refreshToken) {
    writeOAuthError(response, 400, "invalid_request", "refresh_token is required");
    return;
  }
  const store = readPilotStore(options.pilotIssuer!);
  const tokenHash = tokenHashFor(refreshToken);
  const now = Math.floor(Date.now() / 1000);
  const existing = store.refresh_tokens.find((token) => token.token_hash === tokenHash && token.client_id === client.client_id && token.expires_at > now);
  if (!existing) {
    writeOAuthError(response, 400, "invalid_grant", "Refresh token is invalid or expired");
    return;
  }
  store.refresh_tokens = store.refresh_tokens.filter((token) => token.token_hash !== tokenHash);
  writePilotStore(options.pilotIssuer!, store);
  issuePilotTokens(response, options, client, existing.subject, existing.scope);
}

function issuePilotTokens(
  response: ServerResponse,
  options: OAuthOptions,
  client: PilotOAuthClient,
  subject: string,
  scope: string
): void {
  const pilot = options.pilotIssuer!;
  const now = Math.floor(Date.now() / 1000);
  const ttl = pilot.accessTokenTtlSeconds ?? 900;
  const refreshTtl = pilot.refreshTokenTtlSeconds ?? 60 * 60 * 24 * 30;
  const refreshToken = randomToken(32);
  const store = readPilotStore(pilot);
  store.refresh_tokens = [
    ...store.refresh_tokens.filter((token) => token.expires_at > now),
    {
      token_hash: tokenHashFor(refreshToken),
      client_id: client.client_id,
      subject,
      scope,
      expires_at: now + refreshTtl,
    },
  ];
  writePilotStore(pilot, store);

  const accessToken = signPilotJwt(
    {
      iss: options.issuer,
      sub: subject,
      aud: options.audience ?? options.resource,
      iat: now,
      exp: now + ttl,
      scope,
      ...(pilot.groups && pilot.groups.length > 0 ? { groups: pilot.groups } : {}),
    },
    pilot
  );
  writeOAuthJson(response, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttl,
    refresh_token: refreshToken,
    scope,
  });
}

function authenticatePilotClient(
  request: IncomingMessage,
  params: URLSearchParams,
  options: OAuthOptions
): { client: PilotOAuthClient } | { error: string } {
  const credentials = clientCredentials(request, params);
  if (!credentials.clientId) return { error: "client_id is required" };
  const client = readPilotStore(options.pilotIssuer!).clients.find((record) => record.client_id === credentials.clientId);
  if (!client) return { error: "OAuth client is not registered" };
  if (client.token_endpoint_auth_method === "none") return { client };
  if (!client.client_secret || !credentials.clientSecret || !safeEqual(client.client_secret, credentials.clientSecret)) {
    return { error: "client_secret did not match" };
  }
  return { client };
}

function clientCredentials(request: IncomingMessage, params: URLSearchParams): { clientId?: string; clientSecret?: string } {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator >= 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, separator)),
        clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    }
  }
  return {
    clientId: params.get("client_id") ?? undefined,
    clientSecret: params.get("client_secret") ?? undefined,
  };
}

function pilotAuthorizationForm(params: URLSearchParams, error?: string): string {
  const hidden = [...params.entries()]
    .filter(([key]) => key !== "authorization_secret")
    .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CML Pilot Access</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #15171a; }
    main { width: min(420px, calc(100vw - 32px)); background: white; border: 1px solid #d8dde5; border-radius: 8px; padding: 24px; }
    label, input, button { display: block; width: 100%; box-sizing: border-box; }
    input { margin-top: 8px; padding: 10px 12px; border: 1px solid #b7c0cc; border-radius: 6px; font: inherit; }
    button { margin-top: 16px; padding: 10px 12px; border: 0; border-radius: 6px; background: #155eef; color: white; font: inherit; }
    p { margin: 0 0 16px; }
    .error { color: #b42318; }
  </style>
</head>
<body>
  <main>
    <p>Authorize this MCP client for CML pilot access.</p>
    ${error ? `<p class="error">${htmlEscape(error)}</p>` : ""}
    <form method="post">
      ${hidden}
      <label>Access key
        <input name="authorization_secret" type="password" autocomplete="current-password" autofocus>
      </label>
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>`;
}

function requestedScope(rawScope: string | null, options: OAuthOptions): string | undefined {
  const allowed = new Set(options.pilotIssuer?.scopes ?? options.scopesSupported ?? DEFAULT_OAUTH_SCOPES);
  const requested = rawScope ? rawScope.split(/\s+/).filter(Boolean) : [...allowed];
  if (requested.length === 0 || requested.some((scope) => !allowed.has(scope))) return undefined;
  return requested.join(" ");
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const hashed = createHash("sha256").update(verifier).digest();
  return safeEqual(base64UrlEncode(hashed), challenge);
}

function pilotJwks(options: PilotOAuthIssuerOptions): JsonWebKeyRecord[] {
  const publicKey = createPublicKey(pilotPrivateKey(options));
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKeyRecord & { use?: string };
  jwk.kid = options.keyId;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return [jwk];
}

function signPilotJwt(claims: Record<string, unknown>, options: PilotOAuthIssuerOptions): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: options.keyId, typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), pilotPrivateKey(options));
  return `${header}.${payload}.${base64UrlEncode(signature)}`;
}

function pilotPrivateKey(options: PilotOAuthIssuerOptions): KeyObject {
  return createPrivateKey(options.privateKeyPem);
}

function readPilotStore(options: PilotOAuthIssuerOptions): PilotOAuthStore {
  if (!options.clientStorePath) return memoryPilotStore;
  if (!existsSync(options.clientStorePath)) return { clients: [], refresh_tokens: [] };
  const parsed = JSON.parse(readFileSync(options.clientStorePath, "utf8"));
  if (!isRecord(parsed)) return { clients: [], refresh_tokens: [] };
  return {
    clients: Array.isArray(parsed.clients) ? parsed.clients.filter(isRecord) as unknown as PilotOAuthClient[] : [],
    refresh_tokens: Array.isArray(parsed.refresh_tokens) ? parsed.refresh_tokens.filter(isRecord) as unknown as PilotRefreshToken[] : [],
  };
}

function writePilotStore(options: PilotOAuthIssuerOptions, store: PilotOAuthStore): void {
  if (!options.clientStorePath) {
    memoryPilotStore.clients = store.clients;
    memoryPilotStore.refresh_tokens = store.refresh_tokens;
    return;
  }
  mkdirSync(dirname(options.clientStorePath), { recursive: true });
  writeFileSync(options.clientStorePath, JSON.stringify(store, null, 2));
}

function tokenHashFor(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(bytes: number): string {
  return base64UrlEncode(randomBytes(bytes));
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeOAuthJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.setHeader("Cache-Control", "no-store");
  writeJson(response, statusCode, body);
}

function writeOAuthError(response: ServerResponse, statusCode: number, error: string, description: string): void {
  writeOAuthJson(response, statusCode, { error, error_description: description });
}

function writeHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
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

function toJsonRpcId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" || value === null ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCsv(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseKeyValueMap(value: string | undefined): Map<string, string> | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) throw new Error("OAuth actor map JSON must be an object");
    return new Map(Object.entries(parsed).map(([key, actor]) => {
      if (typeof actor !== "string" || actor.length === 0) throw new Error("OAuth actor map values must be non-empty strings");
      return [key, actor];
    }));
  }
  const entries: Array<[string, string]> = trimmed.split(",").map((entry): [string, string] => {
    const index = entry.indexOf("=");
    if (index <= 0) throw new Error("OAuth actor map entries must look like claim=actor");
    return [entry.slice(0, index).trim(), entry.slice(index + 1).trim()];
  }).filter(([key, actor]) => key.length > 0 && actor.length > 0);
  return new Map(entries);
}

function oauthOptionsFromEnv(publicBaseUrl?: string): OAuthOptions | undefined {
  const pilotEnabled = firstEnv("CML_OAUTH_PILOT_ISSUER") === "1";
  const issuer = firstEnv("CML_OAUTH_ISSUER") ?? (pilotEnabled ? publicBaseUrl : undefined);
  if (!issuer) return undefined;
  const resource = firstEnv("CML_OAUTH_RESOURCE") ?? (publicBaseUrl ? `${trimTrailingSlash(publicBaseUrl)}/mcp` : undefined);
  const pilotIssuer = pilotEnabled ? pilotOAuthIssuerFromEnv() : undefined;
  return {
    issuer: trimTrailingSlash(issuer),
    audience: firstEnv("CML_OAUTH_AUDIENCE") ?? (pilotEnabled ? resource : undefined),
    resource,
    protectedResourceMetadataUrl: firstEnv("CML_OAUTH_PROTECTED_RESOURCE_METADATA_URL"),
    jwksUrl: firstEnv("CML_OAUTH_JWKS_URL"),
    scopesSupported: parseCsv(firstEnv("CML_OAUTH_SCOPES"), pilotIssuer?.scopes ?? DEFAULT_OAUTH_SCOPES),
    subjectActorMap: parseKeyValueMap(firstEnv("CML_OAUTH_SUBJECT_ACTOR_MAP")),
    groupActorMap: parseKeyValueMap(firstEnv("CML_OAUTH_GROUP_ACTOR_MAP")),
    defaultActor: firstEnv("CML_OAUTH_DEFAULT_ACTOR") ?? pilotIssuer?.subject,
    pilotIssuer,
  };
}

function pilotOAuthIssuerFromEnv(): PilotOAuthIssuerOptions {
  const privateKeyPath = firstEnv("CML_OAUTH_PRIVATE_KEY_PATH");
  const authorizationSecret = firstEnv("CML_OAUTH_AUTH_SECRET");
  if (!privateKeyPath) throw new Error("CML_OAUTH_PRIVATE_KEY_PATH is required when pilot OAuth issuer is enabled");
  if (!authorizationSecret) throw new Error("CML_OAUTH_AUTH_SECRET is required when pilot OAuth issuer is enabled");
  return {
    privateKeyPem: readFileSync(privateKeyPath, "utf8"),
    keyId: firstEnv("CML_OAUTH_KEY_ID") ?? "cml-pilot",
    authorizationSecret,
    clientStorePath: firstEnv("CML_OAUTH_CLIENT_STORE_PATH") ?? "./var/oauth/clients.json",
    subject: firstEnv("CML_OAUTH_PILOT_SUBJECT") ?? "pilot-user",
    groups: parseCsv(firstEnv("CML_OAUTH_PILOT_GROUPS")),
    scopes: parseCsv(firstEnv("CML_OAUTH_SCOPES"), DEFAULT_OAUTH_SCOPES),
    accessTokenTtlSeconds: parseOptionalInteger(firstEnv("CML_OAUTH_ACCESS_TOKEN_TTL_SECONDS")),
    refreshTokenTtlSeconds: parseOptionalInteger(firstEnv("CML_OAUTH_REFRESH_TOKEN_TTL_SECONDS")),
  };
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Expected positive integer");
  return parsed;
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid public MCP bridge port");
  return port;
}

function main(): void {
  const host = firstEnv("CML_PUBLIC_MCP_HOST") ?? "127.0.0.1";
  const port = parsePort(firstEnv("CML_PUBLIC_MCP_PORT"), 8788);
  const publicBaseUrl = firstEnv("CML_PUBLIC_MCP_BASE_URL") ?? `http://${host}:${port}`;
  const oauth = oauthOptionsFromEnv(publicBaseUrl);
  const publicToken = firstEnv("CML_PUBLIC_MCP_TOKEN");
  const allowInsecure = firstEnv("CML_PUBLIC_MCP_ALLOW_INSECURE") === "1";
  const upstreamUrl = firstEnv("CML_PUBLIC_MCP_UPSTREAM_URL") ?? "http://127.0.0.1:8787/mcp";
  const upstreamToken = firstEnv("CML_PUBLIC_MCP_UPSTREAM_TOKEN");
  if (oauth && allowInsecure) {
    throw new Error("CML_PUBLIC_MCP_ALLOW_INSECURE must not be set when OAuth is enabled");
  }
  if (oauth && !upstreamToken && !isLocalHttpUrl(upstreamUrl)) {
    throw new Error("CML_PUBLIC_MCP_UPSTREAM_TOKEN is required when OAuth protects a non-local upstream MCP server");
  }
  if (!oauth && !publicToken && !allowInsecure) {
    throw new Error("Set CML_PUBLIC_MCP_TOKEN, CML_OAUTH_ISSUER, or CML_OAUTH_PILOT_ISSUER=1 before starting cml-mcp-public");
  }
  const server = createCmlPublicMcpBridge({
    upstreamUrl,
    upstreamToken,
    publicToken,
    allowInsecure,
    allowedTools: new Set(parseCsv(firstEnv("CML_PUBLIC_MCP_ALLOWED_TOOLS"), DEFAULT_ALLOWED_TOOLS)),
    allowedOrigins: new Set(parseCsv(firstEnv("CML_PUBLIC_MCP_ALLOWED_ORIGINS"))),
    requiredActor: firstEnv("CML_PUBLIC_MCP_REQUIRED_ACTOR"),
    writableExactPaths: new Set(parseCsv(firstEnv("CML_PUBLIC_MCP_WRITABLE_EXACT_PATHS"))),
    writablePathPrefixes: parseCsv(firstEnv("CML_PUBLIC_MCP_WRITABLE_PATH_PREFIXES")),
    writablePathSuffixes: parseCsv(firstEnv("CML_PUBLIC_MCP_WRITABLE_PATH_SUFFIXES")),
    allowAllWritablePaths: firstEnv("CML_PUBLIC_MCP_ALLOW_ALL_WRITABLE_PATHS") === "1",
    assumedRole: firstEnv("CML_PUBLIC_MCP_ASSUMED_ROLE"),
    invokedSkillRef: firstEnv("CML_PUBLIC_MCP_INVOKED_SKILL_REF"),
    policyRef: firstEnv("CML_PUBLIC_MCP_POLICY_REF"),
    governingContractKey: firstEnv("CML_PUBLIC_MCP_GOVERNING_CONTRACT_KEY"),
    oauth,
  });
  server.listen(port, host, () => {
    process.stderr.write(`cml-mcp-public listening on http://${host}:${port}/mcp\n`);
  });
}

function firstEnv(...names: string[]): string | undefined {
  return names.map((name) => process.env[name]).find((value): value is string => Boolean(value));
}

function isLocalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

if (process.argv[1]?.endsWith("/mcp/public-bridge.js")) {
  main();
}
