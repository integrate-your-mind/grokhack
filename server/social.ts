import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCIAL_DIR = path.join(__dirname, "..", "data", "social");
const STORE_FILE = path.join(SOCIAL_DIR, "graph.json");

export interface WallPost {
  id: string;
  author: string;
  text: string;
  at: string;
}

export interface DirectMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  at: string;
  read: boolean;
}

export interface PlayerProfile {
  name: string;
  bio: string;
  friends: string[];
  pendingIn: string[];
  pendingOut: string[];
  createdAt: string;
  lastSeen: string;
}

interface SocialStore {
  profiles: Record<string, PlayerProfile>;
  wall: WallPost[];
  dms: DirectMessage[];
}

const MAX_WALL = 500;
const MAX_DMS = 5000;

function defaultProfile(name: string): PlayerProfile {
  const now = new Date().toISOString();
  return {
    name,
    bio: "",
    friends: [],
    pendingIn: [],
    pendingOut: [],
    createdAt: now,
    lastSeen: now,
  };
}

function loadStore(): SocialStore {
  if (!fs.existsSync(SOCIAL_DIR)) fs.mkdirSync(SOCIAL_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    return { profiles: {}, wall: [], dms: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as SocialStore;
  } catch {
    return { profiles: {}, wall: [], dms: [] };
  }
}

function saveStore(store: SocialStore): void {
  if (!fs.existsSync(SOCIAL_DIR)) fs.mkdirSync(SOCIAL_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

let store = loadStore();

function norm(name: string): string {
  return name.trim().toLowerCase();
}

function displayName(name: string): string {
  const key = norm(name);
  return store.profiles[key]?.name ?? name.trim();
}

export function touchProfile(name: string): PlayerProfile {
  const key = norm(name);
  if (!store.profiles[key]) {
    store.profiles[key] = defaultProfile(name.trim());
  }
  store.profiles[key].lastSeen = new Date().toISOString();
  saveStore(store);
  return store.profiles[key];
}

export function getProfile(name: string): PlayerProfile | null {
  return store.profiles[norm(name)] ?? null;
}

export function setBio(name: string, bio: string): PlayerProfile {
  const p = touchProfile(name);
  p.bio = bio.trim().slice(0, 160);
  saveStore(store);
  return p;
}

export function requestFriend(from: string, to: string): { ok: boolean; message: string } {
  const a = norm(from);
  const b = norm(to);
  if (a === b) return { ok: false, message: "You cannot friend yourself." };
  if (!store.profiles[b]) touchProfile(to);

  const fromP = touchProfile(from);
  const toP = store.profiles[b];

  if (fromP.friends.map(norm).includes(b)) {
    return { ok: false, message: `Already friends with ${toP.name}.` };
  }
  if (fromP.pendingOut.map(norm).includes(b)) {
    return { ok: false, message: `Friend request to ${toP.name} already pending.` };
  }
  if (toP.pendingIn.map(norm).includes(a)) {
    fromP.friends.push(toP.name);
    toP.friends.push(fromP.name);
    fromP.pendingIn = fromP.pendingIn.filter((n) => norm(n) !== b);
    toP.pendingIn = toP.pendingIn.filter((n) => norm(n) !== a);
    saveStore(store);
    return { ok: true, message: `You are now friends with ${toP.name}!` };
  }

  fromP.pendingOut.push(toP.name);
  toP.pendingIn.push(fromP.name);
  saveStore(store);
  return { ok: true, message: `Friend request sent to ${toP.name}.` };
}

export function acceptFriend(name: string, friend: string): { ok: boolean; message: string } {
  const p = touchProfile(name);
  const fKey = norm(friend);
  const friendP = store.profiles[fKey];
  if (!friendP) return { ok: false, message: `No profile for ${friend}.` };

  if (!p.pendingIn.map(norm).includes(fKey)) {
    return { ok: false, message: `No pending request from ${friendP.name}.` };
  }

  p.pendingIn = p.pendingIn.filter((n) => norm(n) !== fKey);
  friendP.pendingOut = friendP.pendingOut.filter((n) => norm(n) !== norm(name));

  if (!p.friends.map(norm).includes(fKey)) p.friends.push(friendP.name);
  if (!friendP.friends.map(norm).includes(norm(name))) friendP.friends.push(p.name);

  saveStore(store);
  return { ok: true, message: `You are now friends with ${friendP.name}!` };
}

export function removeFriend(name: string, friend: string): { ok: boolean; message: string } {
  const p = touchProfile(name);
  const fKey = norm(friend);
  const before = p.friends.length;
  p.friends = p.friends.filter((n) => norm(n) !== fKey);
  const friendP = store.profiles[fKey];
  if (friendP) {
    friendP.friends = friendP.friends.filter((n) => norm(n) !== norm(name));
  }
  saveStore(store);
  if (p.friends.length === before) return { ok: false, message: `Not friends with ${friend}.` };
  return { ok: true, message: `Removed ${displayName(friend)} from friends.` };
}

export function listFriends(name: string): string[] {
  return touchProfile(name).friends;
}

export function listPending(name: string): { in: string[]; out: string[] } {
  const p = touchProfile(name);
  return { in: p.pendingIn, out: p.pendingOut };
}

export function sendDM(from: string, to: string, text: string): DirectMessage {
  touchProfile(from);
  touchProfile(to);
  const msg: DirectMessage = {
    id: randomUUID(),
    from: displayName(from),
    to: displayName(to),
    text: text.trim().slice(0, 280),
    at: new Date().toISOString(),
    read: false,
  };
  store.dms.push(msg);
  if (store.dms.length > MAX_DMS) store.dms = store.dms.slice(-MAX_DMS);
  saveStore(store);
  return msg;
}

export function getDMThread(name: string, other: string, limit = 30): DirectMessage[] {
  const a = norm(name);
  const b = norm(other);
  return store.dms
    .filter((m) => {
      const f = norm(m.from);
      const t = norm(m.to);
      return (f === a && t === b) || (f === b && t === a);
    })
    .slice(-limit);
}

export function getUnreadDMs(name: string): DirectMessage[] {
  const key = norm(name);
  return store.dms.filter((m) => norm(m.to) === key && !m.read);
}

export function markDMsRead(name: string, from: string): void {
  const key = norm(name);
  const fKey = norm(from);
  for (const m of store.dms) {
    if (norm(m.to) === key && norm(m.from) === fKey) m.read = true;
  }
  saveStore(store);
}

export function postWall(author: string, text: string): WallPost {
  const post: WallPost = {
    id: randomUUID(),
    author: displayName(author),
    text: text.trim().slice(0, 280),
    at: new Date().toISOString(),
  };
  store.wall.push(post);
  if (store.wall.length > MAX_WALL) store.wall = store.wall.slice(-MAX_WALL);
  saveStore(store);
  return post;
}

export function getWallFeed(name: string, limit = 25): WallPost[] {
  const friends = new Set(listFriends(name).map(norm));
  friends.add(norm(name));
  return store.wall
    .filter((p) => friends.has(norm(p.author)))
    .slice(-limit)
    .reverse();
}

export function getGlobalWall(limit = 40): WallPost[] {
  return store.wall.slice(-limit).reverse();
}

export function getSocialSnapshot(name: string) {
  const p = touchProfile(name);
  return {
    profile: { name: p.name, bio: p.bio, lastSeen: p.lastSeen },
    friends: p.friends,
    pendingIn: p.pendingIn,
    pendingOut: p.pendingOut,
    wall: getWallFeed(name, 15),
    unreadDMs: getUnreadDMs(name).length,
  };
}

/** Test helper */
export function _resetSocialForTests(): void {
  store = { profiles: {}, wall: [], dms: [] };
  saveStore(store);
}