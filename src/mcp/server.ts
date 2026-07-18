import { CmlClient, CmlClientOptions } from "../sdk/cml-client.js";
import { GovernanceRepository } from "../governance/repository.js";
import { SqliteGovernanceRepository } from "../governance/sqlite-governance-repository.js";
import { GovernanceService } from "../governance/service.js";
import {
  DEFAULT_PUBLIC_MCP_BASE_URL,
  buildOperatorSurfaceState,
  buildOperatorUiManifest,
  renderOperatorRuntime,
  type OperatorRuntimeMode,
} from "../ui/runtime.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CmlMcpServerOptions {
  dbPath?: string;
  defaultActor?: string;
  defaultActorId?: number;
  obsidianBin?: string;
  vaultName?: string;
  vaultRoot?: string;
  repository?: GovernanceRepository;
  env?: NodeJS.ProcessEnv;
}

const SERVER_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26"]);

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "status",
    title: "CML Status",
    description: "Return the active actor, active intents, and active claims visible to that actor.",
    inputSchema: objectSchema({ actor: stringSchema("Stable CML actor name. Defaults to server env.") }),
  },
  {
    name: "ui_manifest",
    title: "Operator UI Manifest",
    description: "Return the CML operator sidebar runtime manifest, URLs, capabilities, and MCP action descriptors.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
    }),
  },
  {
    name: "ui_runtime_get",
    title: "Get Operator UI Runtime",
    description: "Return a self-contained HTML operator sidebar runtime for MCP sandbox or remote HTTP execution.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      mode: enumSchema(["mcp-sandbox", "remote-http"], "Runtime mode."),
      includeState: booleanSchema("Embed the current operator state snapshot. Defaults to true."),
    }),
  },
  {
    name: "operator_state_get",
    title: "Get Operator State",
    description: "Return the full operator state composition used by the UI runtime.",
    inputSchema: objectSchema({ actor: stringSchema("Stable CML actor name.") }),
  },
  {
    name: "actor_get",
    title: "Get Actor",
    description: "Read one provisioned CML actor by numeric id or stable actor name.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      id: numberSchema("Actor id."),
      name: stringSchema("Stable actor name."),
    }),
  },
  {
    name: "actor_list",
    title: "List Actors",
    description: "List provisioned CML actors.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      status: enumSchema(["active", "suspended", "retired"], "Actor status filter."),
      provider: stringSchema("Provider filter."),
    }),
  },
  {
    name: "role_get",
    title: "Get Role",
    description: "Read one provisioned CML role by numeric id or stable role name.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      id: numberSchema("Role id."),
      name: stringSchema("Stable role name."),
    }),
  },
  {
    name: "role_list",
    title: "List Roles",
    description: "List provisioned CML roles.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      status: enumSchema(["active", "suspended", "retired"], "Role status filter."),
    }),
  },
  {
    name: "role_binding_list",
    title: "List Actor Role Bindings",
    description: "List role bindings that connect actors, roles, credential surfaces, and providers.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      actorId: numberSchema("Actor id filter."),
      roleId: numberSchema("Role id filter."),
      surface: stringSchema("Surface filter."),
      status: enumSchema(["active", "suspended", "retired"], "Binding status filter."),
      limit: numberSchema("Maximum results."),
      offset: numberSchema("Result offset."),
    }),
  },
  {
    name: "intent_get",
    title: "Get Intent",
    description: "Read one CML intent by numeric id.",
    inputSchema: objectSchema({ id: numberSchema("Intent id."), actor: stringSchema("Stable CML actor name.") }, ["id"]),
  },
  {
    name: "intent_list",
    title: "List Intents",
    description: "List CML intents, optionally filtered by scope and status.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      scope: stringSchema("Scope filter."),
      status: enumSchema(["draft", "active", "closed", "superseded"], "Intent status filter."),
      limit: numberSchema("Maximum results."),
      offset: numberSchema("Result offset."),
    }),
  },
  {
    name: "intent_create",
    title: "Create Intent",
    description: "Register a canonical intent.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      description: stringSchema("Intent description."),
      source: stringSchema("Source reference."),
      scope: stringSchema("Scope."),
      addressedTo: numberSchema("Actor id to address."),
      parentId: numberSchema("Parent intent id."),
      status: enumSchema(["draft", "active", "closed", "superseded"], "Initial intent status."),
    }, ["description"]),
  },
  {
    name: "intent_update",
    title: "Update Intent",
    description: "Update a canonical intent.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      id: numberSchema("Intent id."),
      reason: stringSchema("Reason for the update."),
      status: enumSchema(["draft", "active", "closed", "superseded"], "Intent status."),
      description: stringSchema("Replacement description."),
      resolutionNotes: stringSchema("Resolution notes."),
      addressedTo: numberSchema("Actor id to address."),
    }, ["id", "reason"]),
  },
  {
    name: "interpret_get",
    title: "Get Interpretation",
    description: "Read one CML interpretation by numeric id, including its full scope assumption/body.",
    inputSchema: objectSchema({ id: numberSchema("Interpretation id."), actor: stringSchema("Stable CML actor name.") }, ["id"]),
  },
  {
    name: "interpretation_get",
    title: "Get Interpretation",
    description: "Alias for interpret_get. Read one CML interpretation by numeric id, including its full scope assumption/body.",
    inputSchema: objectSchema({ id: numberSchema("Interpretation id."), actor: stringSchema("Stable CML actor name.") }, ["id"]),
  },
  {
    name: "interpret_list",
    title: "List Interpretations",
    description: "List CML interpretations, optionally filtered by intent, domain, actor, status, or alignment.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      intentId: numberSchema("Intent filter."),
      domainId: numberSchema("Domain filter."),
      actorId: numberSchema("Interpretation actor id filter."),
      status: enumSchema(["fyi", "clarifying", "proposed", "flagged", "superseded"], "Interpretation status filter."),
      alignment: enumSchema(["aligned", "uncertain", "divergent"], "Interpretation alignment filter."),
      limit: numberSchema("Maximum results."),
      offset: numberSchema("Result offset."),
    }),
  },
  {
    name: "interpretation_list",
    title: "List Interpretations",
    description: "Alias for interpret_list. List CML interpretations, optionally filtered by intent, domain, actor, status, or alignment.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      intentId: numberSchema("Intent filter."),
      domainId: numberSchema("Domain filter."),
      actorId: numberSchema("Interpretation actor id filter."),
      status: enumSchema(["fyi", "clarifying", "proposed", "flagged", "superseded"], "Interpretation status filter."),
      alignment: enumSchema(["aligned", "uncertain", "divergent"], "Interpretation alignment filter."),
      limit: numberSchema("Maximum results."),
      offset: numberSchema("Result offset."),
    }),
  },
  {
    name: "interpretation_create",
    title: "Create Interpretation",
    description: "Register a canonical interpretation.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      intentId: numberSchema("Intent id."),
      domainId: numberSchema("Domain id."),
      title: stringSchema("Interpretation title."),
      scopeAssumption: stringSchema("Interpretation body/scope assumption."),
      status: enumSchema(["fyi", "clarifying", "proposed", "flagged", "superseded"], "Interpretation status."),
      alignment: enumSchema(["aligned", "uncertain", "divergent", "superseded"], "Interpretation alignment."),
      sourceRef: stringSchema("Source reference."),
      resolverId: numberSchema("Resolver actor id."),
      resolveBy: stringSchema("ISO deadline."),
    }, ["intentId", "domainId", "title"]),
  },
  {
    name: "interpret_create",
    title: "Create Interpretation",
    description: "Alias for interpretation_create.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      intentId: numberSchema("Intent id."),
      domainId: numberSchema("Domain id."),
      title: stringSchema("Interpretation title."),
      scopeAssumption: stringSchema("Interpretation body/scope assumption."),
      status: enumSchema(["fyi", "clarifying", "proposed", "flagged", "superseded"], "Interpretation status."),
      alignment: enumSchema(["aligned", "uncertain", "divergent", "superseded"], "Interpretation alignment."),
      sourceRef: stringSchema("Source reference."),
      resolverId: numberSchema("Resolver actor id."),
      resolveBy: stringSchema("ISO deadline."),
    }, ["intentId", "domainId", "title"]),
  },
  {
    name: "interpretation_update",
    title: "Update Interpretation",
    description: "Update a canonical interpretation.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      id: numberSchema("Interpretation id."),
      reason: stringSchema("Reason for update."),
      status: enumSchema(["fyi", "clarifying", "proposed", "flagged", "superseded"], "Interpretation status."),
      alignment: enumSchema(["aligned", "uncertain", "divergent", "superseded"], "Interpretation alignment."),
      resolverId: numberSchema("Resolver actor id."),
      resolveBy: stringSchema("ISO deadline."),
      scopeAssumption: stringSchema("Replacement scope assumption/body."),
      sourceRef: stringSchema("Source reference."),
    }, ["id", "reason"]),
  },
  {
    name: "interpret_update",
    title: "Update Interpretation",
    description: "Alias for interpretation_update.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      id: numberSchema("Interpretation id."),
      reason: stringSchema("Reason for update."),
      status: enumSchema(["fyi", "clarifying", "proposed", "flagged", "superseded"], "Interpretation status."),
      alignment: enumSchema(["aligned", "uncertain", "divergent", "superseded"], "Interpretation alignment."),
      resolverId: numberSchema("Resolver actor id."),
      resolveBy: stringSchema("ISO deadline."),
      scopeAssumption: stringSchema("Replacement scope assumption/body."),
      sourceRef: stringSchema("Source reference."),
    }, ["id", "reason"]),
  },
  {
    name: "interpretation_supersede",
    title: "Supersede Interpretation",
    description: "Create a replacement interpretation and mark the prior interpretation superseded.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      id: numberSchema("Interpretation id."),
      newTitle: stringSchema("Replacement interpretation title."),
      reason: stringSchema("Reason for supersession."),
      newScopeAssumption: stringSchema("Replacement body/scope assumption."),
      newStatus: enumSchema(["fyi", "clarifying", "proposed", "flagged"], "Replacement status."),
    }, ["id", "newTitle", "reason"]),
  },
  {
    name: "interpret_supersede",
    title: "Supersede Interpretation",
    description: "Alias for interpretation_supersede.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      id: numberSchema("Interpretation id."),
      newTitle: stringSchema("Replacement interpretation title."),
      reason: stringSchema("Reason for supersession."),
      newScopeAssumption: stringSchema("Replacement body/scope assumption."),
      newStatus: enumSchema(["fyi", "clarifying", "proposed", "flagged"], "Replacement status."),
    }, ["id", "newTitle", "reason"]),
  },
  {
    name: "action_log",
    title: "Log Action",
    description: "Log a governed action against an intent.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      intentId: numberSchema("Intent id."),
      interpretationId: numberSchema("Optional interpretation id."),
      domainId: numberSchema("Optional domain id."),
      description: stringSchema("Action description."),
      outcome: stringSchema("Action outcome."),
      governingContractKey: stringSchema("Optional governing contract key."),
      assumedRole: stringSchema("Optional trusted bridge role context."),
      invokedSkillRef: stringSchema("Optional trusted bridge skill reference."),
      policyRef: stringSchema("Optional trusted bridge policy reference."),
    }, ["intentId", "description"]),
  },
  {
    name: "claim_create",
    title: "Create Claim",
    description: "Acquire an advisory claim on an entity.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      entityTable: stringSchema("Entity table. Defaults to intents."),
      entityId: numberSchema("Entity id."),
      note: stringSchema("Claim note."),
    }, ["entityId"]),
  },
  {
    name: "claim_release",
    title: "Release Claim",
    description: "Release an advisory claim.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      id: numberSchema("Claim id."),
      reason: stringSchema("Release reason."),
    }, ["id"]),
  },
  {
    name: "expertise_register",
    title: "Register Expertise Signal",
    description: "Register an expertise signal for an intent/domain/actor.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      intentId: numberSchema("Intent id."),
      domainId: numberSchema("Domain id."),
      signal: enumSchema(["concerned", "not_concerned", "blocked"], "Expertise signal."),
      note: stringSchema("Signal note."),
    }, ["intentId", "domainId", "signal"]),
  },
  {
    name: "event_list",
    title: "List Events",
    description: "List append-only governance events.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      scope: stringSchema("Scope filter."),
      entityTable: stringSchema("Entity table filter."),
      limit: numberSchema("Maximum results."),
      offset: numberSchema("Result offset."),
    }),
  },
  {
    name: "report_create",
    title: "Create Report",
    description: "Create a governed report attributed to the stable actor.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      kind: stringSchema("Report kind."),
      title: stringSchema("Report title."),
      summary: stringSchema("Compact report summary."),
      scope: stringSchema("Optional scope override."),
      bodyRef: stringSchema("Optional body reference, usually a vault path."),
      domainId: numberSchema("Optional domain id."),
      intentId: numberSchema("Optional intent id."),
      sourceRef: stringSchema("Optional source reference."),
      assumedRole: stringSchema("Optional assumed role name injected by a trusted bridge profile."),
      invokedSkillRef: stringSchema("Optional skill contract key or evidence reference injected by a trusted bridge profile."),
      policyRef: stringSchema("Optional policy or contract reference injected by a trusted bridge profile."),
    }, ["kind", "title", "summary"]),
  },
  {
    name: "report_list",
    title: "List Reports",
    description: "List governed reports.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      scope: stringSchema("Scope filter."),
      kind: stringSchema("Kind filter."),
      intentId: numberSchema("Intent filter."),
      domainId: numberSchema("Domain filter."),
      actorId: numberSchema("Report actor id filter."),
      limit: numberSchema("Maximum results."),
      offset: numberSchema("Result offset."),
    }),
  },
  {
    name: "contract_register",
    title: "Register Contract",
    description: "Register canonical contract matter in CML. Contract text is stored here; vault/filesystem projections are not authority.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      key: stringSchema("Stable hierarchy key, e.g. root:agent-bootstrap or skill:reagent-reading-composer."),
      kind: enumSchema(["root", "system", "role", "actor", "actor_type", "skill", "policy", "process"], "Contract hierarchy kind."),
      domainId: numberSchema("Optional domain owner/concern signpost; not an access-control fence."),
      parentKey: stringSchema("Required active parent key for non-root contracts."),
      title: stringSchema("Contract title."),
      body: stringSchema("Canonical contract text."),
      scope: stringSchema("Optional scope override."),
      status: enumSchema(["draft", "active"], "Initial contract status."),
      governingContractKey: stringSchema("Optional active contract key authorizing this revision; advisory, not an ACL."),
      mandateRef: stringSchema("Optional intent, interpretation, report, or build mandate reference."),
    }, ["key", "kind", "title", "body"]),
  },
  {
    name: "contract_get",
    title: "Get Contract",
    description: "Read canonical contract matter by id or active hierarchy key.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      id: numberSchema("Contract id."),
      key: stringSchema("Contract hierarchy key."),
      status: enumSchema(["draft", "active", "superseded", "retired"], "Status filter when reading by key."),
    }),
  },
  {
    name: "contract_list",
    title: "List Contracts",
    description: "List canonical CML contracts.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      key: stringSchema("Contract hierarchy key filter."),
      kind: enumSchema(["root", "system", "role", "actor", "actor_type", "skill", "policy", "process"], "Contract kind filter."),
      scope: stringSchema("Scope filter."),
      domainId: numberSchema("Domain owner/concern filter."),
      status: enumSchema(["draft", "active", "superseded", "retired"], "Status filter."),
      parentKey: stringSchema("Parent key filter."),
      governingContractKey: stringSchema("Governing contract key filter."),
      limit: numberSchema("Maximum results."),
      offset: numberSchema("Result offset."),
    }),
  },
  {
    name: "contract_supersede",
    title: "Supersede Contract",
    description: "Create a new canonical contract revision and mark the prior revision superseded; no in-place body mutation.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      id: numberSchema("Contract id to supersede."),
      body: stringSchema("Replacement canonical contract text."),
      reason: stringSchema("Reason for supersession."),
      title: stringSchema("Optional replacement title."),
      status: enumSchema(["draft", "active"], "Replacement contract status."),
      domainId: numberSchema("Optional replacement domain owner/concern signpost."),
      governingContractKey: stringSchema("Optional replacement governing contract key."),
      mandateRef: stringSchema("Optional intent, interpretation, report, or build mandate reference."),
    }, ["id", "body", "reason"]),
  },
  {
    name: "actor_type_register",
    title: "Register Actor Type Contract",
    description: "Register a default baseline contract for an actor type. This is an audit signpost, not an access-control profile.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      name: stringSchema("Actor type name, e.g. build-agent."),
      title: stringSchema("Optional actor type contract title."),
      body: stringSchema("Canonical baseline contract text."),
      scope: stringSchema("Optional scope override."),
      domainId: numberSchema("Optional domain owner/concern signpost."),
      parentKey: stringSchema("Optional parent contract key. Defaults to root:agent-bootstrap."),
      status: enumSchema(["draft", "active"], "Initial contract status."),
      governingContractKey: stringSchema("Optional active contract key authorizing this actor type contract."),
      mandateRef: stringSchema("Optional intent, interpretation, report, or build mandate reference."),
    }, ["name", "body"]),
  },
  {
    name: "actor_type_get",
    title: "Get Actor Type Contract",
    description: "Read an actor type default contract by actor type name.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      name: stringSchema("Actor type name."),
      status: enumSchema(["draft", "active", "superseded", "retired"], "Status filter."),
    }, ["name"]),
  },
  {
    name: "actor_type_list",
    title: "List Actor Type Contracts",
    description: "List default actor type contracts.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      scope: stringSchema("Scope filter."),
      domainId: numberSchema("Domain owner/concern filter."),
      status: enumSchema(["draft", "active", "superseded", "retired"], "Status filter."),
      limit: numberSchema("Maximum results."),
      offset: numberSchema("Result offset."),
    }),
  },
  {
    name: "vault_read",
    title: "Read Vault File",
    description: "Read a vault file by vault-relative path.",
    inputSchema: objectSchema({ actor: stringSchema("Stable CML actor name."), path: stringSchema("Vault-relative path.") }, ["path"]),
  },
  {
    name: "vault_search",
    title: "Search Vault",
    description: "Run bounded text search over the vault. Prefer path and limit for large vaults.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      query: stringSchema("Search query."),
      path: stringSchema("Optional vault-relative folder path."),
      limit: numberSchema("Maximum files."),
      format: enumSchema(["text", "json"], "Result format."),
    }, ["query"]),
  },
  {
    name: "vault_write",
    title: "Write Vault File",
    description: "Write a vault file. Requires an intent mandate and logs a governed action.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      intent: numberSchema("Mandating intent id."),
      path: stringSchema("Vault-relative path."),
      content: stringSchema("Full replacement content."),
      governingContractKey: stringSchema("Optional active contract key authorizing the write, usually injected by a trusted bridge profile."),
      assumedRole: stringSchema("Optional assumed role name injected by a trusted bridge profile."),
      invokedSkillRef: stringSchema("Optional skill contract key or evidence reference injected by a trusted bridge profile."),
      policyRef: stringSchema("Optional policy or contract reference injected by a trusted bridge profile."),
    }, ["intent", "path", "content"]),
  },
  {
    name: "vault_append",
    title: "Append Vault File",
    description: "Append to a vault file. Requires an intent mandate and logs a governed action.",
    inputSchema: objectSchema({
      actor: stringSchema("Stable CML actor name."),
      intent: numberSchema("Mandating intent id."),
      path: stringSchema("Vault-relative path."),
      content: stringSchema("Content to append."),
      governingContractKey: stringSchema("Optional active contract key authorizing the append, usually injected by a trusted bridge profile."),
      assumedRole: stringSchema("Optional assumed role name injected by a trusted bridge profile."),
      invokedSkillRef: stringSchema("Optional skill contract key or evidence reference injected by a trusted bridge profile."),
      policyRef: stringSchema("Optional policy or contract reference injected by a trusted bridge profile."),
    }, ["intent", "path", "content"]),
  },
];

