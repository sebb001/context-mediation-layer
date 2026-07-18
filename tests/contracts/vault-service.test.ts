import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianVaultService } from "../../src/vault/obsidian-vault-service.js";

describe("ObsidianVaultService filesystem backend", () => {
  let tempDir: string;
  let vaultRoot: string;
  let service: ObsidianVaultService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "cml-vault-"));
    vaultRoot = join(tempDir, "vault");
    await mkdir(join(vaultRoot, "05_formulations", "outside-the-machine"), { recursive: true });
    writeFileSync(
      join(vaultRoot, "05_formulations", "outside-the-machine", "essay.md"),
      "The machine is a social object.\nCML makes coordination legible.\n"
    );
    service = new ObsidianVaultService({ vaultRoot });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads vault files without an Obsidian process", async () => {
    const result = await service.read("05_formulations/outside-the-machine/essay.md");
    expect(result).toMatchObject({
      operation: "read",
      path: "05_formulations/outside-the-machine/essay.md",
      data: "The machine is a social object.\nCML makes coordination legible.\n",
    });
  });

  it("searches vault files from a folder path", async () => {
    const result = await service.search("coordination", {
      path: "05_formulations/outside-the-machine",
      format: "json",
    });
    expect(JSON.parse(result.data ?? "[]")).toEqual([
      {
        path: "05_formulations/outside-the-machine/essay.md",
        line: 2,
        preview: "CML makes coordination legible.",
      },
    ]);
  });

  it("writes and appends through the filesystem backend", async () => {
    await service.write("99_engine/smoke/fs-vault.md", "first");
    await service.append("99_engine/smoke/fs-vault.md", "second");
    expect(readFileSync(join(vaultRoot, "99_engine", "smoke", "fs-vault.md"), "utf8")).toBe("first\nsecond");
  });

  it("blocks parent traversal", async () => {
    await expect(service.read("../outside.md")).rejects.toThrow("parent");
    expect(existsSync(join(tempDir, "outside.md"))).toBe(false);
  });
});
