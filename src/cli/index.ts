#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { SqliteGovernanceRepository } from "../governance/sqlite-governance-repository.js";
import { GovernanceService, ServiceResponse } from "../governance/service.js";
import {
  Actor,
  ActorSessionStatus,
  ActorStatus,
  ClaimStatus,
  ContractKind,
  ContractStatus,
  ExpertiseSignal,
  IntentStatus,
  InterpretationAlignment,
  InterpretationStatus,
} from "../governance/domain.js";
import { inspectIntent, inspectInterpretation } from "../orchestration/inspect.js";
import { ObsidianVaultService } from "../vault/obsidian-vault-service.js";

interface CliContext {
  service: GovernanceService;
  actor: Actor;
  pretty: boolean;
}

type Flags = Record<string, string | boolean>;

interface CmlConfig {
  database?: {
    path?: string;
  };
  defaultScope?: string;
  actor?: {
    id?: number;
    name?: string;
    role?: "human" | "agent";
    provider?: string;
    capabilityNamespace?: string;
    defaultScope?: string;
  };
  vault?: {
    root?: string;
    obsidianBin?: string;
    obsidianVault?: string;
  };
  mcp?: {
    http?: {
      host?: string;
      port?: number;
    };
    publicBridge?: {
      host?: string;
      port?: number;
      baseUrl?: string;
      upstreamUrl?: string;
      allowedTools?: string[];
      oauth?: {
        issuer?: string;
        audience?: string;
        resource?: string;
        scopes?: string[];
        jwksUrl?: string;
        subjectActorMap?: Record<string, string>;
        groupActorMap?: Record<string, string>;
        defaultActor?: string;
        pilotIssuer?: {
          enabled?: boolean;
          privateKeyPath?: string;
          keyId?: string;
          clientStorePath?: string;
          subject?: string;
          groups?: string[];
        };
      };
    };
  };
}

interface ConfigBundle {
  path?: string;
  data: CmlConfig;
}

const DEFAULT_CONFIG_PATH = "cml.config.json";
const DEFAULT_DB_PATH = "./var/cml.sqlite";
const DEFAULT_VAULT_ROOT = "./vault";
const DEFAULT_SCOPE = "default";
const DEFAULT_ACTOR = "local-operator";
const DEFAULT_PROVIDER = "human";

