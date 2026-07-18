#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tempDir = await mkdtemp(join(tmpdir(), "cml-smoke-"));
const configPath = join(tempDir, "cml.config.json");

function run(args) {
  const result = spawnSync(process.execPath, [join(root, "dist/cli/index.js"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

try {
  run(["init", "--config", configPath]);
  const status = JSON.parse(run(["--config", configPath, "status"]));
  if (!status.ok || status.data.actor.name !== "local-operator") {
    throw new Error("local status check did not return the default operator");
  }
  process.stdout.write("local smoke ok\n");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
