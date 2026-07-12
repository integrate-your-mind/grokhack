import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dataPath } from "./data-paths.js";

const SOCIAL_DIR = dataPath("social");
const STORE_FILE = dataPath("social", "graph.json");

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

function emptyProfiles(): Record<string, PlayerProfile> {
  return Object.create(null) as Record<string, PlayerProfile>;
}

function emptyStore(): SocialStore {
  return { profiles: emptyProfiles(), wall: [], dms: [] };
}

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
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as Partial<SocialStore>;
    const profiles = emptyProfiles();
    if (parsed.profiles && typeof parsed.profiles === "object" && !Array.isArray(parsed.profiles)) {
      for (const [key, profile] of Object.entries(parsed.profiles)) profiles[key] = profile;
    }
    return {
      profiles,
      wall: Array.isArray(parsed.wall) ? parsed.wall : [],
      dms: Array.isArray(parsed.dms) ? parsed.dms : [],
    };
  } catch {
    return emptyStore();
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
  if (!b) return { ok: false, message: "Usage: :friend add <name>" };
  if (!store.profiles[b]) touchProfile(to);

  const fromP = touchProfile(from);
  const toP = store.profiles[b];

  if (fromP.friends.map(norm).includes(b)) {
    return { ok: false, message: `Already friends with ${toP.name}.` };
  }
  if (fromP.pendingOut.map(norm).includes(b)) {
    return { ok: false, message: `Friend request to ${toP.name} already pending.` };
  }
  // They already requested us → auto-accept (mutual)
  if (fromP.pendingIn.map(norm).includes(b)) {
    if (!fromP.friends.map(norm).includes(b)) fromP.friends.push(toP.name);
    if (!toP.friends.map(norm).includes(a)) toP.friends.push(fromP.name);
    fromP.pendingIn = fromP.pendingIn.filter((n) => norm(n) !== b);
    toP.pendingOut = toP.pendingOut.filter((n) => norm(n) !== a);
    fromP.pendingOut = fromP.pendingOut.filter((n) => norm(n) !== b);
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

/** Decline an inbound friend request. */
export function declineFriend(name: string, friend: string): { ok: boolean; message: string } {
  const p = touchProfile(name);
  const fKey = norm(friend);
  const friendP = store.profiles[fKey];
  if (!friendP) return { ok: false, message: `No profile for ${friend}.` };

  if (!p.pendingIn.map(norm).includes(fKey)) {
    return { ok: false, message: `No pending request from ${friendP.name}.` };
  }

  p.pendingIn = p.pendingIn.filter((n) => norm(n) !== fKey);
  friendP.pendingOut = friendP.pendingOut.filter((n) => norm(n) !== norm(name));
  saveStore(store);
  return { ok: true, message: `Declined friend request from ${friendP.name}.` };
}

/** Cancel an outbound friend request you sent. */
export function cancelFriendRequest(name: string, friend: string): { ok: boolean; message: string } {
  const p = touchProfile(name);
  const fKey = norm(friend);
  const friendP = store.profiles[fKey];
  if (!friendP) return { ok: false, message: `No profile for ${friend}.` };

  if (!p.pendingOut.map(norm).includes(fKey)) {
    return { ok: false, message: `No pending request to ${friendP.name}.` };
  }

  p.pendingOut = p.pendingOut.filter((n) => norm(n) !== fKey);
  friendP.pendingIn = friendP.pendingIn.filter((n) => norm(n) !== norm(name));
  saveStore(store);
  return { ok: true, message: `Cancelled friend request to ${friendP.name}.` };
}

export function listFriends(name: string): string[] {
  return getProfile(name)?.friends ?? [];
}

export function listPending(name: string): { in: string[]; out: string[] } {
  const p = getProfile(name);
  if (!p) return { in: [], out: [] };
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
  const p = getProfile(name) ?? defaultProfile(name.trim());
  return {
    profile: { name: p.name, bio: p.bio, lastSeen: p.lastSeen },
    friends: p.friends,
    pendingIn: p.pendingIn,
    pendingOut: p.pendingOut,
    wall: getWallFeed(name, 15),
    unreadDMs: getUnreadDMs(name).length,
  };
}

/** Public profile projection: read-only and intentionally excludes private inbox/request state. */
export function getPublicSocialProfile(name: string) {
  const p = getProfile(name);
  if (!p) return null;
  const key = norm(p.name);
  return {
    profile: { name: p.name, bio: p.bio, lastSeen: p.lastSeen },
    friends: [...p.friends],
    wall: store.wall
      .filter((post) => norm(post.author) === key)
      .slice(-15)
      .reverse(),
  };
}

/** Test helper */
export function _resetSocialForTests(): void {
  store = emptyStore();
  saveStore(store);
}
