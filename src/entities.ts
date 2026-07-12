import type {
  BucStatus,
  Entity,
  Item,
  MonsterDef,
  MonsterKind,
  MonsterTrait,
  PotionEffect,
  RingEffect,
  ScrollEffect,
  WandEffect,
} from "./types";

let entityCounter = 0;

export function nextId(prefix: string): string {
  return `${prefix}-${++entityCounter}`;
}

/** @internal test helper */
export function resetEntityCounterForTests(): void {
  entityCounter = 0;
}

/**
 * Base monster table — stats are pre-scale (depth multiplies later).
 * Traits drive special combat; hunt flags override default AI.
 */
export const MONSTER_DEFS: Record<MonsterKind, MonsterDef> = {
  rat: {
    kind: "rat",
    char: "r",
    name: "giant rat",
    hp: 5,
    attack: 2,
    defense: 0,
    xp: 5, // cycle1: faster first level so careful play hits L2 before d4 wall
    color: "#8a6a4a",
    traits: ["pack"],
  },
  bat: {
    kind: "bat",
    char: "B",
    name: "bat",
    hp: 4,
    attack: 3,
    defense: 0,
    xp: 6,
    color: "#6a5a7a",
    traits: ["swift"],
    hunt: true,
  },
  snake: {
    kind: "snake",
    char: "S",
    name: "snake",
    hp: 8,
    attack: 4, // was 5 — poison is the real threat (cycle1 analytics)
    defense: 1,
    xp: 12,
    color: "#4a9a4a",
    traits: ["poisonous"],
    hunt: true,
  },
  kobold: {
    kind: "kobold",
    char: "k",
    name: "kobold",
    hp: 9,
    attack: 4,
    defense: 1,
    xp: 10,
    color: "#7a9a5a",
    traits: ["pack"],
  },
  goblin: {
    kind: "goblin",
    char: "g",
    name: "goblin",
    hp: 12,
    attack: 5, // was 6 — hurts, not free one-shots on leather
    defense: 2,
    xp: 16,
    color: "#5a8a4a",
    traits: ["pack"],
    hunt: true,
  },
  skeleton: {
    kind: "skeleton",
    char: "z",
    name: "skeleton",
    hp: 15,
    attack: 6, // was 7
    defense: 4,
    xp: 20,
    color: "#c0c0b0",
    traits: ["undead"],
    hunt: true,
  },
  orc: {
    kind: "orc",
    char: "o",
    name: "orc",
    hp: 18,
    attack: 7, // was 8 — still top early killer, chip not always OS
    defense: 3,
    xp: 28,
    color: "#6a5a4a",
    traits: ["pack"],
    hunt: true,
  },
  wraith: {
    kind: "wraith",
    char: "W",
    name: "wraith",
    hp: 22,
    attack: 9,
    defense: 5,
    xp: 36,
    color: "#7a6aaa",
    traits: ["undead", "poisonous", "level_drain"],
    hunt: true,
  },
  ogre: {
    kind: "ogre",
    char: "O",
    name: "ogre",
    hp: 34,
    attack: 12,
    defense: 4,
    xp: 48,
    color: "#8a5a3a",
    hunt: true,
  },
  troll: {
    kind: "troll",
    char: "T",
    name: "troll",
    hp: 36,
    attack: 11,
    defense: 5,
    xp: 55,
    color: "#4a6a5a",
    traits: ["regenerate"],
    hunt: true,
  },
  dragon: {
    kind: "dragon",
    char: "D",
    name: "dragon",
    hp: 90,
    attack: 14,
    defense: 7,
    xp: 220,
    color: "#c94a4a",
    traits: ["breath", "boss", "regenerate"],
    hunt: true,
  },
  // ─── Early-depth fauna (d1–5 ecology — not just rat/bat/kobold) ────────
  newt: {
    kind: "newt",
    char: ":",
    name: "newt",
    hp: 3,
    attack: 1,
    defense: 0,
    xp: 1,
    color: "#5a9a6a",
    // No pack/hunt — pure tutorial vermin
  },
  grid_bug: {
    kind: "grid_bug",
    char: "x",
    name: "grid bug",
    hp: 4,
    attack: 2,
    defense: 0,
    xp: 4,
    color: "#c060e0",
    traits: ["pack", "swift"],
    hunt: true,
  },
  lichen: {
    kind: "lichen",
    char: "F",
    name: "lichen",
    hp: 8,
    attack: 1,
    defense: 2,
    xp: 2,
    color: "#6a9a4a",
    // Stationary plant — wander only; soaks a hit in dens
    hunt: false,
  },
  jackal: {
    kind: "jackal",
    char: "d",
    name: "jackal",
    hp: 6,
    attack: 3,
    defense: 0,
    xp: 5,
    color: "#b09050",
    traits: ["pack"],
    hunt: true,
  },
  // ─── Mid/late NetHack-class threats ────────────────────────────────────
  killer_bee: {
    kind: "killer_bee",
    char: "a",
    name: "killer bee",
    hp: 6,
    attack: 4,
    defense: 1,
    xp: 8,
    color: "#e8c84a",
    traits: ["pack", "swarm", "poisonous", "swift"],
    hunt: true,
  },
  mimic: {
    kind: "mimic",
    char: "m",
    name: "mimic",
    hp: 22,
    attack: 10,
    defense: 6,
    xp: 40,
    color: "#8a7a5a",
    // mimic disguise + ambush surprise (TICKET-BE-01 / §3.4)
    traits: ["mimic", "ambush"],
    // Wander until revealed — ambush fires on first melee
    hunt: false,
  },
  nymph: {
    kind: "nymph",
    char: "n",
    name: "nymph",
    hp: 14,
    attack: 5,
    defense: 2,
    xp: 28,
    color: "#6ac0c8",
    traits: ["steal", "swift"],
    hunt: true,
  },
  mind_flayer: {
    kind: "mind_flayer",
    char: "h",
    name: "mind flayer",
    hp: 32,
    attack: 10,
    defense: 5,
    xp: 70,
    color: "#9a6aaa",
    traits: ["mind_blast", "level_drain"],
    hunt: true,
  },
  lich: {
    kind: "lich",
    char: "L",
    name: "lich",
    hp: 55,
    attack: 13,
    defense: 7,
    xp: 160,
    color: "#b8d0e8",
    // undead + drain + summon skeleton CD (§3.4 mini-boss)
    traits: ["unique", "boss", "undead", "regenerate", "level_drain", "mind_blast", "summon"],
    hunt: true,
  },
  // ─── TICKET-BE-01 §3.4 kinds ───────────────────────────────────────────
  wolf: {
    kind: "wolf",
    char: "d",
    name: "wolf",
    hp: 12,
    attack: 6,
    defense: 1,
    xp: 12,
    color: "#a09080",
    traits: ["pack"],
    hunt: true,
  },
  insect: {
    kind: "insect",
    char: "a",
    name: "giant insect",
    hp: 7,
    attack: 3,
    defense: 1,
    xp: 7,
    color: "#6a8a3a",
    traits: ["pack", "swarm", "poisonous"],
    hunt: true,
  },
  thief: {
    kind: "thief",
    char: "n",
    name: "thief",
    hp: 10,
    attack: 3,
    defense: 2,
    xp: 18,
    color: "#5a6a7a",
    // Risk without DPS — steal is the threat
    traits: ["steal", "swift"],
    hunt: true,
  },
  ooze: {
    kind: "ooze",
    char: "P",
    name: "acid ooze",
    hp: 24,
    attack: 7,
    defense: 3,
    xp: 36,
    color: "#4aaa4a",
    traits: ["acid", "regenerate"],
    hunt: true,
  },
  // ─── d1–5 variety wave (DENSITY_COORD — more kinds, not reskins) ───────
  gecko: {
    kind: "gecko",
    char: ":",
    name: "gecko",
    hp: 4,
    attack: 2,
    defense: 0,
    xp: 2,
    color: "#7aba5a",
    // Weak tutorial lizard — fills early FOV variety
  },
  giant_ant: {
    kind: "giant_ant",
    char: "a",
    name: "giant ant",
    hp: 6,
    attack: 3,
    defense: 1,
    xp: 6,
    color: "#8a4a2a",
    traits: ["pack", "swarm"],
    hunt: true,
  },
  leprechaun: {
    kind: "leprechaun",
    char: "l",
    name: "leprechaun",
    hp: 8,
    attack: 2,
    defense: 2,
    xp: 16,
    color: "#3aaa5a",
    // Nymph-class: gold-first steal, low DPS
    traits: ["steal", "swift"],
    hunt: true,
  },
  floating_eye: {
    kind: "floating_eye",
    char: "e",
    name: "floating eye",
    hp: 10,
    attack: 1,
    defense: 4,
    xp: 14,
    color: "#6ac0e8",
    // Gaze freezes you — threat is mobility, not damage
    traits: ["gaze"],
    hunt: false,
  },
  fox: {
    kind: "fox",
    char: "d",
    name: "fox",
    hp: 5,
    attack: 3,
    defense: 0,
    xp: 5,
    color: "#c08040",
    traits: ["pack", "swift"],
    hunt: true,
  },
};

