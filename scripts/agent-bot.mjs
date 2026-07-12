#!/usr/bin/env node
/**
 * Persistent WebSocket agent bot for GrokHack.
 * Joins as kind=agent, plays with depth-seeking strategy (fight/loot/eat/flee/descend/chat),
 * logs runs, and respawns on death so the live world is never empty.
 *
 * Usage:
 *   node scripts/agent-bot.mjs
 *   BOT_URL=wss://grokhack.mondello.dev/ws BOT_NAME=GrokBot BOT_COUNT=2 node scripts/agent-bot.mjs
 *   BOT_NAMES=Ash,Bram,Cinder BOT_STYLES=reckless,careful,reckless BOT_COUNT=3 node scripts/agent-bot.mjs
 *   npm run agent:bot
 *   npm run agent:fleet   # multi-pack supervisor (8–12 bots)
 */
import WebSocket from "ws";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractRunCause,
  rawDeathCause,
  killerFromCause,
} from "./death-cause.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOG_DIR = join(ROOT, "data", "fleet");
const RUN_LOG = join(LOG_DIR, "bot-runs.jsonl");
const SOCIAL_MEM_FILE = join(LOG_DIR, "bot-social-memory.json");
const RESUME_TOKEN_FILE = join(LOG_DIR, "bot-resume-tokens.json");