export class CmlMcpServer {
  constructor(private readonly options: CmlMcpServerOptions = {}) {}

  async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    if (message.id == null) {
      return undefined;
    }

    try {
      if (message.method === "initialize") {
        return this.result(message.id, this.initializeResult(message.params));
      }
      if (message.method === "ping") {
        return this.result(message.id, {});
      }
      if (message.method === "tools/list") {
        return this.result(message.id, { tools: TOOL_DEFINITIONS });
      }
      if (message.method === "tools/call") {
        return this.result(message.id, await this.callTool(message.params));
      }
      return this.error(message.id, -32601, `Method not found: ${message.method}`);
    } catch (error) {
      return this.error(message.id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  private initializeResult(params?: Record<string, unknown>): Record<string, unknown> {
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
    return {
      protocolVersion: requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : SERVER_PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: "cml-mcp",
        version: "0.1.0",
      },
      instructions: "Use CML tools for governed coordination and vault access. Vault mutations require a mandating intent.",
    };
  }

  private async callTool(params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = requireString(params, "name");
    const args = isRecord(params?.arguments) ? params.arguments : {};
    const actor = optionalString(args, "actor");
    const client = new CmlClient({
      dbPath: this.options.dbPath,
      actor: actor ?? this.options.defaultActor,
      actorId: actor ? undefined : this.options.defaultActorId,
      obsidianBin: this.options.obsidianBin,
      vaultName: this.options.vaultName,
      vaultRoot: this.options.vaultRoot,
      repository: this.options.repository,
      env: this.options.env,
    });

    try {
      const response = await this.executeTool(client, name, args);
      return toolResult(response, !response.ok);
    } finally {
      client.close();
    }
  }

  private executeTool(client: CmlClient, name: string, args: Record<string, unknown>) {
    switch (name) {
      case "status":
        return client.status();
      case "ui_manifest":
        return this.withOperatorContext(args, async (context) => {
          const runtime = renderOperatorRuntime(undefined, {
            mode: "mcp-sandbox",
            includeState: false,
            publicMcpBaseUrl: publicMcpBaseUrl(this.options.env),
            uiPublicUrls: uiPublicUrls(this.options.env),
          });
          return successEnvelope(buildOperatorUiManifest({
            runtime,
            publicMcpBaseUrl: publicMcpBaseUrl(this.options.env),
            uiPublicUrls: uiPublicUrls(this.options.env),
          }));
        });
      case "ui_runtime_get":
        return this.withOperatorContext(args, async (context) => {
          const includeState = optionalBoolean(args, "includeState") ?? true;
          const state = includeState ? await buildOperatorSurfaceState(context) : undefined;
          return successEnvelope(renderOperatorRuntime(state, {
            mode: (optionalString(args, "mode") as OperatorRuntimeMode | undefined) ?? "mcp-sandbox",
            includeState,
            publicMcpBaseUrl: publicMcpBaseUrl(this.options.env),
            uiPublicUrls: uiPublicUrls(this.options.env),
          }));
        });
      case "operator_state_get":
        return this.withOperatorContext(args, async (context) =>
          successEnvelope(await buildOperatorSurfaceState(context))
        );
      case "actor_get":
        return client.actor.get({
          id: optionalNumber(args, "id"),
          name: optionalString(args, "name"),
        });
      case "actor_list":
        return client.actor.list({
          status: optionalString(args, "status") as any,
          provider: optionalString(args, "provider"),
        });
      case "role_get":
        return client.role.get({
          id: optionalNumber(args, "id"),
          name: optionalString(args, "name"),
        });
      case "role_list":
        return client.role.list({
          status: optionalString(args, "status") as any,
        });
      case "role_binding_list":
        return client.role.bindings({
          actorId: optionalNumber(args, "actorId"),
          roleId: optionalNumber(args, "roleId"),
          surface: optionalString(args, "surface"),
          status: optionalString(args, "status") as any,
          limit: optionalNumber(args, "limit"),
          offset: optionalNumber(args, "offset"),
        });
      case "intent_get":
        return client.intent.get(requireNumber(args, "id"));
      case "intent_list":
        return client.intent.list({
          scope: optionalString(args, "scope"),
          status: optionalString(args, "status") as any,
          limit: optionalNumber(args, "limit"),
          offset: optionalNumber(args, "offset"),
        });
      case "intent_create":
        return client.intent.create({
          description: requireString(args, "description"),
          source: optionalString(args, "source"),
          scope: optionalString(args, "scope"),
          addressedTo: optionalNumber(args, "addressedTo"),
          parentId: optionalNumber(args, "parentId"),
          status: optionalString(args, "status") as any,
        });
      case "intent_update":
        return client.intent.update({
          id: requireNumber(args, "id"),
          reason: requireString(args, "reason"),
          status: optionalString(args, "status") as any,
          description: optionalString(args, "description"),
          resolutionNotes: optionalString(args, "resolutionNotes"),
          addressedTo: optionalNumber(args, "addressedTo"),
        });
      case "interpret_get":
      case "interpretation_get":
        return client.interpret.get(requireNumber(args, "id"));
      case "interpret_list":
      case "interpretation_list":
        return client.interpret.list({
          intentId: optionalNumber(args, "intentId"),
          domainId: optionalNumber(args, "domainId"),
          actorId: optionalNumber(args, "actorId"),
          status: optionalString(args, "status") as any,
          alignment: optionalString(args, "alignment") as any,
          limit: optionalNumber(args, "limit"),
          offset: optionalNumber(args, "offset"),
        });
      case "interpret_create":
      case "interpretation_create":
        return client.interpret.create({
          intentId: requireNumber(args, "intentId"),
          domainId: requireNumber(args, "domainId"),
          title: requireString(args, "title"),
          scopeAssumption: optionalString(args, "scopeAssumption"),
          status: optionalString(args, "status") as any,
          alignment: optionalString(args, "alignment") as any,
          sourceRef: optionalString(args, "sourceRef"),
          resolverId: optionalNumber(args, "resolverId"),
          resolveBy: optionalString(args, "resolveBy"),
        });
      case "interpret_update":
      case "interpretation_update":
        return client.interpret.update({
          id: requireNumber(args, "id"),
          reason: requireString(args, "reason"),
          status: optionalString(args, "status") as any,
          alignment: optionalString(args, "alignment") as any,
          resolverId: optionalNumber(args, "resolverId"),
          resolveBy: optionalString(args, "resolveBy"),
          scopeAssumption: optionalString(args, "scopeAssumption"),
          sourceRef: optionalString(args, "sourceRef"),
        });
      case "interpret_supersede":
      case "interpretation_supersede":
        return client.interpret.supersede({
          id: requireNumber(args, "id"),
          newTitle: requireString(args, "newTitle"),
          reason: requireString(args, "reason"),
          newScopeAssumption: optionalString(args, "newScopeAssumption"),
          newStatus: optionalString(args, "newStatus") as any,
        });
      case "action_log":
        return client.action.log({
          intentId: requireNumber(args, "intentId"),
          interpretationId: optionalNumber(args, "interpretationId"),
          domainId: optionalNumber(args, "domainId"),
          description: requireString(args, "description"),
          outcome: optionalString(args, "outcome"),
          governingContractKey: optionalString(args, "governingContractKey"),
          assumedRole: optionalString(args, "assumedRole"),
          invokedSkillRef: optionalString(args, "invokedSkillRef"),
          policyRef: optionalString(args, "policyRef"),
        });
      case "claim_create":
        return client.claim.create({
          entityTable: optionalString(args, "entityTable"),
          entityId: requireNumber(args, "entityId"),
          note: optionalString(args, "note"),
        });
      case "claim_release":
        return client.claim.release({
          id: requireNumber(args, "id"),
          reason: optionalString(args, "reason"),
        });
      case "expertise_register":
        return client.expertise.register({
          intentId: requireNumber(args, "intentId"),
          domainId: requireNumber(args, "domainId"),
          signal: requireString(args, "signal") as any,
          note: optionalString(args, "note"),
        });
      case "event_list":
        return client.event.list({
          scope: optionalString(args, "scope"),
          entityTable: optionalString(args, "entityTable"),
          limit: optionalNumber(args, "limit"),
          offset: optionalNumber(args, "offset"),
        });
      case "report_create":
        return client.report.create({
          kind: requireString(args, "kind"),
          title: requireString(args, "title"),
          summary: requireString(args, "summary"),
          scope: optionalString(args, "scope"),
          bodyRef: optionalString(args, "bodyRef"),
          domainId: optionalNumber(args, "domainId"),
          intentId: optionalNumber(args, "intentId"),
          sourceRef: optionalString(args, "sourceRef"),
          assumedRole: optionalString(args, "assumedRole"),
          invokedSkillRef: optionalString(args, "invokedSkillRef"),
          policyRef: optionalString(args, "policyRef"),
        });
      case "report_list":
        return client.report.list({
          scope: optionalString(args, "scope"),
          kind: optionalString(args, "kind"),
          intentId: optionalNumber(args, "intentId"),
          domainId: optionalNumber(args, "domainId"),
          actorId: optionalNumber(args, "actorId"),
          limit: optionalNumber(args, "limit"),
          offset: optionalNumber(args, "offset"),
        });
      case "contract_register":
        return client.contract.register({
          key: requireString(args, "key"),
          kind: requireString(args, "kind") as any,
          domainId: optionalNumber(args, "domainId"),
          parentKey: optionalString(args, "parentKey"),
          title: requireString(args, "title"),
          body: requireString(args, "body"),
          scope: optionalString(args, "scope"),
          status: optionalString(args, "status") as any,
          governingContractKey: optionalString(args, "governingContractKey"),
          mandateRef: optionalString(args, "mandateRef"),
        });
      case "contract_get":
        return client.contract.get({
          id: optionalNumber(args, "id"),
          key: optionalString(args, "key"),
          status: optionalString(args, "status") as any,
        });
      case "contract_list":
        return client.contract.list({
          key: optionalString(args, "key"),
          kind: optionalString(args, "kind") as any,
          scope: optionalString(args, "scope"),
          domainId: optionalNumber(args, "domainId"),
          status: optionalString(args, "status") as any,
          parentKey: optionalString(args, "parentKey"),
          governingContractKey: optionalString(args, "governingContractKey"),
          limit: optionalNumber(args, "limit"),
          offset: optionalNumber(args, "offset"),
        });
      case "contract_supersede":
        return client.contract.supersede({
          id: requireNumber(args, "id"),
          body: requireString(args, "body"),
          reason: requireString(args, "reason"),
          title: optionalString(args, "title"),
          status: optionalString(args, "status") as any,
          domainId: optionalNumber(args, "domainId"),
          governingContractKey: optionalString(args, "governingContractKey"),
          mandateRef: optionalString(args, "mandateRef"),
        });
      case "actor_type_register":
        return client.actorType.register({
          name: requireString(args, "name"),
          title: optionalString(args, "title"),
          body: requireString(args, "body"),
          scope: optionalString(args, "scope"),
          domainId: optionalNumber(args, "domainId"),
          parentKey: optionalString(args, "parentKey"),
          status: optionalString(args, "status") as any,
          governingContractKey: optionalString(args, "governingContractKey"),
          mandateRef: optionalString(args, "mandateRef"),
        });
      case "actor_type_get": {
        const name = requireString(args, "name");
        const key = `actor-type:${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
        return client.contract.get({
          key,
          status: optionalString(args, "status") as any,
        });
      }
      case "actor_type_list":
        return client.contract.list({
          kind: "actor_type",
          scope: optionalString(args, "scope"),
          domainId: optionalNumber(args, "domainId"),
          status: optionalString(args, "status") as any,
          limit: optionalNumber(args, "limit"),
          offset: optionalNumber(args, "offset"),
        });
      case "vault_read":
        return client.vault.read({ path: requireString(args, "path") });
      case "vault_search":
        return client.vault.search({
          query: requireString(args, "query"),
          path: optionalString(args, "path"),
          limit: optionalNumber(args, "limit"),
          format: optionalString(args, "format") as any,
        });
      case "vault_write":
        return client.vault.write({
          intent: requireNumber(args, "intent"),
          path: requireString(args, "path"),
          content: requireString(args, "content"),
          governingContractKey: optionalString(args, "governingContractKey"),
          assumedRole: optionalString(args, "assumedRole"),
          invokedSkillRef: optionalString(args, "invokedSkillRef"),
          policyRef: optionalString(args, "policyRef"),
        });
      case "vault_append":
        return client.vault.append({
          intent: requireNumber(args, "intent"),
          path: requireString(args, "path"),
          content: requireString(args, "content"),
          governingContractKey: optionalString(args, "governingContractKey"),
          assumedRole: optionalString(args, "assumedRole"),
          invokedSkillRef: optionalString(args, "invokedSkillRef"),
          policyRef: optionalString(args, "policyRef"),
        });
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async withOperatorContext<T>(
    args: Record<string, unknown>,
    fn: (context: {
      repo: GovernanceRepository;
      service: GovernanceService;
      defaultActor?: string;
      defaultActorId?: number;
      publicMcpBaseUrl?: string;
      uiPublicUrls?: string[];
    }) => Promise<T>
  ) {
    const env = this.options.env ?? process.env;
    const actor = optionalString(args, "actor") ?? this.options.defaultActor ?? env.CML_ACTOR;
    const actorId = actor
      ? undefined
      : this.options.defaultActorId ?? parseOptionalEnvInteger(env.CML_ACTOR_ID);
    const repo = this.options.repository ?? new SqliteGovernanceRepository(
      this.options.dbPath ?? env.CML_DB_PATH ?? requireEnv("CML_DB_PATH")
    );
    const ownsRepo = !this.options.repository;
    try {
      return await fn({
        repo,
        service: new GovernanceService(repo),
        defaultActor: actor,
        defaultActorId: actorId,
        publicMcpBaseUrl: publicMcpBaseUrl(env),
        uiPublicUrls: uiPublicUrls(env),
      });
    } finally {
      if (ownsRepo && "close" in repo && typeof repo.close === "function") {
        repo.close();
      }
    }
  }

  private result(id: JsonRpcId, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private error(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message, data } };
  }
}

function toolResult(structuredContent: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError,
  };
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function numberSchema(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function booleanSchema(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

function enumSchema(values: string[], description: string): Record<string, unknown> {
  return { type: "string", enum: values, description };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing required string argument: ${key}`);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`Argument ${key} must be a string`);
  return value;
}

function requireNumber(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Missing required integer argument: ${key}`);
  return value;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Argument ${key} must be an integer`);
  return value;
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new Error(`Argument ${key} must be a boolean`);
  return value;
}

function successEnvelope<T>(data: T): Record<string, unknown> {
  return { ok: true, data, meta: { schema_version: 2 } };
}

function parseOptionalEnvInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error("Actor id env value must be an integer");
  return parsed;
}

function requireEnv(name: string): string {
  throw new Error(`Set ${name} before using operator state tools`);
}

function publicMcpBaseUrl(env: NodeJS.ProcessEnv | undefined): string {
  return env?.CML_PUBLIC_MCP_BASE_URL ?? DEFAULT_PUBLIC_MCP_BASE_URL;
}

function uiPublicUrls(env: NodeJS.ProcessEnv | undefined): string[] {
  return parseCsv(env?.CML_UI_PUBLIC_URLS);
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