/** Fake floor-item glyphs for mimic disguise (not full Item objects). */
const MIMIC_DISGUISES: { char: string; name: string; color: string }[] = [
  { char: ")", name: "short sword", color: "#8a8a4a" },
  { char: "[", name: "leather armor", color: "#8a8a4a" },
  { char: "!", name: "red potion", color: "#8a4a8a" },
  { char: "?", name: "scroll", color: "#8a8a4a" },
  { char: "=", name: "iron ring", color: "#8a8a4a" },
  { char: "/", name: "oak wand", color: "#8a8a4a" },
  { char: "%", name: "ration", color: "#8a8a4a" },
  { char: "$", name: "gold pile", color: "#c9a227" },
];

/**
 * Weighted spawn tables — heavier threats rise with depth.
 *
 * Early ecology (d1–5): newt / grid_bug / lichen / jackal + classic vermin so
 * shallow floors are not "rat/bat/kobold forever". Pack kinds (jackal, grid_bug,
 * rat, kobold, killer_bee) feed spawn-ecology dens.
 *
 * Mid/late (killer_bee→lich) + dragon/lair/abyss identity stay intact.
 * NOTE: depth-1 first weight must remain `rat` (tests pin pickMonsterKind(1,0)).
 */
const DEPTH_TABLES: { maxDepth: number; weights: [MonsterKind, number][] }[] = [
  // d1: tutorial fauna + d1–5 variety wave (rat-first for pickMonsterKind(1,0))
  {
    maxDepth: 1,
    weights: [
      ["rat", 22],
      ["newt", 12],
      ["gecko", 12],
      ["fox", 10],
      ["jackal", 10],
      ["bat", 10],
      ["grid_bug", 8],
      ["giant_ant", 8],
      ["lichen", 6],
      ["kobold", 2],
    ],
  },
  // d2: pack dens + swarm + light nymph-class
  {
    maxDepth: 2,
    weights: [
      ["rat", 12],
      ["fox", 10],
      ["jackal", 10],
      ["giant_ant", 12],
      ["grid_bug", 10],
      ["bat", 10],
      ["gecko", 8],
      ["newt", 8],
      ["kobold", 8],
      ["snake", 6],
      ["killer_bee", 6],
      ["leprechaun", 6],
      ["wolf", 8],
    ],
  },
  // d3: swarm + nymph-class + mimic + eye (mid knowledge tax)
  {
    maxDepth: 3,
    weights: [
      ["kobold", 10],
      ["giant_ant", 10],
      ["jackal", 6],
      ["grid_bug", 6],
      ["snake", 10],
      ["goblin", 10],
      ["bat", 6],
      ["killer_bee", 10],
      ["nymph", 8],
      ["leprechaun", 8],
      ["mimic", 6],
      ["floating_eye", 6],
      ["fox", 6],
      ["wolf", 6],
      ["insect", 6],
      ["thief", 4],
      ["gecko", 4],
      ["lichen", 2],
    ],
  },
  // d4: mid — bees, nymphs, mimics, eyes, swarms
  {
    maxDepth: 4,
    weights: [
      ["goblin", 10],
      ["snake", 8],
      ["kobold", 6],
      ["skeleton", 10],
      ["giant_ant", 8],
      ["killer_bee", 10],
      ["nymph", 10],
      ["leprechaun", 8],
      ["mimic", 10],
      ["floating_eye", 8],
      ["orc", 6],
      ["jackal", 4],
      ["wolf", 6],
      ["insect", 6],
      ["thief", 6],
      ["fox", 4],
    ],
  },
  // d5: humanoids + mid threats still present
  {
    maxDepth: 5,
    weights: [
      ["goblin", 10],
      ["skeleton", 12],
      ["orc", 12],
      ["snake", 4],
      ["wraith", 6],
      ["nymph", 10],
      ["leprechaun", 6],
      ["mimic", 10],
      ["floating_eye", 6],
      ["killer_bee", 10],
      ["giant_ant", 6],
      ["jackal", 2],
      ["kobold", 2],
      ["ooze", 6],
      ["insect", 4],
      ["thief", 6],
      ["wolf", 4],
    ],
  },
  // d6: P0-8 last bee band + mid mimic/nymph still present
  {
    maxDepth: 6,
    weights: [
      ["skeleton", 10],
      ["orc", 16],
      ["wraith", 12],
      ["troll", 8],
      ["ogre", 8],
      ["mimic", 12],
      ["nymph", 10],
      ["killer_bee", 12],
      ["mind_flayer", 8],
      // TICKET-BE-01 appends
      ["ooze", 10],
      ["thief", 6],
      ["insect", 4],
    ],
  },
  {
    maxDepth: 7,
    weights: [
      ["orc", 10],
      ["wraith", 18],
      ["ogre", 18],
      ["troll", 18],
      ["skeleton", 6],
      ["mimic", 8],
      ["mind_flayer", 16],
      ["nymph", 6],
      // TICKET-BE-01 appends
      ["ooze", 8],
    ],
  },
  {
    maxDepth: 8,
    weights: [
      ["wraith", 14],
      ["ogre", 22],
      ["troll", 24],
      ["orc", 6],
      ["dragon", 4],
      ["mind_flayer", 18],
      ["mimic", 8],
      ["lich", 4],
      // TICKET-BE-01 appends
      ["ooze", 6],
    ],
  },
  {
    maxDepth: 9,
    weights: [
      ["ogre", 18],
      ["troll", 24],
      ["wraith", 14],
      ["dragon", 14],
      ["mind_flayer", 18],
      ["lich", 12],
      // TICKET-BE-01 appends
      ["ooze", 4],
    ],
  },
  // Lair (d10) — dragon-heavy but not pure dragon spam
  {
    maxDepth: 10,
    weights: [
      ["troll", 22],
      ["ogre", 16],
      ["wraith", 14],
      ["dragon", 24],
      ["mind_flayer", 12],
      ["lich", 12],
      // TICKET-BE-01 appends (ooze only — no early trash)
      ["ooze", 4],
    ],
  },
  // ——— Abyss (d11–d15): harder than lair; denser elite/dragon + uniques ———
  {
    maxDepth: 11,
    weights: [
      ["troll", 14],
      ["ogre", 10],
      ["wraith", 22],
      ["dragon", 30],
      ["mind_flayer", 12],
      ["lich", 12],
      ["ooze", 4],
    ],
  },
  {
    maxDepth: 12,
    weights: [
      ["troll", 10],
      ["ogre", 8],
      ["wraith", 22],
      ["dragon", 36],
      ["mind_flayer", 12],
      ["lich", 12],
      ["ooze", 3],
    ],
  },
  {
    maxDepth: 13,
    weights: [
      ["troll", 8],
      ["ogre", 5],
      ["wraith", 22],
      ["dragon", 42],
      ["mind_flayer", 10],
      ["lich", 13],
      ["ooze", 3],
    ],
  },
  {
    maxDepth: 14,
    weights: [
      ["troll", 6],
      ["ogre", 4],
      ["wraith", 20],
      ["dragon", 48],
      ["mind_flayer", 8],
      ["lich", 14],
      ["ooze", 2],
    ],
  },
  {
    maxDepth: 15,
    weights: [
      ["troll", 5],
      ["ogre", 3],
      ["wraith", 18],
      ["dragon", 52],
      ["mind_flayer", 8],
      ["lich", 14],
      ["ooze", 2],
    ],
  },
  // Safety net past abyss end (should not spawn in normal play)
  {
    maxDepth: 99,
    weights: [
      ["wraith", 18],
      ["dragon", 55],
      ["troll", 8],
      ["lich", 12],
      ["mind_flayer", 7],
      ["ooze", 2],
    ],
  },
];

