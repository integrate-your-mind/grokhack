/**
 * TICKET-SE-01 / nethack-concepts §3.1 — spawn ecology.
 * d1–5 density, room loot pass, dens packs, entry safety.
 */
import { describe, it, expect } from "vitest";
import {
  monsterCountRange,
  itemCountRange,
  ecologyMonsterFloor,
  roomItemPassChance,
} from "./entities";
import { newGame, tryDescend } from "./game";
import { generateDungeon, planMonsterSpawns, isWalkable } from "./dungeon";
import { RNG } from "./rng";
import type { GameState, Room } from "./types";

const SEEDS = [1, 7, 42, 99, 123, 777, 1337, 2024, 4096, 9001, 12345, 42424];

function inRoom(r: Room, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

function floorAtDepth(depth: number, seed: number): GameState {
  const g = newGame(seed);
  while (g.player.depth < depth && g.phase === "playing") {
    for (const m of g.monsters) m.hp = 0;
    g.player.entity.x = g.dungeon.stairsDown.x;
    g.player.entity.y = g.dungeon.stairsDown.y;
    tryDescend(g);
  }
  expect(g.player.depth).toBe(depth);
  expect(g.phase).toBe("playing");
  return g;
}

describe("TICKET-SE-01 bands (§3.1)", () => {
  it("ecologyMonsterFloor matches §3.1 table mins", () => {
    expect(ecologyMonsterFloor(1)).toBe(12);
    expect(ecologyMonsterFloor(3)).toBe(14);
    expect(ecologyMonsterFloor(5)).toBe(16);
  });

  it("monsterCountRange(1).min >= 12 and d1–4 denser", () => {
    expect(monsterCountRange(1).min).toBeGreaterThanOrEqual(12);
    expect(monsterCountRange(2).min).toBeGreaterThanOrEqual(14);
    expect(monsterCountRange(3).min).toBeGreaterThanOrEqual(14);
    expect(monsterCountRange(4).min).toBeGreaterThanOrEqual(16);
    // Escalation: late not thinner than early min band
    expect(monsterCountRange(10).max).toBeGreaterThan(monsterCountRange(1).max);
  });

  it("roomItemPassChance is ≥0.75 and capped at 0.95", () => {
    expect(roomItemPassChance(1)).toBeGreaterThanOrEqual(0.75);
    expect(roomItemPassChance(1)).toBeLessThanOrEqual(0.95);
    expect(roomItemPassChance(20)).toBe(0.95);
    expect(roomItemPassChance(5)).toBeGreaterThan(roomItemPassChance(1));
  });

  it("item free-loot band stays non-barren vs ecology floor", () => {
    for (const d of [1, 2, 3, 4, 5]) {
      expect(itemCountRange(d).min).toBeGreaterThanOrEqual(
        Math.ceil(ecologyMonsterFloor(d) * 0.6)
      );
    }
  });
});

describe("TICKET-SE-01 newGame density", () => {
  it("d1 always has ≥12 monsters and ≥8 items", () => {
    for (const seed of SEEDS) {
      const g = newGame(seed);
      expect(g.monsters.length).toBeGreaterThanOrEqual(12);
      expect(g.items.length).toBeGreaterThanOrEqual(8);
    }
  });

  it("d3 ≥14 monsters, d5 ≥16 monsters; items keep pace", () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const g3 = floorAtDepth(3, seed + 300);
      expect(g3.monsters.length).toBeGreaterThanOrEqual(14);
      // Den packs can raise mon count; items still plentiful (not barren)
      expect(g3.items.length).toBeGreaterThanOrEqual(12);
      expect(g3.items.length).toBeGreaterThanOrEqual(g3.monsters.length * 0.45);

      const g5 = floorAtDepth(5, seed + 500);
      expect(g5.monsters.length).toBeGreaterThanOrEqual(16);
      expect(g5.items.length).toBeGreaterThanOrEqual(12);
      expect(g5.items.length).toBeGreaterThanOrEqual(g5.monsters.length * 0.45);
    }
  }, 15_000);
});

describe("TICKET-SE-01 room pass + dens + safe radius", () => {
  it("≥75% of non-start rooms contain ≥1 item (mean across seeds)", () => {
    let total = 0;
    let withItem = 0;
    for (const seed of SEEDS) {
      const g = newGame(seed);
      const start = g.dungeon.rooms[0];
      for (const r of g.dungeon.rooms) {
        if (r === start) continue;
        total++;
        if (g.items.some((i) => inRoom(r, i.x, i.y))) withItem++;
      }
    }
    expect(total).toBeGreaterThan(20);
    expect(withItem / total).toBeGreaterThanOrEqual(0.75);
  });

  it("planMonsterSpawns still packs zoo/barracks dens", () => {
    let densTrials = 0;
    let densMonsters = 0;
    for (let seed = 0; seed < 100 && densTrials < 12; seed++) {
      const d = generateDungeon(new RNG(seed + 88000), 5);
      const dens = d.rooms.filter((r) => r.special === "barracks" || r.special === "zoo");
      if (!dens.length) continue;
      densTrials++;
      const occupied = new Set<string>([`${d.stairsUp.x},${d.stairsUp.y}`]);
      const band = monsterCountRange(5);
      const spawns = planMonsterSpawns(d, 5, band.min, new RNG(seed), occupied);
      let inDen = 0;
      for (const s of spawns) {
        if (dens.some((r) => inRoom(r, s.x, s.y))) inDen++;
      }
      densMonsters += inDen;
      expect(inDen).toBeGreaterThanOrEqual(4);
    }
    expect(densTrials).toBeGreaterThan(0);
    expect(densMonsters / densTrials).toBeGreaterThanOrEqual(5);
  });

  it("no monster on entry stairs; low close-ambush rate on d1", () => {
    let stairHits = 0;
    let closeHits = 0;
    let totalMon = 0;
    for (const seed of SEEDS) {
      const g = newGame(seed);
      const { x: ex, y: ey } = g.dungeon.stairsUp;
      for (const m of g.monsters) {
        totalMon++;
        if (m.x === ex && m.y === ey) stairHits++;
        const cheb = Math.max(Math.abs(m.x - ex), Math.abs(m.y - ey));
        if (cheb < 3) closeHits++;
        expect(isWalkable(g.dungeon.tiles, m.x, m.y)).toBe(true);
      }
    }
    expect(stairHits).toBe(0);
    expect(closeHits / totalMon).toBeLessThan(0.1);
  });
});
