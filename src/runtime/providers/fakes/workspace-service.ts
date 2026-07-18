import path from "node:path";
import type {
  WorkspaceId,
  WorkspaceInfo,
  WorkspaceService,
  WorkspaceSpec,
} from "../../interfaces/workspace-service.js";

type FakeWorkspace = WorkspaceInfo & { reusable: boolean };

export function createFakeWorkspaceService(): WorkspaceService {
  const workspaces = new Map<WorkspaceId, FakeWorkspace>();
  let nextId = 1;

  function newId(): WorkspaceId {
    return `workspace-${nextId++}`;
  }

  function clone(workspace: FakeWorkspace): WorkspaceInfo {
    return { ...workspace };
  }

  return {
    async create(spec: WorkspaceSpec): Promise<WorkspaceInfo> {
      const id = newId();
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, nextId)).toISOString();
      const workspace: FakeWorkspace = {
        id,
        label: spec.label,
        strategy: spec.strategy,
        status: "active",
        path: path.resolve("/tmp/cml-fake", id),
        createdAt: timestamp,
        lastUsedAt: timestamp,
        reusable: spec.reusable,
      };
      workspaces.set(id, workspace);
      return clone(workspace);
    },

    async get(id: WorkspaceId): Promise<WorkspaceInfo | null> {
      const workspace = workspaces.get(id);
      return workspace ? clone(workspace) : null;
    },

    async list(status?: WorkspaceInfo["status"]): Promise<WorkspaceInfo[]> {
      return Array.from(workspaces.values())
        .filter((workspace) => !status || workspace.status === status)
        .map(clone);
    },

    async acquire(id: WorkspaceId): Promise<WorkspaceInfo> {
      const workspace = workspaces.get(id);
      if (!workspace) throw new Error(`Unknown workspace: ${id}`);
      if (workspace.status !== "active") throw new Error(`Workspace is not active: ${id}`);
      workspace.lastUsedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, nextId)).toISOString();
      return clone(workspace);
    },

    async release(id: WorkspaceId): Promise<void> {
      const workspace = workspaces.get(id);
      if (!workspace) return;
      workspace.lastUsedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, nextId)).toISOString();
      if (!workspace.reusable) workspace.status = "archived";
    },

    async destroy(id: WorkspaceId): Promise<void> {
      workspaces.delete(id);
    },
  };
}