export function monstersForDepth(depth: number): MonsterKind[] {
  const table = DEPTH_TABLES.find((t) => depth <= t.maxDepth) ?? DEPTH_TABLES[DEPTH_TABLES.length - 1];
  return table.weights.map(([k]) => k);
}

/** Weighted pick for a depth (use with RNG or Math.random). */
export function pickMonsterKind(depth: number, roll = Math.random()): MonsterKind {
  const table = DEPTH_TABLES.find((t) => depth <= t.maxDepth) ?? DEPTH_TABLES[DEPTH_TABLES.length - 1];
  const total = table.weights.reduce((s, [, w]) => s + w, 0);
  let r = roll * total;
  for (const [kind, w] of table.weights) {
    r -= w;
    if (r <= 0) return kind;
  }
  return table.weights[table.weights.length - 1][0];
}

/**
 * TICKET-SE-01 / nethack-concepts §3.1 absolute floors.
 * d1 ≥ 12; d2–3 ≥ 14; d4–6 ≥ 16.
 */
export function ecologyMonsterFloor(depth: number): number {
  const d = Math.max(1, depth);
  if (d <= 1) return 12;
  if (d <= 3) return 14;
  if (d <= 6) return 16;
  return 10 + Math.floor(d * 1.2);
}

/**
 * §3.1 per-room item pass probability (non-start rooms).
 * p = 0.75 + 0.03*depth, cap 0.95 → ≥75% of rooms get loot in expectation.
 */
export function roomItemPassChance(depth: number): number {
  return Math.min(0.95, 0.75 + 0.03 * Math.max(1, depth));
}

/**
 * Monster count band for a floor.
 * TICKET-SE-01: d1.min ≥ 12; early depths denser per §3.1 table.
 * Does not rewrite abyss tables (depth ≥ 11 uses abyss term only).
 */
export function monsterCountRange(depth: number): { min: number; max: number } {
  const d = Math.max(1, depth);
  const late = d >= 7 ? d : d >= 5 ? Math.floor(d / 2) : 0;
  const abyss = d >= 11 ? 2 + (d - 11) : 0;
  // §3.1 directional earlyBoost (d1–4 denser; FOV always finds life)
  const earlyBoost = d <= 2 ? 6 : d <= 4 ? 4 : d <= 6 ? 2 : 0;
  let min = 10 + Math.floor(d * 1.2) + (d >= 8 ? 2 : 0) + abyss + earlyBoost;
  const max =
    16 + d * 2 + late + (d >= 9 ? 3 : 0) + abyss + (d >= 13 ? 2 : 0) + earlyBoost + (d <= 5 ? 2 : 0);
  // Hard floor — SE-01 ship gate
  min = Math.max(min, ecologyMonsterFloor(d));
  return { min, max: Math.max(max, min + 2) };
}

/**
 * Living-monster floor before reinforcements fire (world-events / depth).
 * Shared by SP game.ts and MMO world.ts.
 */
export function reinforcementThreshold(depth: number): number {
  const band = monsterCountRange(depth);
  return Math.max(5, Math.floor(band.min * 0.5));
}

/** Extra threats near stairs so first FOV isn't empty (d1–5). P0-6 FOV mean ≥3. */
export function foyerThreatCount(depth: number): number {
  if (depth <= 2) return 5;
  if (depth <= 5) return 4;
  return 1;
}

/**
 * Floor-wide free loot count (before special-room clusters).
 * CEO: d1–5 felt empty — dense ground loot so FOV always finds the ID game.
 * Shared by SP (game.ts) and MMO (server/world.ts).
 */
export function itemCountRange(depth: number): { min: number; max: number } {
  const d = Math.max(1, depth);
  // CEO: free loot ≥ ~0.6× monster floor band so corridors are not barren
  const monFloor = ecologyMonsterFloor(d);
  const lootFloor = Math.ceil(monFloor * 0.6);
  // CEO: more ground loot d1–5 so every corridor finds the ID game
  let min: number;
  let max: number;
  if (d <= 2) {
    min = 16;
    max = 26;
  } else if (d <= 5) {
    min = 14;
    max = 20 + d;
  } else if (d <= 8) {
    min = 11;
    max = 16 + Math.floor(d / 2);
  } else if (d <= 10) {
    min = 9;
    max = 14 + Math.floor(d / 3);
  } else {
    // abyss: still loot-rich but not carpeted
    min = 8;
    max = 12 + Math.floor(d / 3);
  }
  min = Math.max(min, lootFloor);
  return { min, max: Math.max(max, min + 2) };
}

/**
 * Extra items scattered into an ordinary / special room.
 * roll ∈ [0,1). Special rooms get guaranteed denser piles.
 */
export function roomLootCount(
  special: string | null | undefined,
  depth: number,
  roll: number
): number {
  const d = Math.max(1, depth);
  if (special === "vault") return d <= 5 ? 5 : 4;
  if (special === "shrine") return d <= 5 ? 3 : 2;
  if (special === "barracks") return d <= 5 ? 3 : 2;
  if (special === "zoo") return d <= 5 ? 2 : 1;
  // Ordinary rooms — early floors almost always leave something
  if (d <= 2) {
    if (roll < 0.5) return 1;
    if (roll < 0.85) return 2;
    if (roll < 0.97) return 3;
    return 1; // never empty on d1–2
  }
  if (d <= 5) {
    if (roll < 0.45) return 1;
    if (roll < 0.8) return 2;
    if (roll < 0.93) return 3;
    return 0;
  }
  if (roll < 0.35) return 1;
  if (roll < 0.5) return 2;
  return 0;
}

