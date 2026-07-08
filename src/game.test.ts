import { describe, it, expect } from "vitest";
import { generateDungeon, isWalkable } from "./dungeon";
import { RNG } from "./rng";
import { newGame, tryMove, waitTurn } from "./game";
import { hungerDamage, updateHungerState } from "./combat";
import { createPlayer, createMonster } from "./entities";
import type { PlayerState } from "./types";

describe("dungeon generation", () => {
  it("is deterministic for a fixed seed", () => {
    const a = generateDungeon(new RNG(42), 1);
    const b = generateDungeon(new RNG(42), 1);
    expect(a.stairsDown).toEqual(b.stairsDown);
    expect(a.rooms.length).toBe(b.rooms.length);
  });

  it("places walkable stairs", () => {
    const d = generateDungeon(new RNG(99), 3);
    expect(isWalkable(d.tiles, d.stairsDown.x, d.stairsDown.y)).toBe(true);
    expect(isWalkable(d.tiles, d.stairsUp.x, d.stairsUp.y)).toBe(true);
  });
});

describe("hunger", () => {
  it("damages player when starving", () => {
    expect(hungerDamage("starving")).toBe(3);
    expect(hungerDamage("normal")).toBe(0);
  });

  it("transitions to fainting below 5% food", () => {
    const p: PlayerState = {
      entity: createPlayer(0, 0),
      level: 1,
      xp: 0,
      xpToLevel: 20,
      hunger: 60,
      maxHunger: 1000,
      hungerState: "normal",
      inventory: [],
      equippedWeapon: null,
      equippedArmor: null,
      gold: 0,
      turns: 0,
      depth: 1,
      alive: true,
    };
    updateHungerState(p);
    expect(p.hungerState).toBe("fainting");
  });
});

describe("game rules", () => {
  it("starts in playing phase with gear equipped", () => {
    const g = newGame(12345);
    expect(g.phase).toBe("playing");
    expect(g.player.equippedWeapon).not.toBeNull();
    expect(g.player.equippedArmor).not.toBeNull();
    expect(g.monsters.length).toBeGreaterThan(0);
  });

  it("does not consume a turn when bumping a wall", () => {
    const g = newGame(1);
    // place player adjacent to any wall
    outer: for (let y = 0; y < g.dungeon.height; y++) {
      for (let x = 0; x < g.dungeon.width; x++) {
        if (g.dungeon.tiles[y][x] !== "#") continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const fx = x + dx;
          const fy = y + dy;
          if (!isWalkable(g.dungeon.tiles, fx, fy)) continue;
          g.player.entity.x = fx;
          g.player.entity.y = fy;
          const before = g.player.turns;
          tryMove(g, { dx: -dx || 0, dy: -dy || 0 });
          expect(g.player.turns).toBe(before);
          break outer;
        }
      }
    }
  });

  it("kills player from starvation within expected turns without food", () => {
    const g = newGame(42);
    for (let i = 0; i < 400 && g.phase === "playing"; i++) waitTurn(g);
    expect(g.phase).toBe("dead");
    expect(g.player.turns).toBeLessThan(350);
  });
});

describe("combat scaling", () => {
  it("scales dragon HP at depth 10", () => {
    const dragon = createMonster("dragon", 0, 0, 10);
    expect(dragon.hp).toBeGreaterThanOrEqual(60);
  });
});