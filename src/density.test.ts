import { describe, it, expect } from "vitest";
import {
  itemCountRange,
  monsterCountRange,
  roomLootCount,
  itemTypeWeights,
  generateItemBiased,
  generateHealingPotion,
  pickPotionAppearanceForDepth,
  countHealingPotionsOnFloor,
  minHealingPotionsForDepth,
  isHealingPotion,
  generateItem,
  potionMapForSeed,
  foyerThreatCount,
  createPlayer,
} from "./entities";
import { newGame } from "./game";
import { useItem } from "./combat";
import type { PlayerState } from "./types";
import {
  generateDungeon,
  planMonsterSpawns,
  planCorridorScraps,
  computeFOV,
  spawnSafeRadius,
} from "./dungeon";
import { RNG } from "./rng";

// pointInRoom may be unexported — local helper for den checks
function inRoom(
  r: { x: number; y: number; w: number; h: number },
  x: number,
  y: number
): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

describe("density ecology (CEO empty-floor mandate)", () => {
  it("itemCountRange is dense on d1–5", () => {
    const d1 = itemCountRange(1);
    const d5 = itemCountRange(5);
    const d10 = itemCountRange(10);
    expect(d1.min).toBeGreaterThanOrEqual(12);
    expect(d1.max).toBeGreaterThan(d1.min);
    expect(d5.min).toBeGreaterThanOrEqual(10);
    // Early floors should not be leaner than late mid-game free loot
    expect(d1.min).toBeGreaterThanOrEqual(d10.min);
  });

  it("monsterCountRange keeps d1–5 lively", () => {
    const d1 = monsterCountRange(1);
    const d3 = monsterCountRange(3);
    expect(d1.min).toBeGreaterThanOrEqual(10);
    expect(d3.max).toBeGreaterThan(d3.min);
    expect(d3.min).toBeGreaterThanOrEqual(d1.min - 2);
  });

  it("ordinary rooms on d1 almost always drop loot", () => {
    let empty = 0;
    for (let i = 0; i < 100; i++) {
      if (roomLootCount(null, 1, i / 100) === 0) empty++;
    }
    expect(empty).toBe(0);
  });

  it("vaults and shrines guarantee multi-item piles", () => {
    expect(roomLootCount("vault", 3, 0.5)).toBeGreaterThanOrEqual(4);
    expect(roomLootCount("shrine", 3, 0.5)).toBeGreaterThanOrEqual(2);
    expect(roomLootCount("barracks", 2, 0.5)).toBeGreaterThanOrEqual(2);
  });

  it("early item tables weight potions/scrolls/food heavily", () => {
    const w = itemTypeWeights(2);
    const pot = w.find((x) => x.type === "potion")!.w;
    const scroll = w.find((x) => x.type === "scroll")!.w;
    const ring = w.find((x) => x.type === "ring")!.w;
    expect(pot).toBeGreaterThan(ring);
    expect(scroll).toBeGreaterThan(ring);
  });

  it("generateItemBiased can force potions for shrine/ID teaching", () => {
    const it = generateItemBiased(2, "p1", 42, "potion");
    expect(it.type).toBe("potion");
    expect(it.appearance).toBeTruthy();
  });

  it("newGame d1 floors spawn plentiful monsters and items", () => {
    const monCounts: number[] = [];
    const itemCounts: number[] = [];
    for (const seed of [1, 7, 42, 99, 12345]) {
      const g = newGame(seed);
      monCounts.push(g.monsters.length);
      itemCounts.push(g.items.length);
      expect(g.monsters.length).toBeGreaterThanOrEqual(10);
    }
    const avgItems = itemCounts.reduce((a, b) => a + b, 0) / itemCounts.length;
    const avgMons = monCounts.reduce((a, b) => a + b, 0) / monCounts.length;
    // free loot + per-room + corridor scraps
    expect(avgItems).toBeGreaterThanOrEqual(18);
    expect(Math.min(...itemCounts)).toBeGreaterThanOrEqual(12);
    expect(avgMons).toBeGreaterThanOrEqual(12);
  });

  it("d1 FOV at stairs usually reveals at least one threat or scrap", () => {
    let withLife = 0;
    let totalVisMon = 0;
    let totalVisItem = 0;
    const n = 24;
    for (let s = 0; s < n; s++) {
      const g = newGame(5000 + s);
      const fov = computeFOV(
        g.dungeon.tiles,
        g.player.entity.x,
        g.player.entity.y,
        8
      );
      const vm = g.monsters.filter((m) => fov.has(`${m.x},${m.y}`)).length;
      const vi = g.items.filter((i) => fov.has(`${i.x},${i.y}`)).length;
      totalVisMon += vm;
      totalVisItem += vi;
      if (vm + vi > 0) withLife++;
    }
    // FOV is partial map — but start should not feel dead
    expect(withLife / n).toBeGreaterThanOrEqual(0.7);
    expect(totalVisMon / n + totalVisItem / n).toBeGreaterThanOrEqual(1.5);
  });

  /**
   * P0-6 (nethack-systems): live FOV density d1–5.
   * Count monsters with chebyshev ≤8 from stairsUp; mean ≥3 across seeds.
   */
  it("P0-6: mean monsters within chebyshev ≤8 of stairs ≥3 on d1", () => {
    const seeds = Array.from({ length: 24 }, (_, i) => 6000 + i);
    let sum = 0;
    for (const seed of seeds) {
      const g = newGame(seed);
      const { x: sx, y: sy } = g.dungeon.stairsUp;
      const near = g.monsters.filter(
        (m) => Math.max(Math.abs(m.x - sx), Math.abs(m.y - sy)) <= 8
      ).length;
      sum += near;
    }
    const mean = sum / seeds.length;
    expect(mean).toBeGreaterThanOrEqual(3);
  });

  it("P0-6: d1–5 keep strong count bands", () => {
    expect(monsterCountRange(1).min).toBeGreaterThanOrEqual(12);
    expect(monsterCountRange(3).min).toBeGreaterThanOrEqual(12);
    expect(monsterCountRange(5).min).toBeGreaterThanOrEqual(14);
    expect(itemCountRange(1).min).toBeGreaterThanOrEqual(8);
    expect(itemCountRange(5).min).toBeGreaterThanOrEqual(8);
  });

  /**
   * P0-5: dens use themed kinds (zoo → rat/bat/snake; barracks → kobold/goblin).
   */
  it("P0-5: zoo dens spawn themed animals not pure random table", () => {
    const zooKinds = new Set(["rat", "bat", "snake", "kobold"]);
    const barracksKinds = new Set(["kobold", "goblin", "orc", "rat", "skeleton"]);
    let zooMon = 0;
    let zooThemed = 0;
    let barMon = 0;
    let barThemed = 0;
    for (let seed = 0; seed < 40; seed++) {
      const g = newGame(8000 + seed);
      for (const room of g.dungeon.rooms) {
        if (room.special !== "zoo" && room.special !== "barracks") continue;
        for (const m of g.monsters) {
          if (!inRoom(room, m.x, m.y)) continue;
          if (room.special === "zoo") {
            zooMon++;
            if (m.kind && zooKinds.has(m.kind)) zooThemed++;
          } else {
            barMon++;
            if (m.kind && barracksKinds.has(m.kind)) barThemed++;
          }
        }
      }
    }
    // If dens appear, majority themed
    if (zooMon > 0) expect(zooThemed / zooMon).toBeGreaterThanOrEqual(0.7);
    if (barMon > 0) expect(barThemed / barMon).toBeGreaterThanOrEqual(0.7);
    expect(zooMon + barMon).toBeGreaterThan(0);
  });

  it("zoo/barracks dens always pack even when count is low", () => {
    let densTrials = 0;
    let densMonsters = 0;
    for (let seed = 0; seed < 120 && densTrials < 15; seed++) {
      const d = generateDungeon(new RNG(seed + 70000), 5);
      const dens = d.rooms.filter(
        (r) => r.special === "barracks" || r.special === "zoo"
      );
      if (!dens.length) continue;
      densTrials++;
      const occupied = new Set<string>([`${d.stairsUp.x},${d.stairsUp.y}`]);
      // Intentionally low floor count — dens must still overfill
      const spawns = planMonsterSpawns(d, 5, 6, new RNG(seed), occupied);
      let inDen = 0;
      for (const s of spawns) {
        if (dens.some((r) => inRoom(r, s.x, s.y))) inDen++;
      }
      densMonsters += inDen;
      // At least a barracks/zoo pack of 4+
      expect(inDen).toBeGreaterThanOrEqual(4);
    }
    expect(densTrials).toBeGreaterThan(0);
    expect(densMonsters / densTrials).toBeGreaterThanOrEqual(5);
  });

  describe("DENSITY_COORD placement quality (planMonsterSpawns d1–5)", () => {
    it("spawnSafeRadius: d1=4, d2–5=3, late=2", () => {
      expect(spawnSafeRadius(1)).toBe(4);
      expect(spawnSafeRadius(3)).toBe(3);
      expect(spawnSafeRadius(5)).toBe(3);
      expect(spawnSafeRadius(8)).toBe(2);
    });

    it("foyerThreatCount is positive on d1–5 (game/world wire knobs)", () => {
      expect(foyerThreatCount(1)).toBeGreaterThanOrEqual(4);
      expect(foyerThreatCount(5)).toBeGreaterThanOrEqual(3);
      expect(foyerThreatCount(10)).toBeGreaterThanOrEqual(1);
    });

    it("planMonsterSpawns never places on stairs; dens packs fill on d1–5", () => {
      let densTrials = 0;
      let densSum = 0;
      for (let seed = 0; seed < 100 && densTrials < 12; seed++) {
        for (const depth of [1, 3, 5] as const) {
          const d = generateDungeon(new RNG(seed * 17 + depth + 90000), depth);
          const dens = d.rooms.filter(
            (r) => r.special === "barracks" || r.special === "zoo"
          );
          const occupied = new Set<string>([`${d.stairsUp.x},${d.stairsUp.y}`]);
          const count = monsterCountRange(depth).min;
          const spawns = planMonsterSpawns(
            d,
            depth,
            count,
            new RNG(seed + depth),
            occupied
          );
          expect(spawns.length).toBeGreaterThanOrEqual(count);
          for (const s of spawns) {
            expect(s.x === d.stairsUp.x && s.y === d.stairsUp.y).toBe(false);
            expect(s.x === d.stairsDown.x && s.y === d.stairsDown.y).toBe(false);
          }
          if (dens.length) {
            densTrials++;
            let inDen = 0;
            for (const s of spawns) {
              if (dens.some((r) => inRoom(r, s.x, s.y))) inDen++;
            }
            densSum += inDen;
            expect(inDen).toBeGreaterThanOrEqual(4);
          }
        }
      }
      expect(densTrials).toBeGreaterThan(0);
      expect(densSum / densTrials).toBeGreaterThanOrEqual(5);
    });

    it("game.ts uses shared density knobs — newGame d1 meets DENSITY_COORD floors", () => {
      // Verifies monsterCountRange + itemCountRange + foyerThreatCount are wired
      for (const seed of [1, 42, 99, 777, 2024]) {
        const g = newGame(seed);
        expect(g.monsters.length).toBeGreaterThanOrEqual(monsterCountRange(1).min);
        expect(g.items.length).toBeGreaterThanOrEqual(itemCountRange(1).min - 4); // room pass may vary; free band is floor
        expect(g.items.length).toBeGreaterThanOrEqual(8);
        // foyer: at least some life near stairs (placement quality)
        const { x: sx, y: sy } = g.dungeon.stairsUp;
        const near = g.monsters.filter(
          (m) => Math.max(Math.abs(m.x - sx), Math.abs(m.y - sy)) <= 8
        ).length;
        expect(near).toBeGreaterThanOrEqual(1);
      }
    });
  });

  it("planCorridorScraps places hallway loot outside rooms", () => {
    let total = 0;
    for (let seed = 0; seed < 20; seed++) {
      const d = generateDungeon(new RNG(seed + 80000), 1);
      const occupied = new Set<string>();
      const scraps = planCorridorScraps(d, 1, new RNG(seed), occupied);
      total += scraps.length;
      for (const s of scraps) {
        expect(d.tiles[s.y][s.x]).toBe(".");
        expect(d.rooms.some((r) => inRoom(r, s.x, s.y))).toBe(false);
      }
    }
    expect(total / 20).toBeGreaterThanOrEqual(3);
  });
});

