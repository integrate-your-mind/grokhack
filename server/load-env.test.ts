import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertOwnerOnlyFile, loadEnvFile } from "./load-env.js";

describe("sensitive environment file permissions", () => {
  const directories: string[] = [];

  afterEach(() => {
    delete process.env.GROKHACK_TEST_ENV_SENTINEL;
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces owner-only permissions before loading in every runtime mode", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-env-load-mode-"));
    directories.push(directory);
    const file = path.join(directory, ".env");
    fs.writeFileSync(file, "GROKHACK_TEST_ENV_SENTINEL=loaded\n", { mode: 0o600 });

    loadEnvFile(file);
    expect(process.env.GROKHACK_TEST_ENV_SENTINEL).toBe("loaded");

    if (process.platform !== "win32") {
      delete process.env.GROKHACK_TEST_ENV_SENTINEL;
      fs.chmodSync(file, 0o644);
      expect(() => loadEnvFile(file)).toThrow(/mode 0600/);
      expect(process.env.GROKHACK_TEST_ENV_SENTINEL).toBeUndefined();
    }
  });

  it("accepts owner-only files and rejects group/world-readable secrets", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-env-mode-"));
    directories.push(directory);
    const file = path.join(directory, ".env");
    fs.writeFileSync(file, "SAFE_TEST_VALUE=1\n", { mode: 0o600 });
    expect(() => assertOwnerOnlyFile(file, "Test .env")).not.toThrow();

    if (process.platform !== "win32") {
      fs.chmodSync(file, 0o644);
      expect(() => assertOwnerOnlyFile(file, "Test .env")).toThrow(/mode 0600/);
    }
  });
});
