import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LINKS_DIR = path.join(__dirname, "..", "data", "discord");
const LINKS_FILE = path.join(LINKS_DIR, "links.json");

export interface LinkCode {
  code: string;
  discordId: string;
  discordTag: string;
  gameName: string;
  createdAt: string;
  expiresAt: string;
}

interface LinkStore {
  pending: LinkCode[];
  linked: { discordId: string; gameName: string; linkedAt: string }[];
}

function load(): LinkStore {
  if (!fs.existsSync(LINKS_DIR)) fs.mkdirSync(LINKS_DIR, { recursive: true });
  if (!fs.existsSync(LINKS_FILE)) return { pending: [], linked: [] };
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8")) as LinkStore;
  } catch {
    return { pending: [], linked: [] };
  }
}

function save(store: LinkStore): void {
  if (!fs.existsSync(LINKS_DIR)) fs.mkdirSync(LINKS_DIR, { recursive: true });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(store, null, 2));
}

export function createLinkCode(discordId: string, discordTag: string, gameName: string): LinkCode {
  const store = load();
  const code = randomBytes(3).toString("hex").toUpperCase();
  const now = Date.now();
  const entry: LinkCode = {
    code,
    discordId,
    discordTag,
    gameName: gameName.trim().slice(0, 16),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  store.pending = store.pending.filter((p) => p.discordId !== discordId);
  store.pending.push(entry);
  save(store);
  return entry;
}

export function redeemLinkCode(code: string, gameName: string): { ok: boolean; message: string } {
  const store = load();
  const key = code.trim().toUpperCase();
  const idx = store.pending.findIndex(
    (p) => p.code === key && p.gameName.toLowerCase() === gameName.trim().toLowerCase()
  );
  if (idx < 0) return { ok: false, message: "Invalid or expired link code." };
  const entry = store.pending[idx];
  if (Date.now() > new Date(entry.expiresAt).getTime()) {
    store.pending.splice(idx, 1);
    save(store);
    return { ok: false, message: "Link code expired. Run /link again in Discord." };
  }
  store.pending.splice(idx, 1);
  store.linked = store.linked.filter((l) => l.discordId !== entry.discordId);
  store.linked.push({
    discordId: entry.discordId,
    gameName: entry.gameName,
    linkedAt: new Date().toISOString(),
  });
  save(store);
  return { ok: true, message: `Linked Discord ${entry.discordTag} to ${entry.gameName}.` };
}

export function getLinkedGameName(discordId: string): string | null {
  const store = load();
  return store.linked.find((l) => l.discordId === discordId)?.gameName ?? null;
}