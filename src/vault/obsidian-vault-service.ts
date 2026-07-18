import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

export interface VaultCommandResult {
  operation: string;
  path?: string;
  data?: string;
}

export interface ObsidianVaultServiceOptions {
  obsidianBin?: string;
  vaultName?: string;
  vaultRoot?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultPathError";
  }
}

export class ObsidianVaultService {
  private readonly obsidianBin: string;
  private readonly vaultName?: string;
  private readonly vaultRoot?: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ObsidianVaultServiceOptions = {}) {
    this.obsidianBin = options.obsidianBin ?? "obsidian";
    this.vaultName = options.vaultName;
    this.vaultRoot = options.vaultRoot ?? options.env?.CML_VAULT_ROOT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.env = options.env ?? process.env;
  }

  async read(path: string): Promise<VaultCommandResult> {
    const safePath = safeVaultPath(path);
    if (this.vaultRoot) {
      const data = await readFile(this.resolveVaultPath(safePath), "utf8");
      return { operation: "read", path: safePath, data };
    }
    const data = await this.run(["read", `path=${safePath}`]);
    return { operation: "read", path: safePath, data };
  }

  async search(query: string, options: { path?: string; limit?: number; format?: "text" | "json" } = {}): Promise<VaultCommandResult> {
    if (query.trim().length === 0) throw new VaultPathError("Search query must not be empty");
    if (this.vaultRoot) {
      const data = await this.searchFilesystem(query, options);
      return { operation: "search", data };
    }
    const args = ["search", `query=${query}`];
    if (options.path) args.push(`path=${safeVaultPath(options.path)}`);
    if (options.limit != null) {
      if (!Number.isInteger(options.limit) || options.limit < 1) throw new VaultPathError("Search limit must be a positive integer");
      args.push(`limit=${options.limit}`);
    }
    if (options.format) args.push(`format=${options.format}`);
    const data = await this.run(args);
    return { operation: "search", data };
  }

  async write(path: string, content: string): Promise<VaultCommandResult> {
    const safePath = safeVaultPath(path);
    if (this.vaultRoot) {
      const absolute = this.resolveVaultPath(safePath);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
      return { operation: "write", path: safePath, data: "written" };
    }
    const data = await this.run(["create", `path=${safePath}`, `content=${content}`, "overwrite"]);
    return { operation: "write", path: safePath, data };
  }

  async append(path: string, content: string): Promise<VaultCommandResult> {
    const safePath = safeVaultPath(path);
    if (this.vaultRoot) {
      const absolute = this.resolveVaultPath(safePath);
      await mkdir(dirname(absolute), { recursive: true });
      const exists = await pathExists(absolute);
      await appendFile(absolute, `${exists ? "\n" : ""}${content}`);
      return { operation: "append", path: safePath, data: "appended" };
    }
    const data = await this.run(["append", `path=${safePath}`, `content=${content}`]);
    return { operation: "append", path: safePath, data };
  }

  async move(path: string, to: string): Promise<VaultCommandResult> {
    const safePath = safeVaultPath(path);
    const safeDestination = safeVaultPath(to);
    if (this.vaultRoot) {
      const source = this.resolveVaultPath(safePath);
      const destination = this.resolveVaultPath(safeDestination);
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination);
      return { operation: "move", path: safeDestination, data: "moved" };
    }
    const data = await this.run(["move", `path=${safePath}`, `to=${safeDestination}`]);
    return { operation: "move", path: safeDestination, data };
  }

  async delete(path: string): Promise<VaultCommandResult> {
    const safePath = safeVaultPath(path);
    if (this.vaultRoot) {
      await rm(this.resolveVaultPath(safePath), { force: true });
      return { operation: "delete", path: safePath, data: "deleted" };
    }
    const data = await this.run(["delete", `path=${safePath}`]);
    return { operation: "delete", path: safePath, data };
  }

  private resolveVaultPath(path: string): string {
    if (!this.vaultRoot) throw new VaultPathError("Vault root is not configured");
    const root = resolve(this.vaultRoot);
    const absolute = resolve(root, path);
    const fromRoot = relative(root, absolute);
    if (fromRoot.startsWith("..") || fromRoot.split(/[\\/]+/).includes("..")) {
      throw new VaultPathError("Vault path resolves outside the vault root");
    }
    return absolute;
  }

  private async searchFilesystem(query: string, options: { path?: string; limit?: number; format?: "text" | "json" }): Promise<string> {
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) throw new VaultPathError("Search limit must be a positive integer");
    const basePath = options.path ? safeVaultPath(options.path) : undefined;
    const start = this.resolveVaultPath(basePath ?? ".");
    const root = resolve(this.vaultRoot!);
    const lowerQuery = query.toLowerCase();
    const results: Array<{ path: string; line: number; preview: string }> = [];
    const startStat = await stat(start);
    const files = startStat.isDirectory() ? walkFiles(start) : [start];

    for await (const file of files) {
      if (results.length >= limit) break;
      const fileStat = await stat(file);
      if (!fileStat.isFile() || fileStat.size > MAX_SEARCH_FILE_BYTES) continue;
      const vaultRelativePath = relative(root, file).split(/[\\/]+/).join("/");
      if (vaultRelativePath.startsWith(".obsidian/")) continue;
      const matches = await searchFile(file, lowerQuery, vaultRelativePath, limit - results.length);
      results.push(...matches);
    }

    if (options.format === "json") return JSON.stringify(results, null, 2);
    return results.map((result) => `${result.path}:${result.line}: ${result.preview}`).join("\n");
  }

  private async run(args: string[]): Promise<string> {
    const commandArgs = this.vaultName ? [...args, `vault=${this.vaultName}`] : args;
    try {
      const { stdout } = await execFileAsync(this.obsidianBin, commandArgs, {
        env: this.env,
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = stdout.trimEnd();
      if (/^Error:/m.test(output)) {
        throw new Error(`Obsidian CLI failed: ${output}`);
      }
      return output;
    } catch (error) {
      if (isExecError(error)) {
        const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
        const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
        const detail = stderr || stdout || error.message;
        throw new Error(`Obsidian CLI failed: ${detail}`);
      }
      throw error;
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = resolve(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(absolute);
    } else if (entry.isFile()) {
      yield absolute;
    }
  }
}

async function searchFile(file: string, lowerQuery: string, vaultRelativePath: string, limit: number): Promise<Array<{ path: string; line: number; preview: string }>> {
  const results: Array<{ path: string; line: number; preview: string }> = [];
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (line.toLowerCase().includes(lowerQuery)) {
      results.push({
        path: vaultRelativePath,
        line: lineNumber,
        preview: line.trim().slice(0, 240),
      });
      if (results.length >= limit) {
        rl.close();
        break;
      }
    }
  }
  return results;
}

export function safeVaultPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) throw new VaultPathError("Vault path must not be empty");
  if (trimmed.startsWith("/")) throw new VaultPathError("Vault path must be relative");
  const parts = trimmed.split(/[\\/]+/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new VaultPathError("Vault path must not contain empty, current, or parent segments");
  }
  return parts.join("/");
}

function isExecError(error: unknown): error is Error & { stdout?: unknown; stderr?: unknown } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