/** Prefer gear scraps in barracks, edible junk in zoos, ID bait early.
 * Pass `roll` (and optional `roll2`) from RNG for seed fidelity.
 */
export function roomLootBias(
  special: string | null | undefined,
  depth: number,
  roll = 0.5,
  roll2 = 0.5
): "weapon" | "armor" | "potion" | "food" | "scroll" | "any" {
  if (special === "barracks") return "weapon";
  if (special === "zoo") return "food";
  if (special === "shrine") return "potion";
  if (special === "vault") return "any";
  // Teach the ID game + early sustain (analytics cycle1)
  if (depth <= 3 && roll < 0.62) return roll2 < 0.72 ? "potion" : "scroll";
  if (depth <= 5 && roll < 0.45) return roll2 < 0.55 ? "potion" : "scroll";
  return "any";
}

/** Chance a generated item is cursed — deadly mistakes deepen. */
export function curseChance(depth: number): number {
  // Caps higher past mid-dungeon so ID mistakes punish depth divers.
  return Math.min(0.34, 0.06 + depth * 0.022 + (depth >= 6 ? 0.03 : 0));
}

/**
 * Asymmetric depth scaling: HP climbs faster than attack so late floors
 * become attrition fights, not one-shot lotteries.
 * Depth 8+ gets a second gear so skilled humans/bots still feel the wall.
 *
 * cycle1 analytics: attack scale was too steep d1–5 (orc@d4 ATK~11 one-shotting Lv1).
 * Early attack growth is softer; XP scale is slightly richer so kills pay for levels.
 */
export function depthScale(depth: number): { hp: number; attack: number; defense: number; xp: number } {
  const d = Math.max(0, depth - 1);
  const late = Math.max(0, depth - 7); // 0 until d8
  // Softer ATK ramp through d5; steeper after so midgame still cruel
  const atkPer = depth <= 5 ? 0.07 : 0.11;
  return {
    hp: 1 + d * 0.18 + late * 0.08,
    attack: 1 + d * atkPer + late * 0.05,
    defense: 1 + d * 0.08 + late * 0.04,
    xp: 1 + d * 0.22 + late * 0.06, // richer XP so levels keep pace with depth
  };
}

/** First level XP threshold — cycle1: 20 was too high vs bot kill rates (all died Lv1). */
export const STARTER_XP_TO_LEVEL = 12;

export function createPlayer(x: number, y: number): Entity {
  return {
    id: nextId("player"),
    x,
    y,
    char: "@",
    name: "adventurer",
    hp: 18, // was 16 — buffer vs mean lethal hit ~6.6
    maxHp: 18,
    attack: 4,
    defense: 2,
    xp: 0,
    color: "#c9a227",
    isPlayer: true,
  };
}

export function createMonster(kind: MonsterKind, x: number, y: number, depth: number): Entity {
  const def = MONSTER_DEFS[kind];
  const scale = depthScale(depth);
  const traits: MonsterTrait[] = [...(def.traits ?? [])];
  const hunt =
    def.hunt ||
    traits.includes("boss") ||
    traits.includes("regenerate") ||
    traits.includes("unique") ||
    traits.includes("mind_blast") ||
    traits.includes("summon");
  const entity: Entity = {
    id: nextId("monster"),
    x,
    y,
    char: def.char,
    name: def.name,
    hp: Math.max(1, Math.round(def.hp * scale.hp)),
    maxHp: Math.max(1, Math.round(def.hp * scale.hp)),
    attack: Math.max(1, Math.round(def.attack * scale.attack)),
    defense: Math.max(0, Math.round(def.defense * scale.defense)),
    xp: Math.max(1, Math.round(def.xp * scale.xp)),
    color: def.color,
    isPlayer: false,
    kind,
    ai: hunt ? "hunt" : "wander",
    traits,
    specialCooldown: 0,
  };
  // Unique uniques get a named identity + slightly tougher frame (once per table roll)
  if (traits.includes("unique") && kind === "lich") {
    entity.name = "Azaroth the lich";
    entity.hp = Math.round(entity.hp * 1.15);
    entity.maxHp = entity.hp;
    entity.xp = Math.round(entity.xp * 1.2);
  }
  // Mimic disguise — looks like floor loot until revealed (TICKET-BE-01)
  if (traits.includes("mimic")) {
    const d = MIMIC_DISGUISES[Math.floor(Math.random() * MIMIC_DISGUISES.length)];
    entity.trueChar = def.char;
    entity.hiddenAs = { char: d.char, name: d.name, color: d.color };
    entity.char = d.char;
    entity.color = d.color;
  }
  return entity;
}

/** True if this kind may appear on the given depth's weighted table. */
export function isMonsterEligibleAtDepth(kind: MonsterKind, depth: number): boolean {
  return monstersForDepth(depth).includes(kind);
}

/** All defined monster kinds (for tests / tooling). */
export function allMonsterKinds(): MonsterKind[] {
  return Object.keys(MONSTER_DEFS) as MonsterKind[];
}

// ─── Den helpers (P0-8 beehive + spawn-ecology / algorithms handoff) ─────────

/**
 * Beehive den monster pool — **always** pack-trait swarm kinds.
 * Algorithms / world-events: when `RoomSpecial === "beehive"`, pick from this pool
 * (via `pickBeehiveMonsterKind` or `pickDenMonsterKind("beehive", …)`).
 *
 * P0-8: dens use `killer_bee` (pack+swarm+poisonous); light `insect` filler.
 */
export function beehiveDenMonsterPool(depth: number): MonsterKind[] {
  const d = Math.max(1, depth);
  // Heavier pure-bee dens mid; allow insect filler early/mid
  if (d >= 6) {
    return ["killer_bee", "killer_bee", "killer_bee", "killer_bee", "insect"];
  }
  if (d >= 3) {
    return ["killer_bee", "killer_bee", "killer_bee", "insect", "killer_bee"];
  }
  // Below gate (algos should not place beehive d1–2) — still bees if forced
  return ["killer_bee", "killer_bee", "insect"];
}

/** Weighted pick from {@link beehiveDenMonsterPool}. roll ∈ [0, 1). */
export function pickBeehiveMonsterKind(depth: number, roll = Math.random()): MonsterKind {
  const pool = beehiveDenMonsterPool(depth);
  const idx = Math.min(pool.length - 1, Math.floor(Math.max(0, roll) * pool.length));
  return pool[idx] ?? "killer_bee";
}

/**
 * Assert den kind is pack-capable for dens pressure.
 * Beehive/zoo dens should only use pack (or swarm) monsters.
 */
export function isPackDenKind(kind: MonsterKind): boolean {
  const t = MONSTER_DEFS[kind]?.traits ?? [];
  return t.includes("pack") || t.includes("swarm");
}

/** Guaranteed boss dragon for depth 10 — tougher than a random table spawn. */
export function createBossDragon(x: number, y: number, depth: number): Entity {
  const d = createMonster("dragon", x, y, depth);
  d.name = "ancient dragon";
  d.hp = Math.round(d.hp * 1.25);
  d.maxHp = d.hp;
  d.attack = Math.round(d.attack * 1.1);
  d.defense = Math.round(d.defense * 1.15);
  d.xp = Math.round(d.xp * 1.35);
  d.traits = ["breath", "boss", "regenerate"];
  d.ai = "hunt";
  return d;
}

