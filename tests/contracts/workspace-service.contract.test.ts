import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { WorkspaceService } from "../../src/runtime/interfaces/workspace-service.js";
import {
  createFakeWorkspaceService,
  createLocalWorkspaceService,
} from "../../src/runtime/providers/index.js";

function runWorkspaceServiceContract(name: string, factory: () => WorkspaceService) {
  describe(name, () => {
    it("creates and lists active workspaces", async () => {
      const service = factory();
      const workspace = await service.create({
        label: "runtime-main",
        strategy: "directory",
        basePath: "/tmp/base",
        reusable: true,
      });

      expect(workspace.status).toBe("active");
      const all = await service.list();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        id: workspace.id,
        label: "runtime-main",
        strategy: "directory",
      });
    });

    it("acquires and releases reusable workspaces without archiving them", async () => {
      const service = factory();
      const workspace = await service.create({
        label: "runtime-main",
        strategy: "directory",
        basePath: "/tmp/base",
        reusable: true,
      });

      const acquired = await service.acquire(workspace.id);
      expect(acquired.id).toBe(workspace.id);

      await service.release(workspace.id);
      const reread = await service.get(workspace.id);
      expect(reread?.status).toBe("active");
    });

    it("archives non-reusable workspaces on release", async () => {
      const service = factory();
      const workspace = await service.create({
        label: "ephemeral",
        strategy: "directory",
        basePath: "/tmp/base",
        reusable: false,
      });

      await service.acquire(workspace.id);
      await service.release(workspace.id);

      const reread = await service.get(workspace.id);
      expect(reread?.status).toBe("archived");
      const archived = await service.list("archived");
      expect(archived.map((item) => item.id)).toContain(workspace.id);
    });

    it("destroys workspaces permanently", async () => {
      const service = factory();
      const workspace = await service.create({
        label: "to-destroy",
        strategy: "directory",
        basePath: "/tmp/base",
        reusable: false,
      });

      await service.destroy(workspace.id);
      expect(await service.get(workspace.id)).toBeNull();
    });
  });
}

describe("WorkspaceService contract", () => {
  runWorkspaceServiceContract("fake provider", () => createFakeWorkspaceService());

  const rootDir = path.join(os.tmpdir(), "cml-workspace-contracts");
  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  runWorkspaceServiceContract("local provider", () =>
    createLocalWorkspaceService({
      rootDir,
      now: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
      })(),
      idFactory: (() => {
        let counter = 0;
        return () => `ws-${++counter}`;
      })(),
    }),
  );

  it("local provider provisions git_worktree-style directories without leaking ontology", async () => {
    const service = createLocalWorkspaceService({
      rootDir,
      idFactory: (() => {
        let counter = 100;
        return () => `ws-${++counter}`;
      })(),
    });

    const workspace = await service.create({
      label: "git-sandbox",
      strategy: "git_worktree",
      basePath: "git@github.com:example/repo.git",
      branch: "feature/test",
      reusable: true,
    });

    const marker = await fs.readFile(
      path.join(workspace.path, ".git", "cml-worktree.txt"),
      "utf8",
    );

    expect(marker).toContain("base=git@github.com:example/repo.git");
    expect(marker).toContain("branch=feature/test");
  });
});
