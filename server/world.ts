import { randomUUID } from "node:crypto";

import {
  generateDungeon,
  isWalkable,
  findSpawnPoint,
  randomPointInRoom,
  computeFOV,
  planMonsterSpawns,
  planCorridorScraps,
} from "../src/dungeon.js";
import { RNG } from "../src/rng.js";
import {
  createPlayer,
  createMonster,
  createBossDragon,
  createStarterItems,
  generateItem,
  generateItemBiased,
  generatePotion,
  generateHealingPotion,
  pickMonsterKind,
  monsterCountRange,
  foyerThreatCount,
  itemCountRange,
  roomLootCount,
  roomItemPassChance,
  roomLootBias,
  countHealingPotionsOnFloor,
  minHealingPotionsForDepth,
  isHealingPotion,
  nextId,
  makeCorpse,
  depthFlavor,
  itemDisplayName,
  curseChance,
  STARTER_XP_TO_LEVEL,
} from "../src/entities.js";
import {
  meleeAttack,
  effectivePlayerEntity,
  useItem,
  playerHitPenalty,
  tickMonsterRegen,
  tryRangedSpecial,
  trySummonMinion,
  revealMimic,
  checkBossEnrage,
  tryApplyMonsterOnHit,
  tickPlayerStatuses,
  packChaseTarget,
  chooseStepToward,
  sacrificeCorpse,
  resolveThroneSit,
  findCorpseIndex,
  applyXpGain,
} from "../src/combat.js";
// trap-pressure handoff
import {
  applyTrapsOnStep,
  ensureFloorTraps,
  generateTraps,
  searchForTraps,
  trapsRngFromFloorSeed,
} from "../src/traps.js";
// world-events handoff — pure helpers (lead owns src/world-events.ts)
import {
  WORLD_EVENT_SEED_SALT,
  applyPlayerEventEffects,
  applyRoomSpecialOnStep,
  applyAmbientEffects,
  createFloorEventState,
  ensureFloorEventState,
  pickDenMonsterKind,
  planDenPackSpawns,
  isDenSpecial,
  floorEnterAmbient,
  discoverSpecialRoomsInFov,
  detectPackSpotted,
  peripheralWhisper,
  eventRng,
  roomAt,
  spawnFromSpecs,
  tickWorldEventsCore,
} from "../src/world-events.js";
// TICKET-WE-01 pollution (kills fuel blood_moon)
import { ensureFloorEventBook, notePollution } from "../src/events.js";
import type { Direction, Entity, GamePhase, PlayerState, Tile } from "../src/types.js";
import { reduceGameplay } from "../src/gameplay-reducer.js";
import type { GameplayState } from "../src/gameplay-reducer.js";
import {
  movementEventHash,
  movementStateHash,
  reduceMovement,
  type MovementState,
} from "../src/movement-reducer.js";
import {
  movementJournalRunId,
  movementJournalStreamId,
  OriginGameplayJournal,
  type JournalAppendResult,
} from "./origin-journal.js";
import { logEvent } from "./audit.js";
import {
  attachPlayer,
  bumpMetric,
  updateMaxDepth,
} from "./session-metrics.js";
import { recordRun } from "./leaderboard.js";
import {
  acceptFriend,
  cancelFriendRequest,
  declineFriend,
  getDMThread,
  getSocialSnapshot,
  getWallFeed,
  listFriends,
  listPending,
  markDMsRead,
  postWall,
  removeFriend,
  requestFriend,
  sendDM,
  setBio,
  touchProfile,
} from "./social.js";
import { bridgeOutboundChat, bridgeOutboundEmote, bridgeSystemMessage } from "./bridge.js";
import { redeemLinkCode } from "./discord-links.js";
import { redeemXLinkCode } from "./x-links.js";
import {
  appendChatMessages,
  deletePlayerById,
  loadResumablePlayerByName,
  loadWorld,
  saveFloorNow,
  savePlayerNow,
  saveWorldMeta,
  scheduleSaveFloor,
  scheduleSavePlayer,
  scheduleSaveWorldMeta,
} from "./persistence.js";
import { sanitizeChatText, sanitizeExternalName } from "./security.js";
import { normalizeFloorMonsters } from "./floor-monsters.js";
import {
  clearResumeToken,
  ensureResumeToken,
  issueResumeToken,
  verifyResumeToken,
} from "./resume-auth.js";
import type {
  ClientConnection,
  DisconnectReason,
  FloorState,
  GroundItem,
  OnlinePlayer,
  PlayerKind,
  WorldStats,
} from "./types.js";

/** Dragon lair — gate to the abyss (must slay dragon to go deeper). */
const LAIR_DEPTH = 10;
/** Abyss end — true ending only (dragon kill alone is not a win). */
const MAX_DEPTH = 15;
const FOV_RADIUS = 8;
const MAX_PLAYERS = 500;
const MAX_MOVEMENT_NOOP_EVIDENCE_PER_PLAYER = 64;
const MAX_MOVEMENT_NOOP_EVIDENCE_PLAYERS = 2_048;
export const SHUTDOWN_RETRY_MESSAGE = "Server is restarting. Retry shortly.";

export function shouldRecordMovementNoopEvidence(
  evidenceByPlayer: ReadonlyMap<string, ReadonlyMap<string, true>>,
  playerId: string,
  fingerprint: string,
  perPlayerLimit = MAX_MOVEMENT_NOOP_EVIDENCE_PER_PLAYER,
  playerLimit = MAX_MOVEMENT_NOOP_EVIDENCE_PLAYERS,
): boolean {
  if (!Number.isSafeInteger(perPlayerLimit) || perPlayerLimit < 1 ||
      !Number.isSafeInteger(playerLimit) || playerLimit < 1) {
    throw new RangeError("invalid movement evidence limit");
  }
  const evidence = evidenceByPlayer.get(playerId);
  if (!evidence && evidenceByPlayer.size >= playerLimit) return false;
  return !evidence?.has(fingerprint) && (evidence?.size ?? 0) < perPlayerLimit;
}

export interface WorldServerOptions {
  /** Override only for deterministic admission tests; production uses durable persistence. */
  loadResumablePlayer?: (name: string) => Promise<OnlinePlayer | null>;
  /** Maximum resident characters admitted by the legacy single-origin runtime. */
  maxPlayers?: number;
  /** Null disables shadow journaling in narrow tests; production uses the append-only journal. */
  originJournal?: (
    Pick<OriginGameplayJournal, "appendTransition"> &
    Partial<Pick<OriginGameplayJournal, "movementAuthorityForFloor" | "validateMovementAuthorityRegistry">>
  ) | null;
}
/** Hide from map if no input this long — still listed in :who as [away] */
const MAP_IDLE_MS = 30 * 60 * 1000;
/**
 * Soft-disconnect grace: keep player on map + delay "has disconnected" chat
 * so brief WS blips / client reconnects resume silently. Override via env (ms).
 * 0 = finalize immediately (useful in tests).
 */
export function disconnectGraceMs(): number {
  const raw = process.env.GROKHACK_DISCONNECT_GRACE_MS;
  if (raw === undefined || raw === "") return 45_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 45_000;
}

/** Extract monster/source name from deathCause ("Slain by a orc" → "orc"). */
export function killerFromDeathCause(cause: string | null | undefined): string | null {
  if (!cause) return null;
  const m = cause.match(/\bby an?\s+(.+)$/i);
  if (!m?.[1]) return null;
  const name = m[1].trim();
  return name || null;
}

/** Lethal message patterns used when deathCause was never set by the hit path. */
const LETHAL_MSG_RE =
  /you die|slain by|starved|incinerated|killed by|drained dry|succumbed to|burned by|torn apart|food poisoning|cursed teleport|cursed item|polymorphed|zapped self|frozen by|crushed by|ambushed by|mind blasted|fell into|pit trap|dart trap/i;

/**
 * Ensure player.state.deathCause is set before scoring / audit.
 * Prefer existing cause; else last lethal log line; else a generic epitaph.
 * Never invent causes from inventory / stairs / miss spam.
 */
export function ensureDeathCause(
  player: { state: PlayerState; messages?: string[] },
  fallback = "The dungeon claims another soul"
): string {
  const existing = player.state.deathCause?.trim();
  if (existing) return existing;

  const msgs = player.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = String(msgs[i] || "").trim();
    if (!m) continue;
    if (m.startsWith("[chat]") || m.startsWith("Agent")) continue;
    if (/inventory|stairs|welcome back|you hear|bump into|you wait|for \d+ damage/i.test(m) && !LETHAL_MSG_RE.test(m)) {
      continue;
    }
    if (LETHAL_MSG_RE.test(m)) {
      player.state.deathCause = m;
      return m;
    }
  }

  player.state.deathCause = fallback;
  return fallback;
}

const PLAYER_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const DIR_KEYS: Record<string, Direction> = {
  h: { dx: -1, dy: 0 }, j: { dx: 0, dy: 1 }, k: { dx: 0, dy: -1 }, l: { dx: 1, dy: 0 },
  y: { dx: -1, dy: -1 }, u: { dx: 1, dy: -1 }, b: { dx: -1, dy: 1 }, n: { dx: 1, dy: 1 },
  w: { dx: 0, dy: -1 }, a: { dx: -1, dy: 0 }, s: { dx: 0, dy: 1 }, d: { dx: 1, dy: 0 },
};

export class WorldServer {
  private floors = new Map<number, FloorState>();
  private players = new Map<string, OnlinePlayer>();
  private connections = new Map<string, ClientConnection>();
  /** playerId → active socket conn id (guards stale close-after-reconnect) */
  private playerConnIds = new Map<string, string>();
  /** playerId → grace deadline ms (soft-disconnect window) */
  private graceUntil = new Map<string, number>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** playerId → last audit sessionId (for grace_expired disconnect logs) */
  private playerSessions = new Map<string, string>();
  private usedGlyphs = new Set<string>();
  private chatLog: string[] = [];
  /** playerId → timestamps of recent social/chat posts (spam guard) */
  private chatHits = new Map<string, number[]>();
  /** Globally and per-player bounded sampler for free/no-op collision evidence. */
  private movementNoopEvidence = new Map<string, Map<string, true>>();
  /** Avoids turning full non-authoritative shadow journals into log amplification. */
  private evidenceCapacityReported = new Set<"vitals" | "movement">();
  private startedAt = Date.now();
  private totalTurns = 0;
  private worldSeed = Date.now();
  private readonly movementAuthorityBootstrapId = randomUUID();
  private readonly pendingMovementAuthorityRotations = new Map<number, string>();
  /** FIFO admission mutex: capacity/name checks and commits must be one atomic decision. */
  private joinAdmissionTail: Promise<void> = Promise.resolve();
  private readonly loadResumablePlayer: (name: string) => Promise<OnlinePlayer | null>;
  private readonly maxPlayers: number;
  private readonly originJournal: (
    Pick<OriginGameplayJournal, "appendTransition"> &
    Partial<Pick<OriginGameplayJournal, "movementAuthorityForFloor" | "validateMovementAuthorityRegistry">>
  ) | null;
  private shuttingDown = false;

  constructor(options: WorldServerOptions = {}) {
    this.loadResumablePlayer = options.loadResumablePlayer ?? loadResumablePlayerByName;
    this.maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
    this.originJournal = options.originJournal === undefined ? new OriginGameplayJournal() : options.originJournal;
    if (!Number.isSafeInteger(this.maxPlayers) || this.maxPlayers < 1) {
      throw new Error("maxPlayers must be a positive safe integer");
    }
  }

  async hydrateFromDatabase(): Promise<void> {
    this.originJournal?.validateMovementAuthorityRegistry?.call(this.originJournal);
    const data = await loadWorld();
    if (!data) {
      await this.persistMeta();
      return;
    }

    this.worldSeed = data.meta.worldSeed;
    this.totalTurns = data.meta.totalTurns;
    this.startedAt = data.meta.startedAt;

    for (const floor of data.floors) {
      floor.movementAuthority = this.resolveMovementAuthority(floor.depth, floor.seed, false);
      const compacted = this.enforceFloorMonsterInvariant(floor, "hydrate");
      // trap-pressure handoff
      floor.traps = ensureFloorTraps(floor.dungeon, floor.depth, floor.seed, floor.traps);
      // spawn-ecology TICKET-SE-01: sparse hydrate refill (band.min/2 / items < 3)
      this.ensureFloorEcology(floor, "hydrate");
      this.floors.set(floor.depth, floor);
      if (compacted) this.touchFloor(floor);
    }

    for (const player of data.players) {
      player.connected = false;
      this.players.set(player.id, player);
      this.usedGlyphs.add(player.glyph);
    }

    if (data.chatLog.length) {
      this.chatLog = data.chatLog.slice(-200);
    }

    console.log(
      `[world] hydrated ${this.players.size} players, ${this.floors.size} floors from database`
    );
  }