function parseArgv(argv: string[]): { command: string[]; flags: Flags } {
  const command: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      command.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const equalsIndex = key.indexOf("=");
    if (equalsIndex > 0) {
      flags[key.slice(0, equalsIndex)] = key.slice(equalsIndex + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { command, flags };
}

function flag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function hasFlag(flags: Flags, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, name);
}

function clearableFlag(flags: Flags, name: string): string | null | undefined {
  if (hasFlag(flags, `clear-${name}`)) return null;
  return flag(flags, name);
}

function intFlag(flags: Flags, name: string): number | undefined {
  const value = flag(flags, name);
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

function requiredFlag(flags: Flags, name: string): string {
  const value = flag(flags, name);
  if (value == null || value.length === 0) throw new Error(`Missing required --${name}`);
  return value;
}

function boolFlag(flags: Flags, name: string): boolean {
  return flags[name] === true || flag(flags, name) === "true";
}

function requiredIntFlag(flags: Flags, name: string): number {
  const value = intFlag(flags, name);
  if (value == null) throw new Error(`Missing required --${name}`);
  return value;
}

function enumFlag<T extends string>(flags: Flags, name: string, allowed: readonly T[]): T | undefined {
  const value = flag(flags, name);
  if (value == null) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`--${name} must be one of: ${allowed.join(", ")}`);
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asConfig(value: unknown): CmlConfig {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error("CML config must be a JSON object");
  }
  return value as CmlConfig;
}

function loadConfig(flags: Flags, allowMissingExplicit = false): ConfigBundle {
  const explicitPath = flag(flags, "config") ?? process.env.CML_CONFIG;
  const candidate = explicitPath ?? (existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : undefined);
  if (candidate == null) return { data: {} };
  const path = resolve(candidate);
  if (!existsSync(path)) {
    if (allowMissingExplicit) return { path, data: {} };
    throw new Error(`Config file not found: ${path}`);
  }
  return { path, data: asConfig(readJsonFile(path)) };
}

function resolveMaybeRelative(path: string, config?: ConfigBundle): string {
  if (path.startsWith("/")) return path;
  return resolve(config?.path ? dirname(config.path) : process.cwd(), path);
}

function configString(flags: Flags, config: ConfigBundle, name: string, envName: string, configValue?: string): string | undefined {
  return flag(flags, name) ?? process.env[envName] ?? configValue;
}

function configNumber(flags: Flags, config: ConfigBundle, name: string, envName: string, configValue?: number): number | undefined {
  const fromFlag = intFlag(flags, name);
  if (fromFlag != null) return fromFlag;
  const fromEnv = process.env[envName];
  if (fromEnv != null && fromEnv.length > 0) {
    const parsed = Number(fromEnv);
    if (!Number.isInteger(parsed)) throw new Error(`${envName} must be an integer`);
    return parsed;
  }
  return configValue;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const INTENT_STATUSES = ["draft", "active", "closed", "superseded"] as const satisfies readonly IntentStatus[];
const INTERPRETATION_STATUSES = ["fyi", "clarifying", "proposed", "flagged", "superseded"] as const satisfies readonly InterpretationStatus[];
const INTERPRETATION_ALIGNMENTS = ["aligned", "uncertain", "divergent", "superseded"] as const satisfies readonly InterpretationAlignment[];
const CLAIM_STATUSES = ["active", "released"] as const satisfies readonly ClaimStatus[];
const ACTOR_STATUSES = ["active", "suspended", "retired"] as const satisfies readonly ActorStatus[];
const ROLE_STATUSES = ["active", "suspended", "retired"] as const;
const ACTOR_SESSION_STATUSES = ["active", "closed"] as const satisfies readonly ActorSessionStatus[];
const CONTRACT_KINDS = ["root", "system", "role", "actor", "actor_type", "skill", "policy", "process"] as const satisfies readonly ContractKind[];
const CONTRACT_STATUSES = ["draft", "active", "superseded", "retired"] as const satisfies readonly ContractStatus[];
const CONTRACT_WRITE_STATUSES = ["draft", "active"] as const;
const EXPERTISE_SIGNALS = ["concerned", "not_concerned", "blocked"] as const satisfies readonly ExpertiseSignal[];
const VAULT_SEARCH_FORMATS = ["text", "json"] as const;

type CmlRef =
  | { kind: "intent"; id: number; canonical: string; entityTable: "intents" }
  | { kind: "interpretation"; id: number; canonical: string; entityTable: "interpretations" }
  | { kind: "report"; id: number; canonical: string; entityTable: "reports" };

function parseCmlRef(value: string | undefined): CmlRef {
  if (value == null || value.length === 0) throw new Error("Missing CML reference");
  const match = /^([A-Za-z]+)-?(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error("Reference must look like INTENT-35, INTERPRETATION-101, or REPORT-8");
  }

  const prefix = match[1].toUpperCase();
  const id = Number(match[2]);
  if (!Number.isInteger(id)) throw new Error("Reference id must be an integer");

  if (prefix === "CML" || prefix === "INTENT") {
    return { kind: "intent", id, canonical: `INTENT-${id}`, entityTable: "intents" };
  }
  if (prefix === "INT" || prefix === "INTERPRETATION") {
    return { kind: "interpretation", id, canonical: `INTERPRETATION-${id}`, entityTable: "interpretations" };
  }
  if (prefix === "RPT" || prefix === "REPORT") {
    return { kind: "report", id, canonical: `REPORT-${id}`, entityTable: "reports" };
  }

  throw new Error(`Unsupported CML reference prefix: ${match[1]}`);
}

function usage(): ServiceResponse<{ commands: string[] }> {
  return {
    ok: true,
    data: {
      commands: [
        "cml init [--config ./cml.config.json] [--db ./var/cml.sqlite]",
        "cml setup mcp --transport <stdio|http|public> [--out ./mcp.json]",
        "cml intent list|get|create|update",
        "cml interpret file|list|get|supersede",
        "cml action log|list",
        "cml claim create|release|list",
        "cml actor list|get|provision|update|retire",
        "cml role list|get|register|bind|bindings",
        "cml actor-type register|get|list",
        "cml session open|heartbeat|close|list",
        "cml report create|list|get",
        "cml contract register|get|list|supersede|import",
        "cml domain register|list|get",
        "cml scope register|list",
        "cml expertise register|coverage",
        "cml event list|history",
        "cml vault read|search|write|append|move|delete",
        "cml resolve <INTENT-35|INTERPRETATION-101|REPORT-8>",
        "cml context <INTENT-35|INTERPRETATION-101>",
        "cml status",
      ],
    },
    meta: { schema_version: 2 },
  };
}

function printJson(response: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(response, null, pretty ? 2 : 0)}\n`);
}

function commandError(message: string, code = "CLI_ERROR"): ServiceResponse<never> {
  return { ok: false, error: { code, message } };
}

function parseIdOrName(value: string | undefined): { id?: number; name?: string } {
  if (value == null || value.length === 0) throw new Error("Missing identifier");
  const parsed = Number(value);
  return Number.isInteger(parsed) ? { id: parsed } : { name: value };
}

function vaultService(flags: Flags, config: ConfigBundle): ObsidianVaultService {
  const vaultRoot = configString(flags, config, "vault-root", "CML_VAULT_ROOT", config.data.vault?.root);
  return new ObsidianVaultService({
    obsidianBin: configString(flags, config, "obsidian-bin", "CML_OBSIDIAN_BIN", config.data.vault?.obsidianBin),
    vaultName: configString(flags, config, "vault-name", "CML_OBSIDIAN_VAULT", config.data.vault?.obsidianVault),
    vaultRoot: vaultRoot ? resolveMaybeRelative(vaultRoot, config) : undefined,
  });
}

async function logVaultMutation(
  ctx: CliContext,
  params: { intentId: number; operation: string; path?: string; destination?: string; outcome?: string }
): Promise<ServiceResponse<unknown>> {
  return ctx.service.logAction({
    intentId: params.intentId,
    actorId: ctx.actor.id,
    description: `Vault ${params.operation}: ${params.path ?? "(no path)"}${params.destination ? ` -> ${params.destination}` : ""}`,
    outcome: params.outcome,
  });
}

async function requireIntentForVaultMutation(ctx: CliContext, intentId: number): Promise<void> {
  const intent = await ctx.service.getIntent(intentId);
  if (!intent.ok) throw new Error(intent.error.message);
}

function requireOk<T>(response: ServiceResponse<T>): T {
  if (!response.ok) throw new Error(response.error.message);
  return response.data;
}

function defaultConfig(params: {
  dbPath: string;
  scope: string;
  actor: string;
  provider: string;
  vaultRoot: string;
}): CmlConfig {
  return {
    database: { path: params.dbPath },
    defaultScope: params.scope,
    actor: {
      name: params.actor,
      role: params.provider === "human" ? "human" : "agent",
      provider: params.provider,
      capabilityNamespace: "local",
      defaultScope: params.scope,
    },
    vault: { root: params.vaultRoot },
    mcp: {
      http: { host: "127.0.0.1", port: 8787 },
      publicBridge: {
        host: "127.0.0.1",
        port: 8788,
        upstreamUrl: "http://127.0.0.1:8787/mcp",
        allowedTools: ["resolve", "context", "status"],
      },
    },
  };
}

async function handleInit(flags: Flags, config: ConfigBundle): Promise<unknown> {
  const configPath = config.path ?? resolve(flag(flags, "config") ?? process.env.CML_CONFIG ?? DEFAULT_CONFIG_PATH);
  const scope = configString(flags, config, "scope", "CML_SCOPE", config.data.defaultScope ?? config.data.actor?.defaultScope) ?? DEFAULT_SCOPE;
  const actorName = configString(flags, config, "actor", "CML_ACTOR", config.data.actor?.name) ?? DEFAULT_ACTOR;
  const provider = configString(flags, config, "provider", "CML_PROVIDER", config.data.actor?.provider) ?? DEFAULT_PROVIDER;
  const role = enumFlag(flags, "role", ["human", "agent"] as const) ?? config.data.actor?.role ?? (provider === "human" ? "human" : "agent");
  const dbSetting = configString(flags, config, "db", "CML_DB_PATH", config.data.database?.path) ?? DEFAULT_DB_PATH;
  const vaultSetting = configString(flags, config, "vault-root", "CML_VAULT_ROOT", config.data.vault?.root) ?? DEFAULT_VAULT_ROOT;
  const dbPath = resolveMaybeRelative(dbSetting, config.path ? config : { path: configPath, data: config.data });
  const vaultRoot = resolveMaybeRelative(vaultSetting, config.path ? config : { path: configPath, data: config.data });
  const shouldWriteConfig = !existsSync(configPath) || boolFlag(flags, "force");

  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(vaultRoot, { recursive: true });
  if (shouldWriteConfig) {
    writeJson(configPath, defaultConfig({ dbPath: dbSetting, scope, actor: actorName, provider, vaultRoot: vaultSetting }));
  }

  const repo = new SqliteGovernanceRepository(dbPath);
  const service = new GovernanceService(repo);
  try {
    const scopes = await repo.listScopes();
    if (!scopes.includes(scope)) requireOk(await service.registerScope({ scope }));

    const domains = await repo.listDomains();
    let domain = domains.find((item) => item.scope === scope && item.name === "Coordination");
    if (!domain) {
      domain = requireOk(await service.registerDomain({
        scope,
        name: "Coordination",
        concern: "Mediation surface, intent state, contracts, actions, claims, and reports.",
      }));
    }

    let actor = await repo.getActorByName(actorName);
    if (!actor) {
      actor = requireOk(await service.registerActor({
        name: actorName,
        role,
        provider,
        capabilityNamespace: config.data.actor?.capabilityNamespace ?? "local",
        defaultScope: scope,
        status: "active",
        description: "Default local operator created by CML init.",
      }));
    }

    const rootKey = "root:cml-bootstrap";
    let rootContract = await repo.getContractByKey(rootKey, "active");
    if (!rootContract) {
      rootContract = requireOk(await service.registerContract({
        key: rootKey,
        kind: "root",
        scope,
        domainId: domain.id,
        title: "CML Bootstrap Contract",
        body: "This root contract anchors local CML setup. It authorizes reversible local governance, configuration, and contract import operations for a pilot instance.",
        custodianActorId: actor.id,
        status: "active",
      }));
    }

    const actorTypeKey = "actor-type:default-agent";
    let actorTypeContract = await repo.getContractByKey(actorTypeKey, "active");
    if (!actorTypeContract) {
      actorTypeContract = requireOk(await service.registerContract({
        key: actorTypeKey,
        kind: "actor_type",
        scope,
        domainId: domain.id,
        parentKey: rootKey,
        title: "Default Agent Actor Type",
        body: "Default agent actors participate by resolving governed state first, separating observed, inferred, unresolved, and proposed material when the work is substantive, and recording governed writes when they act.",
        custodianActorId: actor.id,
        status: "active",
        governingContractKey: rootKey,
      }));
    }

    let roleRecord = await repo.getRoleByName("operator");
    if (!roleRecord) {
      roleRecord = requireOk(await service.registerRole({
        name: "operator",
        contractKey: rootKey,
        description: "Local operator role for setup, QA, and pilot operations.",
      }));
    }

    const bindings = await repo.listActorRoleBindings({ actorId: actor.id, roleId: roleRecord.id, surface: "cli", status: "active" });
    const binding = bindings[0] ?? requireOk(await service.bindActorRole({
      actorId: actor.id,
      roleId: roleRecord.id,
      surface: "cli",
      provider,
    }));

    return {
      ok: true,
      data: {
        config: { path: configPath, status: shouldWriteConfig ? "written" : "left_existing" },
        database: { path: dbPath },
        vault: { root: vaultRoot },
        scope,
        actor,
        domain,
        contracts: { root: rootContract, actorType: actorTypeContract },
        role: roleRecord,
        binding,
      },
      meta: { schema_version: 2 },
    };
  } finally {
    repo.close();
  }
}

function mcpSetupConfig(transport: "stdio" | "http" | "public", config: ConfigBundle): Record<string, unknown> {
  const dbPath = config.data.database?.path ?? "${CML_DB_PATH}";
  const actor = config.data.actor?.name ?? "${CML_ACTOR}";
  if (transport === "stdio") {
    return {
      mcpServers: {
        "cml": {
          command: "cml-mcp",
          env: {
            CML_DB_PATH: dbPath,
            CML_ACTOR: actor,
          },
        },
      },
    };
  }
  if (transport === "http") {
    const host = config.data.mcp?.http?.host ?? "127.0.0.1";
    const port = config.data.mcp?.http?.port ?? 8787;
    return {
      server: {
        command: "cml-mcp-http",
        env: {
          CML_DB_PATH: dbPath,
          CML_ACTOR: actor,
          CML_MCP_HTTP_HOST: host,
          CML_MCP_HTTP_PORT: String(port),
        },
        url: `http://${host}:${port}/mcp`,
      },
    };
  }
  const bridge = config.data.mcp?.publicBridge;
  const oauth = bridge?.oauth;
  const host = bridge?.host ?? "127.0.0.1";
  const port = bridge?.port ?? 8788;
  return {
    server: {
      command: "cml-mcp-public",
      env: {
        CML_PUBLIC_MCP_HOST: host,
        CML_PUBLIC_MCP_PORT: String(port),
        ...(bridge?.baseUrl ? { CML_PUBLIC_MCP_BASE_URL: bridge.baseUrl } : {}),
        CML_PUBLIC_MCP_UPSTREAM_URL: bridge?.upstreamUrl ?? "http://127.0.0.1:8787/mcp",
        CML_PUBLIC_MCP_TOKEN: "${CML_PUBLIC_MCP_TOKEN}",
        CML_PUBLIC_MCP_ALLOWED_TOOLS: (bridge?.allowedTools ?? ["resolve", "context", "status"]).join(","),
        ...(oauth ? {
          ...(oauth.issuer ? { CML_OAUTH_ISSUER: oauth.issuer } : oauth.pilotIssuer?.enabled ? {} : { CML_OAUTH_ISSUER: "${CML_OAUTH_ISSUER}" }),
          ...(oauth.audience ? { CML_OAUTH_AUDIENCE: oauth.audience } : {}),
          ...(oauth.resource ? { CML_OAUTH_RESOURCE: oauth.resource } : {}),
          ...(oauth.scopes ? { CML_OAUTH_SCOPES: oauth.scopes.join(",") } : {}),
          ...(oauth.jwksUrl ? { CML_OAUTH_JWKS_URL: oauth.jwksUrl } : {}),
          ...(oauth.subjectActorMap ? { CML_OAUTH_SUBJECT_ACTOR_MAP: JSON.stringify(oauth.subjectActorMap) } : {}),
          ...(oauth.groupActorMap ? { CML_OAUTH_GROUP_ACTOR_MAP: JSON.stringify(oauth.groupActorMap) } : {}),
          ...(oauth.defaultActor ? { CML_OAUTH_DEFAULT_ACTOR: oauth.defaultActor } : {}),
          ...(oauth.pilotIssuer?.enabled ? {
            CML_OAUTH_PILOT_ISSUER: "1",
            CML_OAUTH_PRIVATE_KEY_PATH: oauth.pilotIssuer.privateKeyPath ?? "${CML_OAUTH_PRIVATE_KEY_PATH}",
            CML_OAUTH_KEY_ID: oauth.pilotIssuer.keyId ?? "${CML_OAUTH_KEY_ID}",
            CML_OAUTH_CLIENT_STORE_PATH: oauth.pilotIssuer.clientStorePath ?? "./var/oauth/clients.json",
            CML_OAUTH_AUTH_SECRET: "${CML_OAUTH_AUTH_SECRET}",
            CML_OAUTH_PILOT_SUBJECT: oauth.pilotIssuer.subject ?? oauth.defaultActor ?? "pilot-user",
            ...(oauth.pilotIssuer.groups ? { CML_OAUTH_PILOT_GROUPS: oauth.pilotIssuer.groups.join(",") } : {}),
          } : {}),
        } : {}),
      },
      url: `http://${host}:${port}/mcp`,
    },
  };
}

