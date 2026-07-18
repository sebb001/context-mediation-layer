/**
 * WorkspaceService — anti-corruption interface for execution workspace management.
 *
 * Wraps: project workspaces, execution workspaces, git worktree isolation,
 *        workspace lifecycle and cleanup.
 * CML vocabulary only. No project/company concepts cross this boundary.
 *
 * Substitution criteria:
 * - Create isolated execution environments (directory + optional git worktree)
 * - Track workspace lifecycle (create, active, archived)
 * - Support workspace reuse policies
 * - Clean up workspaces on completion
 */

export type WorkspaceId = string;

export type WorkspaceStrategy = "directory" | "git_worktree";
export type WorkspaceStatus = "creating" | "active" | "archived" | "failed";

export interface WorkspaceSpec {
  /** Human-readable label for this workspace. */
  label: string;
  /** Isolation strategy. */
  strategy: WorkspaceStrategy;
  /** Base path or repo URL for git_worktree strategy. */
  basePath: string;
  /** Optional branch for git_worktree. */
  branch?: string;
  /** Whether this workspace can be reused across invocations. */
  reusable: boolean;
}

export interface WorkspaceInfo {
  id: WorkspaceId;
  label: string;
  strategy: WorkspaceStrategy;
  status: WorkspaceStatus;
  /** Absolute filesystem path to the workspace root. */
  path: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface WorkspaceService {
  /** Create a new workspace. */
  create(spec: WorkspaceSpec): Promise<WorkspaceInfo>;

  /** Get workspace info by ID. */
  get(id: WorkspaceId): Promise<WorkspaceInfo | null>;

  /** List workspaces, optionally filtered by status. */
  list(status?: WorkspaceStatus): Promise<WorkspaceInfo[]>;

  /** Mark a workspace as actively in use. */
  acquire(id: WorkspaceId): Promise<WorkspaceInfo>;

  /** Release a workspace after use. Archives non-reusable workspaces. */
  release(id: WorkspaceId): Promise<void>;

  /** Permanently remove an archived workspace and its files. */
  destroy(id: WorkspaceId): Promise<void>;
}
