/**
 * Fake WorkspaceService for vertical-slice integration tests.
 */

import {
  WorkspaceService,
  WorkspaceId,
  WorkspaceSpec,
  WorkspaceInfo,
  WorkspaceStatus,
} from "../../src/runtime/interfaces/workspace-service.js";

export class FakeWorkspaceService implements WorkspaceService {
  workspaces = new Map<WorkspaceId, WorkspaceInfo>();
  private nextId = 1;

  /** If true, create() will throw to simulate workspace failure. */
  shouldFail = false;

  async create(spec: WorkspaceSpec): Promise<WorkspaceInfo> {
    if (this.shouldFail) throw new Error("Fake workspace creation failed");

    const id = `ws-${this.nextId++}` as WorkspaceId;
    const info: WorkspaceInfo = {
      id,
      label: spec.label,
      strategy: spec.strategy,
      status: "creating",
      path: `/tmp/fake-workspaces/${id}`,
      createdAt: new Date().toISOString(),
    };
    this.workspaces.set(id, info);
    return info;
  }

  async get(id: WorkspaceId): Promise<WorkspaceInfo | null> {
    return this.workspaces.get(id) ?? null;
  }

  async list(status?: WorkspaceStatus): Promise<WorkspaceInfo[]> {
    const all = Array.from(this.workspaces.values());
    return status ? all.filter((w) => w.status === status) : all;
  }

  async acquire(id: WorkspaceId): Promise<WorkspaceInfo> {
    const ws = this.workspaces.get(id);
    if (!ws) throw new Error(`Workspace ${id} not found`);
    const acquired = { ...ws, status: "active" as WorkspaceStatus, lastUsedAt: new Date().toISOString() };
    this.workspaces.set(id, acquired);
    return acquired;
  }

  async release(id: WorkspaceId): Promise<void> {
    const ws = this.workspaces.get(id);
    if (!ws) throw new Error(`Workspace ${id} not found`);
    this.workspaces.set(id, { ...ws, status: "archived" });
  }

  async destroy(id: WorkspaceId): Promise<void> {
    this.workspaces.delete(id);
  }
}
