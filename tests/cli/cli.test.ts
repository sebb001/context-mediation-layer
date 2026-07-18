import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixtureSchemaUrl = new URL("../fixtures/governance-schema.sql", import.meta.url);

function loadGovernanceSchema(): string {
  return readFileSync(process.env.CML_SCHEMA_SQL ?? fixtureSchemaUrl, "utf8");
}

describe("cml CLI", () => {
  let tempDir: string;
  let dbPath: string;
  let obsidianBin: string;
  let fakeVaultRoot: string;

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: process.cwd(), stdio: "pipe" });
    tempDir = mkdtempSync(join(tmpdir(), "cml-cli-"));
    dbPath = join(tempDir, "cml.db");
    obsidianBin = join(tempDir, "fake-obsidian-cli.mjs");
    fakeVaultRoot = join(tempDir, "vault");
    writeFileSync(
      obsidianBin,
      `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.env.FAKE_OBSIDIAN_ROOT;
if (!root) {
  console.error("FAKE_OBSIDIAN_ROOT missing");
  process.exit(1);
}

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
  mkdirSync(dirname(source), { recursive: true });
  appendFileSync(source, (existsSync(source) ? "\\n" : "") + (flags.content ?? ""));
  console.log("appended");
} else if (command === "read") {
  process.stdout.write(readFileSync(source, "utf8"));
} else if (command === "search") {
  if (flags.path && flags.path.includes("..")) {
    console.error("unsafe path");
    process.exit(1);
  }
  console.log("match\\t" + flags.query);
} else if (command === "move") {
  const destination = join(root, flags.to);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);
  console.log("moved");
} else if (command === "delete") {
  rmSync(source, { force: true });
  console.log("deleted");
} else {
  console.error("unknown command " + command);
  process.exit(1);
}
`
    );
    chmodSync(obsidianBin, 0o755);
    const db = new DatabaseSync(dbPath);
    db.exec(loadGovernanceSchema());
    db.prepare("INSERT INTO scopes (name, description) VALUES ('default', 'Default')").run();
    db.prepare(
      `INSERT INTO actors (id, name, role, provider, capability_namespace, default_scope)
       VALUES (22, 'build-agent', 'agent', 'openai-codex', 'build', 'default')`
    ).run();
    db.prepare(
      `INSERT INTO domains (id, scope, name, concern)
       VALUES (4, 'default', 'Framework Build', 'CML framework build')`
    ).run();
    db.close();
  }, 30000);

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function cli(args: string[], actorId = "22") {
    const output = execFileSync("node", ["dist/cli/index.js", "--db", dbPath, "--actor-id", actorId, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CML_OBSIDIAN_BIN: obsidianBin, FAKE_OBSIDIAN_ROOT: fakeVaultRoot },
    });
    return JSON.parse(output);
  }

  function cliByActorName(args: string[], actorName = "build-agent") {
    const output = execFileSync("node", ["dist/cli/index.js", "--db", dbPath, "--actor", actorName, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CML_OBSIDIAN_BIN: obsidianBin, FAKE_OBSIDIAN_ROOT: fakeVaultRoot },
    });
    return JSON.parse(output);
  }

  it("smoke-runs status with JSON envelope", () => {
    const result = cli(["status"]);
    expect(result.ok).toBe(true);
    expect(result.meta.schema_version).toBe(2);
    expect(result.data.actor.name).toBe("build-agent");
  });

  it("initializes a config-backed local pilot database", () => {
    const initDir = mkdtempSync(join(tmpdir(), "cml-init-"));
    const configPath = join(initDir, "cml.config.json");
    try {
      const initOutput = execFileSync("node", ["dist/cli/index.js", "init", "--config", configPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const init = JSON.parse(initOutput);
      expect(init.ok).toBe(true);
      expect(existsSync(configPath)).toBe(true);
      expect(init.data.actor.name).toBe("local-operator");
      expect(init.data.contracts.root.key).toBe("root:cml-bootstrap");

      const statusOutput = execFileSync("node", ["dist/cli/index.js", "--config", configPath, "status"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const status = JSON.parse(statusOutput);
      expect(status.ok).toBe(true);
      expect(status.data.actor.name).toBe("local-operator");
    } finally {
      rmSync(initDir, { recursive: true, force: true });
    }
  });

  it("generates transparent MCP setup snippets", () => {
    const outPath = join(tempDir, "mcp.stdio.json");
    const output = execFileSync("node", ["dist/cli/index.js", "setup", "mcp", "--transport", "stdio", "--out", outPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    expect(result.ok).toBe(true);
    expect(result.data.transport).toBe("stdio");
    expect(existsSync(outPath)).toBe(true);
    const generated = JSON.parse(readFileSync(outPath, "utf8"));
    expect(generated.mcpServers["cml"].command).toBe("cml-mcp");
  });

  it("resolves provisioned actor identity by stable name", () => {
    const result = cliByActorName(["status"]);
    expect(result.ok).toBe(true);
    expect(result.data.actor.id).toBe(22);
    expect(result.data.actor.status).toBe("active");
  });

  it("--actor takes precedence over CML_ACTOR_ID", () => {
    const output = execFileSync("node", ["dist/cli/index.js", "--db", dbPath, "--actor", "build-agent", "status"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CML_ACTOR_ID: "999" },
    });
    const result = JSON.parse(output);
    expect(result.ok).toBe(true);
    expect(result.data.actor.id).toBe(22);
  });

  it("provisions actors with context contract metadata", () => {
    const result = cli([
      "actor",
      "provision",
      "--name",
      "cowork-research",
      "--provider",
      "claude-cowork",
      "--capability-namespace",
      "research, synthesis",
      "--contract-ref",
      "vault/contracts/cowork-research.md",
      "--context-ref",
      "vault/context-packs/cowork-research.md",
      "--context-policy",
      "intent-window + linked reports only",
      "--description",
      "Research synthesis actor",
    ]);
    expect(result.ok).toBe(true);
    expect(result.data.status).toBe("active");
    expect(result.data.contextRef).toContain("context-packs");
    expect(result.data.contextPolicy).toContain("linked reports");

    const get = cli(["actor", "get", "cowork-research"]);
    expect(get.ok).toBe(true);
    expect(get.data.contractRef).toContain("contracts");

    const cleared = cli([
      "actor",
      "update",
      String(get.data.id),
      "--clear-contract-ref",
      "--clear-context-ref",
    ]);
    expect(cleared.ok).toBe(true);
    expect(cleared.data.contractRef).toBeUndefined();
    expect(cleared.data.contextRef).toBeUndefined();
  });

  it("registers roles and binds them to actor surfaces", () => {
    const root = cli([
      "contract",
      "register",
      "--key",
      "root:role-bootstrap",
      "--kind",
      "root",
      "--title",
      "Role Bootstrap",
      "--body",
      "Roles are provisioned from CML contract registry matter.",
    ]);
    expect(root.ok).toBe(true);

    const roleContract = cli([
      "contract",
      "register",
      "--key",
      "role:project-advisor",
      "--kind",
      "role",
      "--parent-key",
      "root:role-bootstrap",
      "--title",
      "Project Advisor",
      "--body",
      "Only an approved agent actor using a reviewed reasoning profile may assume this role.",
    ]);
    expect(roleContract.ok).toBe(true);

    const role = cli([
      "role",
      "register",
      "--name",
      "project-advisor",
      "--contract-key",
      "role:project-advisor",
      "--description",
      "Approved agent and reviewed reasoning profile only.",
    ]);
    expect(role.ok).toBe(true);
    expect(role.data.contractKey).toBe("role:project-advisor");
    expect(role.data.contractRef).toBeUndefined();
    expect(role.data.policyRef).toBeUndefined();

    const binding = cli([
      "role",
      "bind",
      "--role-id",
      String(role.data.id),
      "--surface",
      "chatgpt-app",
      "--provider",
      "openai-chatgpt-5.5-high-reasoning",
      "--credential-ref",
      "cml:secret-path:project-advisor",
    ]);
    expect(binding.ok).toBe(true);
    expect(binding.data.actorId).toBe(22);

    const bindings = cli(["role", "bindings", "--role-id", String(role.data.id)]);
    expect(bindings.ok).toBe(true);
    expect(bindings.data).toHaveLength(1);
  });

  it("round-trips canonical contracts without projection paths", () => {
    const root = cli([
      "contract",
      "register",
      "--key",
      "root:cli-bootstrap",
      "--kind",
      "root",
      "--title",
      "CLI Bootstrap",
      "--body",
      "Agents use CML contract get/list for canonical contracts.",
      "--mandate-ref",
      "INTENT-35",
    ]);
    expect(root.ok).toBe(true);
    expect(root.data.contentHash).toMatch(/^sha256:/);

    const skill = cli([
      "contract",
      "register",
      "--key",
      "skill:cli-reading",
      "--kind",
      "skill",
      "--parent-key",
      "root:cli-bootstrap",
      "--title",
      "CLI Reading Skill",
      "--body",
      "Initial skill contract.",
      "--domain",
      "4",
      "--governing-contract-key",
      "root:cli-bootstrap",
    ]);
    expect(skill.ok).toBe(true);
    expect(skill.data.parentKey).toBe("root:cli-bootstrap");
    expect(skill.data.domainId).toBe(4);
    expect(skill.data.governingContractKey).toBe("root:cli-bootstrap");

    const replacement = cli([
      "contract",
      "supersede",
      String(skill.data.id),
      "--body",
      "Revised skill contract.",
      "--reason",
      "test revision",
      "--domain",
      "4",
      "--governing-contract-key",
      "root:cli-bootstrap",
      "--mandate-ref",
      "INTERPRETATION-101",
    ]);
    expect(replacement.ok).toBe(true);
    expect(replacement.data.old.status).toBe("superseded");
    expect(replacement.data.replacement.version).toBe(2);

    const active = cli(["contract", "get", "skill:cli-reading"]);
    expect(active.ok).toBe(true);
    expect(active.data.id).toBe(replacement.data.replacement.id);
    expect(active.data.body).toBe("Revised skill contract.");

    const listed = cli([
      "contract",
      "list",
      "--kind",
      "skill",
      "--status",
      "active",
      "--domain",
      "4",
      "--governing-contract-key",
      "root:cli-bootstrap",
    ]);
    expect(listed.ok).toBe(true);
    expect(listed.data.some((contract: { key: string }) => contract.key === "skill:cli-reading")).toBe(true);
  });

  it("imports contracts, actor types, and roles from JSON", () => {
    const importPath = join(tempDir, "contract-import.json");
    writeFileSync(importPath, JSON.stringify({
      contracts: [
        {
          key: "root:import-test",
          kind: "root",
          title: "Import Test Root",
          body: "Imported root contract for CLI coverage.",
        },
      ],
      actorTypes: [
        {
          name: "imported-agent",
          parentKey: "root:import-test",
          title: "Imported Agent",
          body: "Imported actor type for pilot setup.",
        },
      ],
      roles: [
        {
          name: "imported-operator",
          contractKey: "root:import-test",
          description: "Imported setup role.",
        },
      ],
    }));

    const result = cli(["contract", "import", "--file", importPath]);
    expect(result.ok).toBe(true);
    expect(result.data.results).toHaveLength(3);

    const actorType = cli(["contract", "get", "actor-type:imported-agent"]);
    expect(actorType.ok).toBe(true);
    expect(actorType.data.parentKey).toBe("root:import-test");
  });

  it("registers actor type defaults and applies them to unqualified actions", () => {
    const root = cli([
      "contract",
      "register",
      "--key",
      "root:cli-actor-types",
      "--kind",
      "root",
      "--title",
      "CLI Actor Type Bootstrap",
      "--body",
      "Actor type defaults are baseline signposts, not directory fences.",
    ]);
    expect(root.ok).toBe(true);

    const actorType = cli([
      "actor-type",
      "register",
      "--name",
      "CLI Default",
      "--title",
      "CLI Default Actor",
      "--body",
      "Default baseline for CLI-created agents without a more specific governing contract.",
      "--parent-key",
      "root:cli-actor-types",
    ]);
    expect(actorType.ok).toBe(true);
    expect(actorType.data.key).toBe("actor-type:cli-default");
    expect(actorType.data.kind).toBe("actor_type");

    const actor = cli([
      "actor",
      "provision",
      "--name",
      "cli-defaulted-agent",
      "--provider",
      "openai-codex",
      "--actor-type",
      "CLI Default",
      "--capability-namespace",
      "build",
    ]);
    expect(actor.ok).toBe(true);
    expect(actor.data.defaultContractKey).toBe("actor-type:cli-default");

    const intent = cli(["intent", "create", "--description", "Default actor type action", "--source", "test"]);
    const action = cliByActorName([
      "action",
      "log",
      "--intent",
      String(intent.data.id),
      "--description",
      "No explicit governing contract supplied",
    ], "cli-defaulted-agent");
    expect(action.ok).toBe(true);
    expect(action.data.governingContractKey).toBe("actor-type:cli-default");
  });

  it("rejects inactive actors before accountable writes", () => {
    const provisioned = cli([
      "actor",
      "provision",
      "--name",
      "retired-spike",
      "--provider",
      "openai-codex",
      "--capability-namespace",
      "spike",
    ]);
    cli(["actor", "retire", String(provisioned.data.id), "--reason", "test retirement"]);

    const output = spawnSync("node", [
      "dist/cli/index.js",
      "--db",
      dbPath,
      "--actor",
      "retired-spike",
      "intent",
      "create",
      "--description",
      "Should fail",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output.status).toBe(1);
    const result = JSON.parse(output.stdout);
    expect(result.error.code).toBe("ACTOR_INACTIVE");
  });

  it("round-trips intent create and list", () => {
    const created = cli(["intent", "create", "--description", "CLI intent", "--source", "test"]);
    expect(created.ok).toBe(true);
    expect(created.data.description).toBe("CLI intent");

    const listed = cli(["intent", "list", "--scope", "default"]);
    expect(listed.ok).toBe(true);
    expect(listed.data.some((intent: { description: string }) => intent.description === "CLI intent")).toBe(true);
  });

  it("accepts --key=value flags", () => {
    const created = cli(["intent", "create", "--description=Equals intent", "--source=test"]);
    expect(created.ok).toBe(true);
    expect(created.data.description).toBe("Equals intent");
    expect(created.data.source).toBe("test");
  });

  it("rejects invalid enum flags before hitting SQLite constraints", () => {
    const output = spawnSync("node", [
      "dist/cli/index.js",
      "--db",
      dbPath,
      "--actor-id",
      "22",
      "intent",
      "list",
      "--status",
      "not-a-status",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output.status).toBe(1);
    const result = JSON.parse(output.stdout);
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("--status must be one of");
  });

  it("fails fast for unknown actor id", () => {
    const output = spawnSync("node", ["dist/cli/index.js", "--db", dbPath, "--actor-id", "999", "status"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output.status).toBe(1);
    const result = JSON.parse(output.stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ACTOR_NOT_FOUND");
  });

  it("requires an explicit database path", () => {
    const output = spawnSync("node", ["dist/cli/index.js", "--actor-id", "22", "status"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CML_DB_PATH: "" },
    });
    expect(output.status).toBe(1);
    const result = JSON.parse(output.stdout);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("DB_PATH_REQUIRED");
  });

  it("files an interpretation and logs an action", () => {
    const intent = cli(["intent", "create", "--description", "Interpretation target", "--source", "test"]);
    const interp = cli([
      "interpret",
      "file",
      "--intent",
      String(intent.data.id),
      "--domain",
      "4",
      "--title",
      "CLI interpretation",
      "--scope-assumption",
      "Test scope",
    ]);
    expect(interp.ok).toBe(true);

    const action = cli([
      "action",
      "log",
      "--intent",
      String(intent.data.id),
      "--interpretation",
      String(interp.data.id),
      "--domain",
      "4",
      "--description",
      "Logged from CLI",
    ]);
    expect(action.ok).toBe(true);
    expect(action.data.interpretationId).toBe(interp.data.id);
    expect(action.data.domainId).toBe(4);
  });

  it("resolves CML references and returns intent context without filesystem guessing", () => {
    const intent = cli(["intent", "create", "--description", "Resolver target", "--source", "test"]);
    const interp = cli([
      "interpret",
      "file",
      "--intent",
      String(intent.data.id),
      "--domain",
      "4",
      "--title",
      "Resolver interpretation",
    ]);
    const report = cli([
      "report",
      "create",
      "--kind",
      "status",
      "--title",
      "Resolver status",
      "--summary",
      "Resolver reports are included in context",
      "--intent",
      String(intent.data.id),
    ]);
    cli(["action", "log", "--intent", String(intent.data.id), "--description", "Resolver action"]);

    const resolvedIntent = cli(["resolve", `INTENT-${intent.data.id}`]);
    expect(resolvedIntent.ok).toBe(true);
    expect(resolvedIntent.data.ref).toMatchObject({
      kind: "intent",
      canonical: `INTENT-${intent.data.id}`,
      entityTable: "intents",
    });
    expect(resolvedIntent.data.entity.description).toBe("Resolver target");

    const resolvedInterpretation = cli(["resolve", `INTERPRETATION-${interp.data.id}`]);
    expect(resolvedInterpretation.ok).toBe(true);
    expect(resolvedInterpretation.data.ref.kind).toBe("interpretation");
    expect(resolvedInterpretation.data.entity.title).toBe("Resolver interpretation");

    const resolvedReport = cli(["resolve", `RPT-${report.data.id}`]);
    expect(resolvedReport.ok).toBe(true);
    expect(resolvedReport.data.ref.kind).toBe("report");
    expect(resolvedReport.data.entity.title).toBe("Resolver status");

    const context = cli(["context", `CML-${intent.data.id}`]);
    expect(context.ok).toBe(true);
    expect(context.data.context.intent.description).toBe("Resolver target");
    expect(context.data.context.interpretations).toHaveLength(1);
    expect(context.data.context.actions).toHaveLength(1);
    expect(context.data.context.reports).toHaveLength(1);
    expect(context.data.context.summary.reportCount).toBe(1);
  });

  it("tracks actor sessions without changing action attribution", () => {
    const opened = cliByActorName([
      "session",
      "open",
      "--session-ref",
      "codex-thread-1",
      "--surface",
      "codex-desktop",
      "--transcript-ref",
      "transcripts/codex-thread-1.md",
    ]);
    expect(opened.ok).toBe(true);
    expect(opened.data.actorId).toBe(22);

    const intent = cliByActorName(["intent", "create", "--description", "Session attribution target"]);
    const action = cliByActorName([
      "action",
      "log",
      "--intent",
      String(intent.data.id),
      "--description",
      "Promoted work from session",
      "--outcome",
      "Stable actor remains accountable",
    ]);
    expect(action.ok).toBe(true);
    expect(action.data.actorId).toBe(22);

    const closed = cliByActorName(["session", "close", "--session-ref", "codex-thread-1"]);
    expect(closed.ok).toBe(true);
    expect(closed.data.status).toBe("closed");
  });

  it("re-opening an active actor session is idempotent", () => {
    const first = cliByActorName([
      "session",
      "open",
      "--session-ref",
      "codex-thread-reopen",
      "--surface",
      "codex-desktop",
    ]);
    const second = cliByActorName([
      "session",
      "open",
      "--session-ref",
      "codex-thread-reopen",
      "--surface",
      "codex-desktop",
      "--transcript-ref",
      "transcripts/reopened.md",
    ]);
    expect(second.ok).toBe(true);
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.transcriptRef).toBe("transcripts/reopened.md");
    expect(Date.parse(second.data.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(first.data.lastSeenAt));
  });

  it("promotes session-worthy material as a report with stable actor and source ref", () => {
    const report = cliByActorName([
      "report",
      "create",
      "--kind",
      "compression",
      "--title",
      "Session compression",
      "--summary",
      "Promoted useful session subset",
      "--source-ref",
      "codex-thread-1#useful-slice",
      "--body-ref",
      "vault/reports/session-compression.md",
    ]);
    expect(report.ok).toBe(true);
    expect(report.data.actorId).toBe(22);
    expect(report.data.sourceRef).toContain("useful-slice");

    const listed = cliByActorName(["report", "list", "--kind", "compression"]);
    expect(listed.ok).toBe(true);
    expect(listed.data.some((item: { title: string }) => item.title === "Session compression")).toBe(true);
  });

  it("writes vault material through Obsidian CLI and logs a governed action", () => {
    const intent = cli(["intent", "create", "--description", "Vault mutation mandate", "--source", "test"]);
    const written = cli([
      "vault",
      "write",
      "--intent",
      String(intent.data.id),
      "--path",
      "99_engine/smoke/vault-cli-test.md",
      "--content",
      "hello from cml",
    ]);
    expect(written.ok).toBe(true);
    expect(written.data.vault.operation).toBe("write");
    expect(written.data.action.description).toContain("Vault write");
    expect(written.data.action.actorId).toBe(22);

    const read = cli(["vault", "read", "--path", "99_engine/smoke/vault-cli-test.md"]);
    expect(read.ok).toBe(true);
    expect(read.data.data).toBe("hello from cml");
  });

  it("supports bounded vault search options", () => {
    const searched = cli([
      "vault",
      "search",
      "--query",
      "hello",
      "--path",
      "99_engine/smoke",
      "--limit",
      "5",
      "--format",
      "json",
    ]);
    expect(searched.ok).toBe(true);
    expect(searched.data.operation).toBe("search");
    expect(searched.data.data).toContain("hello");
  });

  it("requires an intent mandate for vault mutations", () => {
    const output = spawnSync("node", [
      "dist/cli/index.js",
      "--db",
      dbPath,
      "--actor-id",
      "22",
      "vault",
      "append",
      "--path",
      "99_engine/smoke/no-mandate.md",
      "--content",
      "ungoverned",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CML_OBSIDIAN_BIN: obsidianBin, FAKE_OBSIDIAN_ROOT: fakeVaultRoot },
    });
    expect(output.status).toBe(1);
    const result = JSON.parse(output.stdout);
    expect(result.error.message).toContain("Missing required --intent");
  });

  it("preflights vault mutation intent before touching the vault", () => {
    const output = spawnSync("node", [
      "dist/cli/index.js",
      "--db",
      dbPath,
      "--actor-id",
      "22",
      "vault",
      "write",
      "--intent",
      "99999",
      "--path",
      "99_engine/smoke/no-such-intent.md",
      "--content",
      "should not exist",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CML_OBSIDIAN_BIN: obsidianBin, FAKE_OBSIDIAN_ROOT: fakeVaultRoot },
    });
    expect(output.status).toBe(1);
    const result = JSON.parse(output.stdout);
    expect(result.error.message).toContain("Intent 99999 not found");
    expect(existsSync(join(fakeVaultRoot, "99_engine/smoke/no-such-intent.md"))).toBe(false);
  });

  it("requires explicit confirmation for vault delete", () => {
    const intent = cli(["intent", "create", "--description", "Vault delete mandate", "--source", "test"]);
    cli([
      "vault",
      "write",
      "--intent",
      String(intent.data.id),
      "--path",
      "99_engine/smoke/delete-me.md",
      "--content",
      "temporary",
    ]);
    const output = spawnSync("node", [
      "dist/cli/index.js",
      "--db",
      dbPath,
      "--actor-id",
      "22",
      "vault",
      "delete",
      "--intent",
      String(intent.data.id),
      "--path",
      "99_engine/smoke/delete-me.md",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CML_OBSIDIAN_BIN: obsidianBin, FAKE_OBSIDIAN_ROOT: fakeVaultRoot },
    });
    expect(output.status).toBe(1);
    const result = JSON.parse(output.stdout);
    expect(result.error.message).toContain("requires --confirm");
  });

  it("rejects vault paths outside the vault", () => {
    const output = spawnSync("node", [
      "dist/cli/index.js",
      "--db",
      dbPath,
      "--actor-id",
      "22",
      "vault",
      "read",
      "--path",
      "../secret.md",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CML_OBSIDIAN_BIN: obsidianBin, FAKE_OBSIDIAN_ROOT: fakeVaultRoot },
    });
    expect(output.status).toBe(1);
    const result = JSON.parse(output.stdout);
    expect(result.error.message).toContain("parent segments");
  });

  it("filters claims by entity id", () => {
    const first = cli(["intent", "create", "--description", "Claimed intent", "--source", "test"]);
    const second = cli(["intent", "create", "--description", "Other claimed intent", "--source", "test"]);
    cli(["claim", "create", "--entity-id", String(first.data.id), "--note", "first"]);
    cli(["claim", "create", "--entity-id", String(second.data.id), "--note", "second"]);

    const listed = cli(["claim", "list", "--entity-table", "intents", "--entity-id", String(first.data.id)]);
    expect(listed.ok).toBe(true);
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].entityId).toBe(first.data.id);
  });
});