export function createStarterItems(): Item[] {
  return [
    {
      id: nextId("item"),
      name: "dagger",
      char: ")",
      type: "weapon",
      power: 3,
      identified: true,
      buc: "uncursed",
      bucKnown: true,
    },
    {
      id: nextId("item"),
      name: "leather armor",
      char: "[",
      type: "armor",
      power: 3, // was 2 — starter DEF 5 so orcs chip, not always OS
      identified: true,
      buc: "uncursed",
      bucKnown: true,
    },
    {
      id: nextId("item"),
      name: "ration",
      char: "%",
      type: "food",
      power: 400,
      identified: true,
      buc: "uncursed",
      bucKnown: true,
    },
  ];
}

/** Appearance labels for unidentified potions. */
export const POTION_APPEARANCES = [
  "red",
  "blue",
  "green",
  "purple",
  "amber",
  "milky",
  "fizzy",
  "inky",
] as const;

export const POTION_EFFECTS: PotionEffect[] = [
  "healing",
  "extra_healing",
  "poison",
  "strength",
  "nutrition",
  "speed",
  "invisibility",
];

export const POTION_TRUE_NAMES: Record<PotionEffect, string> = {
  healing: "potion of healing",
  extra_healing: "potion of extra healing",
  poison: "potion of poison",
  strength: "potion of strength",
  nutrition: "potion of nutrition",
  speed: "potion of speed",
  invisibility: "potion of invisibility",
};

/** NetHack-style gibberish scroll labels (appearance while unidentified). */
export const SCROLL_LABELS = [
  "FOOBIE BLETCH",
  "ZELGO MER",
  "JUYED AWK YACC",
  "NR 9",
  "XIXAXA XOXAXA XUXAXA",
  "PRATYAVAYAH",
  "DAIYEN FOOELS",
  "ELBIB YLOH",
  "VERR YED HORRE",
  "VENZAR BORGAVVE",
  "THARR",
  "YUM YUM",
] as const;

export const SCROLL_EFFECTS: ScrollEffect[] = [
  "identify",
  "teleport",
  "enchant_weapon",
  "magic_mapping",
  "fire",
  "amnesia",
  "create_monster",
  "remove_curse",
];

export const SCROLL_TRUE_NAMES: Record<ScrollEffect, string> = {
  identify: "scroll of identify",
  teleport: "scroll of teleportation",
  enchant_weapon: "scroll of enchant weapon",
  magic_mapping: "scroll of magic mapping",
  fire: "scroll of fire",
  amnesia: "scroll of amnesia",
  create_monster: "scroll of create monster",
  remove_curse: "scroll of remove curse",
};

/** Ring materials / gem looks while unidentified. */
export const RING_APPEARANCES = [
  "wooden",
  "silver",
  "gold",
  "iron",
  "copper",
  "opal",
  "moonstone",
  "jade",
  "granite",
  "ivory",
] as const;

export const RING_EFFECTS: RingEffect[] = [
  "protection",
  "regeneration",
  "sustain_ability",
  "searching",
  "stealth",
  "hunger",
  "aggravate",
  "adornment",
];

export const RING_TRUE_NAMES: Record<RingEffect, string> = {
  protection: "ring of protection",
  regeneration: "ring of regeneration",
  sustain_ability: "ring of sustain ability",
  searching: "ring of searching",
  stealth: "ring of stealth",
  hunger: "ring of hunger",
  aggravate: "ring of aggravate monster",
  adornment: "ring of adornment",
};

/** Wand materials while unidentified (NetHack-style appearance labels). */
export const WAND_APPEARANCES = [
  "glass",
  "balsa",
  "crystal",
  "maple",
  "pine",
  "oak",
  "ebony",
  "marble",
  "tin",
  "brass",
  "copper",
  "silver",
] as const;

export const WAND_EFFECTS: WandEffect[] = [
  "light",
  "digging",
  "striking",
  "cold",
  "sleep",
  "nothing",
  "polymorph",
  "secret_door_detection",
];

export const WAND_TRUE_NAMES: Record<WandEffect, string> = {
  light: "wand of light",
  digging: "wand of digging",
  striking: "wand of striking",
  cold: "wand of cold",
  sleep: "wand of sleep",
  nothing: "wand of nothing",
  polymorph: "wand of polymorph",
  secret_door_detection: "wand of secret door detection",
};

