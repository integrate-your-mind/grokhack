import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { dataPath } from "./data-paths.js";

const DEFAULT_LINKS_FILE = dataPath("x", "links.json");

/** Override path for tests only. */
let linksFile = DEFAULT_LINKS_FILE;

export interface XLinkCode {
  code: string;
  /** Normalized handle without leading @ (display may re-add it). */
  xHandle: string;
  /** Optional OAuth user id — filled when OAuth lands later. */
  xUserId?: string;
  gameName: string;
  createdAt: string;
  expiresAt: string;
}

export interface XLinkedAccount {
  xHandle: string;
  gameName: string;
  linkedAt: string;
  xUserId?: string;
}

interface XLinkStore {
  pending: XLinkCode[];
  linked: XLinkedAccount[];
}

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const GAME_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/;

export function normalizeXHandle(raw: string): string | null {
  let h = raw.trim().replace(/^@+/, "");
  // Accept x.com/user or twitter.com/user paste
  try {
    if (/^https?:\/\//i.test(h) || h.includes("x.com/") || h.includes("twitter.com/")) {
      const u = h.includes("://") ? new URL(h) : new URL(`https://${h}`);
      const parts = u.pathname.split("/").filter(Boolean);
      h = parts[0] || "";
    }
  } catch {
    /* keep raw stripped handle */
  }
  h = h.replace(/^@+/, "").split(/[/?#]/)[0] || "";
  if (!HANDLE_RE.test(h)) return null;
  return h;
}

export function formatXHandle(handle: string): string {
  const n = handle.replace(/^@+/, "");
  return n ? `@${n}` : "";
}

function emptyStore(): XLinkStore {
  return { pending: [], linked: [] };
}

function load(): XLinkStore {
  const dir = path.dirname(linksFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(linksFile)) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(linksFile, "utf8")) as XLinkStore;
    return {
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      linked: Array.isArray(raw.linked) ? raw.linked : [],
    };
  } catch {
    return emptyStore();
  }
}

function save(store: XLinkStore): void {
  const dir = path.dirname(linksFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(linksFile, JSON.stringify(store, null, 2));
}

/**
 * Create a pending link code (web /link equivalent).
 * Proves later via in-game `:verify CODE` as `gameName`.
 * Ownership of the X account is honor-system until OAuth.
 */
export function createXLinkCode(
  xHandleRaw: string,
  gameNameRaw: string
): { ok: true; entry: XLinkCode } | { ok: false; message: string } {
  const xHandle = normalizeXHandle(xHandleRaw);
  if (!xHandle) {
    return { ok: false, message: "Invalid X handle. Use 1–15 letters, numbers, or underscores." };
  }
  const gameName = gameNameRaw.trim().slice(0, 16);
  if (!GAME_NAME_RE.test(gameName)) {
    return { ok: false, message: "Invalid game name format." };
  }

  const store = load();
  const code = randomBytes(3).toString("hex").toUpperCase();
  const now = Date.now();
  const entry: XLinkCode = {
    code,
    xHandle,
    gameName,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  // One pending per handle and per game name
  store.pending = store.pending.filter(
    (p) =>
      p.xHandle.toLowerCase() !== xHandle.toLowerCase() &&
      p.gameName.toLowerCase() !== gameName.toLowerCase()
  );
  store.pending.push(entry);
  save(store);
  return { ok: true, entry };
}

export function redeemXLinkCode(code: string, gameName: string): { ok: boolean; message: string } {
  const store = load();
  const key = code.trim().toUpperCase();
  const idx = store.pending.findIndex(
    (p) => p.code === key && p.gameName.toLowerCase() === gameName.trim().toLowerCase()
  );
  if (idx < 0) return { ok: false, message: "Invalid or expired X link code." };
  const entry = store.pending[idx];
  if (Date.now() > new Date(entry.expiresAt).getTime()) {
    store.pending.splice(idx, 1);
    save(store);
    return { ok: false, message: "X link code expired. Request a new code on play.html." };
  }
  store.pending.splice(idx, 1);
  // One character per handle, one handle per character
  store.linked = store.linked.filter(
    (l) =>
      l.xHandle.toLowerCase() !== entry.xHandle.toLowerCase() &&
      l.gameName.toLowerCase() !== entry.gameName.toLowerCase()
  );
  store.linked.push({
    xHandle: entry.xHandle,
    gameName: entry.gameName,
    linkedAt: new Date().toISOString(),
    ...(entry.xUserId ? { xUserId: entry.xUserId } : {}),
  });
  save(store);
  return {
    ok: true,
    message: `Linked X ${formatXHandle(entry.xHandle)} to ${entry.gameName}.`,
  };
}

export function getLinkedXHandle(gameName: string): string | null {
  const store = load();
  const hit = store.linked.find((l) => l.gameName.toLowerCase() === gameName.trim().toLowerCase());
  return hit ? hit.xHandle : null;
}

export function getLinkedGameNameForX(xHandleRaw: string): string | null {
  const h = normalizeXHandle(xHandleRaw);
  if (!h) return null;
  const store = load();
  return store.linked.find((l) => l.xHandle.toLowerCase() === h.toLowerCase())?.gameName ?? null;
}

export function getXLinkStatus(gameName?: string) {
  const store = load();
  const linked = gameName
    ? store.linked.find((l) => l.gameName.toLowerCase() === gameName.trim().toLowerCase())
    : null;
  return {
    oauthReady: Boolean(process.env.X_CLIENT_ID || process.env.TWITTER_CLIENT_ID),
    mode: "code",
    linked: linked
      ? {
          xHandle: linked.xHandle,
          display: formatXHandle(linked.xHandle),
          gameName: linked.gameName,
          linkedAt: linked.linkedAt,
        }
      : null,
    onboarding: [
      "Open play.html Social → 𝕏 (or /api/x/link)",
      "Enter @handle + character name → Get code",
      "In-game type :verify CODE",
      "Death shares include your @handle",
    ],
  };
}

/** Test helpers */
export function _setXLinksFileForTests(filePath: string): void {
  linksFile = filePath;
}

export function _resetXLinksForTests(): void {
  save(emptyStore());
}

export function _restoreXLinksFileDefault(): void {
  linksFile = DEFAULT_LINKS_FILE;
}
