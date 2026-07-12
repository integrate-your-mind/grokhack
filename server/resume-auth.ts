/**
 * Resume-token vault — sec-app.
 * Binds durable characters to a secret issued only to the joining client.
 * File-backed so cold resume survives restarts without touching persistence.ts schema.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dataPath } from "./data-paths.js";

const DEFAULT_PATH = dataPath("resume-tokens.json");

/** 32 bytes → 64 hex chars */
export function mintResumeToken(): string {
  return randomBytes(32).toString("hex");
}

export function isValidResumeTokenFormat(token: string | null | undefined): boolean {
  return typeof token === "string" && /^[0-9a-f]{64}$/i.test(token);
}

function storePath(): string {
  const configured = process.env.GROKHACK_RESUME_TOKENS_PATH?.trim();
  if (configured) return path.resolve(configured);
  return DEFAULT_PATH;
}

interface TokenStore {
  /** name_lower → token hex */
  tokens: Record<string, string>;
}

let cache: TokenStore | null = null;
let cachePath: string | null = null;

function loadStore(): TokenStore {
  const file = storePath();
  if (cache && cachePath === file) return cache;
  cachePath = file;
  if (!fs.existsSync(file)) {
    cache = { tokens: {} };
    return cache;
  }
  try {
    if (process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) {
      throw new Error("Resume-token vault must be owner-readable only (mode 0600)");
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as TokenStore;
    if (!parsed?.tokens || typeof parsed.tokens !== "object" || Array.isArray(parsed.tokens)) {
      throw new Error("Resume-token vault has an invalid schema");
    }
    cache = { tokens: parsed.tokens };
  } catch (error) {
    throw new Error(
      `Resume-token vault is unreadable or corrupt: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }
  return cache;
}

function saveStore(store: TokenStore): void {
  const file = storePath();
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ tokens: store.tokens }, null, 0), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  cache = store;
  cachePath = file;
}

function normName(name: string): string {
  return name.trim().toLowerCase();
}

export function getResumeToken(name: string): string | null {
  const t = loadStore().tokens[normName(name)];
  return t || null;
}

/** Issue or rotate token for a name. Returns the new token. */
export function issueResumeToken(name: string): string {
  const store = loadStore();
  const token = mintResumeToken();
  store.tokens[normName(name)] = token;
  saveStore(store);
  return token;
}

/** Ensure a token exists; mint if missing (first join / migration). */
export function ensureResumeToken(name: string): string {
  const existing = getResumeToken(name);
  if (existing) return existing;
  return issueResumeToken(name);
}

/**
 * Verify presented token against vault.
 * Returns:
 *  - "ok" — match
 *  - "missing" — no vault entry (caller may mint on first claim)
 *  - "mismatch" — vault has token, presented wrong/empty
 */
export function verifyResumeToken(
  name: string,
  presented: string | null | undefined
): "ok" | "missing" | "mismatch" {
  const expected = getResumeToken(name);
  if (!expected) return "missing";
  if (!presented || !isValidResumeTokenFormat(presented)) return "mismatch";
  try {
    const a = Buffer.from(expected.toLowerCase(), "utf8");
    const b = Buffer.from(presented.toLowerCase(), "utf8");
    if (a.length !== b.length) return "mismatch";
    return timingSafeEqual(a, b) ? "ok" : "mismatch";
  } catch {
    return "mismatch";
  }
}

/** Drop vault entry (dead/won cleanup). */
export function clearResumeToken(name: string): void {
  const store = loadStore();
  const key = normName(name);
  if (!(key in store.tokens)) return;
  delete store.tokens[key];
  saveStore(store);
}

/** Test helper — wipe in-memory + file for isolated runs. */
export function resetResumeAuthForTests(): void {
  cache = { tokens: {} };
  const file = storePath();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}
