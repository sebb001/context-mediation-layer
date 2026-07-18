#!/usr/bin/env node

import readline from "node:readline";
import { CmlMcpServer } from "./server.js";

const server = new CmlMcpServer({
  dbPath: process.env.CML_DB_PATH,
  defaultActor: process.env.CML_ACTOR,
  defaultActorId: process.env.CML_ACTOR_ID ? Number(process.env.CML_ACTOR_ID) : undefined,
  obsidianBin: process.env.CML_OBSIDIAN_BIN,
  vaultName: process.env.CML_OBSIDIAN_VAULT,
  vaultRoot: process.env.CML_VAULT_ROOT,
});

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let queue = Promise.resolve();

rl.on("line", (line) => {
  queue = queue
    .then(() => handleLine(line))
    .catch((error) => {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      }) + "\n");
    });
});

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  try {
    const message = JSON.parse(trimmed);
    const response = await server.handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: error instanceof Error ? error.message : String(error),
      },
    }) + "\n");
  }
}

export * from "./server.js";
