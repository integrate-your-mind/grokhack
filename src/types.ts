export type Tile = "#" | "." | ">" | "<";

export type Direction = { dx: number; dy: number };

export const DIRECTIONS: Record<string, Direction> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  h: { dx: -1, dy: 0 },
  j: { dx: 0, dy: 1 },
  k: { dx: 0, dy: -1 },
  l: { dx: 1, dy: 0 },
  y: { dx: -1, dy: -1 },
  u: { dx: 1, dy: -1 },
  b: { dx: -1, dy: 1 },
  n: { dx: 1, dy: 1 },
};

export type ItemType = "weapon" | "armor" | "potion" | "food" | "scroll";

export interface Item {
  id: string;
  name: string;
  char: string;
  type: ItemType;
  power: number;
  identified: boolean;
  cursed?: boolean;
}

export type MonsterKind =
  | "rat"
  | "kobold"
  | "goblin"
  | "orc"
  | "troll"
  | "dragon";

export interface MonsterDef {
  kind: MonsterKind;
  char: string;
  name: string;
  hp: number;
  attack: number;
  defense: number;
  xp: number;
  color: string;
}

export interface Entity {
  id: string;
  x: number;
  y: number;
  char: string;
  name: string;
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  xp: number;
  color: string;
  isPlayer: boolean;
  kind?: MonsterKind;
  ai?: "wander" | "hunt";
}

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Dungeon {
  width: number;
  height: number;
  tiles: Tile[][];
  rooms: Room[];
  stairsDown: { x: number; y: number };
  stairsUp: { x: number; y: number };
}

export type HungerState = "satiated" | "normal" | "hungry" | "weak" | "fainting" | "starving";

export interface PlayerState {
  entity: Entity;
  level: number;
  xp: number;
  xpToLevel: number;
  hunger: number;
  maxHunger: number;
  hungerState: HungerState;
  inventory: Item[];
  equippedWeapon: Item | null;
  equippedArmor: Item | null;
  gold: number;
  turns: number;
  depth: number;
  alive: boolean;
}

export type GamePhase = "playing" | "inventory" | "dead" | "won";

export interface GameState {
  dungeon: Dungeon;
  player: PlayerState;
  monsters: Entity[];
  items: { item: Item; x: number; y: number }[];
  explored: boolean[][];
  messages: string[];
  phase: GamePhase;
  seed: number;
}