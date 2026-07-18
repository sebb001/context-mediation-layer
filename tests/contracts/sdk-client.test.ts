import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { CmlClient } from "../../src/sdk/cml-client.js";

describe("CmlClient", () => {
  let tempDir: string;
  let obsidianBin: string;
  let vaultRoot: string;
  let repo: InMemoryGovernanceRepository;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "cml-sdk-"));
    obsidianBin = join(tempDir, "fake-obsidian-cli.mjs");
    vaultRoot = join(tempDir, "vault");
    writeFileSync(
      obsidianBin,
      `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  mkdirSync(dirname(source), { recursive: true });
  appendFileSync(source, (existsSync(source) ? "\\n" : "") + (flags.content ?? ""));
  console.log("appended");
} else if (command === "read") {
  process.stdout.write(readFileSync(source, "utf8"));
} else if (command === "search") {
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

    repo = new InMemoryGovernanceRepository();
    await repo.registerScope("default");
    await repo.registerActor({
      name: "sdk-agent",
      role: "agent",
      provider: "openai-codex",
      capabilityNamespace: "sdk-test",
      defaultScope: "default",
      contractRef: "contracts/sdk-agent.md",
      contextRef: "context/sdk-agent.md",
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function client(actor = "sdk-agent") {
    return new CmlClient({
      repository: repo,
      actor,
      obsidianBin,
      env: { ...process.env, FAKE_OBSIDIAN_ROOT: vaultRoot },
    });
  }

  it("resolves a stable actor and exposes status", async () => {
    const status = await client().status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.data.actor.name).toBe("sdk-agent");
  });

  it("writes vault material with an intent mandate and logs an action", async () => {
    const epi = client();
    const intent = await epi.intent.create({ description: "SDK vault mandate" });
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    const written = await epi.vault.write({
      intent: intent.data.id,
      path: "99_engine/smoke/sdk-vault.md",
      content: "hello sdk",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.data.vault.operation).toBe("write");
    expect(written.data.action).toMatchObject({ description: "Vault write: 99_engine/smoke/sdk-vault.md" });

    const read = await epi.vault.read({ path: "99_engine/smoke/sdk-vault.md" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data.data).toBe("hello sdk");

    const actions = await epi.action.list({ intentId: intent.data.id });
    expect(actions.ok).toBe(true);
    if (!actions.ok) return;
    expect(actions.data.some((action) => action.description.includes("Vault write"))).toBe(true);
  });

  it("preflights missing intent before vault mutation", async () => {
    const written = await client().vault.write({
      intent: 99999,
      path: "99_engine/smoke/no-intent.md",
      content: "should not exist",
    });
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.error.message).toContain("Intent 99999 not found");
    expect(existsSync(join(vaultRoot, "99_engine/smoke/no-intent.md"))).toBe(false);
  });

  it("rejects retired actor use at the SDK boundary", async () => {
    const retired = await repo.registerActor({
      name: "retired-sdk-agent",
      role: "agent",
      provider: "openai-codex",
      capabilityNamespace: "sdk-test",
      defaultScope: "default",
      status: "retired",
    });
    expect(retired.status).toBe("retired");

    const result = await client("retired-sdk-agent").intent.create({ description: "Should fail" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACTOR_INACTIVE");
  });
});
