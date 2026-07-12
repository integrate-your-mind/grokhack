/** # wall, . floor, > down, < up, + door (open/locked mouth). */
export type Tile = "#" | "." | ">" | "<" | "+";

export type RoomSpecial =
  | "vault"
  | "shrine"
  | "barracks"
  | "zoo"
  | "alcove"
  | "throne"
  | "shop"
  | "beehive"
  | "graveyard"
  | "fountain"
  | null;

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

export type ItemType = "weapon" | "armor" | "potion" | "food" | "scroll" | "ring" | "wand";

/** BUC status — NetHack-style blessed / uncursed / cursed. */
export type BucStatus = "blessed" | "uncursed" | "cursed";

/** Hidden potion effect — revealed when identified. */
export type PotionEffect =
  | "healing"
  | "extra_healing"
  | "poison"
  | "strength"
  | "nutrition"
  | "speed"
  | "invisibility";

/** Hidden scroll effect — revealed when identified / read. */
export type ScrollEffect =
  | "identify"
  | "teleport"
  | "enchant_weapon"
  | "magic_mapping"
  | "fire"
  | "amnesia"
  | "create_monster"
  | "remove_curse";

/** Hidden ring effect — revealed when identified / worn. */
export type RingEffect =
  | "protection"
  | "regeneration"
  | "sustain_ability"
  | "searching"
  | "stealth"
  | "hunger"
  | "aggravate"
  | "adornment";

/** Hidden wand effect — revealed when identified / zapped. */
export type WandEffect =
  | "light"
  | "digging"
  | "striking"
  | "cold"
  | "sleep"
  | "nothing"
  | "polymorph"
  | "secret_door_detection";

export interface Item {
  id: string;
  name: string;
  char: string;
  type: ItemType;
  power: number;
  identified: boolean;
  /** @deprecated prefer buc === "cursed"; kept for back-compat */
  cursed?: boolean;
  /** Bless/uncurse/curse; unknown until ID or harmful discovery. */
  buc?: BucStatus;
  /** Whether the player has discovered BUC (even if type still unknown). */
  bucKnown?: boolean;
  /** Appearance while unidentified: potion color, scroll label, ring material, wand material. */
  appearance?: string;
  /** True potion effect (set at generation). */
  effect?: PotionEffect;
  /** True scroll effect (set at generation). */
  scrollEffect?: ScrollEffect;
  /** True ring effect (set at generation). */
  ringEffect?: RingEffect;
  /** True wand effect (set at generation). */
  wandEffect?: WandEffect;
  /** Remaining charges on a wand (0 = empty). */
  charges?: number;
  /** Corpse source kind (for safety table / sacrifice). */
  corpseKind?: MonsterKind;
  /** True when corpse is never safe to eat (undead etc.). */
  corpseUnsafe?: boolean;
}

export type MonsterKind =
  | "rat"
  | "bat"
  | "snake"
  | "kobold"
  | "goblin"
  | "skeleton"
  | "orc"
  | "wraith"
  | "ogre"
  | "troll"
  | "dragon"
  // ─── Early-depth fauna (d1–5 ecology) ───────────────────────────────────
  /** Weakest tutorial vermin (NetHack newt). */
  | "newt"
  /** Pack electric bugs for dens (NetHack grid bug). */
  | "grid_bug"
  /** Passive plant — fills rooms, low threat (NetHack lichen). */
  | "lichen"
  /** Pack canine scavenger (NetHack jackal). */
  | "jackal"
  // ─── Mid/late NetHack-class threats ────────────────────────────────────
  /** Swarm insect — pack pressure + venom (NetHack bee/ant class). */
  | "killer_bee"
  /** Ambush predator; waits, then surprise strike (NetHack mimic). */
  | "mimic"
  /** Steals inventory / gold on hit (NetHack nymph). */
  | "nymph"
  /** Ranged mind blast + brain drain (NetHack mind flayer class). */
  | "mind_flayer"
  /** Rare unique undead spellcaster (NetHack unique-class threat). */
  | "lich"
  // ─── TICKET-BE-01 (+6 kinds from nethack-concepts §3.4) ────────────────
  /** Pack canine — zoo dens (stronger jackal-class). */
  | "wolf"
  /** Beehive swarm insect (generic colony, weak poison). */
  | "insect"
  /** Gold/item thief — steal trait, low DPS. */
  | "thief"
  /** Acid blob — degrades armor on hit. */
  | "ooze"
  // ─── d1–5 variety wave (DENSITY_COORD bestiary lane) ───────────────────
  /** Tutorial lizard vermin (NetHack gecko-class). */
  | "gecko"
  /** Swarm ant colony — pack dens early (NetHack giant ant). */
  | "giant_ant"
  /** Nymph-class gold thief (NetHack leprechaun). */
  | "leprechaun"
  /** Gaze stun on hit — knowledge/mobility tax (NetHack floating eye). */
  | "floating_eye"
  /** Small pack canine — early hunt pressure (NetHack fox). */
  | "fox";