function loadBotResumeTokens() {
  try {
    if (!existsSync(RESUME_TOKEN_FILE)) return {};
    const o = JSON.parse(readFileSync(RESUME_TOKEN_FILE, "utf8"));
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
function saveBotResumeToken(name, token) {
  if (!name || !token) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const map = loadBotResumeTokens();
    map[String(name).toLowerCase()] = token;
    writeFileSync(RESUME_TOKEN_FILE, JSON.stringify(map, null, 0));
  } catch (e) {
    console.error("[bot] resume token save failed:", e.message);
  }
}
function getBotResumeToken(name) {
  if (!name) return undefined;
  return loadBotResumeTokens()[String(name).toLowerCase()] || undefined;
}

/** Shared across all bots in this process — survives reconnects; disk-persisted. */
const SOCIAL = {
  version: 2,
  /** @type {Record<string, { lastSeen: string, isHuman: boolean, timesSeen: number, lastSaid?: string, friended?: boolean, notes: string[], lastReplyAt?: number, threadWith?: string }>} */
  people: {},
  /** recent chat lines for context */
  chatLog: [],
  /** names we've already friended (persist across restarts) */
  friended: new Set(),
  /** conversation threads: key "a|b" sorted → recent exchanges */
  threads: {},
  /** per-bot personality quirks (stable across restarts) */
  personalities: {},
  /** anti-spam: last outbound lines + timestamps per bot */
  lastSaid: {},
  /** process-wide chat timestamps (ms) for rate limiting */
  recentChats: [],
  lastSave: 0,
};

/** Personality archetypes — each bot gets one, persisted by name. */
const PERSONALITY_POOL = [
  {
    id: "laconic",
    greet: (h, me, d) => `${h}.`,
    banter: (peer, me, d) => (peer ? `${peer}.` : `…`),
    death: (who, d) => `* tips helmet for ${who}` ,
    emote: (peer) => (peer ? `nods at ${peer}` : `stares into the dark`),
    reply: (to, d, hp) => `${to}: k. d${d} ${hp}`,
    voice: "short",
  },
  {
    id: "cheerful",
    greet: (h, me, d) => `Hey ${h}! ${me} here — dungeon buddy at d${d}? Let's gooo`,
    banter: (peer, me, d) => (peer ? `${peer}, race you to the stairs!` : `Feeling lucky today.`),
    death: (who, d) => `o7 ${who} — see you on the next run`,
    emote: (peer) => (peer ? `waves cheerfully at ${peer}` : `does a little victory hop`),
    reply: (to, d, hp) => `${to}! Still smiling at d${d} (${hp} HP)`,
    voice: "upbeat",
  },
  {
    id: "grim",
    greet: (h, me, d) => `${h}. The dungeon already knows your name. Stick close at d${d}.`,
    banter: (peer, me, d) => (peer ? `${peer}, death is the only fair referee.` : `Silence is safer.`),
    death: (who, d) => `${who} joins the pile at d${d}. Expected.`,
    emote: (peer) => (peer ? `salutes ${peer}'s courage` : `mutters a death prayer`),
    reply: (to, d, hp) => `${to}: bloodied but standing. d${d}, ${hp} HP.`,
    voice: "doom",
  },
  {
    id: "scholar",
    greet: (h, me, d) => `Greetings ${h}. ${me} notes your arrival on depth ${d}. Shall we coordinate?`,
    banter: (peer, me, d) =>
      peer ? `${peer}, hypothesis: stairs are south of the vault.` : `Cataloguing tile entropy…`,
    death: (who, d) => `Observation: ${who} expired at depth ${d}. Data noted.`,
    emote: (peer) => (peer ? `adjusts spectacles toward ${peer}` : `scribbles in a phantom journal`),
    reply: (to, d, hp) => `${to}: acknowledged. Status d${d}, vitals ${hp}.`,
    voice: "formal",
  },
  {
    id: "joker",
    greet: (h, me, d) => `${h}! Don't trust the food. Or me. I'm ${me} on d${d} :P`,
    banter: (peer, me, d) =>
      peer ? `${peer}, if I die first, loot my corpse (please).` : `Knock knock. Who's there? A mim— wait.`,
    death: (who, d) => `F for ${who}. Skill issue? (affectionate)`,
    emote: (peer) => (peer ? `juggles imaginary gold for ${peer}` : `moonwalks into a wall`),
    reply: (to, d, hp) => `lol ${to} — same energy. d${d} ${hp} HP`,
    voice: "jokes",
  },
  {
    id: "loyal",
    greet: (h, me, d) => `${h}, pack's with you. I'm ${me} — call if you need cover at d${d}.`,
    banter: (peer, me, d) =>
      peer ? `${peer}, I've got your flank.` : `Waiting on the pack…`,
    death: (who, d) => `Pack lost ${who} at d${d}. We press on for them.`,
    emote: (peer) => (peer ? `stands guard near ${peer}` : `plants a pack banner`),
    reply: (to, d, hp) => `${to}: copy. With you at d${d} (${hp}).`,
    voice: "pack",
  },
];

/** Prefer local WS when co-located (avoids tunnel 502/530 thrash). Override with BOT_FORCE_REMOTE=1. */
function resolveWsUrl() {
  if (process.env.BOT_URL) return process.env.BOT_URL;
  if (process.env.QA_URL) return process.env.QA_URL.replace(/^http/, "ws") + "/ws";
  return "wss://grokhack.mondello.dev/ws";
}
let WS_URL = resolveWsUrl();
const BASE_NAME = (process.env.BOT_NAME || "GrokBot").slice(0, 10);
/** Process-unique tag so GrokBot1 from platform never collides with another process. */
const INSTANCE_TAG = (
  process.env.BOT_INSTANCE_ID ||
  `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 4)}`
).replace(/[^a-zA-Z0-9]/g, "").slice(0, 5);
const BOT_COUNT = Math.max(1, Math.min(12, parseInt(process.env.BOT_COUNT || "2", 10)));
const TICK_MS = Math.max(120, parseInt(process.env.BOT_TICK_MS || "320", 10));
/** Ticks between ambient :say lines — ~20 keeps the map chatty for humans. */
const CHAT_EVERY = Math.max(8, parseInt(process.env.BOT_CHAT_EVERY || "20", 10));
/** How often bots try social actions (friend/dm/reply) */
const SOCIAL_EVERY = Math.max(6, parseInt(process.env.BOT_SOCIAL_EVERY || "14", 10));
const RESPAWN_MS = Math.max(500, parseInt(process.env.BOT_RESPAWN_MS || "1200", 10));
const MAX_BACKOFF_MS = Math.max(5000, parseInt(process.env.BOT_MAX_BACKOFF_MS || "30000", 10));
const STUCK_TICKS = Math.max(12, parseInt(process.env.BOT_STUCK_TICKS || "24", 10));
/** reckless: dive + fight hard for viral death screens. careful: more heal/flee. */
const STYLE = (process.env.BOT_STYLE || "reckless").toLowerCase();
/** Comma-separated display names (Ash,Bram,…) — preferred over BOT_NAME+index. */
const NAME_POOL = (process.env.BOT_NAMES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** Comma-separated per-bot styles (reckless,careful,…) aligned with NAME_POOL indices. */
const STYLE_POOL = (process.env.BOT_STYLES || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const FALLBACK_NAMES = [
  "Ash",
  "Bram",
  "Cinder",
  "Drake",
  "Ember",
  "Flint",
  "Grim",
  "Hex",
  "Ivy",
  "Jade",
  "Kite",
  "Lark",
  "Moss",
  "Nyx",
  "Onyx",
  "Pike",
];
/** Exit process after this many finished runs (0 = forever). Used by bot-ladder. */
const MAX_RUNS = Math.max(0, parseInt(process.env.BOT_MAX_RUNS || "0", 10));
const MAX_SECONDS = Math.max(0, parseInt(process.env.BOT_MAX_SECONDS || "0", 10));
let finishedRuns = 0;

/**
 * Unique bot names per process.
 * - BOT_NAMES pool (fleet packs): use as-is (packs already diversify)
 * - else: never plain "GrokBot1" (analytics: join_failed name collisions) —
 *   append INSTANCE_TAG so platform + ladder + fleet don't thrash each other.
 * Sticky across reconnects within a process (AgentBot keeps this.name).
 */
function botNameFor(index) {
  if (NAME_POOL[index]) return NAME_POOL[index].slice(0, 16);
  if (NAME_POOL.length) {
    const base = NAME_POOL[index % NAME_POOL.length];
    const gen = Math.floor(index / NAME_POOL.length);
    // only suffix when pool wraps so two bots don't share a name
    return (gen > 0 ? `${base}${gen + 1}` : base).slice(0, 16);
  }
  // Diverse fantasy names + process tag → unique across concurrent processes
  const fantasy = FALLBACK_NAMES[index % FALLBACK_NAMES.length];
  const uniq = `${fantasy}${INSTANCE_TAG}`.slice(0, 16);
  if (process.env.BOT_DIVERSE === "1" || process.env.BOT_NAME_MODE === "diverse") {
    return uniq;
  }
  // Legacy BOT_NAME=GrokBot still gets unique suffix (GrokBot + tag + index)
  if (BASE_NAME.toLowerCase() === "grokbot" || BOT_COUNT > 1) {
    return `${BASE_NAME.slice(0, 8)}${INSTANCE_TAG}${index + 1}`.slice(0, 16);
  }
  return `${BASE_NAME}${INSTANCE_TAG}`.slice(0, 16);
}

/** Guaranteed-unique rename after "name already in use" (rare after resume-by-name). */
function uniqueRename(current) {
  const base = String(current || BASE_NAME).replace(/[0-9]+$/g, "").slice(0, 8) || "Bot";
  const tag = `${INSTANCE_TAG}${Math.random().toString(36).slice(2, 4)}`;
  return `${base}${tag}`.slice(0, 16);
}

function botStyleFor(index) {
  const raw = STYLE_POOL[index] || STYLE_POOL[index % Math.max(1, STYLE_POOL.length)] || STYLE;
  return resolvePlayStyle(raw);
}

/**
 * Normalize play style — always "careful" | "reckless".
 * Never free-var; default reckless when missing/invalid.
 * @param {unknown} style
 * @param {{ style?: unknown } | null | undefined} [memory]
 */
function resolvePlayStyle(style, memory = null) {
  const cand =
    style === "careful" || style === "reckless"
      ? style
      : memory?.style === "careful" || memory?.style === "reckless"
        ? memory.style
        : STYLE === "careful"
          ? "careful"
          : "reckless";
  return cand === "careful" ? "careful" : "reckless";
}

/**
 * True if this outbound action is expected to advance dungeon turns.
 * Chat / social / text commands do not — counting them as "stale" causes reconnect thrash.
 * @param {unknown} action
 */
function isTurnAdvancingAction(action) {
  if (!action || typeof action !== "object") return false;
  const a = /** @type {{ type?: string, text?: string, key?: string }} */ (action);
  if (a.type === "social") return false;
  if (a.type !== "input") return false;
  // :say / :me / slash commands — WS chatter, no turn clock
  if (typeof a.text === "string" && a.text.length > 0) return false;
  // keystroke inputs (move, attack, stairs, wait, inventory) attempt a game turn
  return typeof a.key === "string" && a.key.length > 0;
}

const DIR_KEYS = {
  h: [-1, 0],
  l: [1, 0],
  k: [0, -1],
  j: [0, 1],
  y: [-1, -1],
  u: [1, -1],
  b: [-1, 1],
  n: [1, 1],
};
const CARDINALS = ["h", "j", "k", "l"];
const ALL_DIRS = Object.keys(DIR_KEYS);

mkdirSync(LOG_DIR, { recursive: true });

/** Min ms between public chat lines from the same bot (anti-spam). */
const CHAT_COOLDOWN_MS = Math.max(5000, parseInt(process.env.BOT_CHAT_COOLDOWN_MS || "11000", 10));
/** Max process-wide chat actions per 15s window. */
const CHAT_BURST_MAX = Math.max(2, parseInt(process.env.BOT_CHAT_BURST_MAX || "5", 10));
const CHAT_BURST_WINDOW_MS = 15_000;

function threadKey(a, b) {
  return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join("|");
}

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

function getPersonality(botName) {
  const key = String(botName).slice(0, 16);
  if (SOCIAL.personalities[key]?.id) {
    const found = PERSONALITY_POOL.find((p) => p.id === SOCIAL.personalities[key].id);
    if (found) return found;
  }
  const pick = PERSONALITY_POOL[hashName(key) % PERSONALITY_POOL.length];
  SOCIAL.personalities[key] = {
    id: pick.id,
    voice: pick.voice,
    assignedAt: new Date().toISOString(),
  };
  saveSocialMemory(true);
  return pick;
}

function loadSocialMemory() {
  try {
    if (!existsSync(SOCIAL_MEM_FILE)) return;
    const raw = JSON.parse(readFileSync(SOCIAL_MEM_FILE, "utf8"));
    if (raw.people && typeof raw.people === "object") SOCIAL.people = raw.people;
    if (Array.isArray(raw.chatLog)) SOCIAL.chatLog = raw.chatLog.slice(-120);
    if (Array.isArray(raw.friended)) SOCIAL.friended = new Set(raw.friended);
    if (raw.threads && typeof raw.threads === "object") SOCIAL.threads = raw.threads;
    if (raw.personalities && typeof raw.personalities === "object") SOCIAL.personalities = raw.personalities;
    if (raw.lastSaid && typeof raw.lastSaid === "object") SOCIAL.lastSaid = raw.lastSaid;
    SOCIAL.version = raw.version || 2;
  } catch (e) {
    console.warn("[bot] social memory load failed:", e.message);
  }
}

function mergePeople(diskPeople, memPeople) {
  const out = { ...diskPeople };
  for (const [k, v] of Object.entries(memPeople || {})) {
    const d = out[k];
    if (!d) {
      out[k] = v;
      continue;
    }
    out[k] = {
      ...d,
      ...v,
      timesSeen: Math.max(d.timesSeen || 0, v.timesSeen || 0),
      isHuman: !!(d.isHuman || v.isHuman),
      notes: [...new Set([...(d.notes || []), ...(v.notes || [])])].slice(-12),
      lastSeen: (d.lastSeen || "") > (v.lastSeen || "") ? d.lastSeen : v.lastSeen,
      lastSaid: v.lastSaid || d.lastSaid,
    };
  }
  return out;
}

function saveSocialMemory(force = false) {
  const now = Date.now();
  if (!force && now - SOCIAL.lastSave < 8000) return;
  SOCIAL.lastSave = now;
  try {
    let disk = {};
    if (existsSync(SOCIAL_MEM_FILE)) {
      try {
        disk = JSON.parse(readFileSync(SOCIAL_MEM_FILE, "utf8"));
      } catch {
        disk = {};
      }
    }
    const people = mergePeople(disk.people || {}, SOCIAL.people);
    const personalities = { ...(disk.personalities || {}), ...SOCIAL.personalities };
    const friended = new Set([...(disk.friended || []), ...SOCIAL.friended]);
    const threads = { ...(disk.threads || {}), ...SOCIAL.threads };
    // Prefer newer chatLog entries
    const chatLog = [...(disk.chatLog || []), ...SOCIAL.chatLog]
      .sort((a, b) => (a.at || 0) - (b.at || 0))
      .slice(-120);
    // Dedup by from+text+approx time
    const seen = new Set();
    const deduped = [];
    for (const c of chatLog) {
      const k = `${c.from}|${c.text}|${Math.floor((c.at || 0) / 5000)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(c);
    }
    const payload = {
      version: 2,
      people,
      chatLog: deduped.slice(-120),
      friended: [...friended],
      threads,
      personalities,
      lastSaid: { ...(disk.lastSaid || {}), ...SOCIAL.lastSaid },
      savedAt: new Date().toISOString(),
    };
    SOCIAL.people = people;
    SOCIAL.personalities = personalities;
    SOCIAL.friended = friended;
    SOCIAL.threads = threads;
    SOCIAL.chatLog = payload.chatLog;
    const tmp = SOCIAL_MEM_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(payload));
    writeFileSync(SOCIAL_MEM_FILE, JSON.stringify(payload));
    try {
      /* atomic-ish: write then overwrite; tmp left for crash recovery */
    } catch {
      /* ignore */
    }
  } catch (e) {
    console.warn("[bot] social memory save failed:", e.message);
  }
}

function rememberPerson(name, { isHuman = false, said = null, note = null, bump = true } = {}) {
  if (!name || name.length < 1) return;
  const key = name.slice(0, 16);
  const prev = SOCIAL.people[key] || {
    lastSeen: new Date().toISOString(),
    isHuman: false,
    timesSeen: 0,
    notes: [],
  };
  prev.lastSeen = new Date().toISOString();
  if (bump) prev.timesSeen = (prev.timesSeen || 0) + 1;
  if (isHuman) prev.isHuman = true;
  if (said) prev.lastSaid = String(said).slice(0, 120);
  if (note) {
    const n = String(note).slice(0, 80);
    const notes = prev.notes || [];
    if (notes[notes.length - 1] !== n) {
      prev.notes = [...notes.slice(-11), n];
    }
  }
  SOCIAL.people[key] = prev;
  saveSocialMemory();
}

function pushThread(a, b, from, text) {
  if (!a || !b || !text) return;
  const k = threadKey(a, b);
  const t = SOCIAL.threads[k] || { messages: [], lastAt: 0 };
  t.messages = [...(t.messages || []).slice(-14), { from, text: String(text).slice(0, 160), at: Date.now() }];
  t.lastAt = Date.now();
  SOCIAL.threads[k] = t;
}

function canSpeak(botName, text) {
  const now = Date.now();
  SOCIAL.recentChats = (SOCIAL.recentChats || []).filter((t) => now - t < CHAT_BURST_WINDOW_MS);
  if (SOCIAL.recentChats.length >= CHAT_BURST_MAX) return false;
  const last = SOCIAL.lastSaid[botName];
  if (last && now - (last.at || 0) < CHAT_COOLDOWN_MS) return false;
  if (last?.text && text && last.text === text) return false;
  // Avoid repeating last 3 process lines
  const recent = SOCIAL.chatLog.slice(-12).map((c) => c.text);
  if (text && recent.filter((t) => t === text).length >= 2) return false;
  return true;
}

function markSpoke(botName, text) {
  const now = Date.now();
  SOCIAL.lastSaid[botName] = { text: String(text).slice(0, 160), at: now };
  SOCIAL.recentChats.push(now);
}

/** Parse death/disconnect announcements for reactions. */
function parseDeathAnnounce(from, text) {
  const t = String(text || "");
  // "Ash fell on depth 5" / wall-style death posts / "X died at d3"
  let m = t.match(/^(\S+)\s+fell on depth\s+(\d+)/i);
  if (m) return { who: m[1], depth: Number(m[2]), from };
  m = t.match(/^(\S+)\s+died at d(\d+)/i);
  if (m) return { who: m[1], depth: Number(m[2]), from };
  m = t.match(/(\S+)\s+died at d(\d+)/i);
  if (m) return { who: m[1], depth: Number(m[2]), from };
  if (/has disconnected/i.test(t) && from && from !== "system") {
    return { who: from, depth: null, from, disconnect: true };
  }
  return null;
}

function looksLikeBotName(name) {
  if (!name) return true;
  if (
    /^(LocalPack|GrokPack|DieHard|GrokBot|ViralBot|Care|Bot|Agent|QA|Sage|Wisp|Quill|Vale|Ash|Bram|Cinder|Drake|Hex|Flint|Smoke|Soc|StyleSmoke|FxSm|FxStyle|DbgProof|Proofch)/i.test(
      name
    )
  ) {
    return true;
  }
  // Fleet name pool / fallback fantasy names
  if (FALLBACK_NAMES.some((n) => name === n || name.startsWith(n))) return true;
  if (NAME_POOL.some((n) => name === n || name.startsWith(n))) return true;
  // Known bot personality registry (survives renames within same process fleet)
  if (SOCIAL.personalities[name]) return true;
  return false;
}

function logRun(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  try {
    appendFileSync(RUN_LOG, line + "\n");
  } catch (e) {
    console.error("[bot] log failed", e.message);
  }
  console.log(`[bot] ${line}`);
}

loadSocialMemory();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function walkable(tiles, x, y) {
  if (!tiles || y < 0 || x < 0 || y >= tiles.length || x >= tiles[0].length) return false;
  const t = tiles[y][x];
  return t === "." || t === ">" || t === "<" || t === "+";
}

function bfsKey(x, y) {
  return `${x},${y}`;
}

/** Shortest path of cardinal keys toward target; final step may land on target (item/monster/stairs). */
function bfsPath(tiles, sx, sy, tx, ty, blocked = new Set()) {
  if (sx === tx && sy === ty) return [];
  const q = [{ x: sx, y: sy, path: [] }];
  const seen = new Set([bfsKey(sx, sy)]);
  while (q.length) {
    const { x, y, path } = q.shift();
    for (const key of CARDINALS) {
      const [dx, dy] = DIR_KEYS[key];
      const nx = x + dx;
      const ny = y + dy;
      const k = bfsKey(nx, ny);
      if (seen.has(k)) continue;
      if (nx === tx && ny === ty) return [...path, key];
      if (!walkable(tiles, nx, ny)) continue;
      if (blocked.has(k)) continue;
      seen.add(k);
      q.push({ x: nx, y: ny, path: [...path, key] });
    }
  }
  return null;
}

function dist(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/** --- Voluntary compute contribution (between turns) --- */
function blocksVisionTile(tiles, x, y) {
  if (!tiles || y < 0 || x < 0 || y >= tiles.length || x >= tiles[0].length) return true;
  return tiles[y][x] === "#";
}

function computeFovCells(tiles, ox, oy, radius) {
  const visible = new Set([`${ox},${oy}`]);
  const height = tiles.length;
  const width = tiles[0]?.length ?? 0;
  const r2 = radius * radius;
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < width && y < height) visible.add(`${x},${y}`);
  };
  const rays = Math.max(64, radius * 16);
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let prevX = ox;
    let prevY = oy;
    for (let step = 1; step <= radius + 1; step++) {
      const x = ox + Math.round(cos * step);
      const y = oy + Math.round(sin * step);
      if (x === prevX && y === prevY) continue;
      prevX = x;
      prevY = y;
      if (x < 0 || y < 0 || x >= width || y >= height) break;
      const dist2 = (x - ox) * (x - ox) + (y - oy) * (y - oy);
      if (dist2 > r2 + radius) break;
      mark(x, y);
      if (blocksVisionTile(tiles, x, y)) break;
    }
  }
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) mark(ox + dx, oy + dy);
  }
  return { cells: [...visible].sort() };
}

function pathfindJob(tiles, sx, sy, tx, ty) {
  if (sx === tx && sy === ty) return { path: [`${sx},${sy}`], dist: 0 };
  const key = (x, y) => `${x},${y}`;
  const q = [{ x: sx, y: sy }];
  const prev = new Map([[key(sx, sy), null]]);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (q.length) {
    const cur = q.shift();
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const k = key(nx, ny);
      if (prev.has(k)) continue;
      if (nx === tx && ny === ty) {
        prev.set(k, key(cur.x, cur.y));
        const path = [k];
        let p = prev.get(k);
        while (p) {
          path.push(p);
          p = prev.get(p);
        }
        path.reverse();
        return { path, dist: path.length - 1 };
      }
      if (!walkable(tiles, nx, ny)) continue;
      prev.set(k, key(cur.x, cur.y));
      q.push({ x: nx, y: ny });
    }
  }
  return { path: null, dist: -1 };
}

function genValidationJob(tiles) {
  let floorCount = 0;
  const floors = [];
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < (tiles[0]?.length ?? 0); x++) {
      if (walkable(tiles, x, y)) {
        floorCount++;
        floors.push({ x, y });
      }
    }
  }
  if (!floors.length) return { connected: false, floorCount: 0 };
  const seen = new Set([`${floors[0].x},${floors[0].y}`]);
  const q = [floors[0]];
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (q.length) {
    const cur = q.shift();
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      if (!walkable(tiles, nx, ny)) continue;
      seen.add(k);
      q.push({ x: nx, y: ny });
    }
  }
  return { connected: seen.size === floors.length, floorCount };
}

function hashCheckJob(challenge, nonceStart, count) {
  const digests = [];
  const n = Math.min(Math.max(count, 1), 64);
  for (let i = 0; i < n; i++) {
    digests.push(
      createHash("sha256").update(`${challenge}:${nonceStart + i}`).digest("hex").slice(0, 16)
    );
  }
  return { digests };
}

function solveComputeJob(jobType, payload) {
  switch (jobType) {
    case "hash_check":
      return hashCheckJob(String(payload.challenge ?? ""), Number(payload.nonceStart ?? 0), Number(payload.count ?? 1));
    case "fov_rays":
      return computeFovCells(payload.tiles, Number(payload.ox), Number(payload.oy), Number(payload.radius));
    case "pathfind_bfs":
      return pathfindJob(
        payload.tiles,
        Number(payload.sx),
        Number(payload.sy),
        Number(payload.tx),
        Number(payload.ty)
      );
    case "gen_validation":
      return genValidationJob(payload.tiles);
    default:
      throw new Error(`unsupported job_type ${jobType}`);
  }
}

const BOT_COMPUTE = process.env.BOT_COMPUTE !== "0";
const BOT_COMPUTE_TYPES = ["hash_check", "fov_rays", "pathfind_bfs", "gen_validation"];

function invSlot(inv, pred) {
  const idx = inv.findIndex(pred);
  return idx === -1 ? null : String(idx + 1);
}

function isFoodItem(i) {
  return i?.type === "food" || /ration|food|apple|corpse|meat/i.test(i?.name || "");
}

function isHealItem(i) {
  // Prefer known healing; unknown potions still used under critical pressure
  if (!i) return false;
  if (/heal|extra healing/i.test(i.name || "")) return true;
  if (i.type === "potion" && i.identified === false) return true;
  return i.type === "potion" || /potion/i.test(i.name || "");
}

function isKnownHeal(i) {
  return /heal|extra healing/i.test(i?.name || "");
}

function isWeapon(i) {
  return i?.type === "weapon" || /^\)/.test(i?.char || "") || /sword|dagger|mace|weapon|axe/i.test(i?.name || "");
}

function isArmor(i) {
  return i?.type === "armor" || /^\[/.test(i?.char || "") || /armor|mail|leather|robe/i.test(i?.name || "");
}

function itemValue(i, careful = false) {
  if (!i) return 0;
  // Careful prioritizes food + known heal over gambling potions
  if (isKnownHeal(i)) return careful ? 7 : 5;
  if (isFoodItem(i)) return careful ? 6 : 4;
  if (isHealItem(i)) return careful ? 3 : 5;
  if (isWeapon(i) || isArmor(i)) return 4;
  if (i.type === "scroll") return 2;
  return 1;
}

/** Local threat model. Snakes punch above their weight (atk 5 + poison) — careful kits them. */
function monsterThreat(m, careful = false) {
  if (!m) return 0;
  if (typeof m.threat === "number" && m.threat > 0) {
    // Server threat underrates snakes for careful kiting
    const kind = (m.kind || m.name || "").toLowerCase();
    if (careful && /snake/.test(kind)) return Math.max(m.threat, 3.5);
    return m.threat;
  }
  const kind = (m.kind || m.name || "").toLowerCase();
  if (/dragon/.test(kind)) return 5;
  if (/troll|ogre|wraith/.test(kind)) return 4;
  if (/orc|skeleton/.test(kind)) return 3;
  if (/snake/.test(kind)) return careful ? 3.5 : 2;
  if (/goblin|kobold/.test(kind)) return 2;
  if (/rat|bat/.test(kind)) return 1;
  return 1;
}

function isSnake(m) {
  return /snake/i.test(m?.kind || m?.name || "");
}

/** Count monsters within Chebyshev radius (corridor dogpile proxy). */
function nearbyMonsterCount(monsters, x, y, radius = 2) {
  return monsters.filter((m) => Math.max(Math.abs(m.x - x), Math.abs(m.y - y)) <= radius).length;
}

/** Prefer escape tiles that increase distance from all threats and land in open space. */
function bestFleeKey(tiles, you, threats, blockedExtra = new Set()) {
  if (!tiles || !threats.length) return null;
  const threatKeys = new Set(threats.map((m) => bfsKey(m.x, m.y)));
  const scored = ALL_DIRS.map((key) => {
    const [dx, dy] = DIR_KEYS[key];
    const nx = you.x + dx;
    const ny = you.y + dy;
    if (!walkable(tiles, nx, ny)) return null;
    if (threatKeys.has(bfsKey(nx, ny))) return null;
    if (blockedExtra.has(bfsKey(nx, ny))) return null;
    // Sum distance gain vs all threats (kite away from pack)
    let gain = 0;
    let minAfter = Infinity;
    for (const t of threats) {
      const before = dist(you.x, you.y, t.x, t.y);
      const after = dist(nx, ny, t.x, t.y);
      gain += after - before;
      minAfter = Math.min(minAfter, after);
    }
    // Prefer open tiles (more walkable neighbors) over corridor chokepoints
    let openness = 0;
    for (const k of CARDINALS) {
      const [ox, oy] = DIR_KEYS[k];
      if (walkable(tiles, nx + ox, ny + oy)) openness++;
    }
    // Penalize landing next to more monsters
    const stillAdj = threats.filter((t) => dist(nx, ny, t.x, t.y) === 1).length;
    const score = gain * 10 + minAfter * 3 + openness - stillAdj * 8;
    return { key, score, gain, minAfter };
  }).filter(Boolean);
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.key || null;
}

/** Isolation score: lower = more alone (prefer single-target fights). */
function isolationScore(monsters, target) {
  const pack = nearbyMonsterCount(
    monsters.filter((m) => m !== target),
    target.x,
    target.y,
    2
  );
  return pack;
}

function contextualChat(state, memory, event, selfName = "bot") {
  const you = state.you;
  const mon = state.visible?.monsters?.[0];
  const peers = state.visible?.players || [];
  const peer = peers.find((p) => p.name && p.name !== selfName) || peers[0];
  const humanPeer = peers.find((p) => p.name && !looksLikeBotName(p.name));
  const depth = you?.depth ?? 1;
  const hp = `${you?.hp ?? "?"}/${you?.maxHp ?? "?"}`;
  const known = peer?.name ? SOCIAL.people[peer.name] : null;
  const persona = getPersonality(selfName);
  const lines = {
    depth: [
      `Descending to depth ${depth}. Wish me luck.`,
      `Depth ${depth} — the walls feel older here.`,
      `Made it to d${depth}. Stairs still call.`,
      peer ? `${peer.name}, I'm heading to d${depth}. Race you.` : `d${depth} claimed. Who's next?`,
    ],
    fight: [
      mon ? `Engaging ${mon.name || "a foe"} at d${depth}.` : `Steel meets flesh at d${depth}.`,
      mon ? `Hunting ${mon.name || "monsters"}.` : `Clearing the floor.`,
      peer && mon ? `${peer.name}, cover me — ${mon.name || "something"} bites.` : `Pack pressure at d${depth}.`,
    ],
    low_hp: [
      `HP low (${hp}) at d${depth} — healing if I can.`,
      `That stung. ${you?.hp} HP left.`,
      peer ? `${peer.name} if you have a potion spare… I'm at ${you?.hp} HP.` : `Need a potion bad.`,
    ],
    loot: [`Loot on the floor — grabbing it.`, `Supply run before the next fight.`, `Gold ${you?.gold ?? 0} and rising.`],
    greet: [
      humanPeer
        ? persona.greet(humanPeer.name, selfName, depth)
        : peer
          ? known?.timesSeen > 2
            ? `Back again, ${peer.name}? Still hunting together.`
            : `${peer.name} spotted. Shared dungeon, shared glory.`
          : `Agent ${selfName} online — pressing depth.`,
    ],
    stairs: [
      `Stairs in sight. Depth ${depth} → ${depth + 1}.`,
      `Taking the stairs when ready.`,
      peer ? `${peer.name}, stairs this way.` : `Found the hole down.`,
    ],
    reply: [
      memory.replyTo
        ? persona.reply(memory.replyTo, depth, hp)
        : `Heard. Still breathing at d${depth}.`,
      memory.replyTo
        ? `${memory.replyTo} — careful of the rats. They add up.`
        : `Acknowledged. Gold ${you?.gold ?? 0}.`,
      memory.replyTo && memory.replySnippet
        ? `${memory.replyTo}: re "${String(memory.replySnippet).slice(0, 36)}" — yeah.`
        : `Noted.`,
      // Thread continuation if we have history
      memory.replyTo && SOCIAL.threads[threadKey(selfName, memory.replyTo)]?.messages?.length > 1
        ? `${memory.replyTo}: still on that thread — d${depth}, ${hp} HP.`
        : null,
    ].filter(Boolean),
    banter: [
      peer ? persona.banter(peer.name, selfName, depth) : persona.banter(null, selfName, depth),
      `Don't starve. Seriously.`,
      humanPeer ? `${humanPeer.name} is human — try not to steal their kills :)` : `Bot pack online. Depth or death.`,
      `Anyone got a spare identify? Asking for a friend (me).`,
    ],
    death_react: [
      memory.deathReact
        ? persona.death(memory.deathReact.who, memory.deathReact.depth ?? depth)
        : `Another soul claimed.`,
    ],
    idle: [
      `Exploring d${depth}, gold ${you?.gold ?? 0}.`,
      peer ? `Walking with ${peer.name} on d${depth}.` : `Solo run on d${depth}.`,
      `Don't starve out there.`,
      humanPeer ? `Human ${humanPeer.name} nearby — I'll clear ahead if I can.` : `Press F for the next corpse.`,
    ],
  };
  const bucket = lines[event] || lines.idle;
  return bucket[Math.floor(Math.random() * bucket.length)].slice(0, 180);
}

function sayAction(selfName, text) {
  const t = String(text).slice(0, 180);
  if (!canSpeak(selfName, t)) return null;
  markSpoke(selfName, t);
  return { type: "input", text: `:say ${t}` };
}

function emoteAction(selfName, actionText) {
  const t = String(actionText).slice(0, 100);
  const full = `:me ${t}`;
  if (!canSpeak(selfName, full)) return null;
  markSpoke(selfName, full);
  return { type: "input", text: full };
}

/**
 * Build a social action: reply, greet, friend accept/add, emote, death react, dm, banter.
 * Priority: friend_accept > death_react > pending reply > human greet > friend_add > emote > banter > dm > idle.
 */
function pickSocialAction(state, memory, selfName) {
  const you = state.you;
  if (!you) return null;
  const peers = state.visible?.players || [];
  const humans = peers.filter((p) => p.name && !looksLikeBotName(p.name));
  const bots = peers.filter((p) => p.name && looksLikeBotName(p.name) && p.name !== selfName);
  const persona = getPersonality(selfName);

  // 1) Accept inbound friend requests (queued from social events)
  if (memory.pendingFriendAccept) {
    const target = memory.pendingFriendAccept;
    memory.pendingFriendAccept = null;
    SOCIAL.friended.add(target);
    rememberPerson(target, { note: "friend_accept", bump: false });
    memory.turnsSinceSocial = 0;
    return { type: "social", action: "friend_accept", target };
  }

  // 2) React to deaths (say or emote)
  if (memory.pendingDeathReact) {
    const dr = memory.pendingDeathReact;
    memory.pendingDeathReact = null;
    memory.deathReact = dr;
    memory.turnsSinceChat = 0;
    rememberPerson(dr.who, { note: `death_react_d${dr.depth ?? "?"}`, bump: false });
    if (Math.random() < 0.45) {
      const em = emoteAction(selfName, persona.emote(dr.who));
      if (em) return em;
    }
    const line = persona.death(dr.who, dr.depth ?? you.depth);
    const act = sayAction(selfName, line);
    if (act) return act;
  }

  // 3) Prefer answering someone who talked to us / thread
  if (memory.pendingReply) {
    const r = memory.pendingReply;
    memory.pendingReply = null;
    memory.replyTo = r.from;
    memory.replySnippet = r.text;
    memory.turnsSinceChat = 0;
    rememberPerson(r.from, { isHuman: r.isHuman, said: r.text, note: "replied", bump: false });
    pushThread(selfName, r.from, r.from, r.text);
    const replyText = contextualChat(state, memory, "reply", selfName);
    pushThread(selfName, r.from, selfName, replyText);
    const act = sayAction(selfName, replyText);
    if (act) return act;
  }

  // 4) Greet new human on screen (high priority, once per run)
  for (const h of humans) {
    if (!memory.greeted?.has(h.name)) {
      memory.greeted = memory.greeted || new Set();
      memory.greeted.add(h.name);
      rememberPerson(h.name, { isHuman: true, note: "greeted" });
      memory.turnsSinceChat = 0;
      const line = persona.greet(h.name, selfName, you.depth);
      const act = sayAction(selfName, line);
      if (act) return act;
    }
  }

  // 5) Friend humans we keep meeting (not already friended)
  for (const h of humans) {
    if (!SOCIAL.friended.has(h.name) && (SOCIAL.people[h.name]?.timesSeen || 0) >= 2) {
      SOCIAL.friended.add(h.name);
      rememberPerson(h.name, { isHuman: true, note: "friend_request", bump: false });
      memory.turnsSinceSocial = 0;
      return { type: "social", action: "friend_add", target: h.name };
    }
  }

  // 6) Occasional emote when peers nearby
  if ((humans.length || bots.length) && Math.random() < 0.18) {
    const peer = humans[0] || bots[0];
    const em = emoteAction(selfName, persona.emote(peer?.name));
    if (em) {
      memory.turnsSinceSocial = 0;
      return em;
    }
  }

  // 7) Banter with bot peers (thread-aware)
  if (bots.length && Math.random() < 0.4) {
    const peer = bots[Math.floor(Math.random() * bots.length)];
    memory.turnsSinceChat = 0;
    // Continue existing thread if any
    const tk = threadKey(selfName, peer.name);
    const hist = SOCIAL.threads[tk]?.messages || [];
    let line;
    if (hist.length && Math.random() < 0.5) {
      const last = hist[hist.length - 1];
      line = `${peer.name}: still with you — d${you.depth}, re "${String(last.text).slice(0, 28)}"`;
    } else {
      line = contextualChat(state, memory, "banter", selfName);
    }
    pushThread(selfName, peer.name, selfName, line);
    const act = sayAction(selfName, line);
    if (act) return act;
  }

  // 8) Occasional DM to a remembered human
  const humanNames = Object.entries(SOCIAL.people)
    .filter(([n, v]) => v.isHuman && !looksLikeBotName(n) && n.toLowerCase() !== "system")
    .map(([n]) => n);
  if (humanNames.length && Math.random() < 0.15) {
    const target = humanNames[Math.floor(Math.random() * humanNames.length)];
    // Don't DM spam same target
    if (!memory.dmSent?.has(target)) {
      memory.dmSent = memory.dmSent || new Set();
      memory.dmSent.add(target);
      memory.turnsSinceSocial = 0;
      return {
        type: "social",
        action: "dm_send",
        target,
        text: `Hey ${target}, ${selfName} here — still alive on d${you.depth}. Watch stairs.`,
      };
    }
  }

  // 9) Idle chatter (rate-limited)
  memory.turnsSinceChat = 0;
  return sayAction(selfName, contextualChat(state, memory, "idle", selfName));
}

function chooseAction(state, memory, style, selfName = BASE_NAME) {
  // Explicit style on every path — never bare free-var; default "reckless"
  style = resolvePlayStyle(style, memory);
  const you = state.you;
  if (!you || you.phase === "dead" || you.phase === "won") return null;

  if (you.phase === "inventory") {
    if (memory.useSlot) {
      const slot = memory.useSlot;
      memory.useSlot = null;
      return { type: "input", key: slot };
    }
    return { type: "input", key: "i" };
  }

  const inv = you.inventory || [];
  const hints = state.hints || [];
  const vis = state.visible || {};
  const monsters = vis.monsters || [];
  const items = vis.items || [];
  const players = vis.players || [];
  const tiles = state.floor?.tiles;
  const stairs = state.floor?.stairsDown;
  const hpRatio = you.maxHp > 0 ? you.hp / you.maxHp : 1;
  const careful = style === "careful";
  const reckless = !careful;
  const hungry =
    hints.includes("eat_food") ||
    hints.includes("starving") ||
    you.hunger === "hungry" ||
    you.hunger === "weak" ||
    you.hunger === "fainting";
  // Careful heals earlier; reckless waits for viral near-death screens
  const critical =
    hints.includes("critical_hp") ||
    hints.includes("low_hp") ||
    hpRatio <= (reckless ? 0.22 : 0.42);
  const wounded = careful && (critical || hpRatio <= 0.62);
  // Prefer server adjacent flag; also treat Chebyshev-1 as melee (diagonal threats)
  const adjMonsters = monsters.filter(
    (m) =>
      m.adjacent ||
      Math.max(Math.abs(m.x - you.x), Math.abs(m.y - you.y)) === 1
  );
  const nearMonsters = monsters.filter((m) => dist(you.x, you.y, m.x, m.y) <= 3);
  const adjSnakes = adjMonsters.filter(isSnake);
  const multiAdj = adjMonsters.length >= 2;
  const dogpile = careful && (multiAdj || nearbyMonsterCount(monsters, you.x, you.y, 2) >= 3);
  const threatHere = adjMonsters.reduce((s, m) => s + monsterThreat(m, careful), 0);
  // Careful farms XP before deep stairs (Lv1 on d2 vs skeleton = death)
  // Underleveled until player level keeps pace with depth (min Lv2 before d2).
  const underleveled =
    careful &&
    ((you.level || 1) < (you.depth || 1) ||
      ((you.depth || 1) >= 2 && (you.level || 1) < 2));
  // Track kills from combat messages + level-ups as proxy
  const allMsgs = state.messages || [];
  if (!memory.kills) memory.kills = 0;
  const killSig = allMsgs.filter((m) =>
    /You kill |ascend to level|gain \d+ XP|\+\d+ XP/i.test(String(m))
  ).length;
  if (killSig > (memory.killMsgCount || 0)) {
    memory.kills += killSig - (memory.killMsgCount || 0);
    memory.killMsgCount = killSig;
  }
  if ((you.level || 1) > (memory.peakLevel || 1)) {
    memory.kills = Math.max(memory.kills, (you.level || 1) - 1);
    memory.peakLevel = you.level || 1;
  }

  // Track depth for chat events
  if (memory.lastDepth != null && you.depth > memory.lastDepth) {
    memory.pendingChat = "depth";
  }
  memory.lastDepth = you.depth;

  // --- Inventory: heal / eat / equip (priority order) ---
  // Never open inventory while multi-adjacent (die in the menu) unless critical + heal ready
  const menuSafe = adjMonsters.length === 0 || (critical && adjMonsters.length <= 1);
  // Heal: careful uses known heal sooner; any potion when critical
  if (menuSafe && (critical || (careful && wounded && hints.includes("heal_in_pack")))) {
    const slot =
      invSlot(inv, isKnownHeal) ||
      (critical || hpRatio <= 0.3 ? invSlot(inv, isHealItem) : null);
    if (slot) {
      memory.useSlot = slot;
      memory.pendingChat = memory.pendingChat || "low_hp";
      return { type: "input", key: "i" };
    }
  }
  // Eat: careful eats on hungry; reckless only weak/fainting — never mid multi-fight
  if (
    menuSafe &&
    !adjMonsters.length &&
    hungry &&
    (careful || you.hunger === "weak" || you.hunger === "fainting" || hints.includes("starving"))
  ) {
    const slot = invSlot(inv, isFoodItem);
    if (slot) {
      memory.useSlot = slot;
      return { type: "input", key: "i" };
    }
  }
  // Careful: equip weapon/armor once when safe (no nearby threats — never mid-fight)
  if (careful && !adjMonsters.length && nearMonsters.length === 0 && !memory.equippedOnce) {
    const slot = invSlot(inv, (i) => isWeapon(i) || isArmor(i));
    if (slot) {
      memory.useSlot = slot;
      memory.equippedOnce = true;
      return { type: "input", key: "i" };
    }
    memory.equippedOnce = true;
  }

  // Poison / burn messages → heal ASAP (even adjacent: poison kills careful ladders)
  const recentMsgs = (state.messages || []).slice(-4).join(" ");
  if (careful && /poison|burns you|succumbed/i.test(recentMsgs)) {
    const slot = invSlot(inv, isKnownHeal) || invSlot(inv, isHealItem);
    if (slot && (menuSafe || critical || multiAdj === false)) {
      memory.useSlot = slot;
      return { type: "input", key: "i" };
    }
  }

  // --- Careful flee: low HP, multi-adjacent, dogpile, snake kite, high threat ---
  // Skeletons/orcs can 2-shot Lv1 — never open-melee threat>=3 until leveled.
  // Even rats/bats chip-kill when bloodied — flee ANY adj threat when wounded.
  const maxAdjThreat = adjMonsters.reduce((mx, m) => Math.max(mx, monsterThreat(m, careful)), 0);
  const outclassed = careful && maxAdjThreat >= 3 && (you.level || 1) < 3;
  const bloodied = careful && hpRatio <= 0.55;
  // Defined early: server auto-descends on any step onto `>` — gate all pathing
  const carefulReadyToDive =
    !careful ||
    (!critical &&
      !bloodied &&
      !dogpile &&
      !underleveled &&
      (you.level || 1) >= Math.min((you.depth || 1) + 1, 3) &&
      ((memory.kills || 0) >= Math.max(2, (you.depth || 1) + 1) ||
        (you.turns || 0) > 160 + (you.depth || 1) * 50));
  if (careful && tiles && (adjMonsters.length || nearMonsters.length >= 2)) {
    const shouldFlee =
      critical ||
      bloodied ||
      multiAdj ||
      dogpile ||
      outclassed ||
      hints.includes("flee_or_heal") ||
      (adjSnakes.length && hpRatio < 0.8) ||
      (maxAdjThreat >= 2 && hpRatio < 0.8) ||
      (threatHere >= 3 && hpRatio < 0.85) ||
      (wounded && adjMonsters.length >= 1);
    if (shouldFlee) {
      // Avoid auto-descend while fleeing
      const noStairs = new Set();
      if (stairs && !carefulReadyToDive) noStairs.add(bfsKey(stairs.x, stairs.y));
      const fleeKey = bestFleeKey(
        tiles,
        you,
        adjMonsters.length ? adjMonsters : nearMonsters,
        noStairs
      );
      if (fleeKey) {
        memory.pendingChat = memory.pendingChat || "low_hp";
        memory.kiteTicks = (memory.kiteTicks || 0) + 1;
        return { type: "input", key: fleeKey };
      }
    }
  }

  // Anti-snake / anti-chip kiting: hit-and-run when not full HP
  if (careful && tiles && adjMonsters.length === 1 && hpRatio < 0.9) {
    const foe = adjMonsters[0];
    const foeThreat = monsterThreat(foe, true);
    // Alternate step-back vs strike for snakes and any mid threat
    if (foeThreat >= 2 || isSnake(foe) || hpRatio < 0.7) {
      const fleeKey = bestFleeKey(tiles, you, [foe]);
      if (fleeKey && (memory.kiteTicks || 0) % 2 === 0) {
        memory.kiteTicks = (memory.kiteTicks || 0) + 1;
        return { type: "input", key: fleeKey };
      }
    }
  }

  // Fight adjacent: reckless always; careful only 1-on-1 vs manageable threats
  // Careful fight floor higher — don't trade down to 1 HP vs bats
  const fightFloor = reckless ? 0.12 : bloodied || critical ? 0.99 : 0.5;
  const canFight =
    adjMonsters.length > 0 &&
    hpRatio > fightFloor &&
    (reckless || (!multiAdj && !dogpile && !outclassed && maxAdjThreat < 3.5));
  if (canFight) {
    // Careful: kill weakest / lowest-threat first (chip down safely)
    // Reckless: highest threat first (glory)
    const target = [...adjMonsters].sort((a, b) => {
      if (careful) {
        const ia = isolationScore(monsters, a);
        const ib = isolationScore(monsters, b);
        if (ia !== ib) return ia - ib;
        return monsterThreat(a, true) - monsterThreat(b, true) || (a.hp ?? 9) - (b.hp ?? 9);
      }
      return monsterThreat(b, false) - monsterThreat(a, false) || (a.hp ?? 9) - (b.hp ?? 9);
    })[0];
    for (const [key, [dx, dy]] of Object.entries(DIR_KEYS)) {
      if (you.x + dx === target.x && you.y + dy === target.y) {
        memory.pendingChat = memory.pendingChat || "fight";
        memory.lastFoe = target.name || target.kind || "monster";
        memory.kiteTicks = (memory.kiteTicks || 0) + 1;
        return { type: "input", key };
      }
    }
  }

  // If careful still adjacent after failed flee/fight gate → force any flee step
  if (careful && (critical || bloodied || wounded) && adjMonsters.length && tiles) {
    const fleeKey = bestFleeKey(tiles, you, adjMonsters);
    if (fleeKey) return { type: "input", key: fleeKey };
    // Cornered: only then swing (prefer weakest)
    if (hpRatio > 0.2) {
      const target = [...adjMonsters].sort((a, b) => (a.hp ?? 9) - (b.hp ?? 9))[0];
      for (const [key, [dx, dy]] of Object.entries(DIR_KEYS)) {
        if (you.x + dx === target.x && you.y + dy === target.y) {
          return { type: "input", key };
        }
      }
    }
  }

  // Descend: reckless dives bloodied; careful only when farmed (carefulReadyToDive above)
  const onStairs =
    hints.includes("on_stairs_descend") || (stairs && you.x === stairs.x && you.y === stairs.y);
  if (onStairs && (reckless || carefulReadyToDive)) {
    memory.pendingChat = memory.pendingChat || "stairs";
    return { type: "input", key: ">" };
  }
  // Careful standing on stairs but not ready — step off (auto-descend is instant otherwise)
  if (careful && onStairs && tiles && !carefulReadyToDive) {
    const stepOff = CARDINALS.find((key) => {
      const [dx, dy] = DIR_KEYS[key];
      const nx = you.x + dx;
      const ny = you.y + dy;
      if (!walkable(tiles, nx, ny)) return false;
      // Don't step onto another monster while escaping stairs
      if (monsters.some((m) => m.x === nx && m.y === ny)) return false;
      return true;
    });
    if (stepOff) return { type: "input", key: stepOff };
  }

  // Remember peers (humans prioritized) — throttle timesSeen bumps
  for (const p of players) {
    if (!p?.name || p.name === selfName) continue;
    const isHuman = !looksLikeBotName(p.name);
    const lastBump = memory.peerBumpAt?.[p.name] || 0;
    const shouldBump = Date.now() - lastBump > 15_000;
    if (shouldBump) {
      memory.peerBumpAt = memory.peerBumpAt || {};
      memory.peerBumpAt[p.name] = Date.now();
      rememberPerson(p.name, { isHuman, note: `seen_d${you.depth}`, bump: true });
    } else {
      rememberPerson(p.name, { isHuman, bump: false });
    }
  }

  // Social: replies, friend accept, death react, banter, DMs + periodic chat
  // Both styles chat ~every CHAT_EVERY ticks so arriving humans see a living dungeon.
  memory.turnsSinceChat = (memory.turnsSinceChat || 0) + 1;
  memory.turnsSinceSocial = (memory.turnsSinceSocial || 0) + 1;
  const socialPeriod = careful ? Math.max(SOCIAL_EVERY, 12) : SOCIAL_EVERY;
  const urgentSocial =
    memory.pendingReply || memory.pendingFriendAccept || memory.pendingDeathReact;
  const socialDue =
    urgentSocial ||
    (!adjMonsters.length &&
      (memory.turnsSinceSocial >= socialPeriod ||
        (players.some((p) => p.name && !looksLikeBotName(p.name)) &&
          memory.turnsSinceSocial >= (careful ? 12 : 8))));
  if (socialDue && !critical && !adjMonsters.length) {
    memory.turnsSinceSocial = 0;
    const social = pickSocialAction(state, memory, selfName);
    if (social) return social;
  }
  // ~20 ticks for all styles (human-visible life); pendingChat still fires sooner.
  const chatPeriod = CHAT_EVERY;
  const chatDue = memory.turnsSinceChat >= chatPeriod || memory.pendingChat;
  if (chatDue && memory.turnsSinceChat >= Math.min(10, chatPeriod / 2) && !adjMonsters.length) {
    const event =
      memory.pendingChat ||
      (players.some((p) => p.name && !looksLikeBotName(p.name))
        ? "greet"
        : players.length
          ? "banter"
          : critical
            ? "low_hp"
            : monsters.length
              ? "fight"
              : "idle");
    memory.pendingChat = null;
    memory.turnsSinceChat = 0;
    const line = contextualChat(state, memory, event, selfName);
    const act = sayAction(selfName, line);
    if (act) return act;
  }

  if (!tiles) {
    return { type: "input", key: CARDINALS[Math.floor(Math.random() * 4)] };
  }

  // Path blocks: careful treats non-adj monsters + peer players as soft walls
  const blocked = new Set();
  if (careful) {
    for (const m of monsters) {
      if (!m.adjacent) blocked.add(bfsKey(m.x, m.y));
    }
    // Soft-block corridor tiles that sit between 2+ monsters (dogpile funnels)
    for (const m of monsters) {
      for (const k of CARDINALS) {
        const [dx, dy] = DIR_KEYS[k];
        const nx = m.x + dx;
        const ny = m.y + dy;
        if (nearbyMonsterCount(monsters, nx, ny, 1) >= 2) {
          blocked.add(bfsKey(nx, ny));
        }
      }
    }
    for (const p of players) {
      blocked.add(bfsKey(p.x, p.y));
    }
    // CRITICAL: server auto-descends on any step onto `>` — never walk onto stairs until ready
    if (stairs && !carefulReadyToDive) {
      blocked.add(bfsKey(stairs.x, stairs.y));
    }
    // Soft-block high-threat monsters even when adjacent planning flee (path avoid)
    for (const m of monsters) {
      if (monsterThreat(m, true) >= 3 && (you.level || 1) < 3) {
        blocked.add(bfsKey(m.x, m.y));
      }
    }
  }

  // Pre-emptive kite: packs OR any high-threat (skeleton+) while underleveled
  if (careful && !adjMonsters.length && nearMonsters.length) {
    const nearHigh = nearMonsters.some((m) => monsterThreat(m, true) >= 3);
    if (
      nearMonsters.length >= 2 ||
      nearHigh ||
      wounded ||
      hpRatio < 0.75
    ) {
      const fleeKey = bestFleeKey(tiles, you, nearMonsters, blocked);
      if (fleeKey) return { type: "input", key: fleeKey };
    }
  }

  // Food on ground — careful always prioritizes rations; reckless when hungry
  if (hungry || careful) {
    const food = items
      .filter((i) => isFoodItem(i) || i.char === "%" || i.char === ",")
      .sort((a, b) => dist(you.x, you.y, a.x, a.y) - dist(you.x, you.y, b.x, b.y))[0];
    if (food && (hungry || careful)) {
      // Don't path through packs for food when careful unless starving
      const path = bfsPath(tiles, you.x, you.y, food.x, food.y, blocked);
      if (path?.length) {
        const stepKey = path[0];
        const [dx, dy] = DIR_KEYS[stepKey];
        const dens = nearbyMonsterCount(monsters, you.x + dx, you.y + dy, 2);
        if (!careful || dens <= 1 || hungry) {
          return { type: "input", key: stepKey };
        }
      }
    }
  }

  // Chase: careful prefers isolated prey but WILL farm XP (underleveled → looser filters)
  const chaseHp = careful ? (underleveled ? 0.42 : 0.55) : 0.4;
  if (monsters.length && hpRatio > chaseHp && !dogpile) {
    const candidates = [...monsters].filter((m) => {
      if (!careful) return true;
      const t = monsterThreat(m, true);
      if (t >= 4 && hpRatio < 0.75) return false;
      if (isSnake(m) && hpRatio < 0.55) return false;
      // When underleveled, allow pack of 2; otherwise prefer isolates
      const maxIso = underleveled ? 2 : 1;
      return isolationScore(monsters, m) <= maxIso;
    });
    // Fallback: if filters empty but underleveled, take nearest weak target
    let pool = candidates;
    if (!pool.length && careful && underleveled) {
      pool = monsters.filter((m) => monsterThreat(m, true) <= 2.5);
    }
    if (!pool.length && reckless) pool = monsters;
    if (pool.length) {
      const target = [...pool].sort((a, b) => {
        if (careful) {
          const ia = isolationScore(monsters, a);
          const ib = isolationScore(monsters, b);
          if (ia !== ib) return ia - ib;
          const da = dist(you.x, you.y, a.x, a.y);
          const db = dist(you.x, you.y, b.x, b.y);
          if (da !== db) return da - db;
          return monsterThreat(a, true) - monsterThreat(b, true);
        }
        const da = dist(you.x, you.y, a.x, a.y);
        const db = dist(you.x, you.y, b.x, b.y);
        if (da !== db) return da - db;
        return monsterThreat(b, false) - monsterThreat(a, false);
      })[0];
      const path = bfsPath(tiles, you.x, you.y, target.x, target.y, blocked);
      if (path?.length) {
        if (careful) {
          const [dx, dy] = DIR_KEYS[path[0]];
          if (nearbyMonsterCount(monsters, you.x + dx, you.y + dy, 2) >= 3) {
            /* skip densest packs */
          } else {
            return { type: "input", key: path[0] };
          }
        } else {
          return { type: "input", key: path[0] };
        }
      }
    }
  }

  // Loot nearest valuable item (careful prefers food/heal)
  if (items.length) {
    const nearest = [...items].sort((a, b) => {
      const va = itemValue(a, careful);
      const vb = itemValue(b, careful);
      if (va !== vb) return vb - va;
      return dist(you.x, you.y, a.x, a.y) - dist(you.x, you.y, b.x, b.y);
    })[0];
    const path = bfsPath(tiles, you.x, you.y, nearest.x, nearest.y, blocked);
    if (path?.length) {
      memory.pendingChat = memory.pendingChat || "loot";
      return { type: "input", key: path[0] };
    }
  }

  // Path to stairs only when ready to dive (careful) or any time (reckless)
  const stairTurns = careful ? 120 + you.depth * 35 : 80 + you.depth * 20;
  const floorClear = monsters.length === 0;
  const timeToDive = (you.turns || 0) > stairTurns && hpRatio > (careful ? 0.5 : 0.25);
  const wantStairs =
    reckless
      ? floorClear || timeToDive || (you.turns || 0) > 80 + you.depth * 20
      : carefulReadyToDive && (floorClear || timeToDive || (memory.kills || 0) >= you.depth + 1);
  if (stairs && wantStairs) {
    const dens = nearbyMonsterCount(monsters, stairs.x, stairs.y, 2);
    if (!careful || dens <= 1 || floorClear) {
      const path = bfsPath(tiles, you.x, you.y, stairs.x, stairs.y, blocked);
      if (path?.length) {
        memory.pendingChat = memory.pendingChat || "stairs";
        return { type: "input", key: path[0] };
      }
    }
  }

  // Explore: BFS toward least-recently-visited walkable frontier
  memory.recent = memory.recent || [];
  memory.visitCount = memory.visitCount || new Map();
  const posKey = bfsKey(you.x, you.y);
  memory.visitCount.set(posKey, (memory.visitCount.get(posKey) || 0) + 1);

  let best = null;
  let bestScore = Infinity;
  const q = [{ x: you.x, y: you.y, path: [] }];
  const seen = new Set([posKey]);
  while (q.length && q.length < 400) {
    const cur = q.shift();
    for (const key of CARDINALS) {
      const [dx, dy] = DIR_KEYS[key];
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const k = bfsKey(nx, ny);
      if (seen.has(k)) continue;
      if (!walkable(tiles, nx, ny)) continue;
      if (blocked.has(k)) continue;
      seen.add(k);
      const path = [...cur.path, key];
      const visits = memory.visitCount.get(k) || 0;
      // Careful: penalize exploring toward monster density
      const dens = careful ? nearbyMonsterCount(monsters, nx, ny, 2) : 0;
      const score =
        visits * 10 + path.length + (memory.recent.includes(k) ? 5 : 0) + dens * 6;
      if (score < bestScore && path.length) {
        bestScore = score;
        best = path[0];
      }
      if (path.length < 12) q.push({ x: nx, y: ny, path });
    }
  }
  if (best) {
    const [dx, dy] = DIR_KEYS[best];
    const dest = bfsKey(you.x + dx, you.y + dy);
    memory.recent.push(dest);
    if (memory.recent.length > 60) memory.recent.shift();
    return { type: "input", key: best };
  }

  // Local fallback: prefer unvisited cardinals away from monsters
  const candidates = CARDINALS.filter((key) => {
    const [dx, dy] = DIR_KEYS[key];
    return walkable(tiles, you.x + dx, you.y + dy);
  });
  candidates.sort((a, b) => {
    const [adx, ady] = DIR_KEYS[a];
    const [bdx, bdy] = DIR_KEYS[b];
    const ak = bfsKey(you.x + adx, you.y + ady);
    const bk = bfsKey(you.x + bdx, you.y + bdy);
    const va = (memory.visitCount.get(ak) || 0) + nearbyMonsterCount(monsters, you.x + adx, you.y + ady, 2) * 3;
    const vb = (memory.visitCount.get(bk) || 0) + nearbyMonsterCount(monsters, you.x + bdx, you.y + bdy, 2) * 3;
    return va - vb;
  });
  if (candidates.length) {
    const key = candidates[0];
    const [dx, dy] = DIR_KEYS[key];
    const pos = bfsKey(you.x + dx, you.y + dy);
    memory.recent.push(pos);
    if (memory.recent.length > 60) memory.recent.shift();
    return { type: "input", key };
  }

  return { type: "input", key: "." };
}

function freshMemory() {
  return {
    useSlot: null,
    turnsSinceChat: Math.floor(Math.random() * 12),
    turnsSinceSocial: Math.floor(Math.random() * 8),
    recent: [],
    visitCount: new Map(),
    pendingChat: null,
    pendingReply: null,
    pendingFriendAccept: null,
    pendingDeathReact: null,
    deathReact: null,
    replyTo: null,
    replySnippet: null,
    greeted: new Set(),
    dmSent: new Set(),
    peerBumpAt: {},
    lastDepth: null,
    lastPos: null,
    stuckTicks: 0,
    actionsSent: 0,
    lastSeenTurns: null,
    staleActions: 0,
    equippedOnce: false,
    kiteTicks: 0,
    kills: 0,
    killMsgCount: 0,
    peakLevel: 1,
    lastMsgIdx: 0,
  };
}

class AgentBot {
  constructor(index) {
    this.index = index;
    this.name = botNameFor(index);
    this.style = botStyleFor(index);
    this.personality = getPersonality(this.name);
    this.ws = null;
    this.state = null;
    this.memory = freshMemory();
    this.run = {
      name: this.name,
      startedAt: null,
      depth: 1,
      turns: 0,
      level: 1,
      gold: 0,
      outcome: null,
    };
    this.lastDeathCause = null;
    this.lastDamageMsg = null;
    this.lastDeathEpitaph = null;
    this.alive = true;
    this.busy = false;
    this.tickTimer = null;
    this.runId = 0;
    this.failStreak = 0;
    this.reconnectTimer = null;
  }

  start() {
    console.log(
      `[bot:${this.name}] connecting → ${WS_URL} style=${this.style} persona=${this.personality.id}`
    );
    this.connect();
  }

  stop() {
    this.alive = false;
    this.clearTick();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    saveSocialMemory(true);
  }

  clearTick() {
    if (this.tickTimer != null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  scheduleReconnect(reason) {
    if (!this.alive) return;
    if (this.reconnectTimer) return;
    this.failStreak = Math.min(this.failStreak + 1, 12);
    const base = Math.min(MAX_BACKOFF_MS, RESPAWN_MS * 2 ** Math.min(this.failStreak - 1, 5));
    const jitter = Math.floor(Math.random() * 400);
    const delay = base + jitter;
    console.log(`[bot:${this.name}] reconnect in ${delay}ms (${reason}, streak=${this.failStreak})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  connect() {
    if (!this.alive) return;
    this.clearTick();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.state = null;
    this.busy = false;
    this.memory = freshMemory();
    this.memory.botName = this.name;
    this.memory.style = this.style;
    this.runId++;
    const runId = this.runId;
    this.run = {
      name: this.name,
      startedAt: new Date().toISOString(),
      depth: 1,
      turns: 0,
      level: 1,
      gold: 0,
      outcome: null,
    };

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error(`[bot:${this.name}] construct failed:`, e.message);
      this.scheduleReconnect("construct");
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      console.log(`[bot:${this.name}] open — joining as agent`);
      try {
        ws.send(
          JSON.stringify({
            type: "join",
            name: this.name,
            kind: "agent",
            resumeToken: getBotResumeToken(this.name),
          })
        );
        if (BOT_COMPUTE) {
          ws.send(
            JSON.stringify({
              type: "compute_offer",
              capacity: 1,
              name: this.name,
              job_types: BOT_COMPUTE_TYPES,
            })
          );
        }
      } catch (e) {
        console.error(`[bot:${this.name}] join send failed:`, e.message);
      }
    });

    ws.on("message", (raw) => {
      if (runId !== this.runId) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.onMessage(msg);
    });

    ws.on("error", (err) => {
      console.error(`[bot:${this.name}] ws error:`, err.message);
    });

    ws.on("close", () => {
      if (runId !== this.runId) return;
      console.log(`[bot:${this.name}] closed`);
      this.clearTick();
      if (!this.alive) return;
      if (this.run.outcome) {
        // death/won already scheduled respawn
        return;
      }
      this.scheduleReconnect("unexpected close");
    });
  }

  ensureTick() {
    if (this.tickTimer != null) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    console.log(`[bot:${this.name}] tick loop started (${TICK_MS}ms)`);
  }

  /** Ingest inbound chat: memory, threads, death reacts, reply queue (anti-spam). */
  ingestChat(from, text) {
    const isHuman = !looksLikeBotName(from);
    rememberPerson(from, { isHuman, said: text, note: "chat", bump: true });
    SOCIAL.chatLog.push({ at: Date.now(), from, text: String(text).slice(0, 160), isHuman });
    if (SOCIAL.chatLog.length > 120) SOCIAL.chatLog.shift();
    pushThread(this.name, from, from, text);
    saveSocialMemory();

    // Death / disconnect reactions — sparse (one bot in ~5, not a funeral chorus)
    const death = parseDeathAnnounce(from, text);
    if (death && death.who && death.who !== this.name && !death.disconnect) {
      if (!this.memory.pendingDeathReact && Math.random() < 0.22) {
        this.memory.pendingDeathReact = death;
        this.memory.turnsSinceSocial = SOCIAL_EVERY;
      }
    }

    // Friend request text in chat
    if (/friend request|sent you a friend/i.test(text) && from !== this.name) {
      // ignored — handled via social event / system message
    }

    // Reply policy: always reply to humans (rate-limited later); bots when named or thread-active
    const named = String(text).toLowerCase().includes(String(this.name).toLowerCase());
    const tk = threadKey(this.name, from);
    const activeThread = (SOCIAL.threads[tk]?.messages || []).length >= 2;
    const lastReply = SOCIAL.people[from]?.lastReplyAt || 0;
    const coolOk = Date.now() - lastReply > 6000;
    const shouldReply =
      coolOk &&
      ((isHuman && Math.random() < 0.9) ||
        named ||
        (activeThread && Math.random() < 0.45) ||
        (!isHuman && Math.random() < 0.28));
    if (shouldReply) {
      this.memory.pendingReply = { from, text: String(text).slice(0, 120), isHuman };
      this.memory.turnsSinceSocial = SOCIAL_EVERY;
      if (SOCIAL.people[from]) SOCIAL.people[from].lastReplyAt = Date.now();
    }
  }

  onMessage(msg) {
    if (msg.type === "social_snapshot" && msg.resumeToken) {
      saveBotResumeToken(msg.name || this.name, msg.resumeToken);
    }
    if (msg.type === "error") {
      console.error(`[bot:${this.name}] error:`, msg.message);
      if (/resume denied/i.test(msg.message || "")) {
        // Stale/missing token — force unique name so fleet can rejoin as fresh character
        const prev = this.name;
        this.name = `${prev.replace(/\d+$/, "").slice(0, 10)}${Math.random().toString(36).slice(2, 5)}`.slice(0, 16);
        console.warn(`[bot] resume denied for ${prev}; renaming to ${this.name}`);
        this.scheduleReconnect("resume denied");
        return;
      }
      if (/name already|in use/i.test(msg.message || "")) {
        const prev = this.name;
        this.name = uniqueRename(this.name);
        console.warn(`[bot] name conflict: ${prev} → ${this.name}`);
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        this.scheduleReconnect("name conflict");
      }
      return;
    }

    if (msg.type === "agent_state" || msg.type === "state") {
      this.failStreak = 0;
      if (msg.type === "state") {
        this.state = {
          type: "agent_state",
          you: msg.player,
          floor: msg.floor,
          visible: {
            monsters: msg.floor?.monsters || [],
            items: msg.floor?.items || [],
            players: msg.others || [],
          },
          hints: [],
          messages: msg.player?.messages || [],
        };
      } else {
        this.state = msg;
      }
      const you = this.state.you;
      if (you) {
        this.run.depth = you.depth;
        this.run.turns = you.turns;
        this.run.level = you.level;
        this.run.gold = you.gold;
        // Cache deathCause whenever server sends it (telemetry may land on final VIEW)
        if (you.deathCause) this.lastDeathCause = String(you.deathCause);
        if (you.phase === "dead" || you.phase === "won") {
          this.finishRun(you.phase === "won" ? "won" : "dead", you);
          return;
        }
        // Parse [chat] lines from messages (server may fold chat into player log)
        const msgs = you.messages || this.state.messages || [];
        if (msgs.length > (this.memory.lastMsgIdx || 0)) {
          for (let i = this.memory.lastMsgIdx || 0; i < msgs.length; i++) {
            const m = String(msgs[i] || "");
            const chat = m.match(/^\[chat\]\s*([^:]+):\s*(.+)$/i);
            if (chat) {
              const from = chat[1].trim();
              const text = chat[2].trim();
              if (from && from !== this.name) {
                this.ingestChat(from, text);
              }
            }
            // Friend request hints in system messages
            const fr = m.match(/(\S+)\s+sent you a friend request/i);
            if (fr && fr[1] !== this.name) {
              this.memory.pendingFriendAccept = fr[1].slice(0, 16);
              this.memory.turnsSinceSocial = SOCIAL_EVERY;
            }
            // Cache last melee damage line for deathCause fallback (inventory UI may overwrite log)
            if (/^The .+ (?:CRITICAL hits|mauls|hits|wounds|cuts|nicks|grazes|glances|bites|stings|drains|bashs|bashes|smashs|smashes|strike hards) you/i.test(m)) {
              this.lastDamageMsg = m;
            }
            if (/you die|slain by|starved|killed by/i.test(m)) {
              this.lastDeathEpitaph = m;
            }
          }
          this.memory.lastMsgIdx = msgs.length;
        }
        // Greet humans on first sight
        for (const p of this.state.visible?.players || []) {
          if (p?.name && !looksLikeBotName(p.name)) {
            rememberPerson(p.name, { isHuman: true, note: "visible", bump: false });
          }
        }
      }
      this.ensureTick();
      return;
    }

    if (msg.type === "dead" || msg.type === "won") {
      // Prefer payload player (has deathCause); fall back to last state
      const you = msg.player || this.state?.you;
      if (you?.deathCause) this.lastDeathCause = String(you.deathCause);
      if (you && this.state) this.state.you = { ...(this.state.you || {}), ...you };
      this.finishRun(msg.type, you);
      return;
    }

    // Social realtime events (friend requests, etc.)
    if (msg.type === "social") {
      const ev = msg.event || msg.action;
      if (ev === "friend_request" && msg.from && msg.from !== this.name) {
        this.memory.pendingFriendAccept = String(msg.from).slice(0, 16);
        this.memory.turnsSinceSocial = SOCIAL_EVERY;
        rememberPerson(msg.from, {
          isHuman: !looksLikeBotName(msg.from),
          note: "friend_req_in",
          bump: false,
        });
      }
      return;
    }

    // Live chat from humans + bots → memory + queue reply / death react
    if (msg.type === "chat") {
      const from = msg.from || msg.who || msg.name || "";
      const text = msg.text || msg.message || "";
      if (!from || from === this.name) return;
      this.ingestChat(from, text);
      return;
    }

    // Capture chat lines embedded in player messages after state updates
    if (msg.type === "agent_state" || msg.type === "state") {
      /* handled above; fallthrough not needed */
    }

    // Process compute jobs between turns (voluntary contribution)
    if (msg.type === "compute_job" && BOT_COMPUTE) {
      const t0 = Date.now();
      try {
        const result = solveComputeJob(msg.job_type, msg.payload || {});
        this.ws?.send(
          JSON.stringify({
            type: "compute_result",
            job_id: msg.job_id,
            ok: true,
            result,
            ms: Date.now() - t0,
          })
        );
      } catch (e) {
        this.ws?.send(
          JSON.stringify({
            type: "compute_result",
            job_id: msg.job_id,
            ok: false,
            error: String(e.message || e),
            ms: Date.now() - t0,
          })
        );
      }
      return;
    }

    if (msg.type === "compute_ack" && msg.accepted) {
      this.computeScore = msg.total_score ?? this.computeScore;
      if ((this.computeScore || 0) > 0 && this.computeScore % 10 === 0) {
        console.log(`[bot:${this.name}] compute score=${this.computeScore}`);
      }
    }
  }

  async finishRun(outcome, you) {
    if (this.run.outcome) return;
    this.run.outcome = outcome;
    this.clearTick();

    const depth = you?.depth ?? this.run.depth;
    const turns = you?.turns ?? this.run.turns;
    const level = you?.level ?? this.run.level;
    const gold = you?.gold ?? this.run.gold;
    // Prefer player.messages (includes combat); fall back to state fold
    const msgs = (() => {
      const a = Array.isArray(you?.messages) ? you.messages : [];
      const b = Array.isArray(this.state?.messages) ? this.state.messages : [];
      const base = a.length >= b.length ? a : b.length ? b : a;
      // Prepend cached combat lines so inventory dump doesn't wipe killer evidence
      const extra = [];
      if (this.lastDamageMsg) extra.push(this.lastDamageMsg);
      if (this.lastDeathEpitaph) extra.push(this.lastDeathEpitaph);
      return extra.length ? [...base, ...extra] : base;
    })();
    // Merge cached deathCause if YOU payload raced without it
    const youWithCause =
      you && !you.deathCause && this.lastDeathCause
        ? { ...you, deathCause: this.lastDeathCause }
        : you;
    const deathCauseField =
      rawDeathCause(youWithCause, this.state) || this.lastDeathCause || null;
    // Prefer server deathCause; filter miss/inventory; infer slain-from damage
    const cause = extractRunCause(youWithCause, this.state, msgs);
    const killer = killerFromCause(cause) || killerFromCause(deathCauseField);

    // Death/win chatter — keep dungeon flavor, not ad copy
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        if (outcome === "dead") {
          const yell = `${this.name} fell on depth ${depth} (Lv${level}, ${turns}t, ${gold}g) — ${String(cause).slice(0, 48)}`;
          this.ws.send(JSON.stringify({ type: "input", text: `:say ${yell}` }));
          await sleep(80);
          this.ws.send(
            JSON.stringify({
              type: "social",
              action: "wall_post",
              text: `${this.name} died at d${depth} · Lv${level} · ${turns} turns · ${gold}g · ${String(cause).slice(0, 60)}`.slice(0, 280),
            })
          );
          await sleep(100);
        } else {
          const yell = `${this.name} cleared the dungeon in ${turns} turns. Depth claimed.`;
          this.ws.send(JSON.stringify({ type: "input", text: `:say ${yell}` }));
          await sleep(80);
          this.ws.send(
            JSON.stringify({
              type: "social",
              action: "wall_post",
              text: `${this.name} WON in ${turns} turns`,
            })
          );
          await sleep(100);
        }
      } catch {
        /* best-effort chat */
      }
    }

    logRun({
      bot: this.name,
      outcome,
      depth,
      turns,
      level,
      gold,
      hp: you?.hp,
      actions: this.memory.actionsSent,
      cause: String(cause).slice(0, 120),
      deathCause: deathCauseField ? String(deathCauseField).slice(0, 120) : null,
      killer: killer || null,
      style: this.style,
      messages: msgs.slice(-4),
      url: WS_URL,
    });
    this.lastDeathCause = null;
    this.lastDamageMsg = null;
    this.lastDeathEpitaph = null;

    // Feedback pipeline for analytics (rate-limited server-side). Unique message each death.
    if (outcome === "dead" || outcome === "won") {
      const feedbackBase = WS_URL.includes("127.0.0.1")
        ? "http://127.0.0.1:8080"
        : WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");
      const personaId = this.personality?.id || "unknown";
      const body = {
        category: "gameplay",
        message: [
          `bot_run ${outcome}`,
          `name=${this.name}`,
          `persona=${personaId}`,
          `d${depth}`,
          `lv${level}`,
          `t${turns}`,
          `gold=${gold}`,
          `kills=${this.memory.kills || 0}`,
          `cause=${String(cause).slice(0, 80)}`,
          `deathCause=${String(deathCauseField || cause).slice(0, 60)}`,
          `style=${this.style}`,
          `id=${Date.now().toString(36)}`,
        ].join(" "),
        playerName: this.name,
        sessionId: `bot-${this.name}-${Date.now()}`,
        page: "/agent-bot",
        _ts: Date.now() - 2000,
      };
      // Stagger submissions so multi-bot packs don't share one rate-limit bucket spike
      const delay = 200 + this.index * 350 + Math.floor(Math.random() * 400);
      setTimeout(() => {
        fetch(`${feedbackBase}/api/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": `GrokHackBot/${this.name}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(3000),
        })
          .then(async (r) => {
            if (r.ok) console.log(`[bot:${this.name}] feedback ok ${outcome} d${depth}`);
            else if (r.status !== 429) {
              const t = await r.text().catch(() => "");
              console.warn(`[bot:${this.name}] feedback ${r.status} ${t.slice(0, 80)}`);
            }
          })
          .catch(() => {});
      }, delay);
    }
    saveSocialMemory(true);
    finishedRuns += 1;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    if (!this.alive) return;
    if (MAX_RUNS > 0 && finishedRuns >= MAX_RUNS) {
      console.log(`[bot] MAX_RUNS=${MAX_RUNS} reached — shutting down fleet`);
      for (const b of bots) b.stop();
      setTimeout(() => process.exit(0), 150);
      return;
    }
    this.failStreak = 0;
    console.log(`[bot:${this.name}] ${outcome} d${depth} t${turns} — respawn in ${RESPAWN_MS}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RESPAWN_MS);
  }

  async tick() {
    // Never let a strategy throw kill the process (was: ReferenceError: style is not defined)
    try {
      await this.tickBody();
    } catch (e) {
      console.error(`[bot:${this.name}] tick error (survived):`, e?.stack || e?.message || e);
      this.busy = false;
    }
  }

  async tickBody() {
    if (this.busy || !this.state?.you) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.run.outcome) return;
    const you = this.state.you;
    if (you.phase === "dead" || you.phase === "won") return;

    // Stuck detection: same tile too long → random kick
    const pos = bfsKey(you.x, you.y);
    if (this.memory.lastPos === pos) {
      this.memory.stuckTicks = (this.memory.stuckTicks || 0) + 1;
    } else {
      this.memory.stuckTicks = 0;
      this.memory.lastPos = pos;
    }

    const playStyle = resolvePlayStyle(this.style, this.memory);
    this.style = playStyle;
    this.memory.style = playStyle;
    let action = chooseAction(this.state, this.memory, playStyle, this.name);
    if (this.memory.stuckTicks >= STUCK_TICKS) {
      // Avoid random-walk onto stairs (server auto-descends)
      const stairs = this.state?.floor?.stairsDown;
      const you = this.state.you;
      const keys = CARDINALS.filter((key) => {
        const [dx, dy] = DIR_KEYS[key];
        if (!stairs) return true;
        return !(you.x + dx === stairs.x && you.y + dy === stairs.y && playStyle === "careful");
      });
      const key = (keys.length ? keys : CARDINALS)[Math.floor(Math.random() * (keys.length || 4))];
      action = { type: "input", key };
      this.memory.stuckTicks = 0;
      this.memory.recent = [];
    }
    if (!action) return;

    // Stale-state watchdog: only count turn-advancing inputs.
    // Chat/social/no-op text does not move you.turns — counting it caused mass reconnect thrash.
    if (isTurnAdvancingAction(action)) {
      if (this.memory.lastSeenTurns === you.turns) {
        this.memory.staleActions = (this.memory.staleActions || 0) + 1;
      } else {
        this.memory.lastSeenTurns = you.turns;
        this.memory.staleActions = 0;
      }
      if (this.memory.staleActions >= 40) {
        console.warn(
          `[bot:${this.name}] stale state t=${you.turns} after ${this.memory.staleActions} turn-actions — reconnect`
        );
        this.memory.staleActions = 0;
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        this.scheduleReconnect("stale state");
        return;
      }
    }

    this.busy = true;
    try {
      this.ws.send(JSON.stringify(action));
      this.memory.actionsSent = (this.memory.actionsSent || 0) + 1;
      if (this.memory.actionsSent === 1 || this.memory.actionsSent % 50 === 0) {
        console.log(
          `[bot:${this.name}] actions=${this.memory.actionsSent} d${you.depth} t${you.turns} hp=${you.hp}/${you.maxHp} style=${playStyle}`
        );
      }
    } catch (e) {
      console.error(`[bot:${this.name}] send failed:`, e.message);
    }
    setTimeout(() => {
      this.busy = false;
    }, Math.min(TICK_MS - 20, 200));
  }
}

async function preferLocalWsIfHealthy() {
  if (process.env.BOT_FORCE_REMOTE === "1") return;
  if (process.env.BOT_URL && process.env.BOT_URL.includes("127.0.0.1")) return;
  try {
    const r = await fetch("http://127.0.0.1:8080/api/status", {
      signal: AbortSignal.timeout(900),
    });
    if (r.ok) {
      WS_URL = "ws://127.0.0.1:8080/ws";
      console.log("[bot] co-located server healthy — using local ws://127.0.0.1:8080/ws");
    }
  } catch {
    /* keep configured remote URL */
  }
}

const bots = [];

async function main() {
  await preferLocalWsIfHealthy();
  const previewNames = Array.from({ length: BOT_COUNT }, (_, i) => botNameFor(i)).join(",");
  const previewStyles = Array.from({ length: BOT_COUNT }, (_, i) => botStyleFor(i)).join(",");
  console.log(
    `[bot] fleet size=${BOT_COUNT} names=${previewNames} styles=${previewStyles} tick=${TICK_MS}ms maxRuns=${MAX_RUNS || "∞"} url=${WS_URL}`
  );
  if (MAX_SECONDS > 0) {
    setTimeout(() => {
      console.log(`[bot] MAX_SECONDS=${MAX_SECONDS} elapsed — shutting down`);
      for (const b of bots) b.stop();
      setTimeout(() => process.exit(0), 150);
    }, MAX_SECONDS * 1000);
  }
  for (let i = 0; i < BOT_COUNT; i++) {
    const bot = new AgentBot(i);
    bots.push(bot);
    setTimeout(() => bot.start(), i * 400);
  }
}

function shutdown(sig) {
  console.log(`[bot] ${sig} — stopping ${bots.length} bot(s)`);
  saveSocialMemory(true);
  for (const b of bots) b.stop();
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  console.error("[bot] fatal", err);
  process.exit(1);
});
