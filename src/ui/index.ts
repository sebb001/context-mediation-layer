#!/usr/bin/env node

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { Actor, actorId as toActorId } from "../governance/domain.js";
import { GovernanceRepository } from "../governance/repository.js";
import { SqliteGovernanceRepository } from "../governance/sqlite-governance-repository.js";
import { GovernanceService } from "../governance/service.js";
import { inspectIntent, inspectInterpretation, inspectIntentTree } from "../orchestration/inspect.js";
import {
  DEFAULT_PUBLIC_MCP_BASE_URL,
  OperatorSurfaceState,
  buildOperatorSurfaceState,
  buildOperatorUiManifest,
  renderMediationCentreRuntime,
  renderOperatorRuntime,
} from "./runtime.js";

interface CmlUiOptions {
  dbPath?: string;
  repository?: GovernanceRepository;
  defaultActor?: string;
  defaultActorId?: number;
  host?: string;
  port?: number;
  publicMcpBaseUrl?: string;
  uiPublicUrls?: string[];
}

type UiContext = {
  repo?: GovernanceRepository;
  service?: GovernanceService;
  setupError?: {
    code: string;
    message: string;
  };
  defaultActor?: string;
  defaultActorId?: number;
  publicMcpBaseUrl?: string;
  uiPublicUrls?: string[];
};

export function createCmlUiServer(options: CmlUiOptions = {}): Server {
  const repo = options.repository ?? (options.dbPath ? openRepository(options.dbPath) : undefined);
  const context: UiContext = {
    repo,
    service: repo ? new GovernanceService(repo) : undefined,
    setupError: repo ? undefined : {
      code: "DB_PATH_REQUIRED",
      message: "Set CML_DB_PATH before starting cml-ui, or run `cml init`.",
    },
    defaultActor: options.defaultActor,
    defaultActorId: options.defaultActorId,
    publicMcpBaseUrl: options.publicMcpBaseUrl,
    uiPublicUrls: options.uiPublicUrls,
  };

  return createServer((request, response) => {
    void handleRequest(request, response, context);
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: UiContext): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const state = await maybeBuildOperatorSurfaceState(context);
      const runtime = renderOperatorRuntime(state, {
        mode: "remote-http",
        includeState: true,
        publicMcpBaseUrl: context.publicMcpBaseUrl,
        uiPublicUrls: context.uiPublicUrls,
      });
      writeText(response, 200, runtime.html, "text/html; charset=utf-8");
      return;
    }
    if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/human-surface" || url.pathname === "/human-surface/")) {
      response.writeHead(302, { Location: `/mediation-centre${url.search}` });
      response.end();
      return;
    }
    if (request.method === "GET" && (url.pathname === "/mediation-centre" || url.pathname === "/mediation-centre/")) {
      const state = await maybeBuildOperatorSurfaceState(context);
      const runtime = renderMediationCentreRuntime(state, {
        includeState: true,
        setupError: context.setupError,
      });
      writeText(response, 200, runtime.html, "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, service: "cml-ui" });
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      writeJson(response, 404, errorEnvelope("NOT_FOUND", "Not found"));
      return;
    }
    if (request.method === "GET") {
      await handleGet(url, response, context);
      return;
    }
    if (request.method === "POST" || request.method === "PATCH") {
      await handleWrite(request, url, response, context);
      return;
    }
    response.setHeader("Allow", "GET, POST, PATCH");
    writeJson(response, 405, errorEnvelope("METHOD_NOT_ALLOWED", "Method not allowed"));
  } catch (error) {
    writeJson(response, 500, errorEnvelope("UI_ERROR", error instanceof Error ? error.message : String(error)));
  }
}

