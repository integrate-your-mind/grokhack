#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-test-"));
const excludedTopLevel = new Set([
  ".git",
  ".env",
  "data",
  "dist",
  "dist-test",
  "edge",
  "node_modules",
]);
const excludedDirectoryNames = new Set([
  ".wrangler",
  "coverage",
  "dist",
  "dist-server",
  "dist-test",
  "node_modules",
]);

function shouldCopy(source) {
  const relative = path.relative(root, source);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  if (excludedTopLevel.has(parts[0])) return false;
  if (parts.some((part) => excludedDirectoryNames.has(part))) return false;
  return true;
}

let status;
try {
  fs.cpSync(root, sandbox, {
    recursive: true,
    dereference: false,
    filter: shouldCopy,
  });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(sandbox, "node_modules"), "dir");

  const vitest = path.join(root, "node_modules", ".bin", "vitest");
  const testEnv = { ...process.env };
  for (const key of Object.keys(testEnv)) {
    if (
      /^(ADMIN_TOKEN|CF_|CLOUDFLARE_|DISCORD_|IRC_|X402_|GROKHACK_(?:DB_PATH|DATA_DIR|RESUME_TOKENS_PATH|DEV_BYPASS_PAYMENTS))/.test(
        key
      )
    ) {
      delete testEnv[key];
    }
  }
  const sandboxNonce = randomUUID();
  const sentinel = path.join(sandbox, ".grokhack-test-sandbox");
  fs.writeFileSync(sentinel, sandboxNonce, { encoding: "utf8", mode: 0o600 });
  console.log(`[test] isolated sandbox: ${sandbox}`);
  const result = spawnSync(vitest, ["run", ...process.argv.slice(2)], {
    cwd: sandbox,
    env: {
      ...testEnv,
      NODE_ENV: "test",
      IRC_ENABLED: "0",
      GROKHACK_TEST_ISOLATED: "1",
      GROKHACK_TEST_DATA_ROOT: path.join(sandbox, ".test-data"),
      GROKHACK_TEST_SANDBOX_SENTINEL: sentinel,
      GROKHACK_TEST_SANDBOX_NONCE: sandboxNonce,
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally {
  if (process.env.GROKHACK_KEEP_TEST_SANDBOX === "1") {
    console.log(`[test] preserved sandbox: ${sandbox}`);
  } else {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

process.exitCode = status ?? 1;