  /**
   * Force-write entire live world for SIGTERM / soft reload.
   * Marks players disconnected in the DB snapshot so cold-start rejoin can resume.
   * Does not wait for socket close handlers (those race process.exit).
   * SESSION-HA: call before flushPersistence() + closePersistence().
   */
  async flushAllDurable(): Promise<void> {
    const playerCount = this.players.size;
    const floorCount = this.floors.size;

    // Cancel soft-disconnect grace — process is exiting; do not race finalize timers.
    for (const id of [...this.disconnectTimers.keys()]) {
      this.clearDisconnectTimer(id);
    }
    this.graceUntil.clear();
    this.playerConnIds.clear();

    for (const player of this.players.values()) {
      // Persist as disconnected so hydrate + loadResumablePlayerByName works after restart
      player.connected = false;
      await savePlayerNow(player);
    }
    for (const floor of this.floors.values()) {
      await saveFloorNow(floor);
    }
    await this.persistMeta();

    console.log(
      `[world] flushed durable state: ${playerCount} players, ${floorCount} floors`
    );
  }

  private async persistMeta(): Promise<void> {
    await saveWorldMeta(this.worldMetaSnapshot());
  }

  private worldMetaSnapshot() {
    return {
      worldSeed: this.worldSeed,
      totalTurns: this.totalTurns,
      startedAt: this.startedAt,
    };
  }

  private scheduleMetaPersist(): void {
    scheduleSaveWorldMeta(this.worldMetaSnapshot());
  }

  private touchPlayer(player: OnlinePlayer): void {
    scheduleSavePlayer(player);
    this.scheduleMetaPersist();
  }

  private touchFloor(floor: FloorState): void {
    this.enforceFloorMonsterInvariant(floor, "runtime");
    scheduleSaveFloor(floor);
  }

  private enforceFloorMonsterInvariant(
    floor: FloorState,
    context: "hydrate" | "runtime"
  ): boolean {
    const normalized = normalizeFloorMonsters(floor.monsters);
    const removed =
      normalized.removedDead +
      normalized.removedDuplicates +
      normalized.removedOverflow;
    if (removed === 0) return false;

    floor.monsters = normalized.monsters;
    if (context === "hydrate") {
      console.warn(
        `[world] compacted floor depth=${floor.depth} on hydrate: ` +
          `dead=${normalized.removedDead} duplicates=${normalized.removedDuplicates} ` +
          `overflow=${normalized.removedOverflow} active=${normalized.monsters.length}`
      );
    }
    return true;
  }

  private addFloorMonsters(floor: FloorState, monsters: readonly Entity[]): void {
    if (monsters.length === 0) return;
    floor.monsters = normalizeFloorMonsters([...floor.monsters, ...monsters]).monsters;
  }

  getStats(): WorldStats {
    return {
      onlinePlayers: this.getOnlineCount(),
      floorsActive: this.floors.size,
      totalTurns: this.totalTurns,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  /**
   * Synchronous mutation fence for graceful shutdown. Once set, no new
   * admission or player/social/external-chat mutation may commit.
   */
  beginShutdown(): boolean {
    if (this.shuttingDown) return false;
    this.shuttingDown = true;
    this.markAllDisconnectReason("restart");
    return true;
  }

  isDraining(): boolean {
    return this.shuttingDown;
  }

  /** Live socket or still inside soft-disconnect grace. */
  private isPresent(player: OnlinePlayer): boolean {
    if (!player.state.alive || player.phase === "dead" || player.phase === "won") return false;
    if (player.connected) return true;
    return this.inGrace(player.id);
  }

  private inGrace(playerId: string): boolean {
    const until = this.graceUntil.get(playerId);
    return until !== undefined && Date.now() < until;
  }

  private clearDisconnectTimer(playerId: string): void {
    const t = this.disconnectTimers.get(playerId);
    if (t) clearTimeout(t);
    this.disconnectTimers.delete(playerId);
  }

  private cancelGrace(playerId: string): void {
    this.clearDisconnectTimer(playerId);
    this.graceUntil.delete(playerId);
  }

  /**
   * After grace expires (or forced finalize): announce disconnect + drop from map.
   * No-op if the player already reconnected.
   */
  private finalizeDisconnect(
    playerId: string,
    reason: DisconnectReason = "grace_expired"
  ): void {
    this.disconnectTimers.delete(playerId);
    this.graceUntil.delete(playerId);
    const player = this.players.get(playerId);
    if (!player || player.connected) return;

    // Socket-level session_disconnect already logged on close; only emit
    // grace_expired here (player fully left map after soft window).
    if (reason === "grace_expired") {
      const sid = this.playerSessions.get(playerId) ?? "grace";
      logEvent("session_disconnect", sid, {
        transport: "websocket",
        playerId: player.id,
        playerName: player.name,
        detail: { reason: "grace_expired" as DisconnectReason },
      });
    }
    this.playerSessions.delete(playerId);

    if (reason !== "restart") {
      this.broadcastChat(`${player.name} has disconnected.`, player.id);
      bridgeSystemMessage(`${player.name} left the dungeon`);
    }
    this.broadcastFloor(player.floorDepth);
    void savePlayerNow(player);
  }

  /** SIGTERM/SIGINT: tag open sockets so close audits report reason=restart */
  markAllDisconnectReason(reason: DisconnectReason): void {
    for (const conn of this.connections.values()) {
      conn.disconnectReason = reason;
    }
  }

  /** Test helper: run grace expiry immediately for a player (or all). */
  flushDisconnectGrace(playerId?: string): void {
    if (playerId) {
      this.clearDisconnectTimer(playerId);
      this.finalizeDisconnect(playerId);
      return;
    }
    for (const id of [...this.disconnectTimers.keys()]) {
      this.clearDisconnectTimer(id);
      this.finalizeDisconnect(id);
    }
    for (const id of [...this.graceUntil.keys()]) {
      this.finalizeDisconnect(id);
    }
  }

  getPresence() {
    const players = [...this.players.values()]
      .filter((p) => this.isPresent(p))
      .map((p) => ({
        name: p.name,
        glyph: p.glyph,
        kind: p.kind,
        depth: p.floorDepth,
        level: p.state.level,
        hp: p.state.entity.hp,
        onMap: this.isActiveOnMap(p),
        away: Date.now() - p.lastActive > MAP_IDLE_MS,
      }));
    return {
      online: players.length,
      onMap: players.filter((p) => p.onMap).length,
      connections: this.connections.size,
      players,
    };
  }

  broadcastPresence(): void {
    const payload = { type: "presence", ...this.getPresence() };
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      this.pushRealtime(p, payload);
    }
    for (const conn of this.connections.values()) {
      if (!conn.playerId) {
        conn.send(`RT:${JSON.stringify(payload)}`);
      }
    }
  }

  ingestExternalChat(from: string, text: string, source: "irc" | "discord"): void {
    if (this.shuttingDown) return;
    const safeFrom = sanitizeExternalName(from, source);
    const safeText = sanitizeChatText(text);
    if (!safeText) return;
    const label = `[${source}] ${safeFrom}`;
    this.broadcastChat(`${label}: ${safeText}`, undefined, "global", label, safeText);
  }

  registerConnection(conn: ClientConnection): boolean {
    if (this.shuttingDown) {
      conn.disconnectReason = "restart";
      try {
        conn.close();
      } catch {
        // The transport may already be closing.
      }
      return false;
    }
    this.connections.set(conn.id, conn);
    return true;
  }

  /**
   * Soft-disconnect: durable-save immediately, keep player on map for grace period,
   * then announce + remove. Stale close after a successful reconnect is a no-op.
   */
  removeConnection(connId: string, _reason?: DisconnectReason): void {
    const conn = this.connections.get(connId);
    this.connections.delete(connId);
    if (!conn?.playerId) return;

    const playerId = conn.playerId;
    const player = this.players.get(playerId);
    if (!player) return;

    // Reconnected on a newer socket — ignore the old close.
    const activeConnId = this.playerConnIds.get(playerId);
    if (activeConnId && activeConnId !== connId) {
      return;
    }

    this.playerConnIds.delete(playerId);
    player.connected = false;
    if (conn.sessionId) this.playerSessions.set(playerId, conn.sessionId);

    // Durable save before grace so server restart mid-window still resumes.
    void savePlayerNow(player);
    const floor = this.floors.get(player.floorDepth);
    if (floor) void saveFloorNow(floor);

    // Process restart: finalize immediately (no dangling map ghosts across boots)
    if (_reason === "restart" || conn.disconnectReason === "restart") {
      this.cancelGrace(playerId);
      this.finalizeDisconnect(playerId, "restart");
      return;
    }

    const grace = disconnectGraceMs();
    if (grace <= 0) {
      this.finalizeDisconnect(playerId, "grace_expired");
      return;
    }

    this.cancelGrace(playerId);
    this.graceUntil.set(playerId, Date.now() + grace);
    const timer = setTimeout(() => this.finalizeDisconnect(playerId), grace);
    // Don't keep the process alive solely for grace timers (tests / clean exit).
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }
    this.disconnectTimers.set(playerId, timer);
  }

  /** Active runners visible on the shared floor map (MMO model). */
  isActiveOnMap(player: OnlinePlayer): boolean {
    if (!player.state.alive) return false;
    if (player.phase === "dead" || player.phase === "won") return false;
    if (Date.now() - player.lastActive > MAP_IDLE_MS) return false;
    // Soft-disconnect grace: still on map until finalizeDisconnect.
    if (player.connected || this.inGrace(player.id)) return true;
    return false;
  }

  /**
   * Join or resume a character.
   * @param resumeToken — required to resume/supersede an existing playing run once a vault token exists.
   *   New characters always receive a fresh token on the returned OnlinePlayer.resumeToken.
   */
  async joinPlayer(
    connId: string,
    name: string,
    kind: PlayerKind = "human",
    resumeToken?: string | null
  ): Promise<OnlinePlayer | string> {
    if (this.shuttingDown) return SHUTDOWN_RETRY_MESSAGE;
    const admissionConnection = this.connections.get(connId);
    if (!admissionConnection) return "Connection is no longer active.";
    if (admissionConnection.playerId) return "Connection is already joined.";

    const trimmed = name.trim().slice(0, 16);
    if (!trimmed || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmed)) {
      return "Invalid name. Use letters, numbers, _ or - (max 16).";
    }

    const resident = await this.withJoinAdmission(() => {
      const invalid = this.revalidateAdmissionConnection(connId, admissionConnection);
      if (invalid) return { resolved: true as const, result: invalid };
      const sameName = this.findResidentPlayer(trimmed);
      if (!sameName) return { resolved: false as const };
      return {
        resolved: true as const,
        result: this.resumeResidentPlayer(connId, sameName, trimmed, resumeToken),
      };
    });
    if (resident.resolved) return resident.result;