async function handleGet(url: URL, response: ServerResponse, context: UiContext): Promise<void> {
  if (!context.repo || !context.service) {
    writeJson(response, 503, errorEnvelope(context.setupError?.code ?? "DB_UNAVAILABLE", context.setupError?.message ?? "cml-ui has no configured governance repository"));
    return;
  }

  if (url.pathname === "/api/operator-state") {
    const state = await maybeBuildOperatorSurfaceState(context);
    writeJson(response, 200, { ok: true, data: state, meta: { schema_version: 2 } });
    return;
  }

  if (url.pathname === "/api/ui-manifest") {
    const state = await maybeBuildOperatorSurfaceState(context);
    const runtime = renderOperatorRuntime(state, {
      mode: "mcp-sandbox",
      includeState: true,
      publicMcpBaseUrl: context.publicMcpBaseUrl,
      uiPublicUrls: context.uiPublicUrls,
    });
    writeJson(response, 200, {
      ok: true,
      data: buildOperatorUiManifest({
        runtime,
        publicMcpBaseUrl: context.publicMcpBaseUrl,
        uiPublicUrls: context.uiPublicUrls,
      }),
      meta: { schema_version: 2 },
    });
    return;
  }

  if (url.pathname === "/api/status") {
    const actor = await resolveDefaultActor(context);
    const intents = await context.service.listIntents({ status: "active", limit: 20 });
    const claims = await context.service.listClaims({ status: "active", limit: 20 });
    writeJson(response, 200, {
      ok: true,
      data: {
        actor,
        activeIntents: intents.ok ? intents.data : [],
        activeClaims: claims.ok ? claims.data : [],
      },
      meta: { schema_version: 2 },
    });
    return;
  }

  if (url.pathname === "/api/intents") {
    const status = optionalEnum(url.searchParams.get("status"), ["draft", "active", "closed", "superseded"]);
    const parentId = optionalNullableInteger(url.searchParams.get("parentId"));
    const result = await context.service.listIntents({
      scope: optionalString(url.searchParams.get("scope")),
      status,
      addressedTo: optionalInteger(url.searchParams.get("addressedTo")),
      ...(parentId !== undefined ? { parentId } : {}),
      limit: optionalInteger(url.searchParams.get("limit")) ?? 50,
      offset: optionalInteger(url.searchParams.get("offset")),
    });
    writeJson(response, result.ok ? 200 : 400, result);
    return;
  }

  const intentMatch = url.pathname.match(/^\/api\/intents\/(\d+)$/);
  if (intentMatch) {
    const result = await inspectIntent(Number(intentMatch[1]), context.service);
    writeJson(response, result.ok ? 200 : 404, result);
    return;
  }

  const treeMatch = url.pathname.match(/^\/api\/intents\/(\d+)\/tree$/);
  if (treeMatch) {
    const result = await inspectIntentTree(Number(treeMatch[1]), context.service);
    writeJson(response, result.ok ? 200 : 404, result);
    return;
  }

  const interpretationMatch = url.pathname.match(/^\/api\/interpretations\/(\d+)$/);
  if (interpretationMatch) {
    const result = await inspectInterpretation(Number(interpretationMatch[1]), context.service);
    writeJson(response, result.ok ? 200 : 404, result);
    return;
  }

  if (url.pathname === "/api/reports") {
    const result = await context.service.listReports({
      scope: optionalString(url.searchParams.get("scope")),
      kind: optionalString(url.searchParams.get("kind")),
      intentId: optionalInteger(url.searchParams.get("intentId")),
      domainId: optionalInteger(url.searchParams.get("domainId")),
      actorId: optionalInteger(url.searchParams.get("actorId")),
      limit: optionalInteger(url.searchParams.get("limit")) ?? 20,
      offset: optionalInteger(url.searchParams.get("offset")),
    });
    writeJson(response, result.ok ? 200 : 400, result);
    return;
  }

  writeJson(response, 404, errorEnvelope("NOT_FOUND", "API route not found"));
}

