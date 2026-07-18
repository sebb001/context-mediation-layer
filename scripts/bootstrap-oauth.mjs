#!/usr/bin/env node

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const baseUrl = trimTrailingSlash(args["base-url"] ?? "http://127.0.0.1:8788");
const actor = args.actor ?? "pilot-user";
const keyDir = args["key-dir"] ?? "./var/oauth";
const out = args.out ?? "./.env.oauth.local";
const force = args.force === "1" || args.force === "true";
const keyPath = resolve(keyDir, "private-key.pem");
const jwksPath = resolve(keyDir, "public-jwks.json");
const clientStorePath = resolve(keyDir, "clients.json");
const envPath = resolve(out);

for (const path of [keyPath, jwksPath, envPath]) {
  if (existsSync(path) && !force) {
    console.error(`${path} already exists. Re-run with --force true to rotate pilot OAuth material.`);
    process.exit(1);
  }
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = `cml-${randomBytes(6).toString("hex")}`;
const authSecret = base64Url(randomBytes(32));
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const jwk = publicKey.export({ format: "jwk" });
jwk.kid = kid;
jwk.alg = "RS256";
jwk.use = "sig";

mkdirSync(dirname(keyPath), { recursive: true });
writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
writeFileSync(jwksPath, `${JSON.stringify({ keys: [jwk] }, null, 2)}\n`, { mode: 0o600 });
writeFileSync(envPath, envFile({
  CML_OAUTH_PILOT_ISSUER: "1",
  CML_PUBLIC_MCP_BASE_URL: baseUrl,
  CML_OAUTH_RESOURCE: `${baseUrl}/mcp`,
  CML_OAUTH_AUDIENCE: `${baseUrl}/mcp`,
  CML_OAUTH_PRIVATE_KEY_PATH: keyPath,
  CML_OAUTH_KEY_ID: kid,
  CML_OAUTH_CLIENT_STORE_PATH: clientStorePath,
  CML_OAUTH_AUTH_SECRET: authSecret,
  CML_OAUTH_PILOT_SUBJECT: actor,
  CML_OAUTH_DEFAULT_ACTOR: actor,
  CML_OAUTH_SCOPES: "cml:read",
}), { mode: 0o600 });

console.log(JSON.stringify({
  ok: true,
  env: envPath,
  privateKey: keyPath,
  jwks: jwksPath,
  clientStore: clientStorePath,
  issuer: baseUrl,
  resource: `${baseUrl}/mcp`,
  actor,
}, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const equals = key.indexOf("=");
    if (equals >= 0) {
      parsed[key.slice(0, equals)] = key.slice(equals + 1);
      continue;
    }
    parsed[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : "true";
  }
  return parsed;
}

function envFile(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${shellEscape(value)}`).join("\n")}\n`;
}

function shellEscape(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