/** Fisher–Yates shuffle with salt so potion/scroll/ring/wand maps don't collide. */
function seededShuffle<T>(items: T[], seed: number, salt: number): T[] {
  let s = ((seed >>> 0) ^ (salt >>> 0) || 1) >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function mapAppearancesToEffects<A extends string, E>(
  appearances: readonly A[],
  effects: E[],
  seed: number,
  salt: number
): Map<A, E> {
  const shuffled = seededShuffle(effects, seed, salt);
  const map = new Map<A, E>();
  appearances.forEach((app, i) => {
    map.set(app, shuffled[i % shuffled.length]);
  });
  return map;
}

/**
 * Deterministic appearance → effect mapping for a game/world seed.
 * Once you identify a red potion as healing, every red potion is healing.
 */
export function potionMapForSeed(seed: number): Map<string, PotionEffect> {
  return mapAppearancesToEffects(POTION_APPEARANCES, [...POTION_EFFECTS], seed, 0x504f54);
}

/** Label → scroll effect for this world seed. */
export function scrollMapForSeed(seed: number): Map<string, ScrollEffect> {
  return mapAppearancesToEffects(SCROLL_LABELS, [...SCROLL_EFFECTS], seed, 0x534352);
}

/** Material → ring effect for this world seed. */
export function ringMapForSeed(seed: number): Map<string, RingEffect> {
  return mapAppearancesToEffects(RING_APPEARANCES, [...RING_EFFECTS], seed, 0x524e47);
}

/** Material → wand effect for this world seed. */
export function wandMapForSeed(seed: number): Map<string, WandEffect> {
  return mapAppearancesToEffects(WAND_APPEARANCES, [...WAND_EFFECTS], seed, 0x57414e);
}

/** Depth-weighted BUC roll: deeper floors skew slightly more cursed. */
export function rollBuc(depth: number, rng = Math.random): BucStatus {
  const curseBias = Math.min(0.12, depth * 0.012);
  const r = rng();
  if (r < 0.06) return "blessed";
  if (r < 0.12 + curseBias) return "cursed";
  return "uncursed";
}

function applyBuc(item: Item, buc: BucStatus): Item {
  item.buc = buc;
  item.cursed = buc === "cursed";
  item.bucKnown = false;
  if (buc === "blessed") item.power = Math.max(1, item.power + 1);
  if (buc === "cursed" && (item.type === "weapon" || item.type === "armor" || item.type === "ring")) {
    item.power = Math.max(0, item.power - 1);
  }
  return item;
}

/** Depth-aware type weights — NetHack-ish loot pressure. */
export function itemTypeWeights(depth: number): { type: Item["type"]; w: number }[] {
  const d = Math.max(1, depth);
  // d1–5: flood potions/scrolls/food so the ID game starts immediately
  // analytics cycle1: d1–3 bots die with zero sustain — overweight potions hard
  const earlyId = d <= 5 ? 1 : 0;
  const earlyHeal = d <= 3 ? 1 : 0;
  return [
    { type: "weapon", w: 16 + (d <= 3 ? 2 : 0) },
    { type: "armor", w: 12 },
    { type: "potion", w: 22 + Math.min(10, d) + earlyId * 8 + earlyHeal * 14 },
    { type: "food", w: Math.max(10, 24 - d) + earlyId * 4 + earlyHeal * 6 },
    { type: "scroll", w: 14 + Math.min(10, d) + earlyId * 6 },
    { type: "ring", w: 3 + Math.min(10, Math.floor(d / 2)) },
    { type: "wand", w: 2 + Math.min(8, Math.floor(d / 2)) + (d <= 5 ? 2 : 0) },
  ];
}

/** Appearances that map to a given effect for this world seed. */
export function appearancesForPotionEffect(seed: number, effect: PotionEffect): string[] {
  const map = potionMapForSeed(seed);
  return [...map.entries()].filter(([, e]) => e === effect).map(([a]) => a);
}

/**
 * Pick potion appearance for depth. Keeps seed→effect fidelity (true ID game)
 * but on d1–3 heavily prefers appearances that *are* healing for this seed
 * so skilled players can learn under pressure without pure junk tables.
 */
export function pickPotionAppearanceForDepth(
  depth: number,
  seed: number,
  rng: () => number = Math.random
): string {
  const map = potionMapForSeed(seed);
  const appsFor = (...effects: PotionEffect[]) =>
    [...map.entries()].filter(([, e]) => effects.includes(e)).map(([a]) => a);
  const healing = appsFor("healing", "extra_healing");
  const sustain = appsFor("healing", "extra_healing", "nutrition", "strength", "speed");
  const all = [...POTION_APPEARANCES];
  const pick = (arr: string[]) => arr[Math.floor(rng() * arr.length)] ?? all[0];

  const r = rng();
  if (depth <= 3) {
    // ~62% healing family, ~23% other sustain, ~15% full roulette (poison risk)
    if (r < 0.62 && healing.length) return pick(healing);
    if (r < 0.85 && sustain.length) return pick(sustain);
    return pick(all);
  }
  if (depth <= 5) {
    if (r < 0.42 && healing.length) return pick(healing);
    if (r < 0.72 && sustain.length) return pick(sustain);
    return pick(all);
  }
  return pick(all);
}

/** Minimum guaranteed healing potions on a floor (analytics: early sustain). */
export function minHealingPotionsForDepth(depth: number): number {
  if (depth <= 1) return 3;
  if (depth <= 2) return 2;
  if (depth <= 3) return 2;
  if (depth <= 5) return 1;
  return 0;
}

export function isHealingPotion(item: Item): boolean {
  return (
    item.type === "potion" &&
    (item.effect === "healing" || item.effect === "extra_healing")
  );
}

export function countHealingPotionsOnFloor(
  items: { item: Item }[] | Item[]
): number {
  let n = 0;
  for (const entry of items) {
    const it = "item" in entry ? entry.item : entry;
    if (isHealingPotion(it)) n++;
  }
  return n;
}

/**
 * Unidentified healing potion for the seed's true color map.
 * Uncursed so early sustain is learnable under pressure (not a curse trap).
 */
export function generateHealingPotion(
  depth: number,
  id: string,
  seed: number,
  preferExtra = false
): Item {
  const map = potionMapForSeed(seed);
  const want: PotionEffect = preferExtra ? "extra_healing" : "healing";
  let apps = appearancesForPotionEffect(seed, want);
  if (!apps.length) apps = appearancesForPotionEffect(seed, "healing");
  if (!apps.length) apps = appearancesForPotionEffect(seed, "extra_healing");
  const app = apps[0] ?? [...map.keys()][0] ?? "red";
  const pot = generatePotion(depth, id, seed, app, "uncursed");
  // Slightly stronger early draughts so risk/reward saves skilled players
  if (depth <= 3) pot.power = Math.max(pot.power, 10 + depth * 2);
  return pot;
}

/**
 * Generate an item with optional type bias (room ecology / ID teaching).
 * bias "any" uses normal weighted tables.
 */
export function generateItemBiased(
  depth: number,
  id: string,
  seed: number,
  bias: "weapon" | "armor" | "potion" | "food" | "scroll" | "any" = "any"
): Item {
  if (bias === "any") return generateItem(depth, id, seed);
  // Retry a few times for the preferred type; fall back to generateItem
  for (let i = 0; i < 12; i++) {
    const it = generateItem(depth, `${id}-b${i}`, seed);
    if (it.type === bias) {
      it.id = id;
      return it;
    }
  }
  // Forced factories for teachable types
  if (bias === "potion") return generatePotion(depth, id, seed);
  if (bias === "scroll") return generateScroll(depth, id, seed);
  if (bias === "food") {
    return {
      id,
      name: "ration",
      char: "%",
      type: "food",
      power: Math.max(180, 320 - depth * 12) + depth * 30,
      identified: true,
      buc: "uncursed",
      bucKnown: true,
    };
  }
  if (bias === "weapon") {
    const it = generateItem(depth, id, seed);
    // last resort: accept whatever if table is unlucky
    return it;
  }
  return generateItem(depth, id, seed);
}

function pickWeightedType(depth: number): Item["type"] {
  const weights = itemTypeWeights(depth);
  const total = weights.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const row of weights) {
    r -= row.w;
    if (r <= 0) return row.type;
  }
  return "food";
}

function makeWeapon(depth: number, id: string, buc: BucStatus): Item {
  const weapons = ["dagger", "short sword", "long sword", "mace", "war hammer", "battle axe"];
  const powers = [3, 5, 8, 6, 9, 11];
  const idx = Math.min(Math.max(0, depth - 1), weapons.length - 1);
  const i = Math.floor(Math.random() * (idx + 1));
  return applyBuc(
    {
      id,
      name: weapons[i],
      char: ")",
      type: "weapon",
      power: powers[i] + Math.floor(depth / 2),
      identified: false,
    },
    buc
  );
}

function makeArmor(depth: number, id: string, buc: BucStatus): Item {
  const armors = ["leather armor", "ring mail", "scale mail", "chain mail", "plate mail"];
  const powers = [2, 4, 6, 8, 11];
  const idx = Math.min(Math.max(0, depth - 1), armors.length - 1);
  const i = Math.floor(Math.random() * (idx + 1));
  return applyBuc(
    {
      id,
      name: armors[i],
      char: "[",
      type: "armor",
      power: powers[i] + Math.floor(depth / 3),
      identified: false,
    },
    buc
  );
}

function makePotion(depth: number, id: string, seed: number, buc: BucStatus): Item {
  const map = potionMapForSeed(seed);
  const appearance = pickPotionAppearanceForDepth(depth, seed);
  const effect = map.get(appearance) ?? "healing";
  // Early healing-biased pots: prefer uncursed so first learn isn't a curse death
  let effectiveBuc = buc;
  if (depth <= 3 && (effect === "healing" || effect === "extra_healing") && buc === "cursed") {
    effectiveBuc = Math.random() < 0.75 ? "uncursed" : buc;
  }
  return applyBuc(
    {
      id,
      name: `${appearance} potion`,
      char: "!",
      type: "potion",
      power: 8 + depth * 2 + (depth <= 3 && effect === "healing" ? 2 : 0),
      identified: false,
      appearance,
      effect,
    },
    effectiveBuc
  );
}

