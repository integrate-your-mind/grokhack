import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DATA_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

/**
 * Authoritative writable data root.
 *
 * Production keeps the historical repository-local default. Tests and managed
 * deployments can redirect all file-backed state before importing server code.
 */
export function dataRoot(): string {
  const configured = process.env.GROKHACK_DATA_DIR?.trim();
  if (process.env.VITEST && !configured) {
    throw new Error("Vitest requires an isolated GROKHACK_DATA_DIR; run tests with `npm test`");
  }
  return configured ? path.resolve(configured) : DEFAULT_DATA_ROOT;
}

export function dataPath(...segments: string[]): string {
  return path.join(dataRoot(), ...segments);
}
