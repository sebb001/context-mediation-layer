import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actorId } from "../../src/governance/domain.js";
import { InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { CmlMcpServer } from "../../src/mcp/server.js";

describe("CmlMcpServer", () => {
  let tempDir: string;
  let obsidianBin: string;
  let vaultRoot: string;
  let repo: InMemoryGovernanceRepository;
  let server: CmlMcpServer;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "cml-mcp-"));
    obsidianBin = join(tempDir, "fake-obsidian-cli.mjs");
    vaultRoot = join(tempDir, "vault");
    writeFileSync(
      obsidianBin,
      `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
} else if (command === "append") {
  if (!existsSync(source)) {
    console.log("Error: File \\"" + flags.path + "\\" not found.");
    process.exit(0);
  }
  mkdirSync(dirname(source), { recursive: true });
  appendFileSync(source, (existsSync(source) ? "\\n" : "") + (flags.content ?? ""));
  console.log("appended");
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
      name: "mcp-agent",
      role: "agent",
      provider: "openai-codex",
      capabilityNamespace: "mcp-test",
      defaultScope: "default",
    });
    server = new CmlMcpServer({
      repository: repo,
      defaultActor: "mcp-agent",
      obsidianBin,
      env: { ...process.env, FAKE_OBSIDIAN_ROOT: vaultRoot },
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes with MCP tool capabilities", async () => {
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });
    expect(response?.result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "cml-mcp" },
    });
  });

  it("lists the bounded MVP tool surface", async () => {
    const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(response?.result).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "status" }),
        expect.objectContaining({ name: "ui_manifest" }),
        expect.objectContaining({ name: "ui_runtime_get" }),
        expect.objectContaining({ name: "operator_state_get" }),
        expect.objectContaining({ name: "actor_get" }),
        expect.objectContaining({ name: "actor_list" }),
        expect.objectContaining({ name: "role_get" }),
        expect.objectContaining({ name: "role_list" }),
        expect.objectContaining({ name: "role_binding_list" }),
        expect.objectContaining({ name: "intent_create" }),
        expect.objectContaining({ name: "interpretation_create" }),
        expect.objectContaining({ name: "action_log" }),
        expect.objectContaining({ name: "intent_get" }),
        expect.objectContaining({ name: "contract_get" }),
        expect.objectContaining({ name: "vault_write" }),
      ]),
    });
  });

  it("exposes actor, role, and binding registry reads through MCP", async () => {
    const role = await repo.registerRole({
      name: "kinkscapes-collaborator",
      contractKey: "role:kinkscapes-collaborator",
      description: "Role-bound collaborator profile.",
    });
    const binding = await repo.bindActorRole({
      actorId: actorId(1),
      roleId: role.id,
      surface: "grok-mcp",
      provider: "xai-grok",
      credentialRef: "oauth-client:grok-kinkscapes",
    });

    const actors = await server.handle({
      jsonrpc: "2.0",
      id: 60,
      method: "tools/call",
      params: { name: "actor_list", arguments: { status: "active" } },
    });
    expect(actors?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({ name: "mcp-agent", provider: "openai-codex" }),
        ]),
      },
    });

    const actor = await server.handle({
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: { name: "actor_get", arguments: { name: "mcp-agent" } },
    });
    expect(actor?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: { id: 1, name: "mcp-agent", defaultScope: "default" },
      },
    });

    const roles = await server.handle({
      jsonrpc: "2.0",
      id: 62,
      method: "tools/call",
      params: { name: "role_list", arguments: { status: "active" } },
    });
    expect(roles?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({ name: "kinkscapes-collaborator", contractKey: "role:kinkscapes-collaborator" }),
        ]),
      },
    });

    const readRole = await server.handle({
      jsonrpc: "2.0",
      id: 63,
      method: "tools/call",
      params: { name: "role_get", arguments: { name: "kinkscapes-collaborator" } },
    });
    expect(readRole?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: { id: role.id, name: "kinkscapes-collaborator" },
      },
    });

    const bindings = await server.handle({
      jsonrpc: "2.0",
      id: 64,
      method: "tools/call",
      params: { name: "role_binding_list", arguments: { actorId: 1, roleId: role.id } },
    });
    expect(bindings?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: [
          expect.objectContaining({
            id: binding.id,
            actorId: 1,
            roleId: role.id,
            surface: "grok-mcp",
            credentialRef: "oauth-client:grok-kinkscapes",
          }),
        ],
      },
    });
  });

  it("exposes operator runtime tools and canonical write aliases", async () => {
    await repo.registerDomain({
      name: "framework",
      scope: "default",
      concern: "MCP operator testing",
    });
    await repo.createIntent({
      scope: "default",
      description: "Existing MCP operator intent",
      source: "test",
      status: "active",
    }, actorId(1));

    const manifest = await server.handle({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "ui_manifest", arguments: {} },
    });
    expect(manifest?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: {
          name: "cml-operator-sidebar",
          publicMcpUrl: "https://mcp.example",
          requiredMcpTools: expect.arrayContaining(["ui_runtime_get", "intent_create"]),
        },
      },
    });

    const runtime = await server.handle({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "ui_runtime_get", arguments: { mode: "mcp-sandbox", includeState: true } },
    });
    expect(runtime?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: {
          mediaType: "text/html",
          version: "1.0.0",
        },
      },
    });
    expect((runtime?.result as any).structuredContent.data.html).toContain("Existing MCP operator intent");

    const createdIntent = await server.handle({
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "intent_create",
        arguments: {
          description: "Resolution intent from MCP",
          parentId: 1,
          status: "draft",
        },
      },
    });
    expect(createdIntent?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: { parentId: 1, status: "draft" },
      },
    });

    const updatedIntent = await server.handle({
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: {
        name: "intent_update",
        arguments: {
          id: 1,
          reason: "MCP operator routing",
          addressedTo: 1,
        },
      },
    });
    expect(updatedIntent?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: { id: 1, addressedTo: 1 },
      },
    });

    const interpretation = await server.handle({
      jsonrpc: "2.0",
      id: 34,
      method: "tools/call",
      params: {
        name: "interpretation_create",
        arguments: {
          intentId: 1,
          domainId: 1,
          title: "Operator MCP interpretation",
          alignment: "uncertain",
          status: "proposed",
        },
      },
    });
    expect(interpretation?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: { id: 1, title: "Operator MCP interpretation" },
      },
    });

    const updatedInterpretation = await server.handle({
      jsonrpc: "2.0",
      id: 35,
      method: "tools/call",
      params: {
        name: "interpretation_update",
        arguments: {
          id: 1,
          reason: "MCP update",
          alignment: "divergent",
          scopeAssumption: "Updated by MCP operator alias.",
        },
      },
    });
    expect(updatedInterpretation?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: {
          id: 1,
          alignment: "divergent",
          scopeAssumption: "Updated by MCP operator alias.",
        },
      },
    });

    const action = await server.handle({
      jsonrpc: "2.0",
      id: 36,
      method: "tools/call",
      params: {
        name: "action_log",
        arguments: {
          intentId: 1,
          interpretationId: 1,
          description: "Operator MCP action",
          outcome: "Logged",
        },
      },
    });
    expect(action?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: { description: "Operator MCP action", interpretationId: 1 },
      },
    });

    const claim = await server.handle({
      jsonrpc: "2.0",
      id: 37,
      method: "tools/call",
      params: {
        name: "claim_create",
        arguments: {
          entityTable: "intents",
          entityId: 1,
          note: "MCP claim",
        },
      },
    });
    expect(claim?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: { id: 1, status: "active" },
      },
    });

    const release = await server.handle({
      jsonrpc: "2.0",
      id: 38,
      method: "tools/call",
      params: {
        name: "claim_release",
        arguments: { id: 1, reason: "MCP done" },
      },
    });
    expect(release?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: { released: true },
      },
    });

    const expertise = await server.handle({
      jsonrpc: "2.0",
      id: 39,
      method: "tools/call",
      params: {
        name: "expertise_register",
        arguments: {
          intentId: 1,
          domainId: 1,
          signal: "concerned",
        },
      },
    });
    expect(expertise?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: { signal: "concerned", intentId: 1 },
      },
    });

    const superseded = await server.handle({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "interpretation_supersede",
        arguments: {
          id: 1,
          newTitle: "Replacement MCP interpretation",
          reason: "MCP supersession",
        },
      },
    });
    expect(superseded?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: {
          old: { id: 1, status: "superseded" },
          replacement: { id: 2, title: "Replacement MCP interpretation" },
        },
      },
    });

    const state = await server.handle({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "operator_state_get", arguments: {} },
    });
    expect(state?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: {
          summary: {
            activeIntentCount: 1,
            draftIntentCount: 1,
          },
          supersessionChains: [expect.objectContaining({ currentId: 2, predecessorIds: [1] })],
        },
      },
    });

    const events = await server.handle({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "event_list", arguments: { limit: 10 } },
    });
    expect(events?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({ eventType: "interpretation_superseded" }),
        ]),
      },
    });
  });

  it("registers and reads canonical contracts through MCP tools", async () => {
    const registered = await server.handle({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "contract_register",
        arguments: {
          key: "root:agent-bootstrap",
          kind: "root",
          title: "Agent Bootstrap",
          body: "Use the CML contract registry as authority.",
          mandateRef: "INTENT-35",
        },
      },
    });
    expect(registered?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: {
          key: "root:agent-bootstrap",
          status: "active",
          version: 1,
        },
      },
    });

    const read = await server.handle({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "contract_get",
        arguments: { key: "root:agent-bootstrap" },
      },
    });
    expect(read?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: {
          key: "root:agent-bootstrap",
          body: "Use the CML contract registry as authority.",
        },
      },
    });
  });

  it("writes vault material through tools/call and returns structured content", async () => {
    const intent = await repo.createIntent({
      scope: "default",
      description: "MCP vault mandate",
      source: "test",
    });

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "vault_write",
        arguments: {
          intent: intent.id,
          path: "99_engine/smoke/mcp-vault.md",
          content: "hello mcp",
        },
      },
    });

    expect(response?.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        data: {
          vault: { operation: "write", path: "99_engine/smoke/mcp-vault.md" },
          action: { description: "Vault write: 99_engine/smoke/mcp-vault.md" },
        },
      },
    });

    const read = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "vault_read",
        arguments: { path: "99_engine/smoke/mcp-vault.md" },
      },
    });
    expect(read?.result).toMatchObject({
      structuredContent: {
        ok: true,
        data: { data: "hello mcp" },
      },
    });
  });

  it("returns SDK failures as visible tool errors", async () => {
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "vault_write",
        arguments: {
          intent: 99999,
          path: "99_engine/smoke/missing-intent.md",
          content: "should fail",
        },
      },
    });
    expect(response?.result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { message: "Intent 99999 not found" },
      },
    });
  });

  it("treats Obsidian stdout errors as failed tool calls without logging an action", async () => {
    const intent = await repo.createIntent({
      scope: "default",
      description: "MCP append mandate",
      source: "test",
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "vault_append",
        arguments: {
          intent: intent.id,
          path: "99_engine/smoke/missing.md",
          content: "should fail",
        },
      },
    });
    expect(response?.result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { message: expect.stringContaining("Obsidian CLI failed") },
      },
    });
    const actions = await repo.listActions({ intentId: intent.id });
    expect(actions).toHaveLength(0);
  });
});
