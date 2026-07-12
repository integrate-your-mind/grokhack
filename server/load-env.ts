import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");

export function assertOwnerOnlyFile(file: string, label: string): void {
  if (process.platform === "win32" || !fs.existsSync(file)) return;
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${label} must be owner-readable only (mode 0600, found ${mode.toString(8)})`);
  }
}

export function loadEnvFile(file = envPath): void {
  if (!fs.existsSync(file)) return;
  // .env is a credential container in every environment. Enforce the same
  // owner-only boundary even when production mode itself is declared inside
  // the file and therefore is not visible until after parsing.
  assertOwnerOnlyFile(file, ".env");
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]] != null) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
