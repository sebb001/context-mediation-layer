import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  WorkspaceId,
  WorkspaceInfo,
  WorkspaceService,
  WorkspaceSpec,
} from "../../interfaces/workspace-service.js";

type StoredWorkspace = WorkspaceInfo & {
  reusable: boolean;
  basePath: string;
  branch?: string;
  acquired: boolean;
};

export interface LocalWorkspaceServiceOptions {
  now?: () => string;
  idFactory?: () => string;
  rootDir?: string;
}

function cloneWorkspace(workspace: StoredWorkspace): WorkspaceInfo {
  return {
    id: workspace.id,
    label: workspace.label,
    strategy: workspace.strategy,
    status: workspace.status,
    path: workspace.path,
    createdAt: workspace.createdAt,
    lastUsedAt: workspace.lastUsedAt,
  };
}

async function ensureDirectory(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

/**
 * Local workspace service.
 *
 * This keeps the useful substrate shape:
 * - durable workspace registry
 * - directory or git-worktree style provisioning
 * - lifecycle transitions
 * - explicit cleanup
 *
 * The provider intentionally models "git_worktree" as a filesystem-isolated
 * checkout shell rather than importing project/issue semantics.
 */
export function createLocalWorkspaceService(
  options: LocalWorkspaceServiceOptions = {},
): WorkspaceService {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? randomUUID;
  const rootDir = options.rootDir ?? path.resolve(process.cwd(), ".cml-workspaces");
  const workspaces = new Map<WorkspaceId, StoredWorkspace>();

  async function create(spec: WorkspaceSpec): Promise<WorkspaceInfo> {
    const id = idFactory() as WorkspaceId;
    const createdAt = now();
    const workspacePath = path.resolve(rootDir, id);

    await ensureDirectory(workspacePath);
    if (spec.strategy === "git_worktree") {
      await ensureDirectory(path.join(workspacePath, ".git"));
      await fs.writeFile(
        path.join(workspacePath, ".git", "cml-worktree.txt"),
        `base=${spec.basePath}\nbranch=${spec.branch ?? "main"}\n`,
        "utf8",
      );
    }

    const workspace: StoredWorkspace = {
      id,
      label: spec.label,
      strategy: spec.strategy,
      status: "active",
      path: workspacePath,
      createdAt,
      lastUsedAt: createdAt,
      reusable: spec.reusable,
      basePath: spec.basePath,
      branch: spec.branch,
      acquired: false,
    };
    workspaces.set(id, workspace);
    return cloneWorkspace(workspace);
  }

  async function get(id: WorkspaceId): Promise<WorkspaceInfo | null> {
    const workspace = workspaces.get(id);
    return workspace ? cloneWorkspace(workspace) : null;
  }

  async function list(status?: WorkspaceInfo["status"]): Promise<WorkspaceInfo[]> {
    return Array.from(workspaces.values())
      .filter((workspace) => !status || workspace.status === status)
      .map(cloneWorkspace);
  }

  async function acquire(id: WorkspaceId): Promise<WorkspaceInfo> {
    const workspace = workspaces.get(id);
    if (!workspace) {
      throw new Error(`Unknown workspace: ${id}`);
    }
    if (workspace.status !== "active") {
      throw new Error(`Workspace is not active: ${id}`);
    }
    workspace.acquired = true;
    workspace.lastUsedAt = now();
    return cloneWorkspace(workspace);
  }

  async function release(id: WorkspaceId): Promise<void> {
    const workspace = workspaces.get(id);
    if (!workspace) return;
    workspace.acquired = false;
    workspace.lastUsedAt = now();
    if (!workspace.reusable) {
      workspace.status = "archived";
    }
  }

  async function destroy(id: WorkspaceId): Promise<void> {
    const workspace = workspaces.get(id);
    if (!workspace) return;
    await fs.rm(workspace.path, { recursive: true, force: true });
    workspaces.delete(id);
  }

  return {
    create,
    get,
    list,
    acquire,
    release,
    destroy,
  };
}
