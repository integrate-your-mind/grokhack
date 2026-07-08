import type { Entity, Item, MonsterDef, MonsterKind } from "./types";

let entityCounter = 0;

export function nextId(prefix: string): string {
  return `${prefix}-${++entityCounter}`;
}

export const MONSTER_DEFS: Record<MonsterKind, MonsterDef> = {
  rat: { kind: "rat", char: "r", name: "giant rat", hp: 4, attack: 2, defense: 0, xp: 3, color: "#8a6a4a" },
  kobold: { kind: "kobold", char: "k", name: "kobold", hp: 8, attack: 4, defense: 1, xp: 8, color: "#7a9a5a" },
  goblin: { kind: "goblin", char: "g", name: "goblin", hp: 12, attack: 5, defense: 2, xp: 12, color: "#5a8a4a" },
  orc: { kind: "orc", char: "o", name: "orc", hp: 18, attack: 7, defense: 3, xp: 20, color: "#6a5a4a" },
  troll: { kind: "troll", char: "T", name: "troll", hp: 30, attack: 10, defense: 5, xp: 40, color: "#4a6a5a" },
  dragon: { kind: "dragon", char: "D", name: "dragon", hp: 60, attack: 18, defense: 8, xp: 150, color: "#c94a4a" },
};

export function monstersForDepth(depth: number): MonsterKind[] {
  if (depth <= 2) return ["rat", "kobold"];
  if (depth <= 4) return ["rat", "kobold", "goblin"];
  if (depth <= 6) return ["kobold", "goblin", "orc"];
  if (depth <= 8) return ["goblin", "orc", "troll"];
  return ["orc", "troll", "dragon"];
}

export function createPlayer(x: number, y: number): Entity {
  return {
    id: nextId("player"),
    x,
    y,
    char: "@",
    name: "adventurer",
    hp: 16,
    maxHp: 16,
    attack: 4,
    defense: 2,
    xp: 0,
    color: "#c9a227",
    isPlayer: true,
  };
}

export function createMonster(kind: MonsterKind, x: number, y: number, depth: number): Entity {
  const def = MONSTER_DEFS[kind];
  const scale = 1 + (depth - 1) * 0.15;
  return {
    id: nextId("monster"),
    x,
    y,
    char: def.char,
    name: def.name,
    hp: Math.round(def.hp * scale),
    maxHp: Math.round(def.hp * scale),
    attack: Math.round(def.attack * scale),
    defense: Math.round(def.defense * scale),
    xp: Math.round(def.xp * scale),
    color: def.color,
    isPlayer: false,
    kind,
    ai: kind === "dragon" || kind === "troll" ? "hunt" : "wander",
  };
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
    },
    {
      id: nextId("item"),
      name: "leather armor",
      char: "[",
      type: "armor",
      power: 2,
      identified: true,
    },
    {
      id: nextId("item"),
      name: "ration",
      char: "%",
      type: "food",
      power: 400,
      identified: true,
    },
  ];
}

export function generateItem(depth: number, id: string): Item {
  const roll = Math.random();
  if (roll < 0.25) {
    const weapons = ["dagger", "short sword", "long sword", "mace", "war hammer"];
    const powers = [3, 5, 8, 6, 9];
    const idx = Math.min(depth - 1, weapons.length - 1);
    const i = Math.floor(Math.random() * (idx + 1));
    return { id, name: weapons[i], char: ")", type: "weapon", power: powers[i] + depth, identified: false };
  }
  if (roll < 0.4) {
    const armors = ["leather armor", "ring mail", "scale mail", "plate mail"];
    const powers = [2, 4, 6, 9];
    const idx = Math.min(depth - 1, armors.length - 1);
    const i = Math.floor(Math.random() * (idx + 1));
    return { id, name: armors[i], char: "[", type: "armor", power: powers[i] + Math.floor(depth / 2), identified: false };
  }
  if (roll < 0.65) {
    const types = ["red", "blue", "green", "purple"];
    const t = types[Math.floor(Math.random() * types.length)];
    return { id, name: `${t} potion`, char: "!", type: "potion", power: 8 + depth * 2, identified: false };
  }
  if (roll < 0.85) {
    return { id, name: "ration", char: "%", type: "food", power: 300 + depth * 50, identified: true };
  }
  const scrolls = ["identify", "teleport", "enchant weapon"];
  const s = scrolls[Math.floor(Math.random() * scrolls.length)];
  return { id, name: `scroll of ${s}`, char: "?", type: "scroll", power: 1, identified: false };
}

export function itemDisplayName(item: Item): string {
  if (item.identified) return item.name;
  const unknown: Record<string, string> = {
    weapon: "weapon",
    armor: "armor",
    potion: "potion",
    food: "food",
    scroll: "scroll",
  };
  return `unidentified ${unknown[item.type]}`;
}