function makeScroll(depth: number, id: string, seed: number, buc: BucStatus): Item {
  const map = scrollMapForSeed(seed);
  const labels = [...SCROLL_LABELS];
  let label: string = labels[Math.floor(Math.random() * labels.length)];
  let effect = map.get(label) ?? "identify";

  // Early floors: bias toward identify; deep floors: more risk scrolls
  if (depth <= 3 && Math.random() < 0.4) {
    effect = "identify";
    for (const [lab, eff] of map) {
      if (eff === "identify") {
        label = lab;
        break;
      }
    }
  } else if (depth >= 7 && Math.random() < 0.22) {
    const risky: ScrollEffect[] = ["fire", "amnesia", "create_monster"];
    effect = risky[Math.floor(Math.random() * risky.length)];
    for (const [lab, eff] of map) {
      if (eff === effect) {
        label = lab;
        break;
      }
    }
  } else if (depth >= 6 && Math.random() < 0.2) {
    effect = "remove_curse";
    for (const [lab, eff] of map) {
      if (eff === "remove_curse") {
        label = lab;
        break;
      }
    }
  }

  return applyBuc(
    {
      id,
      name: `scroll labeled ${label}`,
      char: "?",
      type: "scroll",
      power: 1 + Math.floor(depth / 4),
      identified: false,
      appearance: label,
      scrollEffect: effect,
    },
    buc
  );
}

function makeRing(depth: number, id: string, seed: number, buc: BucStatus): Item {
  const map = ringMapForSeed(seed);
  const appearance = RING_APPEARANCES[Math.floor(Math.random() * RING_APPEARANCES.length)];
  const ringEffect = map.get(appearance) ?? "adornment";
  return applyBuc(
    {
      id,
      name: `${appearance} ring`,
      char: "=",
      type: "ring",
      power: 1 + Math.floor(depth / 3),
      identified: false,
      appearance,
      ringEffect,
    },
    buc
  );
}

/** Charges scale slightly with depth; always in 1–8 (empty only after zapping). */
function rollWandCharges(depth: number): number {
  const base = 1 + Math.floor(Math.random() * 6); // 1–6
  const bonus = depth >= 6 ? 1 : 0;
  return Math.min(8, Math.max(1, base + bonus + (Math.random() < 0.15 ? 1 : 0)));
}

function makeWand(depth: number, id: string, seed: number, buc: BucStatus): Item {
  const map = wandMapForSeed(seed);
  const appearance = WAND_APPEARANCES[Math.floor(Math.random() * WAND_APPEARANCES.length)];
  const wandEffect = map.get(appearance) ?? "nothing";
  const charges = rollWandCharges(depth);
  return applyBuc(
    {
      id,
      name: `${appearance} wand`,
      char: "/",
      type: "wand",
      power: 4 + Math.floor(depth / 2),
      identified: false,
      appearance,
      wandEffect,
      charges,
    },
    buc
  );
}

export function generateItem(depth: number, id: string, seed = 1): Item {
  const buc = rollBuc(depth);
  // Merge legacy curseChance with BUC (depth team helper still used by spawns)
  const kind = pickWeightedType(depth);
  switch (kind) {
    case "weapon":
      return makeWeapon(depth, id, buc);
    case "armor":
      return makeArmor(depth, id, buc);
    case "potion":
      return makePotion(depth, id, seed, buc);
    case "scroll":
      return makeScroll(depth, id, seed, buc);
    case "ring":
      return makeRing(depth, id, seed, buc);
    case "wand":
      return makeWand(depth, id, seed, buc);
    case "food":
    default: {
      const base = Math.max(180, 320 - depth * 12);
      return {
        id,
        name: "ration",
        char: "%",
        type: "food",
        power: base + depth * 30,
        identified: true,
        buc: "uncursed",
        bucKnown: true,
      };
    }
  }
}

/** Explicit factories for tests / shrine spawns. */
export function generatePotion(
  depth: number,
  id: string,
  seed: number,
  appearance?: string,
  buc: BucStatus = "uncursed"
): Item {
  const map = potionMapForSeed(seed);
  const app = appearance ?? pickPotionAppearanceForDepth(depth, seed);
  const effect = map.get(app) ?? "healing";
  return applyBuc(
    {
      id,
      name: `${app} potion`,
      char: "!",
      type: "potion",
      power: 8 + depth * 2 + (depth <= 3 && effect === "healing" ? 2 : 0),
      identified: false,
      appearance: app,
      effect,
    },
    buc
  );
}

export function generateScroll(
  depth: number,
  id: string,
  seed: number,
  label?: string,
  buc: BucStatus = "uncursed"
): Item {
  const map = scrollMapForSeed(seed);
  const lab = label ?? SCROLL_LABELS[Math.floor(Math.random() * SCROLL_LABELS.length)];
  const effect = map.get(lab) ?? "identify";
  return applyBuc(
    {
      id,
      name: `scroll labeled ${lab}`,
      char: "?",
      type: "scroll",
      power: 1 + Math.floor(depth / 4),
      identified: false,
      appearance: lab,
      scrollEffect: effect,
    },
    buc
  );
}

export function generateRing(
  depth: number,
  id: string,
  seed: number,
  appearance?: string,
  buc: BucStatus = "uncursed"
): Item {
  const map = ringMapForSeed(seed);
  const app =
    appearance ?? RING_APPEARANCES[Math.floor(Math.random() * RING_APPEARANCES.length)];
  const ringEffect = map.get(app) ?? "adornment";
  return applyBuc(
    {
      id,
      name: `${app} ring`,
      char: "=",
      type: "ring",
      power: 1 + Math.floor(depth / 3),
      identified: false,
      appearance: app,
      ringEffect,
    },
    buc
  );
}

export function generateWand(
  depth: number,
  id: string,
  seed: number,
  appearance?: string,
  buc: BucStatus = "uncursed",
  charges?: number
): Item {
  const map = wandMapForSeed(seed);
  const app =
    appearance ?? WAND_APPEARANCES[Math.floor(Math.random() * WAND_APPEARANCES.length)];
  const wandEffect = map.get(app) ?? "nothing";
  const ch = charges ?? rollWandCharges(depth);
  return applyBuc(
    {
      id,
      name: `${app} wand`,
      char: "/",
      type: "wand",
      power: 4 + Math.floor(depth / 2),
      identified: false,
      appearance: app,
      wandEffect,
      charges: Math.max(0, Math.min(8, ch)),
    },
    buc
  );
}

/**
 * Corpse ecology (TICKET-DP-01 / NetHack-inspired safety table).
 *
 * SAFE-ish (still 18% rot risk when hungry/weak elevated):
 *   rat, bat, snake, kobold, goblin, orc, ogre, troll, newt, grid_bug,
 *   lichen, jackal, killer_bee, mimic, nymph, mind_flayer, dragon (risky nutrition only)
 *
 * NEVER SAFE (always poison / HP loss on eat):
 *   Any kind with `undead` trait, or kinds: skeleton, wraith, lich
 *
 * Note: dragon/troll are "safe" for undead check but still subject to rot RNG —
 * cruelty stays in combat eat path.
 */
export const UNSAFE_CORPSE_KINDS: ReadonlySet<MonsterKind> = new Set([
  "skeleton",
  "wraith",
  "lich",
]);