    // Never hold the admission gate across persistence I/O.
    const resumable = (await this.loadResumablePlayer(trimmed)) ?? undefined;
    return this.withJoinAdmission(() =>
      this.commitJoin(connId, admissionConnection, trimmed, kind, resumeToken, resumable)
    );
  }

  /** Serialize the no-await admission decision and mutation section. */
  private async withJoinAdmission<T>(commit: () => T): Promise<T> {
    const previous = this.joinAdmissionTail;
    let release!: () => void;
    this.joinAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return commit();
    } finally {
      release();
    }
  }

  private revalidateAdmissionConnection(
    connId: string,
    admissionConnection: ClientConnection
  ): string | undefined {
    if (this.shuttingDown) return SHUTDOWN_RETRY_MESSAGE;
    const currentConnection = this.connections.get(connId);
    if (currentConnection !== admissionConnection) return "Connection is no longer active.";
    if (currentConnection.playerId) return "Connection is already joined.";
    return undefined;
  }

  private findResidentPlayer(name: string): OnlinePlayer | undefined {
    const normalized = name.toLowerCase();
    return [...this.players.values()].find(
      (player) =>
        player.name.toLowerCase() === normalized &&
        (player.phase === "playing" || player.phase === "inventory")
    );
  }

  /** Runs synchronously while holding joinAdmissionTail. */
  private resumeResidentPlayer(
    connId: string,
    sameName: OnlinePlayer,
    trimmed: string,
    resumeToken?: string | null
  ): OnlinePlayer | string {
    const auth = this.authorizeResume(trimmed, resumeToken);
    if (auth !== true) return auth;
    // Re-establish a missing floor authority before detaching an existing
    // connection. A failed preflight must leave the current owner online.
    this.getOrCreateFloor(sameName.floorDepth);
    if (sameName.connected) {
      const oldConnId = this.playerConnIds.get(sameName.id);
      if (oldConnId === connId) {
        sameName.resumeToken = ensureResumeToken(trimmed);
        return sameName;
      }
      if (oldConnId && oldConnId !== connId) {
        const oldConn = this.connections.get(oldConnId);
        if (oldConn) {
          oldConn.playerId = null;
          oldConn.disconnectReason = "server";
          try {
            oldConn.close();
          } catch {
            /* ignore */
          }
        }
        this.playerConnIds.delete(sameName.id);
      }
      sameName.connected = false;
      return this.reconnectPlayer(connId, sameName, { silent: true });
    }
    return this.reconnectPlayer(connId, sameName, {
      silent: this.inGrace(sameName.id),
    });
  }

  /** Runs synchronously while holding joinAdmissionTail. */
  private commitJoin(
    connId: string,
    admissionConnection: ClientConnection,
    trimmed: string,
    kind: PlayerKind,
    resumeToken: string | null | undefined,
    resumable: OnlinePlayer | undefined
  ): OnlinePlayer | string {
    const invalid = this.revalidateAdmissionConnection(connId, admissionConnection);
    if (invalid) return invalid;

    // Another lookup may have committed this name while our lookup was pending.
    const sameName = this.findResidentPlayer(trimmed);
    if (sameName) {
      return this.resumeResidentPlayer(connId, sameName, trimmed, resumeToken);
    }

    if (resumable) {
      const auth = this.authorizeResume(trimmed, resumeToken);
      if (auth !== true) return auth;
      // Preflight floor authority before making the durable player resident.
      this.getOrCreateFloor(resumable.floorDepth);
      this.players.set(resumable.id, resumable);
      return this.reconnectPlayer(connId, resumable);
    }

    for (const stale of [...this.players.values()]) {
      if (
        stale.name.toLowerCase() === trimmed.toLowerCase() &&
        (stale.phase === "dead" || stale.phase === "won")
      ) {
        this.players.delete(stale.id);
        this.usedGlyphs.delete(stale.glyph);
        void deletePlayerById(stale.id);
        clearResumeToken(stale.name);
      }
    }

    // Capacity applies only to new characters. Existing in-memory or durable
    // owners must be able to reconnect when the legacy origin is full.
    if (this.players.size >= this.maxPlayers) return "World is full. Try again later.";

    // Establish durable floor authority before issuing a character credential.
    // A sidecar failure must not leave a new resume secret for a rejected join.
    const floor = this.getOrCreateFloor(1);

    // Fresh character — rotate token so a prior owner's secret cannot claim the new run.
    const token = issueResumeToken(trimmed);
    const glyph = this.allocateGlyph(trimmed);
    const spawn = this.findPlayerSpawn(floor, null);

    const entity = createPlayer(spawn.x, spawn.y);
    entity.char = glyph;
    entity.name = trimmed;
    entity.isPlayer = true;

    const state = this.createPlayerState(entity, 1);
    state.equippedWeapon = state.inventory.find((i) => i.type === "weapon") ?? null;
    state.equippedArmor = state.inventory.find((i) => i.type === "armor") ?? null;
    state.inventory = state.inventory.filter(
      (i) => i !== state.equippedWeapon && i !== state.equippedArmor
    );

    const player: OnlinePlayer = {
      id: nextId("player"),
      name: trimmed,
      glyph,
      kind,
      state,
      explored: this.createExplored(floor.dungeon.width, floor.dungeon.height),
      messages: [
        kind === "agent"
          ? `Agent ${trimmed} online. JSON state on each action. Keys: hjkl, ., >, i, :say, :dm, :friend, :me. Save resumeToken from join ack.`
          : `Welcome, ${trimmed}! :say chat · :me emote · :friend add <name> · :dm <name> msg · :wall post`,
        depthFlavor(1),
      ],
      phase: "playing",
      floorDepth: 1,
      connected: true,
      lastActive: Date.now(),
      scoreRecorded: false,
      resumeToken: token,
    };

    this.players.set(player.id, player);
    admissionConnection.playerId = player.id;
    this.playerConnIds.set(player.id, connId);
    this.playerSessions.set(player.id, admissionConnection.sessionId);
    logEvent("player_join", admissionConnection.sessionId, {
      playerId: player.id,
      playerName: trimmed,
      transport: admissionConnection.transport,
      detail: { kind, depth: 1 },
    });
    attachPlayer(admissionConnection.sessionId, player.id, trimmed, kind, 1);

    // world-events handoff — floor-enter ambient for first visitors
    {
      const ev = ensureFloorEventState(floor.eventState);
      floor.eventState = ev;
      const enter = floorEnterAmbient(
        1,
        floor.dungeon,
        ev,
        eventRng(floor.seed, 1, 0, 0xe1)
      );
      if (enter) {
        for (const msg of enter.messages) this.addMessage(player, msg);
      }
    }
    this.revealFOV(player, floor);
    this.broadcastChat(`${trimmed} enters the dungeon.`, player.id);
    bridgeSystemMessage(`${trimmed} entered the dungeon`);
    this.broadcastFloor(player.floorDepth, player.id);
    void savePlayerNow(player);
    this.scheduleMetaPersist();
    return player;
  }

  /** Resume/supersede gate. Existing characters always require their vault token. */
  private authorizeResume(name: string, presented?: string | null): true | string {
    const verdict = verifyResumeToken(name, presented);
    if (verdict === "ok") return true;
    // A missing/corrupt vault is an operational recovery event, never proof that
    // the next anonymous claimant owns the durable character.
    return "Resume denied. Provide resumeToken from your original join (localStorage / prior ack).";
  }

  /**
   * Resume a disconnected (or grace-period) run on a new connection.
   * Silent when within grace or explicit silent (no chat spam); personal note after cold resume.
   */
  private reconnectPlayer(
    connId: string,
    player: OnlinePlayer,
    opts?: { silent?: boolean }
  ): OnlinePlayer {
    // Authority durability is a precondition for every reconnect mutation.
    const floor = this.getOrCreateFloor(player.floorDepth);
    const wasGrace = this.inGrace(player.id);
    const silent = opts?.silent === true || wasGrace;
    this.cancelGrace(player.id);

    // Detach any stale sockets still pointing at this player.
    for (const [cid, c] of this.connections) {
      if (c.playerId === player.id && cid !== connId) {
        c.playerId = null;
      }
    }

    player.connected = true;
    player.lastActive = Date.now();
    player.phase = player.phase === "inventory" ? "playing" : player.phase;
    player.resumeToken = ensureResumeToken(player.name);

    const conn = this.connections.get(connId);
    if (conn) {
      conn.playerId = player.id;
      this.playerConnIds.set(player.id, connId);
      this.playerSessions.set(player.id, conn.sessionId);
      logEvent("player_reconnect", conn.sessionId, {
        playerId: player.id,
        playerName: player.name,
        transport: conn.transport,
        detail: {
          depth: player.floorDepth,
          level: player.state.level,
          silent,
        },
      });
      attachPlayer(conn.sessionId, player.id, player.name, player.kind, player.floorDepth);
    }

    // Grace / supersede: fully silent. Cold resume after grace: personal only.
    if (!silent) {
      this.addMessage(player, `Welcome back, ${player.name}! (depth ${player.floorDepth})`);
    }
    this.revealFOV(player, floor);
    // No global "returns to the dungeon" chat — reconnect is silent for others.
    this.broadcastFloor(player.floorDepth, player.id);
    void savePlayerNow(player);
    return player;
  }

  /**
   * Per-player chat/social rate limit. Never weakens HTTP rateLimit.
   * Default: 20 posts / 60s per player (global say, emote, dm, wall).
   */
  private allowChatPost(playerId: string, limit = 20, windowMs = 60_000): boolean {
    const now = Date.now();
    const hits = (this.chatHits.get(playerId) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
      this.chatHits.set(playerId, hits);
      return false;
    }
    hits.push(now);
    this.chatHits.set(playerId, hits);
    if (this.chatHits.size > 2000) {
      for (const [id, ts] of this.chatHits) {
        if (!ts.length || now - ts[ts.length - 1]! > windowMs) this.chatHits.delete(id);
      }
    }
    return true;
  }

  getPlayer(playerId: string): OnlinePlayer | undefined {
    return this.players.get(playerId);
  }

  getPlayersOnFloor(depth: number, excludeId?: string): OnlinePlayer[] {
    return [...this.players.values()].filter(
      (p) => p.floorDepth === depth && p.id !== excludeId && this.isActiveOnMap(p)
    );
  }

  getOnlineCount(): number {
    return [...this.players.values()].filter((p) => this.isPresent(p)).length;
  }

  findPlayerByName(name: string): OnlinePlayer | undefined {
    const key = name.trim().toLowerCase();
    return [...this.players.values()].find(
      (p) => p.connected && p.name.toLowerCase() === key
    );
  }

  handleSocialCommand(player: OnlinePlayer, raw: string): boolean {
    touchProfile(player.name);

    if (raw.startsWith(":friend add ")) {
      const target = raw.slice(12).trim();
      const result = requestFriend(player.name, target);
      this.addMessage(player, result.message);
      if (result.ok) {
        const other = this.findPlayerByName(target);
        if (other) {
          this.addMessage(other, `${player.name} sent you a friend request. :friend accept ${player.name}`);
          this.pushRealtime(other, { type: "social", event: "friend_request", from: player.name });
          this.sendToPlayer(other);
        }
      }
      this.sendToPlayer(player);
      return true;
    }

    if (raw.startsWith(":friend accept ")) {
      const target = raw.slice(15).trim();
      const result = acceptFriend(player.name, target);
      this.addMessage(player, result.message);
      if (result.ok) {
        const other = this.findPlayerByName(target);
        if (other) {
          this.addMessage(other, `${player.name} accepted your friend request!`);
          this.pushRealtime(other, { type: "social", event: "friend_accept", from: player.name });
          this.sendToPlayer(other);
        }
        this.pushRealtime(player, { type: "social", event: "friends_updated", snapshot: getSocialSnapshot(player.name) });
      }
      this.sendToPlayer(player);
      return true;
    }

    if (raw.startsWith(":friend remove ")) {
      const target = raw.slice(15).trim();
      const result = removeFriend(player.name, target);
      this.addMessage(player, result.message);
      this.pushRealtime(player, { type: "social", event: "friends_updated", snapshot: getSocialSnapshot(player.name) });
      this.sendToPlayer(player);
      return true;
    }

    if (raw.startsWith(":friend decline ")) {
      const target = raw.slice(16).trim();
      const result = declineFriend(player.name, target);
      this.addMessage(player, result.message);
      this.pushRealtime(player, { type: "social", event: "friends_updated", snapshot: getSocialSnapshot(player.name) });
      this.sendToPlayer(player);
      return true;
    }

    if (raw.startsWith(":friend cancel ")) {
      const target = raw.slice(15).trim();
      const result = cancelFriendRequest(player.name, target);
      this.addMessage(player, result.message);
      this.pushRealtime(player, { type: "social", event: "friends_updated", snapshot: getSocialSnapshot(player.name) });
      this.sendToPlayer(player);
      return true;
    }

    if (raw === ":friends" || raw === ":friend") {
      const friends = listFriends(player.name);
      const pending = listPending(player.name);
      const lines = [
        friends.length ? `Friends: ${friends.join(", ")}` : "No friends yet. :friend add <name>",
        pending.in.length
          ? `Pending in: ${pending.in.join(", ")}  (:friend accept|decline <name>)`
          : "",
        pending.out.length
          ? `Pending out: ${pending.out.join(", ")}  (:friend cancel <name>)`
          : "",
      ].filter(Boolean);
      this.addMessage(player, lines.join("\n"));
      this.sendToPlayer(player);
      return true;
    }

    if (raw.startsWith(":dm ") || raw.startsWith(":tell ") || raw.startsWith(":msg ")) {
      const rest = raw.slice(raw.indexOf(" ") + 1);
      const space = rest.indexOf(" ");
      if (space < 1) {
        this.addMessage(player, "Usage: :dm <name> <message>");
        this.sendToPlayer(player);
        return true;
      }
      const target = rest.slice(0, space).trim();
      const text = sanitizeChatText(rest.slice(space + 1));
      if (!text) {
        this.addMessage(player, "Usage: :dm <name> <message>");
        this.sendToPlayer(player);
        return true;
      }
      if (!this.allowChatPost(player.id)) {
        this.addMessage(player, "Chat rate limit — wait a moment.");
        this.sendToPlayer(player);
        return true;
      }
      const msg = sendDM(player.name, target, text);
      this.addMessage(player, `[dm→${msg.to}] ${text}`);
      const other = this.findPlayerByName(target);
      if (other) {
        this.addMessage(other, `[dm←${player.name}] ${text}`);
        this.pushRealtime(other, {
          type: "chat",
          channel: "dm",
          from: player.name,
          to: other.name,
          text,
          at: msg.at,
        });
        this.sendToPlayer(other);
      } else {
        this.addMessage(player, `${target} is offline — message saved.`);
      }
      this.pushRealtime(player, {
        type: "chat",
        channel: "dm",
        from: player.name,
        to: msg.to,
        text,
        at: msg.at,
      });
      this.sendToPlayer(player);
      return true;
    }

    if (raw.startsWith(":wall ")) {
      const text = sanitizeChatText(raw.slice(6));
      if (!text) {
        this.addMessage(player, "Usage: :wall <message>");
        this.sendToPlayer(player);
        return true;
      }
      if (!this.allowChatPost(player.id)) {
        this.addMessage(player, "Chat rate limit — wait a moment.");
        this.sendToPlayer(player);
        return true;
      }
      const post = postWall(player.name, text);
      this.addMessage(player, `Posted to wall: ${text}`);
      for (const p of this.players.values()) {
        if (!p.connected) continue;
        const friends = listFriends(p.name).map((n) => n.toLowerCase());
        if (
          p.id === player.id ||
          friends.includes(player.name.toLowerCase()) ||
          p.name.toLowerCase() === player.name.toLowerCase()
        ) {
          this.pushRealtime(p, {
            type: "social",
            event: "wall_post",
            post,
          });
        }
      }
      this.sendToPlayer(player);
      return true;
    }

    if (raw.startsWith(":bio ")) {
      const bio = raw.slice(5).trim();
      setBio(player.name, bio);
      this.addMessage(player, `Bio updated.`);
      this.sendToPlayer(player);
      return true;
    }

    if (raw === ":social" || raw === ":feed") {
      const feed = getWallFeed(player.name, 8);
      const lines = feed.length
        ? feed.map((p) => `${p.author}: ${p.text}`).join("\n")
        : "Wall is quiet. :wall <message>";
      this.addMessage(player, lines);
      this.sendToPlayer(player);
      return true;
    }

    return false;
  }

  handleSocialApi(
    playerId: string,
    action: string,
    fields: Record<string, string>
  ): Record<string, unknown> | string {
    if (this.shuttingDown) return { ok: false, message: SHUTDOWN_RETRY_MESSAGE };
    const player = this.players.get(playerId);
    if (!player) return "Not in game.";

    const conn = [...this.connections.values()].find((c) => c.playerId === playerId);
    if (conn && action !== "snapshot" && action !== "dm_thread") {
      logEvent("player_social", conn.sessionId, {
        playerId,
        playerName: player.name,
        transport: conn.transport,
        detail: { action, target: (fields.target || "").slice(0, 16) },
      });
      bumpMetric(conn.sessionId, "socialCount");
    }

    if (action === "snapshot") {
      return getSocialSnapshot(player.name);
    }
    if (action === "friend_add") {
      const r = requestFriend(player.name, fields.target || "");
      if (r.ok) {
        const other = this.findPlayerByName(fields.target || "");
        if (other) {
          this.addMessage(other, `${player.name} sent you a friend request.`);
          this.pushRealtime(other, { type: "social", event: "friend_request", from: player.name });
          this.sendToPlayer(other);
        }
      }
      this.pushRealtime(player, { type: "social", event: "friends_updated", snapshot: getSocialSnapshot(player.name) });
      return r;
    }
    if (action === "friend_accept") {
      const r = acceptFriend(player.name, fields.target || "");
      this.pushRealtime(player, { type: "social", event: "friends_updated", snapshot: getSocialSnapshot(player.name) });
      return r;
    }
    if (action === "friend_remove") {
      const r = removeFriend(player.name, fields.target || "");
      this.pushRealtime(player, { type: "social", event: "friends_updated", snapshot: getSocialSnapshot(player.name) });
      return r;
    }
    if (action === "friend_decline") {
      const r = declineFriend(player.name, fields.target || "");
      this.pushRealtime(player, { type: "social", event: "friends_updated", snapshot: getSocialSnapshot(player.name) });
      return r;
    }
    if (action === "friend_cancel") {
      const r = cancelFriendRequest(player.name, fields.target || "");
      this.pushRealtime(player, { type: "social", event: "friends_updated", snapshot: getSocialSnapshot(player.name) });
      return r;
    }
    if (action === "dm_send") {
      const target = fields.target || "";
      const text = sanitizeChatText(fields.text || "");
      if (!text) return { ok: false, message: "Empty message." };
      if (!this.allowChatPost(player.id)) return { ok: false, message: "Chat rate limit — wait a moment." };
      const msg = sendDM(player.name, target, text);
      const other = this.findPlayerByName(target);
      if (other) {
        this.addMessage(other, `[dm←${player.name}] ${text}`);
        this.pushRealtime(other, { type: "chat", channel: "dm", from: player.name, to: other.name, text, at: msg.at });
        this.sendToPlayer(other);
      }
      return { ok: true, message: msg };
    }
    if (action === "dm_thread") {
      markDMsRead(player.name, fields.target || "");
      return { thread: getDMThread(player.name, fields.target || "", 40) };
    }
    if (action === "wall_post") {
      const text = sanitizeChatText(fields.text || "");
      if (!text) return { ok: false, message: "Empty wall post." };
      if (!this.allowChatPost(player.id)) return { ok: false, message: "Chat rate limit — wait a moment." };
      const post = postWall(player.name, text);
      for (const p of this.players.values()) {
        if (!p.connected) continue;
        this.pushRealtime(p, { type: "social", event: "wall_post", post });
      }
      return { ok: true, post };
    }
    return "Unknown social action.";
  }

  private pushRealtime(player: OnlinePlayer, payload: Record<string, unknown>): void {
    const conn = [...this.connections.values()].find((c) => c.playerId === player.id);
    if (conn) conn.send(`RT:${JSON.stringify(payload)}`);
  }

  listWho(): string {
    const lines = [...this.players.values()]
      .filter((p) => p.connected && p.state.alive && p.phase !== "dead" && p.phase !== "won")
      .map((p) => {
        const away = Date.now() - p.lastActive > MAP_IDLE_MS;
        const tag = away ? " [away]" : this.isActiveOnMap(p) ? "" : " [off-map]";
        return `${p.glyph} ${p.name} (d${p.floorDepth} L${p.state.level} HP${p.state.entity.hp})${tag}`;
      });
    return lines.length ? lines.join("\n") : "No adventurers online.";
  }

  handleInput(playerId: string, raw: string): void {
    if (this.shuttingDown) return;
    const player = this.players.get(playerId);
    if (!player || !player.connected) return;

    player.lastActive = Date.now();
    const key = raw.length === 1 ? raw : raw.trim();
    const conn = [...this.connections.values()].find((c) => c.playerId === playerId);
    if (conn) {
      const isCmd = key.startsWith(":");
      logEvent("player_input", conn.sessionId, {
        playerId,
        playerName: player.name,
        transport: conn.transport,
        detail: isCmd
          ? { cmd: key.slice(0, 80), phase: player.phase, depth: player.floorDepth }
          : { key: key.slice(0, 16), phase: player.phase, depth: player.floorDepth },
      });
      bumpMetric(conn.sessionId, "inputCount");
      updateMaxDepth(conn.sessionId, player.floorDepth);
    }

    if (key.startsWith(":say ") || key.startsWith(":chat ")) {
      const text = sanitizeChatText(key.includes(" ") ? key.slice(key.indexOf(" ") + 1) : "");
      if (!text) return;
      if (!this.allowChatPost(playerId)) {
        this.addMessage(player, "Chat rate limit — wait a moment.");
        this.sendToPlayer(player);
        return;
      }
      if (conn) {
        logEvent("player_chat", conn.sessionId, {
          playerId,
          playerName: player.name,
          transport: conn.transport,
          detail: { channel: "global", len: text.length },
        });
        bumpMetric(conn.sessionId, "chatCount");
      }
      this.broadcastChat(`${player.name}: ${text}`, player.id, "global", player.name, text);
      bridgeOutboundChat(player.name, text);
      return;
    }

    if (key.startsWith(":me ") || key.startsWith(":emote ")) {
      const text = sanitizeChatText(key.includes(" ") ? key.slice(key.indexOf(" ") + 1) : "");
      if (!text) {
        this.addMessage(player, "Usage: :me <action>  e.g. :me waves at the stairs");
        this.sendToPlayer(player);
        return;
      }
      if (!this.allowChatPost(playerId)) {
        this.addMessage(player, "Chat rate limit — wait a moment.");
        this.sendToPlayer(player);
        return;
      }
      if (conn) {
        logEvent("player_chat", conn.sessionId, {
          playerId,
          playerName: player.name,
          transport: conn.transport,
          detail: { channel: "emote", len: text.length },
        });
        bumpMetric(conn.sessionId, "chatCount");
      }
      const line = `* ${player.name} ${text}`;
      this.broadcastChat(line, player.id, "global", player.name, line);
      bridgeOutboundEmote(player.name, text);
      return;
    }

    if (key === "who" || key === ":who" || key === "?") {
      this.addMessage(player, this.listWho());
      this.sendToPlayer(player);
      return;
    }

    if (key.startsWith(":verify ")) {
      const code = key.slice(8).trim();
      // Discord /link + :verify, or X (play.html) + :verify — same code shape
      const discord = redeemLinkCode(code, player.name);
      if (discord.ok) {
        this.addMessage(player, discord.message);
        this.sendToPlayer(player);
        return;
      }
      const x = redeemXLinkCode(code, player.name);
      if (x.ok) {
        this.addMessage(player, x.message);
        this.sendToPlayer(player);
        return;
      }
      // Prefer Discord's wording when neither matches (covers expired Discord codes)
      this.addMessage(player, discord.message.includes("expired") ? discord.message : x.message);
      this.sendToPlayer(player);
      return;
    }

    if (this.handleSocialCommand(player, key)) return;

    if (player.phase === "dead" || player.phase === "won") return;

    if (player.phase === "inventory") {
      if (key === "i" || key === "\x1b") {
        player.phase = "playing";
        this.addMessage(player, "You close your pack.");
      } else {
        const num = parseInt(key, 10);
        if (!isNaN(num)) {
          const idx = num === 0 ? 9 : num - 1;
          const msg = useItem(player.state, idx);
          if (msg === "SCROLL_MAGIC_MAPPING") {
            this.revealAllExplored(player, this.getOrCreateFloor(player.floorDepth));
            this.addMessage(player, "The scroll of magic mapping reveals the floor!");
          } else if (msg) {
            this.addMessage(player, msg);
          }
          if (!player.state.alive) {
            player.phase = "dead";
            if (!player.state.deathCause) {
              player.state.deathCause = "Killed by a cursed item";
            }
            this.addMessage(player, "Game over.");
            this.recordScore(player, "died");
            this.broadcastChat(`${player.name} has died on depth ${player.floorDepth}.`, player.id);
            this.usedGlyphs.delete(player.glyph);
            this.broadcastFloor(player.floorDepth);
            this.sendToPlayer(player);
            return;
          }
          player.phase = "playing";
          this.endPlayerTurn(player);
        } else if (DIR_KEYS[key]) {
          player.phase = "playing";
          this.tryMove(player, DIR_KEYS[key]);
        } else {
          this.addMessage(player, "Pick 1-9 to use an item, i to close.");
        }
      }
      this.sendToPlayer(player);
      return;
    }

    if (key === "i") {
      player.phase = "inventory";
      this.addMessage(player, "Inventory (1-9, 0=10, i to close):");
      player.state.inventory.forEach((item, idx) => {
        this.addMessage(player, `  ${idx + 1}. ${item.char} ${itemDisplayName(item)}`);
      });
      this.sendToPlayer(player);
      return;
    }

    if (key === "Q") {
      this.addMessage(player, "Farewell!");
      const conn = [...this.connections.values()].find((c) => c.playerId === playerId);
      conn?.close();
      return;
    }

    if (key === "a" || key === "A") {
      const floor = this.getOrCreateFloor(player.floorDepth);
      this.trySpecialInteract(player, floor);
      this.sendToPlayer(player);
      return;
    }

    if (key === ".") {
      this.endPlayerTurn(player, "wait");
      this.sendToPlayer(player);
      return;
    }

    // trap-pressure handoff — search for hidden traps
    if (key === "s") {
      const floor = this.getOrCreateFloor(player.floorDepth);
      floor.traps = ensureFloorTraps(floor.dungeon, floor.depth, floor.seed, floor.traps);
      const rng = new RNG(floor.seed + player.state.turns * 1301 + 17);
      const { messages } = searchForTraps(
        floor.traps,
        player.state.entity.x,
        player.state.entity.y,
        rng
      );
      for (const msg of messages) this.addMessage(player, msg);
      this.endPlayerTurn(player);
      this.sendToPlayer(player);
      return;
    }

    if (key === ">" || key === "G" || key === "g") {
      this.tryDescend(player);
      this.sendToPlayer(player);
      return;
    }

    const dir = DIR_KEYS[key];
    if (dir) {
      this.tryMove(player, dir);
      this.sendToPlayer(player);
    }
  }

  private tryMove(player: OnlinePlayer, dir: Direction): void {
    if (player.phase !== "playing") return;
    const floor = this.floors.get(player.floorDepth);
    if (!floor) {
      this.addMessage(player, "Floor unavailable — retry shortly.");
      return;
    }

    const nx = player.state.entity.x + dir.dx;
    const ny = player.state.entity.y + dir.dy;
    const other = this.getPlayerAt(floor.depth, nx, ny, player.id);
    const monster = floor.monsters.find((m) => m.hp > 0 && m.x === nx && m.y === ny);
    // Build the authoritative cell snapshot without mutating floor state. Older
    // loaded floors may not yet have a trap array; materialize it only after the
    // immutable command record succeeds.
    const plannedTraps = ensureFloorTraps(floor.dungeon, floor.depth, floor.seed, floor.traps);
    const tile = (floor.dungeon.tiles[ny]?.[nx] ?? null) as Tile | null;
    const movementState: MovementState = {
      authority: floor.movementAuthority ?? this.resolveMovementAuthority(floor.depth, floor.seed, false),
      x: player.state.entity.x,
      y: player.state.entity.y,
      phase: player.phase,
      alive: player.state.alive,
      immobilizedTurns: player.state.immobilizedTurns ?? 0,
      destination: {
        tile,
        occupant: other ? "player" : monster ? "monster" : "none",
        trap: plannedTraps.some((trap) => !trap.sprung && trap.x === nx && trap.y === ny),
        stairsDown: floor.dungeon.stairsDown.x === nx && floor.dungeon.stairsDown.y === ny,
      },
    };
    const command = { type: "move", dx: dir.dx, dy: dir.dy } as const;
    const movement = reduceMovement(movementState, command);
    const noopFingerprint = movement.turnCost === "none"
      ? [movementStateHash(movementState), command.dx, command.dy, movementEventHash(movement)].join("|")
      : null;
    const sampledNoop = noopFingerprint !== null &&
      !shouldRecordMovementNoopEvidence(
        this.movementNoopEvidence,
        player.id,
        noopFingerprint,
        MAX_MOVEMENT_NOOP_EVIDENCE_PER_PLAYER,
        Math.min(this.maxPlayers, MAX_MOVEMENT_NOOP_EVIDENCE_PLAYERS),
      );
    if (!sampledNoop) {
      try {
        const journalResult = this.originJournal?.appendTransition({
          streamId: movementJournalStreamId(
            player.id,
            movementJournalRunId(player.resumeToken ?? ""),
            movementState.authority,
          ),
          command,
          beforeState: movementState,
        });
        if (journalResult?.status === "dropped_capacity") {
          this.reportEvidenceCapacity(player, journalResult);
        } else if (noopFingerprint !== null) {
          let evidence = this.movementNoopEvidence.get(player.id);
          if (!evidence) {
            evidence = new Map<string, true>();
            this.movementNoopEvidence.set(player.id, evidence);
          }
          evidence.set(noopFingerprint, true);
        }
      } catch (error) {
        const conn = [...this.connections.values()].find((candidate) => candidate.playerId === player.id);
        logEvent("server_error", conn?.sessionId ?? "shadow-journal", {
          playerId: player.id,
          playerName: player.name,
          detail: { component: "origin_movement_journal", message: error instanceof Error ? error.message : String(error) },
        });
        this.addMessage(player, "Turn journal unavailable — retry shortly.");
        return;
      }
    }

    if (movement.outcome === "ignored") return;
    if (movement.outcome === "struggle") {
      this.addMessage(player, "You struggle against the trap!");
      this.endPlayerTurn(player);
      return;
    }
    if (movement.outcome === "blocked_terrain") {
      this.addMessage(player, "You bump into a wall.");
      return;
    }
    if (movement.outcome === "blocked_player") {
      this.addMessage(player, `${other?.name ?? "Another player"} is in the way.`);
      return;
    }
    if (movement.outcome === "combat_intent") {
      if (!monster) throw new Error("movement occupant changed before combat");
      const result = meleeAttack(effectivePlayerEntity(player.state), monster, {
        weaponName: player.state.equippedWeapon?.name,
        hitPenalty: playerHitPenalty(player.state),
      });
      this.addMessage(player, result.message);
      if (result.hit && !result.killed) {
        const enrage = checkBossEnrage(monster);
        if (enrage) this.addMessage(player, enrage);
      }
      if (result.killed) this.killMonster(player, floor, monster);
      this.logCombat(player, monster.name, result.damage, true);
      this.endPlayerTurn(player);
      return;
    }

    player.state.entity.x = movement.state.x;
    player.state.entity.y = movement.state.y;
    this.tryPickup(player, floor);

    // trap-pressure handoff — step-on traps
    floor.traps = plannedTraps;
    if (floor.traps.length) {
      const occupied = new Set<string>();
      for (const m of floor.monsters) {
        if (m.hp > 0) occupied.add(`${m.x},${m.y}`);
      }
      for (const op of this.getPlayersOnFloor(floor.depth, player.id)) {
        occupied.add(`${op.state.entity.x},${op.state.entity.y}`);
      }
      const trapMsgs = applyTrapsOnStep(
        floor.traps,
        player.state,
        floor.dungeon,
        new RNG(floor.seed + player.state.turns * 997 + floor.depth),
        occupied
      );
      for (const msg of trapMsgs) this.addMessage(player, msg);
      this.touchFloor(floor);
      if (!player.state.alive) {
        player.phase = "dead";
        ensureDeathCause(player, "Killed by a trap");
        this.addMessage(player, "Game over.");
        this.recordScore(player, "died");
        this.broadcastChat(
          `${player.name} has died on depth ${player.floorDepth}.`,
          player.id
        );
        this.usedGlyphs.delete(player.glyph);
        this.revealFOV(player, floor);
        this.broadcastFloor(player.floorDepth);
        return;
      }
    }

    // world-events handoff — fountain / graveyard / throne / zoo step effects
    if (player.state.alive) {
      this.applyRoomSpecialStep(player, floor);
      if (!player.state.alive) {
        this.revealFOV(player, floor);
        this.broadcastFloor(player.floorDepth);
        return;
      }
    }

    const { stairsDown } = floor.dungeon;
    const { entity } = player.state;
    if (entity.x === stairsDown.x && entity.y === stairsDown.y) {
      this.tryDescend(player);
    }
    if (player.phase === "playing") this.endPlayerTurn(player);
  }

  private tryDescend(player: OnlinePlayer): void {
    const floor = this.getOrCreateFloor(player.floorDepth);
    const { entity } = player.state;
    const { stairsDown } = floor.dungeon;

    if (entity.x !== stairsDown.x || entity.y !== stairsDown.y) {
      this.addMessage(player, "You must stand on > to descend.");
      return;
    }

    // True ending: final stairs at abyss floor (d15)
    if (player.floorDepth >= MAX_DEPTH) {
      player.phase = "won";
      player.state.alive = false;
      this.addMessage(player, "You have conquered the abyss! True ending — Victory!");
      this.recordScore(player, "won");
      this.broadcastChat(`${player.name} has conquered the abyss!`, player.id);
      this.broadcastFloor(player.floorDepth);
      return;
    }

    // Lair gate: dragon must die before abyss stairs open
    if (player.floorDepth === LAIR_DEPTH) {
      const dragon = floor.monsters.find((m) => m.kind === "dragon" && m.hp > 0);
      if (dragon) {
        this.addMessage(player, "A dragon blocks the abyss stairs! Slay it first.");
        return;
      }
    }

    const newDepth = player.floorDepth + 1;
    const newFloor = this.getOrCreateFloor(newDepth);
    const spawn = this.findPlayerSpawn(newFloor, player.id);

    player.floorDepth = newDepth;
    player.state.depth = newDepth;
    player.state.entity.x = spawn.x;
    player.state.entity.y = spawn.y;
    player.explored = this.createExplored(newFloor.dungeon.width, newFloor.dungeon.height);

    const conn = [...this.connections.values()].find((c) => c.playerId === player.id);
    if (conn) {
      logEvent("floor_descend", conn.sessionId, {
        playerId: player.id,
        playerName: player.name,
        transport: conn.transport,
        detail: { from: newDepth - 1, to: newDepth, level: player.state.level },
      });
      updateMaxDepth(conn.sessionId, newDepth);
    }

    this.addMessage(player, `You descend to depth ${newDepth}.`);
    this.addMessage(player, depthFlavor(newDepth));
    // world-events handoff — floor-enter ambient (once per floor visit bookkeeping)
    {
      const ev = ensureFloorEventState(newFloor.eventState);
      newFloor.eventState = ev;
      // Only first arriver to this floor gets enter lines; others get silent
      const enter = floorEnterAmbient(
        newDepth,
        newFloor.dungeon,
        ev,
        eventRng(newFloor.seed, newDepth, 0, 0xe2)
      );
      if (enter) {
        for (const msg of enter.messages) this.addMessage(player, msg);
      }
    }
    this.revealFOV(player, newFloor);
    this.broadcastFloor(player.floorDepth);
    this.touchPlayer(player);
    void saveFloorNow(newFloor);
  }

  private reportEvidenceCapacity(
    player: OnlinePlayer,
    result: Extract<JournalAppendResult, { status: "dropped_capacity" }>,
  ): void {
    if (this.evidenceCapacityReported.has(result.domain)) return;
    const conn = [...this.connections.values()].find((candidate) => candidate.playerId === player.id);
    logEvent("server_error", conn?.sessionId ?? "shadow-journal", {
      playerId: player.id,
      playerName: player.name,
      detail: {
        component: result.domain === "movement" ? "origin_movement_journal" : "origin_gameplay_journal",
        message: `${result.domain}_evidence_capacity`,
        maxEntries: result.maxEntries,
      },
    });
    this.evidenceCapacityReported.add(result.domain);
  }

  private endPlayerTurn(player: OnlinePlayer, action: "wait" | "other" = "other"): void {
    const floor = this.getOrCreateFloor(player.floorDepth);
    const beforeState: GameplayState = {
      turns: player.state.turns,
      depth: player.floorDepth,
      hunger: player.state.hunger,
      maxHunger: player.state.maxHunger,
      hungerState: player.state.hungerState,
      hp: player.state.entity.hp,
      alive: player.state.alive,
    };
    const command = { type: "advance_turn", action } as const;
    const transition = reduceGameplay(beforeState, command);
    try {
      const journalResult = this.originJournal?.appendTransition({ streamId: player.id, command, beforeState });
      if (journalResult?.status === "dropped_capacity") {
        this.reportEvidenceCapacity(player, journalResult);
      }
    } catch (error) {
      const conn = [...this.connections.values()].find((candidate) => candidate.playerId === player.id);
      logEvent("server_error", conn?.sessionId ?? "shadow-journal", {
        playerId: player.id,
        playerName: player.name,
        detail: { component: "origin_gameplay_journal", message: error instanceof Error ? error.message : String(error) },
      });
      this.addMessage(player, "Turn journal unavailable — retry shortly.");
      return;
    }
    player.state.turns = transition.state.turns;
    player.state.hunger = transition.state.hunger;
    player.state.hungerState = transition.state.hungerState;
    player.state.entity.hp = transition.state.hp;
    player.state.alive = transition.state.alive;
    this.totalTurns++;
    for (const event of transition.events) {
      if (event.type === "message") this.addMessage(player, event.text);
      else if (event.type === "starved") {
        player.phase = "dead";
        player.state.deathCause = "Starved to death";
        this.recordScore(player, "died");
        this.broadcastChat(`${player.name} has died on depth ${player.floorDepth}.`, player.id);
        this.usedGlyphs.delete(player.glyph);
        this.broadcastFloor(player.floorDepth);
      }
    }

    if (player.state.alive) {
      const statusMsg = tickPlayerStatuses(player.state);
      if (statusMsg) this.addMessage(player, statusMsg);
      if (!player.state.alive) {
        player.phase = "dead";
        ensureDeathCause(player, "Succumbed to poison");
        this.addMessage(player, "Game over.");
        this.recordScore(player, "died");
        this.broadcastChat(`${player.name} has died on depth ${player.floorDepth}.`, player.id);
        this.usedGlyphs.delete(player.glyph);
        this.broadcastFloor(player.floorDepth);
      }
    }

    // trap-pressure handoff — bear trap hold wears off each turn
    if (player.state.alive && (player.state.immobilizedTurns ?? 0) > 0) {
      player.state.immobilizedTurns! -= 1;
      if (player.state.immobilizedTurns === 0) {
        this.addMessage(player, "You free yourself from the trap.");
      }
    }

    if (player.state.alive) {
      // world-events handoff — shared-floor reinforcements + env variety
      this.tickFloorWorldEvents(floor, player);
      this.runFloorMonsterAI(floor, player);
    }
    this.notePeripheralThreats(player, floor);
    this.revealFOV(player, floor);
    this.broadcastFloor(player.floorDepth, player.id);
    this.touchPlayer(player);
    this.touchFloor(floor);
  }

  /** world-events: reinforcements + env teeth + ambient flavor (anti-spam). */
  /** world-events: same core as game.ts tickWorldEventsModule (shared tickWorldEventsCore). */
  private tickFloorWorldEvents(floor: FloorState, actingPlayer: OnlinePlayer): void {
    const ev = ensureFloorEventState(floor.eventState);
    floor.eventState = ev;

    const players = this.getPlayersOnFloor(floor.depth);
    const playersOnFloor = Math.max(1, players.length);

    const result = tickWorldEventsCore({
      depth: floor.depth,
      seed: floor.seed,
      dungeon: floor.dungeon,
      monsters: floor.monsters,
      playerPos: {
        x: actingPlayer.state.entity.x,
        y: actingPlayer.state.entity.y,
      },
      playersOnFloor,
      eventState: ev,
      hasGraveyard: floor.dungeon.rooms.some((r) => r.special === "graveyard"),
      fovRadius: FOV_RADIUS,
    });

    // Broadcast floor messages to everyone present
    for (const p of players) {
      for (const msg of result.floorMessages) this.addMessage(p, msg);
    }
    for (const msg of result.actorMessages) {
      this.addMessage(actingPlayer, msg);
    }

    if (result.newMonsters.length) {
      this.addFloorMonsters(floor, result.newMonsters);
      this.touchFloor(floor);
    }

    // Soft pack alert applies to floor monsters
    if (result.alertPacks) {
      for (const p of players) {
        applyAmbientEffects(
          { kind: "stampede", messages: [], alertPacks: true },
          p.state,
          floor.monsters
        );
      }
    }

    // Mechanical teeth hit the acting player
    const death = applyPlayerEventEffects(actingPlayer.state, {
      damage: result.damageToActor,
      heal: result.healToActor,
      hungerDelta: result.hungerDrainActor ? -result.hungerDrainActor : undefined,
      goldDelta: result.goldDeltaActor,
    });
    if (death) this.addMessage(actingPlayer, death);
    if (!actingPlayer.state.alive) {
      actingPlayer.phase = "dead";
      ensureDeathCause(actingPlayer, "Crushed by the dungeon itself");
      this.addMessage(actingPlayer, "Game over.");
      this.recordScore(actingPlayer, "died");
      this.broadcastChat(
        `${actingPlayer.name} has died on depth ${actingPlayer.floorDepth}.`,
        actingPlayer.id
      );
      this.usedGlyphs.delete(actingPlayer.glyph);
    }
  }

  /**
   * world-events handoff — fountain / graveyard / throne / zoo / barracks step effects.
   */
  private applyRoomSpecialStep(player: OnlinePlayer, floor: FloorState): void {
    const eventState = ensureFloorEventState(floor.eventState);
    floor.eventState = eventState;

    const occupied = new Set<string>();
    for (const m of floor.monsters) {
      if (m.hp > 0) occupied.add(`${m.x},${m.y}`);
    }
    for (const op of this.getPlayersOnFloor(floor.depth)) {
      occupied.add(`${op.state.entity.x},${op.state.entity.y}`);
    }

    const rng = new RNG(
      (floor.seed +
        player.state.turns * 2654435761 +
        player.state.entity.x * 97 +
        player.state.entity.y * 193 +
        WORLD_EVENT_SEED_SALT) >>>
        0
    );

    const result = applyRoomSpecialOnStep({
      dungeon: floor.dungeon,
      x: player.state.entity.x,
      y: player.state.entity.y,
      depth: floor.depth,
      eventState,
      occupied,
      rng,
      player: player.state,
    });
    if (!result) return;

    if (result.markEntered && !eventState.enteredSpecials.includes(result.markEntered)) {
      eventState.enteredSpecials.push(result.markEntered);
    }

    for (const msg of result.messages) {
      if (msg) this.addMessage(player, msg);
    }

    if (result.spawns?.length) {
      this.addFloorMonsters(floor, spawnFromSpecs(result.spawns, floor.depth));
      const stir =
        result.messages.find((m) => /claw|guardian|stir/i.test(m)) ??
        "Something stirs nearby...";
      for (const p of this.getPlayersOnFloor(floor.depth, player.id)) {
        this.addMessage(p, stir);
      }
      this.touchFloor(floor);
    }

    const deathMsg = applyPlayerEventEffects(player.state, {
      damage: result.damage,
      heal: result.heal,
      hungerDelta: result.hungerDelta,
      goldDelta: result.goldDelta,
    });
    if (deathMsg) {
      player.phase = "dead";
      if (!player.state.deathCause) {
        player.state.deathCause = "Crushed by the dungeon itself";
      }
      this.addMessage(player, deathMsg);
      this.addMessage(player, "Game over.");
      this.recordScore(player, "died");
      this.broadcastChat(
        `${player.name} has died on depth ${player.floorDepth}.`,
        player.id
      );
      this.usedGlyphs.delete(player.glyph);
    }
  }

  private runFloorMonsterAI(floor: FloorState, actingPlayer: OnlinePlayer): void {
    const targets = [...this.getPlayersOnFloor(floor.depth), actingPlayer].filter(
      (p) => p.state.alive
    );

    for (const monster of floor.monsters) {
      if (monster.hp <= 0) continue;

      tickMonsterRegen(monster);

      let nearest = targets[0];
      let nearestDist = Infinity;
      for (const t of targets) {
        const d = Math.abs(monster.x - t.state.entity.x) + Math.abs(monster.y - t.state.entity.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = t;
        }
      }
      if (!nearest) continue;

      const px = nearest.state.entity.x;
      const py = nearest.state.entity.y;

      // Dragon breath / mind flayer blast at range before closing
      if (nearestDist >= 2 && nearestDist <= 6 && nearest.state.alive) {
        const special = tryRangedSpecial(monster, nearest.state, nearestDist);
        if (special) {
          this.addMessage(nearest, special.message);
          this.logCombat(nearest, monster.name, special.damage, false);
          if (special.killed || !nearest.state.alive) {
            nearest.state.alive = false;
            nearest.phase = "dead";
            nearest.state.entity.hp = 0;
            const cause =
              nearest.state.deathCause ??
              (monster.traits?.includes("mind_blast")
                ? `Mind blasted by a ${monster.name}`
                : `Incinerated by a ${monster.name}`);
            nearest.state.deathCause = cause;
            this.addMessage(nearest, "Game over.");
            this.recordScore(nearest, "died");
            this.broadcastChat(`${nearest.name} was killed by a ${monster.name}.`, nearest.id);
            this.usedGlyphs.delete(nearest.glyph);
            this.broadcastFloor(floor.depth);
            continue;
          }
        } else if (monster.traits?.includes("summon") && nearestDist >= 2 && nearestDist <= 5) {
          const open = this.findAdjacentOpenForMonster(floor, monster, targets);
          const summoned = trySummonMinion(monster, floor.depth, open, createMonster);
          if (summoned) {
            this.addFloorMonsters(floor, [summoned.minion]);
            this.addMessage(nearest, summoned.message);
          }
        }
      }

      if (nearestDist === 1 && monster.hiddenAs) {
        const rev = revealMimic(monster);
        if (rev) this.addMessage(nearest, rev);
      }

      if (nearestDist === 1) {
        // effectivePlayerEntity is a copy — apply damage to the real entity
        const result = meleeAttack(monster, effectivePlayerEntity(nearest.state));
        if (result.hit) {
          nearest.state.entity.hp -= result.damage;
          if (nearest.state.entity.hp <= 0) {
            nearest.state.entity.hp = 0;
            nearest.state.alive = false;
          } else {
            const onHit = tryApplyMonsterOnHit(monster, nearest.state);
            if (onHit) this.addMessage(nearest, onHit);
          }
        }
        this.addMessage(nearest, result.message);
        this.logCombat(nearest, monster.name, result.damage, false);
        if (!nearest.state.alive || result.killed) {
          nearest.state.alive = false;
          nearest.phase = "dead";
          nearest.state.entity.hp = 0;
          // Melee last-hit always wins authority (don't keep inventory/ambient pollution).
          nearest.state.deathCause = `Slain by a ${monster.name}`;
          this.addMessage(nearest, "Game over.");
          this.recordScore(nearest, "died");
          this.broadcastChat(`${nearest.name} was slain by a ${monster.name}.`, nearest.id);
          this.usedGlyphs.delete(nearest.glyph);
          this.broadcastFloor(floor.depth);
        }
        continue;
      }

      const isPack =
        monster.traits?.includes("pack") || monster.traits?.includes("swarm");
      const huntRange = isPack ? 16 : monster.traits?.includes("swift") ? 14 : 12;
      if (monster.ai === "hunt" && nearestDist <= huntRange) {
        this.moveMonsterToward(floor, monster, px, py);
      } else if (Math.random() < 0.4) {
        const dirs = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];
        const d = dirs[Math.floor(Math.random() * dirs.length)];
        this.tryMoveMonster(floor, monster, d.dx, d.dy);
      }
    }
  }

  /** Free adjacent tile for lich summons (TICKET-BE-01). */
  private findAdjacentOpenForMonster(
    floor: FloorState,
    monster: Entity,
    players: OnlinePlayer[]
  ): { x: number; y: number } | null {
    const dirs = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
    ];
    for (const d of dirs) {
      const nx = monster.x + d.dx;
      const ny = monster.y + d.dy;
      if (!isWalkable(floor.dungeon.tiles, nx, ny)) continue;
      if (players.some((p) => p.state.entity.x === nx && p.state.entity.y === ny)) continue;
      if (floor.monsters.some((m) => m.hp > 0 && m.x === nx && m.y === ny)) continue;
      return { x: nx, y: ny };
    }
    return null;
  }

  private tryMoveMonster(floor: FloorState, monster: Entity, dx: number, dy: number): boolean {
    const nx = monster.x + dx;
    const ny = monster.y + dy;
    if (!isWalkable(floor.dungeon.tiles, nx, ny)) return false;
    if (floor.monsters.some((m) => m.hp > 0 && m.id !== monster.id && m.x === nx && m.y === ny)) return false;
    if (this.getPlayerAt(floor.depth, nx, ny)) return false;
    monster.x = nx;
    monster.y = ny;
    return true;
  }

  private moveMonsterToward(floor: FloorState, monster: Entity, tx: number, ty: number): void {
    let aimX = tx;
    let aimY = ty;
    if (monster.traits?.includes("pack") || monster.traits?.includes("swarm")) {
      const aim = packChaseTarget(monster.x, monster.y, tx, ty, (x, y) => {
        if (!isWalkable(floor.dungeon.tiles, x, y)) return true;
        if (this.getPlayerAt(floor.depth, x, y)) return true;
        return floor.monsters.some(
          (m) => m.hp > 0 && m.id !== monster.id && m.x === x && m.y === y
        );
      });
      aimX = aim.x;
      aimY = aim.y;
    }
    chooseStepToward(monster.x, monster.y, aimX, aimY, (dx, dy) =>
      this.tryMoveMonster(floor, monster, dx, dy)
    );
  }

  private killMonster(player: OnlinePlayer, floor: FloorState, monster: Entity): void {
    // Shared with SP via applyXpGain — cycle1 bots never left Lv1
    for (const msg of applyXpGain(player.state, monster.xp)) {
      this.addMessage(player, msg);
    }
    const gold = Math.floor(Math.random() * 5) + 1 + Math.floor(player.floorDepth / 2);
    player.state.gold += gold;
    this.addMessage(player, `You kill the ${monster.name} (+${monster.xp} XP, +${gold} gold).`);
    // TICKET-WE-01 pollution (blood_moon fuel)
    {
      const book = ensureFloorEventBook(floor.eventBook);
      floor.eventBook = book;
      notePollution(book, 1);
    }

    // Corpse / loot drops — undead leave unsafe corpses (TICKET-DP-01)
    const corpseChance = monster.traits?.includes("undead") ? 0.42 : 0.35;
    if (Math.random() < corpseChance) {
      const corpse = makeCorpse(monster.name, nextId("item"), {
        kind: monster.kind,
        traits: monster.traits,
      });
      floor.items.push({ item: corpse, x: monster.x, y: monster.y });
      this.addMessage(player, `The ${monster.name} leaves a corpse.`);
    } else if (Math.random() < 0.12) {
      const loot = generateItem(player.floorDepth, nextId("item"), this.worldSeed);
      floor.items.push({ item: loot, x: monster.x, y: monster.y });
      this.addMessage(player, `Something clatters from the ${monster.name}.`);
    }

    const defeatedIndex = floor.monsters.findIndex((candidate) => candidate.id === monster.id);
    if (defeatedIndex >= 0) floor.monsters.splice(defeatedIndex, 1);
    this.touchFloor(floor);
  }

  /** TICKET-DP-01 — shrine sacrifice / throne sit (key `a`). */
  private trySpecialInteract(player: OnlinePlayer, floor: FloorState): void {
    const { x, y } = player.state.entity;
    const room = floor.dungeon.rooms.find(
      (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
    );

    if (room?.special === "shrine") {
      const idx = findCorpseIndex(player.state);
      if (idx < 0) {
        this.addMessage(player, "The shrine waits. Offer a corpse (carry one and press a).");
        return;
      }
      const msg = sacrificeCorpse(player.state, idx);
      this.addMessage(player, msg);
      if (!player.state.alive) {
        player.phase = "dead";
        this.addMessage(player, "Game over.");
        this.recordScore(player, "died");
        this.broadcastChat(`${player.name} has died on depth ${player.floorDepth}.`, player.id);
        this.usedGlyphs.delete(player.glyph);
        this.broadcastFloor(player.floorDepth);
        return;
      }
      this.endPlayerTurn(player);
      return;
    }

    if (room?.special === "throne") {
      if (player.state.throneSatDepth === player.floorDepth) {
        this.addMessage(player, "You already sat this throne. The power has fled.");
        return;
      }
      const result = resolveThroneSit(player.state);
      player.state.throneSatDepth = player.floorDepth;
      this.addMessage(player, result.message);
      if (result.summon) {
        const occupied = new Set<string>();
        occupied.add(`${x},${y}`);
        for (const m of floor.monsters) {
          if (m.hp > 0) occupied.add(`${m.x},${m.y}`);
        }
        for (const p of this.getPlayersOnFloor(floor.depth)) {
          occupied.add(`${p.state.entity.x},${p.state.entity.y}`);
        }
        const pos = findSpawnPoint(floor.dungeon, occupied, undefined, {
          minDistanceFrom: { x, y },
          minDistance: 1,
        });
        if (pos) {
          const mon = createMonster(result.summon.kind, pos.x, pos.y, player.floorDepth);
          mon.ai = "hunt";
          this.addFloorMonsters(floor, [mon]);
          this.touchFloor(floor);
        }
      }
      this.endPlayerTurn(player);
      return;
    }

    this.addMessage(player, "Nothing special to interact with here. (Shrine: sacrifice. Throne: sit.)");
  }

  private tryPickup(player: OnlinePlayer, floor: FloorState): void {
    const idx = floor.items.findIndex(
      (i) => i.x === player.state.entity.x && i.y === player.state.entity.y
    );
    if (idx === -1) return;
    const ground = floor.items[idx];
    player.state.inventory.push(ground.item);
    floor.items.splice(idx, 1);
    const label = ground.item.identified
      ? ground.item.name
      : ground.item.type === "potion" && ground.item.appearance
        ? `a ${ground.item.appearance} potion`
        : itemDisplayName(ground.item);
    this.addMessage(player, `You pick up ${label.startsWith("a ") || label.startsWith("un") ? label : "a " + label}.`);
    this.touchFloor(floor);
  }

  private getPlayerAt(depth: number, x: number, y: number, excludeId?: string): OnlinePlayer | undefined {
    return [...this.players.values()].find(
      (p) =>
        this.isActiveOnMap(p) &&
        p.floorDepth === depth &&
        p.id !== excludeId &&
        p.state.entity.x === x &&
        p.state.entity.y === y
    );
  }

  /**
   * TICKET-SE-01 / §3.1 — refill sparse floors (additive; never wipe loot).
   *
   * - hydrate: monsters.length < band.min/2 OR items.length < 3
   * - access: never bulk-restock monsters. New floors are seeded at creation,
   *   and cleared live floors recover through bounded world-event reinforcements.
   */
  private ensureFloorEcology(
    floor: FloorState,
    mode: "hydrate" | "access" = "access"
  ): void {
    const band = monsterCountRange(floor.depth);
    const needMonsters =
      mode === "hydrate"
        ? floor.monsters.length < band.min / 2
        : false;
    const needItems =
      mode === "hydrate" ? floor.items.length < 3 : floor.items.length === 0;
    if (!needMonsters && !needItems) return;

    const beforeMon = floor.monsters.length;
    const beforeItems = floor.items.length;
    const rng = new RNG((floor.seed ^ 0xec01a6) >>> 0 || 1);
    if (needMonsters) this.spawnMonsters(floor, rng);
    if (needItems) this.spawnItems(floor, rng);
    console.log(
      `[world] re-seeded ${mode} floor depth=${floor.depth} mon ${beforeMon}->${floor.monsters.length} items ${beforeItems}->${floor.items.length}`
    );
    this.touchFloor(floor);
  }

  private getOrCreateFloor(depth: number): FloorState {
    let floor = this.floors.get(depth);
    if (floor) {
      floor.movementAuthority ??= this.resolveMovementAuthority(floor.depth, floor.seed, false);
      this.enforceFloorMonsterInvariant(floor, "runtime");
      // trap-pressure handoff — regenerate traps if floor loaded pre-traps
      floor.traps = ensureFloorTraps(floor.dungeon, floor.depth, floor.seed, floor.traps);
      // world-events handoff — rebuild bookkeeping if missing (pre-events floors)
      floor.eventState = ensureFloorEventState(floor.eventState);
      // spawn-ecology: never-seeded empties only (access mode) — not mid-run thins
      this.ensureFloorEcology(floor, "access");
      return floor;
    }

    const rng = new RNG(this.worldSeed + depth * 7919);
    const dungeon = generateDungeon(rng, depth);
    const seed = this.worldSeed + depth * 7919;
    const movementAuthority = this.resolveMovementAuthority(depth, seed, true);
    floor = {
      depth,
      dungeon,
      monsters: [],
      items: [],
      seed,
      movementAuthority,
      traps: [],
      eventState: createFloorEventState(),
    };

    this.spawnMonsters(floor, rng);
    this.spawnItems(floor, rng);
    // trap-pressure handoff
    floor.traps = generateTraps(dungeon, depth, trapsRngFromFloorSeed(seed));

    if (depth === LAIR_DEPTH) {
      const up = dungeon.stairsUp;
      let dx = up.x + 1;
      let dy = up.y;
      if (!isWalkable(dungeon.tiles, dx, dy)) {
        const spot = findSpawnPoint(dungeon, new Set([`${up.x},${up.y}`]), rng);
        if (spot) { dx = spot.x; dy = spot.y; }
      }
      floor.monsters.push(createBossDragon(dx, dy, depth));
    }

    this.floors.set(depth, floor);
    this.pendingMovementAuthorityRotations.delete(depth);
    this.touchFloor(floor);
    return floor;
  }

  private resolveMovementAuthority(depth: number, floorSeed: number, rotate: boolean): MovementState["authority"] {
    let rotationId = `${this.movementAuthorityBootstrapId}-d${depth}`;
    if (rotate) {
      const pending = this.pendingMovementAuthorityRotations.get(depth);
      rotationId = pending ?? `${randomUUID()}-d${depth}`;
      if (!pending) this.pendingMovementAuthorityRotations.set(depth, rotationId);
    }
    const durable = this.originJournal?.movementAuthorityForFloor;
    if (durable) {
      const authority = durable.call(this.originJournal, {
        realmId: "legacy-1",
        depth,
        floorSeed,
        rotate,
        rotationId,
      });
      return authority;
    }
    // Narrow injected-journal tests do not own a sidecar. Keep their authority
    // process-scoped; production always uses OriginGameplayJournal above.
    const fallback: MovementState["authority"] = {
      realmId: "legacy-1",
      floorInstanceId: rotationId,
      depth,
      floorEpoch: 1,
      rulesetVersion: 1,
    };
    return fallback;
  }

  private spawnMonsters(floor: FloorState, rng: RNG): void {
    // MMO denser; P0-5 themed dens via pickDenMonsterKind / planDenPackSpawns
    const band = monsterCountRange(floor.depth);
    const mmoExtra = floor.depth <= 5 ? 8 : 5;
    const count = rng.int(band.min, band.max) + mmoExtra;
    const occupied = new Set<string>();
    occupied.add(`${floor.dungeon.stairsUp.x},${floor.dungeon.stairsUp.y}`);
    occupied.add(`${floor.dungeon.stairsDown.x},${floor.dungeon.stairsDown.y}`);

    const positions = planMonsterSpawns(floor.dungeon, floor.depth, count, rng, occupied);
    for (const pos of positions) {
      const room = roomAt(floor.dungeon, pos.x, pos.y);
      const special = room?.special ?? null;
      const kind = isDenSpecial(special)
        ? pickDenMonsterKind(special, floor.depth, rng)
        : pickMonsterKind(floor.depth, rng.next());
      floor.monsters.push(createMonster(kind, pos.x, pos.y, floor.depth));
    }

    // P0-5: extra themed den packs (zoo/barracks/graveyard/throne/beehive)
    for (const pack of planDenPackSpawns(floor.dungeon, floor.depth, occupied, rng)) {
      floor.monsters.push(
        createMonster(pack.monsterKind, pack.x, pack.y, floor.depth)
      );
    }

    // DENSITY_COORD: foyerThreatCount — MMO shared floors need near-stairs life too
    const foyerN = foyerThreatCount(floor.depth);
    const entry = floor.dungeon.stairsUp;
    for (let i = 0; i < foyerN; i++) {
      const pos = findSpawnPoint(floor.dungeon, occupied, rng, {
        minDistanceFrom: entry,
        minDistance: 3,
      });
      if (!pos) break;
      const cheb = Math.max(Math.abs(pos.x - entry.x), Math.abs(pos.y - entry.y));
      if (cheb > 8 && floor.depth <= 5) {
        occupied.add(`${pos.x},${pos.y}`);
        continue;
      }
      occupied.add(`${pos.x},${pos.y}`);
      const kind = pickMonsterKind(Math.min(floor.depth, 3), rng.next());
      floor.monsters.push(createMonster(kind, pos.x, pos.y, floor.depth));
    }
  }

  private spawnItems(floor: FloorState, rng: RNG): void {
    // items density handoff — shared with SP via entities.itemCountRange
    // MMO: +3 so shared floors always feel stocked for multiple players
    const depth = floor.depth;
    const band = itemCountRange(depth);
    const count = rng.int(band.min, band.max) + 3;
    const occupied = new Set<string>();
    for (const m of floor.monsters) occupied.add(`${m.x},${m.y}`);
    occupied.add(`${floor.dungeon.stairsUp.x},${floor.dungeon.stairsUp.y}`);
    const curseRate = curseChance(depth);

    for (let i = 0; i < count; i++) {
      const pos = findSpawnPoint(floor.dungeon, occupied, rng, {
        minDistanceFrom: floor.dungeon.stairsUp,
        minDistance: 2,
      });
      if (!pos) break;
      occupied.add(`${pos.x},${pos.y}`);
      const bias =
        depth <= 5 ? roomLootBias(null, depth, rng.next(), rng.next()) : "any";
      const item = generateItemBiased(depth, nextId("item"), floor.seed, bias);
      if (rng.chance(curseRate) && !(depth <= 3 && isHealingPotion(item))) {
        item.cursed = true;
        item.buc = "cursed";
      }
      floor.items.push({ item, x: pos.x, y: pos.y });
    }

    // Analytics cycle1: guarantee healing potions on d1–3 (MMO floors too)
    {
      const need = minHealingPotionsForDepth(depth) - countHealingPotionsOnFloor(floor.items);
      for (let i = 0; i < need; i++) {
        const pos = findSpawnPoint(floor.dungeon, occupied, rng, {
          minDistanceFrom: floor.dungeon.stairsUp,
          minDistance: 2,
        });
        if (!pos) break;
        occupied.add(`${pos.x},${pos.y}`);
        floor.items.push({
          item: generateHealingPotion(depth, nextId("item"), floor.seed, i === 0 && depth === 1),
          x: pos.x,
          y: pos.y,
        });
      }
    }

    // TICKET-SE-01 / §3.1 — vault & shrine clusters
    const startRoom = floor.dungeon.rooms[0];
    for (const room of floor.dungeon.rooms) {
      if (room.special === "vault") {
        const n = roomLootCount("vault", depth, rng.next());
        for (let i = 0; i < n; i++) {
          const pos = randomPointInRoom(room, occupied, rng);
          if (!pos) break;
          occupied.add(`${pos.x},${pos.y}`);
          floor.items.push({
            item: generateItem(depth + 1, nextId("item"), floor.seed),
            x: pos.x,
            y: pos.y,
          });
        }
      } else if (room.special === "shrine") {
        const n = roomLootCount("shrine", depth, rng.next());
        for (let i = 0; i < n; i++) {
          const pos = randomPointInRoom(room, occupied, rng);
          if (!pos) break;
          occupied.add(`${pos.x},${pos.y}`);
          const pot =
            depth <= 3 && i === 0
              ? generateHealingPotion(depth, nextId("item"), floor.seed)
              : generatePotion(depth, nextId("item"), floor.seed, undefined, "uncursed");
          pot.power = Math.max(pot.power, 12 + depth * 2);
          pot.bucKnown = false;
          floor.items.push({ item: pot, x: pos.x, y: pos.y });
        }
      }
    }

    // §3.1 room pass: non-start rooms, p=0.75+0.03d (cap 0.95); 20% second item
    const roomP = roomItemPassChance(depth);
    for (const room of floor.dungeon.rooms) {
      if (room === startRoom) continue;
      if (room.special === "vault" || room.special === "shrine") continue;
      if (!rng.chance(roomP)) continue;
      const n = rng.chance(0.2) ? 2 : 1;
      const bias = roomLootBias(room.special, depth, rng.next(), rng.next());
      for (let i = 0; i < n; i++) {
        const pos = randomPointInRoom(room, occupied, rng);
        if (!pos) break;
        occupied.add(`${pos.x},${pos.y}`);
        const item = generateItemBiased(depth, nextId("item"), floor.seed, bias);
        if (rng.chance(curseRate * 0.8) && !(depth <= 3 && isHealingPotion(item))) {
          item.cursed = true;
          item.buc = "cursed";
        }
        floor.items.push({ item, x: pos.x, y: pos.y });
      }
    }

    // §3.1 corridor scraps — additive, does not wipe existing loot
    for (const pos of planCorridorScraps(floor.dungeon, depth, rng, occupied)) {
      const item = generateItemBiased(depth, nextId("item"), floor.seed, "food");
      if (rng.chance(curseRate * 0.5)) {
        item.cursed = true;
        item.buc = "cursed";
      }
      floor.items.push({ item, x: pos.x, y: pos.y });
    }
  }

  private findPlayerSpawn(floor: FloorState, excludeId: string | null): { x: number; y: number } {
    const occupied = new Set<string>();
    for (const p of this.players.values()) {
      if (p.id === excludeId || p.floorDepth !== floor.depth || !this.isActiveOnMap(p)) continue;
      occupied.add(`${p.state.entity.x},${p.state.entity.y}`);
    }
    const room = floor.dungeon.rooms[0] ?? { x: 2, y: 2, w: 6, h: 4 };
    const cx = room.x + Math.floor(room.w / 2);
    const cy = room.y + Math.floor(room.h / 2);
    if (!occupied.has(`${cx},${cy}`) && isWalkable(floor.dungeon.tiles, cx, cy)) {
      return { x: cx, y: cy };
    }
    const pos = findSpawnPoint(floor.dungeon, occupied);
    return pos ?? { x: cx, y: cy };
  }

  private createPlayerState(entity: Entity, depth: number): PlayerState {
    return {
      entity,
      level: 1,
      xp: 0,
      xpToLevel: STARTER_XP_TO_LEVEL,
      hunger: 800,
      maxHunger: 1000,
      hungerState: "normal",
      inventory: createStarterItems(),
      equippedWeapon: null,
      equippedArmor: null,
      equippedRing: null,
      gold: 0,
      turns: 0,
      depth,
      alive: true,
      statuses: [],
    };
  }

  private createExplored(width: number, height: number): boolean[][] {
    return Array.from({ length: height }, () => Array(width).fill(false));
  }

  private revealAllExplored(player: OnlinePlayer, floor: FloorState): void {
    for (let y = 0; y < floor.dungeon.height; y++) {
      for (let x = 0; x < floor.dungeon.width; x++) {
        if (floor.dungeon.tiles[y][x] !== "#") {
          player.explored[y][x] = true;
        }
      }
    }
  }

  /** Ambient audio cues when hunters lurk just outside torchlight (world-events). */
  private notePeripheralThreats(player: OnlinePlayer, floor: FloorState): void {
    if (player.phase !== "playing" || !player.state.alive) return;
    const ev = ensureFloorEventState(floor.eventState);
    floor.eventState = ev;
    const whisper = peripheralWhisper({
      monsters: floor.monsters,
      playerPos: { x: player.state.entity.x, y: player.state.entity.y },
      fovRadius: FOV_RADIUS,
      depth: floor.depth,
      seed: floor.seed,
      turn: player.state.turns,
      eventState: ev,
    });
    if (whisper) {
      for (const msg of whisper.messages) this.addMessage(player, msg);
    }
  }

  private revealFOV(player: OnlinePlayer, floor: FloorState): void {
    const px = player.state.entity.x;
    const py = player.state.entity.y;
    const { dungeon, explored } = { dungeon: floor.dungeon, explored: player.explored };

    const sawDown = explored[dungeon.stairsDown.y]?.[dungeon.stairsDown.x] ?? false;
    const sawUp = explored[dungeon.stairsUp.y]?.[dungeon.stairsUp.x] ?? false;

    const visible = computeFOV(dungeon.tiles, px, py, FOV_RADIUS);
    for (const key of visible) {
      const [xs, ys] = key.split(",");
      const x = Number(xs);
      const y = Number(ys);
      if (y >= 0 && y < explored.length && x >= 0 && x < explored[0].length) {
        explored[y][x] = true;
      }
    }

    // Stairs discovery feedback
    if (!sawDown && explored[dungeon.stairsDown.y]?.[dungeon.stairsDown.x]) {
      this.addMessage(player, "You spot a staircase leading deeper (>)!");
    }
    if (
      player.floorDepth > 1 &&
      !sawUp &&
      explored[dungeon.stairsUp.y]?.[dungeon.stairsUp.x]
    ) {
      this.addMessage(player, "You notice stairs leading up (<).");
    }

    // world-events handoff — FOV special discovery + pack spotted
    const ev = ensureFloorEventState(floor.eventState);
    floor.eventState = ev;
    const rng = eventRng(floor.seed, floor.depth, player.state.turns, 0xf0);
    const disc = discoverSpecialRoomsInFov({
      dungeon,
      visibleKeys: visible,
      eventState: ev,
      depth: floor.depth,
      rng,
    });
    if (disc) {
      for (const msg of disc.messages) this.addMessage(player, msg);
      applyAmbientEffects(disc, player.state, floor.monsters);
    }
    const pack = detectPackSpotted({
      monsters: floor.monsters,
      visibleKeys: visible,
      eventState: ev,
      rng: eventRng(floor.seed, floor.depth, player.state.turns, 0xf1),
    });
    if (pack) {
      for (const msg of pack.messages) this.addMessage(player, msg);
      applyAmbientEffects(pack, player.state, floor.monsters);
    }
  }

  private allocateGlyph(name: string): string {
    if (!this.usedGlyphs.has("@")) {
      this.usedGlyphs.add("@");
      return "@";
    }
    const first = name[0].toUpperCase();
    if (!this.usedGlyphs.has(first)) {
      this.usedGlyphs.add(first);
      return first;
    }
    for (const g of PLAYER_GLYPHS) {
      if (!this.usedGlyphs.has(g)) {
        this.usedGlyphs.add(g);
        return g;
      }
    }
    return "+";
  }

  private logCombat(player: OnlinePlayer, attacker: string, damage: number, playerDealt: boolean): void {
    const conn = [...this.connections.values()].find((c) => c.playerId === player.id);
    if (!conn || !damage) return;
    logEvent("combat", conn.sessionId, {
      playerId: player.id,
      playerName: player.name,
      transport: conn.transport,
      detail: { attacker, damage, playerDealt, hp: player.state.entity.hp, depth: player.floorDepth },
    });
    bumpMetric(conn.sessionId, "combatCount");
  }

  recordScore(player: OnlinePlayer, outcome: "won" | "died"): void {
    if (player.scoreRecorded) return;
    player.scoreRecorded = true;
    // Authority: every real death must carry a deathCause into audit + YOU payload.
    if (outcome === "died") {
      ensureDeathCause(player);
    }
    const entry = recordRun(
      player.name,
      player.kind,
      outcome,
      player.floorDepth,
      player.state.level,
      player.state.gold,
      player.state.turns
    );
    this.addMessage(player, `Run recorded. Score: ${entry.score}`);
    const conn = [...this.connections.values()].find((c) => c.playerId === player.id);
    if (conn) {
      const deathCause =
        outcome === "died" ? ensureDeathCause(player) : player.state.deathCause?.trim() || null;
      const killer = outcome === "died" ? killerFromDeathCause(deathCause) : null;
      logEvent(outcome === "won" ? "player_victory" : "player_death", conn.sessionId, {
        playerId: player.id,
        playerName: player.name,
        detail: {
          score: entry.score,
          depth: player.floorDepth,
          level: player.state.level,
          turns: player.state.turns,
          gold: player.state.gold,
          ...(outcome === "died"
            ? { deathCause, killer }
            : {}),
        },
      });
    }
    if (conn?.agentMode) {
      conn.send(`SCORE:${JSON.stringify(entry)}`);
    }
  }

  private addMessage(player: OnlinePlayer, msg: string): void {
    player.messages.push(msg);
    if (player.messages.length > 50) player.messages.shift();
  }

  private broadcastChat(
    msg: string,
    excludeId?: string,
    channel: "global" | "system" = "global",
    from?: string,
    text?: string
  ): void {
    this.chatLog.push(msg);
    if (this.chatLog.length > 200) this.chatLog.shift();
    void appendChatMessages([msg]);
    const at = new Date().toISOString();
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      if (p.id !== excludeId) this.addMessage(p, `[chat] ${msg}`);
      this.pushRealtime(p, {
        type: "chat",
        channel,
        from: from ?? "system",
        text: text ?? msg,
        at,
      });
      if (p.id !== excludeId) this.sendToPlayer(p);
    }
    if (excludeId) {
      const sender = this.players.get(excludeId);
      if (sender?.connected) {
        this.addMessage(sender, `[chat] ${msg}`);
        this.sendToPlayer(sender);
      }
    }
  }

  getChatLog(limit = 50): string[] {
    return this.chatLog.slice(-limit);
  }

  private broadcastFloor(depth: number, excludeId?: string): void {
    for (const p of this.players.values()) {
      if (!p.connected || p.floorDepth !== depth || p.id === excludeId) continue;
      this.sendToPlayer(p);
    }
  }

  sendToPlayer(player: OnlinePlayer): void {
    const conn = [...this.connections.values()].find((c) => c.playerId === player.id);
    if (!conn) return;

    if (player.phase === "dead") {
      conn.send("DEAD");
      return;
    }
    if (player.phase === "won") {
      conn.send("WON");
      return;
    }

    const floor = this.getOrCreateFloor(player.floorDepth);
    const others = this.getPlayersOnFloor(player.floorDepth, player.id);
    conn.send("VIEW");
  }

  buildView(player: OnlinePlayer): { floor: FloorState; others: OnlinePlayer[] } {
    return {
      floor: this.getOrCreateFloor(player.floorDepth),
      others: this.getPlayersOnFloor(player.floorDepth, player.id),
    };
  }
}