/** Special combat/AI behaviors carried on entities. */
export type MonsterTrait =
  | "regenerate"
  | "poisonous"
  | "breath"
  | "swift"
  | "undead"
  | "pack"
  | "boss"
  /** NetHack-grade: chance to steal a character level on hit. */
  | "level_drain"
  /** First successful engagement deals surprise bonus damage. */
  | "ambush"
  /** On hit: steal inventory item or gold (nymph/thief-class). */
  | "steal"
  /** Ranged psychic blast (mind flayer-class); ignores half armor. */
  | "mind_blast"
  /** Dense insect/colony AI — hunt farther, pack flanks (with pack). */
  | "swarm"
  /** Named/rare unique: boss enrage eligible, never common trash. */
  | "unique"
  /** Disguised as item glyph until revealed (mimic-class). */
  | "mimic"
  /** On hit: chance to degrade equipped armor power (ooze-class). */
  | "acid"
  /** Summon a minion on cooldown (lich-class). */
  | "summon"
  /** On hit: chance to immobilize (floating eye gaze). */
  | "gaze";

export type StatusKind = "poison";

export interface StatusEffect {
  kind: StatusKind;
  turnsLeft: number;
  power: number;
}

export interface MonsterDef {
  kind: MonsterKind;
  char: string;
  name: string;
  hp: number;
  attack: number;
  defense: number;
  xp: number;
  color: string;
  traits?: MonsterTrait[];
  /** Prefer hunt AI when true. */
  hunt?: boolean;
}

/** Lightweight disguise payload while a mimic pretends to be floor loot. */
export interface MimicDisguise {
  char: string;
  name: string;
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
  traits?: MonsterTrait[];
  /** Boss low-HP phase. */
  enraged?: boolean;
  /** Turns since last breath / special. */
  specialCooldown?: number;
  /**
   * Mimic disguise (TICKET-BE-01 / §3.4). While set, `char`/`color` show the
   * fake item; clear via revealMimic on adjacency or hit.
   */
  hiddenAs?: MimicDisguise;
  /** Real glyph while disguised (restored on reveal). */
  trueChar?: string;
}

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Optional room flavor for generation (vault loot, barracks packs, etc.). */
  special?: RoomSpecial;
  /** Vault sealed to a single door entrance. */
  locked?: boolean;
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

/** Floor traps — hidden until triggered or searched (trap-pressure). */
export type TrapKind = "pit" | "bear" | "teleport" | "poison_needle";

export interface FloorTrap {
  id: string;
  kind: TrapKind;
  x: number;
  y: number;
  /** Visible once triggered or found by search. */
  revealed: boolean;
  /** One-shot traps (bear, poison needle) stop firing after spring. */
  sprung: boolean;
}

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
  equippedRing: Item | null;
  gold: number;
  turns: number;
  depth: number;
  alive: boolean;
  /** Active debuffs (poison, etc.). */
  statuses: StatusEffect[];
  /** How the run ended (for death screen / share). */
  deathCause?: string;
  /** Turns remaining unable to step (bear trap). */
  immobilizedTurns?: number;
  /**
   * Depth on which the player already sat a throne this visit.
   * One sit per player per floor (TICKET-DP-01).
   */
  throneSatDepth?: number;
}

export type GamePhase = "playing" | "inventory" | "dead" | "won";

/** World-events bookkeeping (reinforcements, env, ambient, FOV discovery). */
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

export interface GameState {
  dungeon: Dungeon;
  player: PlayerState;
  monsters: Entity[];
  items: { item: Item; x: number; y: number }[];
  /** Floor traps for this depth (trap-pressure). */
  traps: FloorTrap[];
  explored: boolean[][];
  messages: string[];
  phase: GamePhase;
  seed: number;
  /** @deprecated prefer eventState — kept for back-compat */
  lastWorldEventTurn?: number;
  /** @deprecated prefer eventState */
  eventCooldowns?: Partial<Record<string, number>>;
  /** TICKET-WE-01 mechanical events (reinforce/migration/haunt/pollution). */
  eventBook?: import("./events").FloorEventBook;
  /** Timed reinforcements + environmental events (world-events). */
  eventState?: FloorEventState;
}