export function isUndeadSource(
  kind?: MonsterKind,
  traits?: MonsterTrait[]
): boolean {
  if (kind && UNSAFE_CORPSE_KINDS.has(kind)) return true;
  if (traits?.includes("undead")) return true;
  if (kind && MONSTER_DEFS[kind]?.traits?.includes("undead")) return true;
  return false;
}

export function isCorpseItem(item: Item): boolean {
  return item.type === "food" && (item.name.includes("corpse") || !!item.corpseKind || !!item.corpseUnsafe);
}

/** True when eating this food is guaranteed harmful (undead / flagged). */
export function corpseIsUnsafe(item: Item): boolean {
  if (!isCorpseItem(item)) return false;
  if (item.corpseUnsafe) return true;
  if (item.corpseKind && isUndeadSource(item.corpseKind)) return true;
  // Name fallback for legacy corpses
  const n = item.name.toLowerCase();
  if (n.includes("skeleton") || n.includes("wraith") || n.includes("lich")) return true;
  return false;
}

/** Inverse of unsafe — still may rot; only means "not undead poison guaranteed". */
export function corpseIsSafeToEat(item: Item): boolean {
  if (!isCorpseItem(item)) return true; // rations etc.
  return !corpseIsUnsafe(item);
}

/**
 * Fresh corpse food from a slain monster.
 * Pass kind/traits so undead corpses are marked unsafe.
 */
export function makeCorpse(
  monsterName: string,
  id: string,
  opts?: { kind?: MonsterKind; traits?: MonsterTrait[] }
): Item {
  const kind = opts?.kind;
  const traits = opts?.traits ?? (kind ? MONSTER_DEFS[kind]?.traits : undefined);
  const unsafe = isUndeadSource(kind, traits);
  const basePower = unsafe
    ? 80 + Math.floor(Math.random() * 40) // less nutrition, still tempting
    : 160 + Math.floor(Math.random() * 90);
  return {
    id,
    name: `${monsterName} corpse`,
    char: "%",
    type: "food",
    power: basePower,
    identified: true,
    buc: "uncursed",
    bucKnown: true,
    corpseKind: kind,
    corpseUnsafe: unsafe,
  };
}

function bucPrefix(item: Item): string {
  if (!item.bucKnown || !item.buc || item.buc === "uncursed") return "";
  return `${item.buc} `;
}

export function itemDisplayName(item: Item): string {
  const buc = bucPrefix(item);

  if (item.type === "potion") {
    if (item.identified && item.effect) return `${buc}${POTION_TRUE_NAMES[item.effect]}`;
    if (item.appearance) return `${buc}${item.appearance} potion`;
    return `${buc}unidentified potion`;
  }

  if (item.type === "scroll") {
    if (item.identified && item.scrollEffect) {
      return `${buc}${SCROLL_TRUE_NAMES[item.scrollEffect]}`;
    }
    if (item.appearance) return `${buc}scroll labeled ${item.appearance}`;
    return `${buc}unidentified scroll`;
  }

  if (item.type === "ring") {
    if (item.identified && item.ringEffect) {
      return `${buc}${RING_TRUE_NAMES[item.ringEffect]}`;
    }
    if (item.appearance) return `${buc}${item.appearance} ring`;
    return `${buc}unidentified ring`;
  }

  if (item.type === "wand") {
    const charges =
      item.identified && item.charges !== undefined
        ? item.charges === 0
          ? " (0 charges)"
          : ` (${item.charges} charge${item.charges === 1 ? "" : "s"})`
        : "";
    if (item.identified && item.wandEffect) {
      return `${buc}${WAND_TRUE_NAMES[item.wandEffect]}${charges}`;
    }
    if (item.appearance) return `${buc}${item.appearance} wand`;
    return `${buc}unidentified wand`;
  }

  if (item.identified) {
    if (item.type === "weapon") {
      return `${buc}${item.name} (+${item.power} atk)`;
    }
    if (item.type === "armor") {
      return `${buc}${item.name} (+${item.power} def)`;
    }
    return `${buc}${item.name}`;
  }

  const unknown: Record<string, string> = {
    weapon: "weapon",
    armor: "armor",
    potion: "potion",
    food: "food",
    scroll: "scroll",
    ring: "ring",
    wand: "wand",
  };
  return `${buc}unidentified ${unknown[item.type] ?? "item"}`;
}

/** Fully reveal type + BUC (scroll of identify / formal ID). */
export function fullyIdentify(item: Item): void {
  item.identified = true;
  item.bucKnown = true;
  if (!item.buc) item.buc = item.cursed ? "cursed" : "uncursed";
  item.cursed = item.buc === "cursed";
  if (item.type === "potion" && item.effect) {
    item.name = POTION_TRUE_NAMES[item.effect];
  } else if (item.type === "scroll" && item.scrollEffect) {
    item.name = SCROLL_TRUE_NAMES[item.scrollEffect];
  } else if (item.type === "ring" && item.ringEffect) {
    item.name = RING_TRUE_NAMES[item.ringEffect];
  } else if (item.type === "wand" && item.wandEffect) {
    item.name = WAND_TRUE_NAMES[item.wandEffect];
  }
}

/** Flavor line when first arriving on a depth. */
export function depthFlavor(depth: number): string {
  const lines: Record<number, string> = {
    1: "The air smells of damp stone and old blood.",
    2: "You hear distant scurrying in the dark.",
    3: "Torch-soot blackens the low ceiling. Snakes nest here.",
    4: "A cold draft whispers from deeper tunnels.",
    5: "The walls are carved with forgotten runes. Undead stir.",
    6: "Something large has scraped these corridors.",
    7: "Bones crunch underfoot. Wraiths hunger for warmth.",
    8: "The heat rises. Something below is breathing fire.",
    9: "A low growl vibrates through the bedrock. Ogres and trolls rule.",
    10: "This is the lair. The ancient dragon waits.",
    // Abyss — post-dragon true-ending branch (depths 11–15)
    11: "The abyss opens. Air turns thin and wrong. Stairs behind you feel like a rumor.",
    12: "Black stone drinks the light. Packs of dragons and wraiths own these galleries.",
    13: "Your torch gutters blue. The floor remembers older hunters than you.",
    14: "Heat and frost braid together. Only the cruelest things still hunt here.",
    15: "The bottom of the abyss. One last descent seals the true ending.",
  };
  if (depth > 15) return `Depth ${depth}: past the abyss end, only void remains.`;
  return lines[depth] ?? `Depth ${depth} stretches into darkness.`;
}

/** Combat verb helper for weapon flavor. */
export function weaponVerb(weaponName: string | null | undefined): string {
  if (!weaponName) return "strike";
  const n = weaponName.toLowerCase();
  if (n.includes("dagger") || n.includes("sword")) return "slash";
  if (n.includes("mace") || n.includes("hammer")) return "crush";
  if (n.includes("axe")) return "cleave";
  return "strike";
}

/** Hunger drain per turn — escalates with depth (mid/late game pressure). */
export function hungerPerTurn(depth: number): number {
  // Extra tick past depth 6 so food economy matters for dragon approach.
  // Abyss tax: food pressure past the lair so post-dragon is not free.
  return (
    2 +
    Math.floor(Math.max(0, depth - 1) / 3) +
    (depth >= 6 ? 1 : 0) +
    (depth >= 9 ? 1 : 0) +
    (depth >= 11 ? 1 : 0) +
    (depth >= 14 ? 1 : 0)
  );
}
