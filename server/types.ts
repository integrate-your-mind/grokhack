import type { Dungeon, Entity, FloorTrap, GamePhase, Item, PlayerState } from "../src/types.js";
import type { FloorEventBook } from "../src/events.js";
import type { MovementAuthority } from "../src/movement-reducer.js";

export interface GroundItem {
  item: Item;
  x: number;
  y: number;
}

export type { FloorEventBook };

/** In-memory world-events bookkeeping (not required in DuckDB — rebuilt if missing). */
export interface FloorEventState {
  turnCounter: number;
  lastReinforcementTurn: number;
  lastEnvEventTurn: number;
  lastAmbientTurn: number;
  enteredSpecials: string[];
  discoveredSpecials: string[];
  packSpotted: string[];
  floorEnterDone: boolean;
}

export interface FloorState {
  depth: number;
  dungeon: Dungeon;
  monsters: Entity[];
  items: GroundItem[];
  seed: number;
  /** Synchronously persisted in the shadow-journal authority sidecar. */
  movementAuthority?: MovementAuthority;
  /** Floor traps (trap-pressure). Optional for floors loaded pre-traps; ensure via ensureFloorTraps. */
  traps?: FloorTrap[];
  /** Timed reinforcements + env events (world-events ambient). */
  eventState?: FloorEventState;
  /** TICKET-WE-01 mechanical events book (reinforce/migration/haunt/pollution). */
  eventBook?: FloorEventBook;
}

export type PlayerKind = "human" | "agent";

export interface OnlinePlayer {
  id: string;
  name: string;
  glyph: string;
  kind: PlayerKind;
  state: PlayerState;
  explored: boolean[][];
  messages: string[];
  phase: GamePhase;
  floorDepth: number;
  connected: boolean;
  lastActive: number;
  scoreRecorded: boolean;
  /**
   * Client-held secret for resume/supersede. Issued on join; never broadcast to other players.
   * Durably mirrored in data/resume-tokens.json (sec-app), not DuckDB schema.
   */
  resumeToken?: string;
}

export type ClientTransport = "telnet" | "websocket";

/** Why a session/socket ended — always set on session_disconnect audit detail.reason */
export type DisconnectReason =
  | "client"
  | "server"
  | "timeout"
  | "restart"
  | "grace_expired";

export interface ClientConnection {
  id: string;
  sessionId: string;
  transport: ClientTransport;
  playerId: string | null;
  agentMode: boolean;
  /** Set before close when server/timeout/restart initiated the drop */
  disconnectReason?: DisconnectReason;
  send: (data: string) => void;
  close: () => void;
}

export interface WorldStats {
  onlinePlayers: number;
  floorsActive: number;
  totalTurns: number;
  uptimeMs: number;
}