describe("analytics cycle1 — early healing sustain", () => {
  it("minHealingPotionsForDepth requires sustain on d1–3", () => {
    expect(minHealingPotionsForDepth(1)).toBeGreaterThanOrEqual(3);
    expect(minHealingPotionsForDepth(3)).toBeGreaterThanOrEqual(2);
    expect(minHealingPotionsForDepth(10)).toBe(0);
  });

  it("generateHealingPotion is unidentified but truly healing for seed", () => {
    for (const seed of [1, 42, 99, 1000]) {
      const pot = generateHealingPotion(2, "h1", seed);
      expect(pot.type).toBe("potion");
      expect(pot.identified).toBe(false);
      expect(isHealingPotion(pot)).toBe(true);
      expect(pot.appearance).toBeTruthy();
      expect(potionMapForSeed(seed).get(pot.appearance!)).toMatch(/healing/);
      expect(pot.buc).toBe("uncursed");
    }
  });

  it("d1–3 potion gen biases toward healing appearances", () => {
    let healing = 0;
    const n = 80;
    for (let i = 0; i < n; i++) {
      const app = pickPotionAppearanceForDepth(2, 55, () => (i + 0.5) / n);
      const eff = potionMapForSeed(55).get(app);
      if (eff === "healing" || eff === "extra_healing") healing++;
    }
    expect(healing / n).toBeGreaterThan(0.45);
  });

  it("newGame d1 always has ≥3 healing potions on the floor", () => {
    for (const seed of [1, 7, 42, 99, 123, 999]) {
      const g = newGame(seed);
      const healN = countHealingPotionsOnFloor(g.items);
      expect(healN).toBeGreaterThanOrEqual(minHealingPotionsForDepth(1));
    }
  });

  it("desperate quaff teaches healing under pressure", () => {
    const entity = createPlayer(0, 0);
    const p: PlayerState = {
      entity,
      level: 1,
      xp: 0,
      xpToLevel: 20,
      hunger: 500,
      maxHunger: 1000,
      hungerState: "normal",
      inventory: [],
      equippedWeapon: null,
      equippedArmor: null,
      equippedRing: null,
      gold: 0,
      turns: 0,
      depth: 1,
      alive: true,
      statuses: [],
    };
    p.entity.hp = 4;
    p.entity.maxHp = 16;
    const pot = generateHealingPotion(1, "x", 7);
    p.inventory.push(pot);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/healing|better|desperate/);
    expect(p.entity.hp).toBeGreaterThan(4);
    expect(p.alive).toBe(true);
  });

  it("item tables on d1 weight potions heavily vs rings", () => {
    const w = itemTypeWeights(1);
    const pot = w.find((x) => x.type === "potion")!.w;
    const ring = w.find((x) => x.type === "ring")!.w;
    expect(pot).toBeGreaterThan(ring * 2);
  });

  it("generateItem on d1 produces healing often enough (sample)", () => {
    let pots = 0;
    let heal = 0;
    for (let i = 0; i < 120; i++) {
      const it = generateItem(1, `t${i}`, 42);
      if (it.type === "potion") {
        pots++;
        if (isHealingPotion(it)) heal++;
      }
    }
    expect(pots).toBeGreaterThan(15);
    if (pots > 0) expect(heal / pots).toBeGreaterThan(0.35);
  });
});
