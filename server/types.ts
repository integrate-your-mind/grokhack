import type { Dungeon, Entity, GamePhase, Item, PlayerState } from "../src/types.js";

export interface GroundItem {
  item: Item;
  x: number;
  y: number;
}

export interface FloorState {
  depth: number;
  dungeon: Dungeon;
  monsters: Entity[];
  items: GroundItem[];
  seed: number;
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
}

export type ClientTransport = "telnet" | "websocket";

export interface ClientConnection {
  id: string;
  transport: ClientTransport;
  playerId: string | null;
  agentMode: boolean;
  send: (data: string) => void;
  close: () => void;
}

export interface WorldStats {
  onlinePlayers: number;
  floorsActive: number;
  totalTurns: number;
  uptimeMs: number;
}