async function handleWrite(request: IncomingMessage, url: URL, response: ServerResponse, context: UiContext): Promise<void> {
  if (!context.repo || !context.service) {
    writeJson(response, 503, errorEnvelope(context.setupError?.code ?? "DB_UNAVAILABLE", context.setupError?.message ?? "cml-ui has no configured governance repository"));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/focus") {
    const actor = await requireDefaultActor(context);
    const body = await readJsonBody(request);
    const entityType = requiredString(body.entityType ?? body.entity_type, "entityType");
    const entityIdRaw = body.entityId ?? body.entity_id;
    const entityId = typeof entityIdRaw === "string" && entityIdRaw.startsWith("group:")
      ? Number(entityIdRaw.slice("group:".length))
      : requiredInteger(entityIdRaw, "entityId");
    const entityTable = focusEntityTable(entityType);
    const result = await context.repo.emitEvent("operator_focus", entityTable, entityId, toActorId(Number(actor.id)), {
      scope: actor.defaultScope,
      reason: optionalBodyString(body.pendingAction ?? body.pending_action, "pendingAction"),
      snapshot: stripUndefined({
        entityType,
        entityId: entityIdRaw,
        pendingAction: body.pendingAction ?? body.pending_action,
        parentIntentId: body.parentIntentId ?? body.parent_intent_id,
        alignment: body.alignment,
        hasDraft: body.hasDraft ?? body.has_draft,
      }),
    });
    writeJson(response, 201, { ok: true, data: result, meta: { schema_version: 2 } });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/intents") {
    const actor = await requireDefaultActor(context);
    const body = await readJsonBody(request);
    const result = await context.service.registerIntent({
      description: requiredString(body.description, "description"),
      source: optionalBodyString(body.source, "source") ?? `cml-ui:${actor.name}`,
      scope: optionalBodyString(body.scope, "scope") ?? actor.defaultScope,
      addressedTo: optionalBodyInteger(body.addressedTo, "addressedTo"),
      parentId: optionalBodyInteger(body.parentId, "parentId"),
      status: optionalIntentStatus(body.status),
      actorId: actor.id as number,
    });
    writeJson(response, result.ok ? 201 : 400, result);
    return;
  }

  const intentUpdateMatch = url.pathname.match(/^\/api\/intents\/(\d+)$/);
  if (request.method === "PATCH" && intentUpdateMatch) {
    const actor = await requireDefaultActor(context);
    const body = await readJsonBody(request);
    const result = await context.service.updateIntent({
      id: Number(intentUpdateMatch[1]),
      reason: requiredString(body.reason, "reason"),
      status: optionalIntentStatus(body.status),
      description: optionalBodyString(body.description, "description"),
      resolutionNotes: optionalBodyString(body.resolutionNotes, "resolutionNotes"),
      addressedTo: optionalBodyInteger(body.addressedTo, "addressedTo"),
      actorId: actor.id as number,
    });
    writeJson(response, result.ok ? 200 : 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/interpretations") {
    const actor = await requireDefaultActor(context);
    const body = await readJsonBody(request);
    const result = await context.service.registerInterpretation({
      intentId: requiredInteger(body.intentId, "intentId"),
      domainId: requiredInteger(body.domainId, "domainId"),
      actorId: actor.id as number,
      title: requiredString(body.title, "title"),
      scopeAssumption: optionalBodyString(body.scopeAssumption, "scopeAssumption"),
      status: optionalInterpretationStatus(body.status) ?? "proposed",
      alignment: optionalInterpretationAlignment(body.alignment) ?? "uncertain",
      sourceRef: optionalBodyString(body.sourceRef, "sourceRef") ?? `cml-ui:${actor.name}`,
      resolverId: optionalBodyInteger(body.resolverId, "resolverId"),
      resolveBy: optionalBodyString(body.resolveBy, "resolveBy"),
    });
    writeJson(response, result.ok ? 201 : 400, result);
    return;
  }

  const interpretationUpdateMatch = url.pathname.match(/^\/api\/interpretations\/(\d+)$/);
  if (request.method === "PATCH" && interpretationUpdateMatch) {
    const actor = await requireDefaultActor(context);
    const body = await readJsonBody(request);
    const result = await context.service.updateInterpretation({
      id: Number(interpretationUpdateMatch[1]),
      reason: requiredString(body.reason, "reason"),
      status: optionalInterpretationStatus(body.status),
      alignment: optionalInterpretationAlignment(body.alignment),
      resolverId: optionalBodyInteger(body.resolverId, "resolverId"),
      resolveBy: optionalBodyString(body.resolveBy, "resolveBy"),
      scopeAssumption: optionalBodyString(body.scopeAssumption, "scopeAssumption"),
      actorId: actor.id as number,
    });
    writeJson(response, result.ok ? 200 : 400, result);
    return;
  }

  const supersedeMatch = url.pathname.match(/^\/api\/interpretations\/(\d+)\/supersede$/);
  if (request.method === "POST" && supersedeMatch) {
    const body = await readJsonBody(request);
    await requireDefaultActor(context);
    const result = await context.service.supersedeInterpretation({
      id: Number(supersedeMatch[1]),
      newTitle: requiredString(body.newTitle, "newTitle"),
      reason: requiredString(body.reason, "reason"),
      newScopeAssumption: optionalBodyString(body.newScopeAssumption, "newScopeAssumption"),
      newStatus: optionalInterpretationStatus(body.newStatus),
    });
    writeJson(response, result.ok ? 201 : 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/actions") {
    const actor = await requireDefaultActor(context);
    const body = await readJsonBody(request);
    const intentId = requiredInteger(body.intentId, "intentId");
    const intent = await context.service.getIntent(intentId);
    if (!intent.ok) {
      writeJson(response, 404, intent);
      return;
    }
    if (intent.data.status !== "active") {
      writeJson(response, 400, errorEnvelope("INTENT_INACTIVE", `Intent ${intentId} is ${intent.data.status}`));
      return;
    }
    const result = await context.service.logAction({
      intentId,
      actorId: actor.id as number,
      interpretationId: optionalBodyInteger(body.interpretationId, "interpretationId"),
      domainId: optionalBodyInteger(body.domainId, "domainId"),
      description: requiredString(body.description, "description"),
      outcome: optionalBodyString(body.outcome, "outcome"),
      governingContractKey: optionalBodyString(body.governingContractKey, "governingContractKey"),
      assumedRole: optionalBodyString(body.assumedRole, "assumedRole"),
      invokedSkillRef: optionalBodyString(body.invokedSkillRef, "invokedSkillRef"),
      policyRef: optionalBodyString(body.policyRef, "policyRef"),
    });
    writeJson(response, result.ok ? 201 : 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/reports") {
    const actor = await requireDefaultActor(context);
    const body = await readJsonBody(request);
    const result = await context.service.registerReport({
      actorId: actor.id as number,
      kind: optionalBodyString(body.kind, "kind") ?? "operator-note",
      title: requiredString(body.title, "title"),
      summary: requiredString(body.summary, "summary"),
      scope: optionalBodyString(body.scope, "scope") ?? actor.defaultScope,
      bodyRef: optionalBodyString(body.bodyRef, "bodyRef"),
      sourceRef: optionalBodyString(body.sourceRef, "sourceRef"),
      assumedRole: optionalBodyString(body.assumedRole, "assumedRole"),
      invokedSkillRef: optionalBodyString(body.invokedSkillRef, "invokedSkillRef"),
      policyRef: optionalBodyString(body.policyRef, "policyRef"),
      intentId: optionalBodyInteger(body.intentId, "intentId"),
      domainId: optionalBodyInteger(body.domainId, "domainId"),
    });
    writeJson(response, result.ok ? 201 : 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/claims") {
    const actor = await requireDefaultActor(context);
    const body = await readJsonBody(request);
    const result = await context.service.claim({
      entityTable: optionalBodyString(body.entityTable, "entityTable") ?? "intents",
      entityId: requiredInteger(body.entityId, "entityId"),
      actorId: actor.id as number,
      note: optionalBodyString(body.note, "note"),
    });
    writeJson(response, result.ok ? 201 : 400, result);
    return;
  }

  const releaseClaimMatch = url.pathname.match(/^\/api\/claims\/(\d+)\/release$/);
  if (request.method === "POST" && releaseClaimMatch) {
    await requireDefaultActor(context);
    const body = await readJsonBody(request);
    const result = await context.service.releaseClaim({
      id: Number(releaseClaimMatch[1]),
      reason: optionalBodyString(body.reason, "reason"),
    });
    writeJson(response, result.ok ? 200 : 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/expertise") {
    const actor = await requireDefaultActor(context);
    const body = await readJsonBody(request);
    const result = await context.service.registerExpertise({
      intentId: requiredInteger(body.intentId, "intentId"),
      domainId: requiredInteger(body.domainId, "domainId"),
      actorId: actor.id as number,
      signal: requiredEnum(body.signal, ["concerned", "not_concerned", "blocked"], "signal"),
      note: optionalBodyString(body.note, "note"),
    });
    writeJson(response, result.ok ? 201 : 400, result);
    return;
  }

  writeJson(response, 404, errorEnvelope("NOT_FOUND", "API route not found"));
}

async function resolveDefaultActor(context: UiContext): Promise<Actor | undefined> {
  if (!context.repo) return undefined;
  if (context.defaultActorId != null) return await context.repo.getActor(toActorId(context.defaultActorId)) ?? undefined;
  if (context.defaultActor) return await context.repo.getActorByName(context.defaultActor) ?? undefined;
  return undefined;
}

async function requireDefaultActor(context: UiContext): Promise<Actor> {
  if (!context.repo || !context.service) throw new Error(context.setupError?.message ?? "cml-ui has no configured governance repository");
  const actor = await resolveDefaultActor(context);
  if (!actor) throw new Error("Set CML_ACTOR/CML_ACTOR_ID before using write actions");
  if (actor.status !== "active") throw new Error(`Actor ${actor.name} is ${actor.status}`);
  return actor;
}

async function maybeBuildOperatorSurfaceState(context: UiContext): Promise<OperatorSurfaceState | undefined> {
  if (!context.repo || !context.service) return undefined;
  return buildOperatorSurfaceState({
    repo: context.repo,
    service: context.service,
    defaultActor: context.defaultActor,
    defaultActorId: context.defaultActorId,
    publicMcpBaseUrl: context.publicMcpBaseUrl,
    uiPublicUrls: context.uiPublicUrls,
  });
}

function openRepository(dbPath: string | undefined): GovernanceRepository {
  if (!dbPath) throw new Error("Set CML_DB_PATH before starting cml-ui");
  return new SqliteGovernanceRepository(dbPath);
}

function focusEntityTable(entityType: string): string {
  if (entityType === "intent") return "intents";
  if (entityType === "interpretation") return "interpretations";
  if (entityType === "divergence_group") return "divergence_groups";
  return entityType.endsWith("s") ? entityType : `${entityType}s`;
}

function optionalString(value: string | null): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function optionalInteger(value: string | null): number | undefined {
  if (value == null || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer query value, got ${value}`);
  return parsed;
}

function optionalNullableInteger(value: string | null): number | null | undefined {
  if (value == null || value.length === 0) return undefined;
  if (value === "null") return null;
  return optionalInteger(value);
}

function optionalEnum<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  if (!value) return undefined;
  return requiredEnum(value, allowed, "query value");
}

function requiredEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Expected ${name} to be one of ${allowed.join(", ")}, got ${value}`);
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function optionalBodyInteger(value: unknown, name: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalBodyString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalIntentStatus(value: unknown): "draft" | "active" | "closed" | "superseded" | undefined {
  if (value == null) return undefined;
  return requiredEnum(value, ["draft", "active", "closed", "superseded"] as const, "status");
}

function optionalInterpretationStatus(value: unknown): "fyi" | "clarifying" | "proposed" | "flagged" | "superseded" | undefined {
  if (value == null) return undefined;
  return requiredEnum(value, ["fyi", "clarifying", "proposed", "flagged", "superseded"] as const, "status");
}

function optionalInterpretationAlignment(value: unknown): "aligned" | "uncertain" | "divergent" | "superseded" | undefined {
  if (value == null) return undefined;
  return requiredEnum(value, ["aligned", "uncertain", "divergent", "superseded"] as const, "alignment");
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 256 * 1024) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("Request body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeText(response: ServerResponse, statusCode: number, body: string, contentType: string): void {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(body);
}

function errorEnvelope(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

function parseCsv(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "8792");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CML_UI_PORT must be a valid port");
  return port;
}

function firstEnv(...names: string[]): string | undefined {
  return names.map((name) => process.env[name]).find((value): value is string => Boolean(value));
}

function main(): void {
  const server = createCmlUiServer({
    dbPath: firstEnv("CML_DB_PATH"),
    defaultActor: firstEnv("CML_ACTOR"),
    defaultActorId: firstEnv("CML_ACTOR_ID")
      ? Number(firstEnv("CML_ACTOR_ID"))
      : undefined,
    publicMcpBaseUrl: firstEnv("CML_PUBLIC_MCP_BASE_URL") ?? DEFAULT_PUBLIC_MCP_BASE_URL,
    uiPublicUrls: parseCsv(firstEnv("CML_UI_PUBLIC_URLS")),
  });
  const host = firstEnv("CML_UI_HOST") ?? "127.0.0.1";
  const port = parsePort(firstEnv("CML_UI_PORT"));
  server.listen(port, host, () => {
    process.stderr.write(`cml-ui listening on http://${host}:${port}/\n`);
  });
}

if (process.argv[1]?.endsWith("/ui/index.js")) {
  main();
}