async function handleSetup(command: string[], flags: Flags, config: ConfigBundle): Promise<unknown> {
  const [, op] = command;
  if (op !== "mcp") return commandError(`Unknown setup command: ${command.join(" ")}`);
  const transport = enumFlag(flags, "transport", ["stdio", "http", "public"] as const) ?? "stdio";
  const payload = mcpSetupConfig(transport, config);
  const out = flag(flags, "out");
  if (out) writeJson(resolve(out), payload);
  return {
    ok: true,
    data: {
      transport,
      out: out ? resolve(out) : undefined,
      config: payload,
    },
    meta: { schema_version: 2 },
  };
}

function asObjectArray(value: unknown, name: string): Record<string, unknown>[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "object" || item == null || Array.isArray(item)) {
      throw new Error(`${name}[${index}] must be an object`);
    }
    return item as Record<string, unknown>;
  });
}

function stringProp(item: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = item[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`Missing required ${name}`);
  return undefined;
}

async function handleContractImport(ctx: CliContext, flags: Flags): Promise<unknown> {
  const file = resolve(requiredFlag(flags, "file"));
  const raw = readJsonFile(file);
  if (typeof raw !== "object" || raw == null || Array.isArray(raw)) {
    throw new Error("Contract import file must be a JSON object");
  }
  const payload = raw as Record<string, unknown>;
  const imported: unknown[] = [];

  for (const contract of asObjectArray(payload.contracts, "contracts")) {
    const kind = stringProp(contract, "kind", true) as ContractKind;
    if (!(CONTRACT_KINDS as readonly string[]).includes(kind)) throw new Error(`Unsupported contract kind: ${kind}`);
    imported.push(await ctx.service.registerContract({
      key: stringProp(contract, "key", true) as string,
      kind,
      title: stringProp(contract, "title", true) as string,
      body: stringProp(contract, "body", true) as string,
      custodianActorId: ctx.actor.id,
      scope: stringProp(contract, "scope") ?? ctx.actor.defaultScope,
      domainId: typeof contract.domainId === "number" ? contract.domainId : undefined,
      parentKey: stringProp(contract, "parentKey"),
      status: (stringProp(contract, "status") as ContractStatus | undefined) ?? "active",
      governingContractKey: stringProp(contract, "governingContractKey"),
      mandateRef: stringProp(contract, "mandateRef"),
    }));
  }

  for (const actorType of asObjectArray(payload.actorTypes, "actorTypes")) {
    imported.push(await ctx.service.registerActorTypeContract({
      name: stringProp(actorType, "name", true) as string,
      title: stringProp(actorType, "title"),
      body: stringProp(actorType, "body", true) as string,
      custodianActorId: ctx.actor.id,
      scope: stringProp(actorType, "scope") ?? ctx.actor.defaultScope,
      domainId: typeof actorType.domainId === "number" ? actorType.domainId : undefined,
      parentKey: stringProp(actorType, "parentKey"),
      status: (stringProp(actorType, "status") as ContractStatus | undefined) ?? "active",
      governingContractKey: stringProp(actorType, "governingContractKey"),
      mandateRef: stringProp(actorType, "mandateRef"),
    }));
  }

  for (const role of asObjectArray(payload.roles, "roles")) {
    imported.push(await ctx.service.registerRole({
      name: stringProp(role, "name", true) as string,
      status: stringProp(role, "status") as any,
      contractKey: stringProp(role, "contractKey"),
      contractRef: stringProp(role, "contractRef"),
      contextRef: stringProp(role, "contextRef"),
      policyRef: stringProp(role, "policyRef"),
      description: stringProp(role, "description"),
    }));
  }

  const failed = imported.filter((item) => typeof item === "object" && item != null && "ok" in item && (item as { ok: boolean }).ok === false);
  return {
    ok: failed.length === 0,
    data: { file, results: imported },
    error: failed.length ? { code: "IMPORT_PARTIAL", message: `${failed.length} contract import operation(s) failed` } : undefined,
    meta: { schema_version: 2 },
  };
}

async function dispatch(ctx: CliContext, command: string[], flags: Flags, config: ConfigBundle): Promise<unknown> {
  const [group, op, id] = command;

  if (!group || group === "help" || flags.help === true) return usage();

  if (group === "resolve") {
    const ref = parseCmlRef(op);
    if (ref.kind === "intent") {
      const result = await ctx.service.getIntent(ref.id);
      return result.ok
        ? { ok: true, data: { ref, entity: result.data }, meta: result.meta }
        : result;
    }
    if (ref.kind === "interpretation") {
      const result = await ctx.service.getInterpretation(ref.id);
      return result.ok
        ? { ok: true, data: { ref, entity: result.data }, meta: result.meta }
        : result;
    }
    const result = await ctx.service.getReport(ref.id);
    return result.ok
      ? { ok: true, data: { ref, entity: result.data }, meta: result.meta }
      : result;
  }

  if (group === "context") {
    const ref = parseCmlRef(op);
    if (ref.kind === "intent") {
      const result = await inspectIntent(ref.id, ctx.service);
      return result.ok
        ? { ok: true, data: { ref, context: result.data }, meta: { schema_version: 2 } }
        : commandError(result.error, "NOT_FOUND");
    }
    if (ref.kind === "interpretation") {
      const result = await inspectInterpretation(ref.id, ctx.service);
      return result.ok
        ? { ok: true, data: { ref, context: result.data }, meta: { schema_version: 2 } }
        : commandError(result.error, "NOT_FOUND");
    }
    const report = await ctx.service.getReport(ref.id);
    if (!report.ok) return report;
    const related = report.data.intentId != null ? await inspectIntent(report.data.intentId as number, ctx.service) : undefined;
    return {
      ok: true,
      data: {
        ref,
        report: report.data,
        context: related?.ok ? related.data : undefined,
      },
      meta: { schema_version: 2 },
    };
  }

  if (group === "intent") {
    if (op === "list") {
      return ctx.service.listIntents({
        scope: flag(flags, "scope"),
        status: enumFlag(flags, "status", INTENT_STATUSES),
      });
    }
    if (op === "get") return ctx.service.getIntent(Number(id));
    if (op === "create") {
      return ctx.service.registerIntent({
        scope: flag(flags, "scope") ?? ctx.actor.defaultScope,
        description: requiredFlag(flags, "description"),
        source: flag(flags, "source") ?? `cml-cli:${ctx.actor.name}`,
        addressedTo: intFlag(flags, "addressed-to"),
        actorId: ctx.actor.id,
      });
    }
    if (op === "update") {
      return ctx.service.updateIntent({
        id: Number(id),
        status: enumFlag(flags, "status", INTENT_STATUSES),
        reason: requiredFlag(flags, "reason"),
        description: flag(flags, "description"),
        resolutionNotes: flag(flags, "resolution-notes"),
        actorId: ctx.actor.id,
      });
    }
  }

  if (group === "interpret") {
    if (op === "file") {
      return ctx.service.registerInterpretation({
        intentId: requiredIntFlag(flags, "intent"),
        domainId: requiredIntFlag(flags, "domain"),
        actorId: ctx.actor.id,
        title: requiredFlag(flags, "title"),
        scopeAssumption: flag(flags, "scope-assumption"),
        status: enumFlag(flags, "status", INTERPRETATION_STATUSES),
        alignment: enumFlag(flags, "alignment", INTERPRETATION_ALIGNMENTS),
        sourceRef: flag(flags, "source-ref") ?? `cml-cli:${ctx.actor.name}`,
      });
    }
    if (op === "list") {
      return ctx.service.listInterpretations({
        intentId: intFlag(flags, "intent"),
        status: enumFlag(flags, "status", INTERPRETATION_STATUSES),
        alignment: enumFlag(flags, "alignment", INTERPRETATION_ALIGNMENTS),
      });
    }
    if (op === "get") return ctx.service.getInterpretation(Number(id));
    if (op === "supersede") {
      return ctx.service.supersedeInterpretation({
        id: Number(id),
        newTitle: requiredFlag(flags, "title"),
        reason: requiredFlag(flags, "reason"),
        newScopeAssumption: flag(flags, "scope-assumption"),
        newStatus: enumFlag(flags, "status", INTERPRETATION_STATUSES),
      });
    }
  }

  if (group === "action") {
    if (op === "log") {
      return ctx.service.logAction({
        intentId: requiredIntFlag(flags, "intent"),
        actorId: ctx.actor.id,
        interpretationId: intFlag(flags, "interpretation"),
        domainId: intFlag(flags, "domain"),
        governingContractKey: flag(flags, "governing-contract-key"),
        description: requiredFlag(flags, "description"),
        outcome: flag(flags, "outcome"),
        assumedRole: flag(flags, "assumed-role"),
        invokedSkillRef: flag(flags, "invoked-skill-ref"),
        policyRef: flag(flags, "policy-ref"),
      });
    }
    if (op === "list") {
      return ctx.service.listActions({
        intentId: intFlag(flags, "intent"),
        domainId: intFlag(flags, "domain"),
        governingContractKey: flag(flags, "governing-contract-key"),
      });
    }
  }

  if (group === "claim") {
    if (op === "create") {
      return ctx.service.claim({
        entityTable: flag(flags, "entity-table") ?? "intents",
        entityId: requiredIntFlag(flags, "entity-id"),
        actorId: ctx.actor.id,
        note: flag(flags, "description") ?? flag(flags, "note"),
      });
    }
    if (op === "release") {
      return ctx.service.releaseClaim({
        id: Number(id),
        reason: flag(flags, "reason"),
      });
    }
    if (op === "list") {
      return ctx.service.listClaims({
        entityTable: flag(flags, "entity-table"),
        entityId: intFlag(flags, "entity-id"),
        status: enumFlag(flags, "status", CLAIM_STATUSES),
      });
    }
  }

  if (group === "actor") {
    if (op === "list") {
      return ctx.service.listActors({
        status: enumFlag(flags, "status", ACTOR_STATUSES),
        provider: flag(flags, "provider"),
      });
    }
    if (op === "get") return ctx.service.getActor(parseIdOrName(id));
    if (op === "provision") {
      return ctx.service.registerActor({
        name: requiredFlag(flags, "name"),
        role: enumFlag(flags, "role", ["human", "agent"] as const) ?? "agent",
        provider: requiredFlag(flags, "provider"),
        actorType: flag(flags, "actor-type"),
        capabilityNamespace: requiredFlag(flags, "capability-namespace"),
        defaultScope: flag(flags, "scope") ?? "default",
        status: enumFlag(flags, "status", ACTOR_STATUSES) ?? "active",
        contractKey: flag(flags, "contract-key"),
        defaultContractKey: flag(flags, "default-contract-key"),
        contractRef: flag(flags, "contract-ref"),
        contextRef: flag(flags, "context-ref"),
        contextPolicy: flag(flags, "context-policy"),
        description: flag(flags, "description"),
      });
    }
    if (op === "update") {
      return ctx.service.updateActor({
        id: Number(id),
        name: flag(flags, "name"),
        role: enumFlag(flags, "role", ["human", "agent"] as const),
        provider: flag(flags, "provider"),
        actorType: flag(flags, "actor-type"),
        capabilityNamespace: flag(flags, "capability-namespace"),
        defaultScope: flag(flags, "scope"),
        status: enumFlag(flags, "status", ACTOR_STATUSES),
        contractKey: flag(flags, "contract-key"),
        defaultContractKey: flag(flags, "default-contract-key"),
        contractRef: clearableFlag(flags, "contract-ref"),
        contextRef: clearableFlag(flags, "context-ref"),
        contextPolicy: clearableFlag(flags, "context-policy"),
        description: clearableFlag(flags, "description"),
      });
    }
    if (op === "retire") {
      return ctx.service.retireActor({
        id: Number(id),
        reason: flag(flags, "reason"),
      });
    }
  }

  if (group === "role") {
    if (op === "list") {
      return ctx.service.listRoles({
        status: enumFlag(flags, "status", ROLE_STATUSES) as any,
      });
    }
    if (op === "get") return ctx.service.getRole(parseIdOrName(id));
    if (op === "register") {
      return ctx.service.registerRole({
        name: requiredFlag(flags, "name"),
        status: enumFlag(flags, "status", ROLE_STATUSES) as any,
        contractKey: flag(flags, "contract-key"),
        contractRef: flag(flags, "contract-ref"),
        contextRef: flag(flags, "context-ref"),
        policyRef: flag(flags, "policy-ref"),
        description: flag(flags, "description"),
      });
    }
    if (op === "bind") {
      return ctx.service.bindActorRole({
        actorId: intFlag(flags, "actor-id") ?? ctx.actor.id,
        roleId: requiredIntFlag(flags, "role-id"),
        surface: requiredFlag(flags, "surface"),
        provider: requiredFlag(flags, "provider"),
        credentialRef: flag(flags, "credential-ref"),
        status: enumFlag(flags, "status", ROLE_STATUSES) as any,
      });
    }
    if (op === "bindings") {
      return ctx.service.listActorRoleBindings({
        actorId: intFlag(flags, "actor-id"),
        roleId: intFlag(flags, "role-id"),
        surface: flag(flags, "surface"),
        status: enumFlag(flags, "status", ROLE_STATUSES) as any,
      });
    }
  }

  if (group === "actor-type") {
    if (op === "register") {
      return ctx.service.registerActorTypeContract({
        name: requiredFlag(flags, "name"),
        title: flag(flags, "title"),
        body: requiredFlag(flags, "body"),
        custodianActorId: ctx.actor.id,
        scope: flag(flags, "scope") ?? ctx.actor.defaultScope,
        domainId: intFlag(flags, "domain"),
        parentKey: flag(flags, "parent-key"),
        status: enumFlag(flags, "status", CONTRACT_WRITE_STATUSES) as ContractStatus | undefined,
        governingContractKey: flag(flags, "governing-contract-key"),
        mandateRef: flag(flags, "mandate-ref"),
      });
    }
    if (op === "get") {
      const name = id ?? requiredFlag(flags, "name");
      return ctx.service.getContract({
        key: `actor-type:${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`,
        status: enumFlag(flags, "status", CONTRACT_STATUSES),
      });
    }
    if (op === "list") {
      return ctx.service.listContracts({
        kind: "actor_type",
        scope: flag(flags, "scope"),
        domainId: intFlag(flags, "domain"),
        status: enumFlag(flags, "status", CONTRACT_STATUSES),
      });
    }
  }

  if (group === "session") {
    if (op === "open") {
      return ctx.service.openActorSession({
        actorId: ctx.actor.id,
        sessionRef: requiredFlag(flags, "session-ref"),
        surface: requiredFlag(flags, "surface"),
        provider: flag(flags, "provider"),
        transcriptRef: flag(flags, "transcript-ref"),
      });
    }
    if (op === "heartbeat") {
      return ctx.service.heartbeatActorSession({
        actorId: ctx.actor.id,
        sessionRef: requiredFlag(flags, "session-ref"),
      });
    }
    if (op === "close") {
      return ctx.service.closeActorSession({
        actorId: ctx.actor.id,
        sessionRef: requiredFlag(flags, "session-ref"),
      });
    }
    if (op === "list") {
      return ctx.service.listActorSessions({
        actorId: intFlag(flags, "target-actor-id") ?? ctx.actor.id,
        status: enumFlag(flags, "status", ACTOR_SESSION_STATUSES),
      });
    }
  }

  if (group === "report") {
    if (op === "create") {
      return ctx.service.registerReport({
        kind: requiredFlag(flags, "kind"),
        title: requiredFlag(flags, "title"),
        summary: requiredFlag(flags, "summary"),
        actorId: ctx.actor.id,
        scope: flag(flags, "scope") ?? ctx.actor.defaultScope,
        bodyRef: flag(flags, "body-ref"),
        domainId: intFlag(flags, "domain"),
        intentId: intFlag(flags, "intent"),
        sourceRef: flag(flags, "source-ref"),
        assumedRole: flag(flags, "assumed-role"),
        invokedSkillRef: flag(flags, "invoked-skill-ref"),
        policyRef: flag(flags, "policy-ref"),
      });
    }
    if (op === "list") {
      return ctx.service.listReports({
        scope: flag(flags, "scope"),
        kind: flag(flags, "kind"),
        intentId: intFlag(flags, "intent"),
        domainId: intFlag(flags, "domain"),
        actorId: intFlag(flags, "target-actor-id"),
      });
    }
    if (op === "get") return ctx.service.getReport(Number(id));
  }

  if (group === "contract") {
    if (op === "import") {
      return handleContractImport(ctx, flags);
    }
    if (op === "register") {
      const kind = enumFlag(flags, "kind", CONTRACT_KINDS);
      if (kind == null) throw new Error("Missing required --kind");
      return ctx.service.registerContract({
        key: requiredFlag(flags, "key"),
        kind,
        parentKey: flag(flags, "parent-key"),
        title: requiredFlag(flags, "title"),
        body: requiredFlag(flags, "body"),
        custodianActorId: ctx.actor.id,
        scope: flag(flags, "scope") ?? ctx.actor.defaultScope,
        domainId: intFlag(flags, "domain"),
        governingContractKey: flag(flags, "governing-contract-key"),
        status: enumFlag(flags, "status", CONTRACT_WRITE_STATUSES) as ContractStatus | undefined,
        mandateRef: flag(flags, "mandate-ref"),
      });
    }
    if (op === "get") {
      const identifier = id ?? flag(flags, "key");
      const parsed = parseIdOrName(identifier);
      return ctx.service.getContract({
        id: parsed.id,
        key: parsed.name,
        status: enumFlag(flags, "status", CONTRACT_STATUSES),
      });
    }
    if (op === "list") {
      return ctx.service.listContracts({
        key: flag(flags, "key"),
        kind: enumFlag(flags, "kind", CONTRACT_KINDS),
        scope: flag(flags, "scope"),
        domainId: intFlag(flags, "domain"),
        status: enumFlag(flags, "status", CONTRACT_STATUSES),
        parentKey: flag(flags, "parent-key"),
        governingContractKey: flag(flags, "governing-contract-key"),
      });
    }
    if (op === "supersede") {
      return ctx.service.supersedeContract({
        id: Number(id),
        body: requiredFlag(flags, "body"),
        reason: requiredFlag(flags, "reason"),
        title: flag(flags, "title"),
        status: enumFlag(flags, "status", CONTRACT_WRITE_STATUSES) as ContractStatus | undefined,
        domainId: intFlag(flags, "domain"),
        governingContractKey: flag(flags, "governing-contract-key"),
        mandateRef: flag(flags, "mandate-ref"),
        custodianActorId: ctx.actor.id,
      });
    }
  }

  if (group === "domain") {
    if (op === "register") {
      return ctx.service.registerDomain({
        scope: flag(flags, "scope") ?? ctx.actor.defaultScope,
        name: requiredFlag(flags, "name"),
        concern: requiredFlag(flags, "concern"),
        notionPageId: flag(flags, "notion-page-id"),
      });
    }
    if (op === "list") return ctx.service.listDomains();
    if (op === "get") return ctx.service.getDomain(Number(id));
  }

  if (group === "scope") {
    if (op === "register") return ctx.service.registerScope({ scope: requiredFlag(flags, "name") });
    if (op === "list") return ctx.service.listScopes();
  }

  if (group === "expertise") {
    if (op === "register") {
      return ctx.service.registerExpertise({
        intentId: requiredIntFlag(flags, "intent"),
        domainId: requiredIntFlag(flags, "domain"),
        actorId: ctx.actor.id,
        signal: enumFlag(flags, "signal", EXPERTISE_SIGNALS) ?? "concerned",
        note: flag(flags, "note"),
      });
    }
    if (op === "coverage") return ctx.service.getExpertiseCoverage({ intentId: requiredIntFlag(flags, "intent") });
  }

  if (group === "event") {
    if (op === "list") {
      return ctx.service.listEvents({
        scope: flag(flags, "scope"),
        entityTable: flag(flags, "entity-table"),
      });
    }
    if (op === "history") {
      return ctx.service.getEntityHistory({
        entityTable: requiredFlag(flags, "entity-table"),
        entityId: requiredIntFlag(flags, "entity-id"),
      });
    }
  }

  if (group === "vault") {
    const vault = vaultService(flags, config);
    if (op === "read") {
      return { ok: true, data: await vault.read(requiredFlag(flags, "path")), meta: { schema_version: 2 } };
    }
    if (op === "search") {
      return {
        ok: true,
        data: await vault.search(requiredFlag(flags, "query"), {
          path: flag(flags, "path"),
          limit: intFlag(flags, "limit"),
          format: enumFlag(flags, "format", VAULT_SEARCH_FORMATS),
        }),
        meta: { schema_version: 2 },
      };
    }
    if (op === "write") {
      const intentId = requiredIntFlag(flags, "intent");
      const path = requiredFlag(flags, "path");
      await requireIntentForVaultMutation(ctx, intentId);
      const result = await vault.write(path, requiredFlag(flags, "content"));
      const action = await logVaultMutation(ctx, { intentId, operation: "write", path: result.path, outcome: result.data });
      return { ok: true, data: { vault: result, action: action.ok ? action.data : action }, meta: { schema_version: 2 } };
    }
    if (op === "append") {
      const intentId = requiredIntFlag(flags, "intent");
      const path = requiredFlag(flags, "path");
      await requireIntentForVaultMutation(ctx, intentId);
      const result = await vault.append(path, requiredFlag(flags, "content"));
      const action = await logVaultMutation(ctx, { intentId, operation: "append", path: result.path, outcome: result.data });
      return { ok: true, data: { vault: result, action: action.ok ? action.data : action }, meta: { schema_version: 2 } };
    }
    if (op === "move") {
      const intentId = requiredIntFlag(flags, "intent");
      const path = requiredFlag(flags, "path");
      const destination = requiredFlag(flags, "to");
      await requireIntentForVaultMutation(ctx, intentId);
      const result = await vault.move(path, destination);
      const action = await logVaultMutation(ctx, {
        intentId,
        operation: "move",
        path,
        destination: result.path,
        outcome: result.data,
      });
      return { ok: true, data: { vault: result, action: action.ok ? action.data : action }, meta: { schema_version: 2 } };
    }
    if (op === "delete") {
      if (flags.confirm !== true) throw new Error("Deleting vault material requires --confirm");
      const intentId = requiredIntFlag(flags, "intent");
      const path = requiredFlag(flags, "path");
      await requireIntentForVaultMutation(ctx, intentId);
      const result = await vault.delete(path);
      const action = await logVaultMutation(ctx, { intentId, operation: "delete", path: result.path, outcome: result.data });
      return { ok: true, data: { vault: result, action: action.ok ? action.data : action }, meta: { schema_version: 2 } };
    }
  }

  if (group === "status") {
    const [intents, claims] = await Promise.all([
      ctx.service.listIntents({ scope: flag(flags, "scope") ?? ctx.actor.defaultScope, status: "active", limit: 100 }),
      ctx.service.listClaims({ status: "active", limit: 100 }),
    ]);
    return {
      ok: true,
      data: {
        actor: ctx.actor,
        activeIntents: intents.ok ? intents.data : [],
        activeClaims: claims.ok ? claims.data : [],
      },
      meta: { schema_version: 2 },
    };
  }

  return commandError(`Unknown command: ${command.join(" ")}`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgv(process.argv.slice(2));
  const pretty = flags.pretty === true;
  let repo: SqliteGovernanceRepository | undefined;
  try {
    const config = loadConfig(flags, command[0] === "init");
    if (!command[0] || command[0] === "help" || flags.help === true) {
      printJson(usage(), pretty);
      return;
    }
    if (command[0] === "init") {
      printJson(await handleInit(flags, config), pretty);
      return;
    }
    if (command[0] === "setup") {
      printJson(await handleSetup(command, flags, config), pretty);
      return;
    }

    const dbSetting = configString(flags, config, "db", "CML_DB_PATH", config.data.database?.path);
    if (!dbSetting) {
      printJson(commandError("Set CML_DB_PATH, pass --db, or create cml.config.json with `cml init`.", "DB_PATH_REQUIRED"), pretty);
      process.exitCode = 1;
      return;
    }

    const flagActorId = intFlag(flags, "actor-id");
    const flagActorName = flag(flags, "actor");
    const envActorId = process.env.CML_ACTOR_ID ? Number(process.env.CML_ACTOR_ID) : undefined;
    const configActorId = config.data.actor?.id;
    const actorIdValue = flagActorId ?? (flagActorName ? undefined : envActorId ?? configActorId);
    const actorNameValue = flagActorId != null
      ? undefined
      : flagActorName ?? (envActorId != null ? undefined : process.env.CML_ACTOR ?? (configActorId != null ? undefined : config.data.actor?.name));

    if (!Number.isInteger(actorIdValue) && !actorNameValue) {
      printJson(commandError("Set CML_ACTOR_ID/CML_ACTOR, pass --actor-id/--actor, or run `cml init`.", "ACTOR_REQUIRED"), pretty);
      process.exitCode = 1;
      return;
    }

    repo = new SqliteGovernanceRepository(resolveMaybeRelative(dbSetting, config));
    const actor = Number.isInteger(actorIdValue)
      ? await repo.getActor(actorIdValue as any)
      : await repo.getActorByName(actorNameValue as string);
    if (!actor) {
      printJson(commandError(Number.isInteger(actorIdValue) ? `Actor ${actorIdValue} not found` : `Actor '${actorNameValue}' not found`, "ACTOR_NOT_FOUND"), pretty);
      process.exitCode = 1;
      return;
    }
    if (actor.status !== "active") {
      printJson(commandError(`Actor ${actor.name} is ${actor.status}; accountable writes require an active provisioned actor`, "ACTOR_INACTIVE"), pretty);
      process.exitCode = 1;
      return;
    }
    const response = await dispatch({ service: new GovernanceService(repo), actor, pretty }, command, flags, config);
    printJson(response, pretty);
    if (typeof response === "object" && response !== null && "ok" in response && (response as { ok: boolean }).ok === false) {
      process.exitCode = 1;
    }
  } catch (error) {
    printJson(commandError(error instanceof Error ? error.message : String(error)), pretty);
    process.exitCode = 1;
  } finally {
    repo?.close();
  }
}

void main();
