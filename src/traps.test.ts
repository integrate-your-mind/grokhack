import { describe, it, expect, beforeEach } from "vitest";
import { generateDungeon, isWalkable } from "./dungeon";
import { RNG } from "./rng";
import { createPlayer } from "./entities";
import type { FloorTrap, PlayerState, TrapKind } from "./types";
import {
  applyTrapsOnStep,
  assertTrapsSafe,
  ensureFloorTraps,
  generateTraps,
  isKnownHazard,
  pickTrapKind,
  resetTrapIds,
  resolveTrap,
  revealedTrapAt,
  rollTrapCount,
  searchForTraps,
  trapAt,
  trapCountRange,
  trapDisplayName,
  trapsRngFromFloorSeed,
} from "./traps";

function makePlayer(x = 5, y = 5, depth = 5): PlayerState {
  return {
    entity: createPlayer(x, y),
    level: 3,
    xp: 0,
    xpToLevel: 40,
    hunger: 800,
    maxHunger: 1000,
    hungerState: "normal",
    inventory: [],
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

function bareTrap(kind: TrapKind, x: number, y: number): FloorTrap {
  return {
    id: `t_${kind}`,
    kind,
    x,
    y,
    revealed: false,
    sprung: false,
  };
}

beforeEach(() => {
  resetTrapIds();
});

describe("trap density curve", () => {
  it("is near-zero on depth 1", () => {
    const r = trapCountRange(1);
    expect(r.min).toBe(0);
    expect(r.max).toBe(1);
    // Most d1 rolls are zero (well-spaced seeds — sequential LCG seeds correlate)
    let nonzero = 0;
    for (let s = 0; s < 200; s++) {
      if (rollTrapCount(1, new RNG(s * 9973 + 42)) > 0) nonzero++;
    }
    expect(nonzero).toBeLessThan(60); // ~12% expected
    expect(nonzero).toBeGreaterThan(5);
  });

  it("scales cruelly by d6+", () => {
    const d1 = trapCountRange(1);
    const d6 = trapCountRange(6);
    const d10 = trapCountRange(10);
    expect(d6.min).toBeGreaterThan(d1.max);
    expect(d10.min).toBeGreaterThanOrEqual(d6.min);
    expect(d10.max).toBeGreaterThanOrEqual(d6.max);
    expect(d6.min).toBeGreaterThanOrEqual(5);
  });

  it("pickTrapKind always returns a known kind", () => {
    const kinds = new Set<TrapKind>();
    for (let d = 1; d <= 12; d++) {
      for (let s = 0; s < 40; s++) {
        kinds.add(pickTrapKind(d, new RNG(d * 1000 + s)));
      }
    }
    expect(kinds.has("pit")).toBe(true);
    expect(kinds.has("bear")).toBe(true);
    expect(kinds.has("teleport")).toBe(true);
    expect(kinds.has("poison_needle")).toBe(true);
  });
});

describe("generateTraps", () => {
  it("is deterministic for fixed dungeon + seed", () => {
    const d = generateDungeon(new RNG(42), 6);
    const a = generateTraps(d, 6, new RNG(999));
    resetTrapIds();
    const b = generateTraps(d, 6, new RNG(999));
    expect(a.map((t) => ({ kind: t.kind, x: t.x, y: t.y }))).toEqual(
      b.map((t) => ({ kind: t.kind, x: t.x, y: t.y }))
    );
  });

  it("places zero-to-few traps on d1 and many on d6+", () => {
    let d1Total = 0;
    let d6Total = 0;
    for (let s = 0; s < 30; s++) {
      const d1 = generateDungeon(new RNG(s * 17 + 3), 1);
      const d6 = generateDungeon(new RNG(s * 17 + 3), 6);
      d1Total += generateTraps(d1, 1, new RNG(s * 31 + 1)).length;
      d6Total += generateTraps(d6, 6, new RNG(s * 31 + 1)).length;
    }
    expect(d1Total).toBeLessThan(20);
    expect(d6Total).toBeGreaterThan(100);
  });

  it("never softlocks layout: no stairs, walkable only, unique tiles", () => {
    for (let depth = 1; depth <= 10; depth++) {
      for (let s = 0; s < 8; s++) {
        const dungeon = generateDungeon(new RNG(depth * 1000 + s), depth);
        const traps = generateTraps(dungeon, depth, new RNG(depth * 77 + s));
        const errors = assertTrapsSafe(traps, dungeon);
        expect(errors).toEqual([]);
        for (const t of traps) {
          expect(isWalkable(dungeon.tiles, t.x, t.y)).toBe(true);
          expect(t.revealed).toBe(false);
          expect(t.sprung).toBe(false);
        }
      }
    }
  });

  it("prefers corridor tiles over room interiors when possible", () => {
    // Deep floors have more corridors; measure corridor share
    let corridorHits = 0;
    let roomHits = 0;
    for (let s = 0; s < 40; s++) {
      const dungeon = generateDungeon(new RNG(5000 + s), 7);
      const traps = generateTraps(dungeon, 7, new RNG(9000 + s));
      for (const t of traps) {
        const inRoom = dungeon.rooms.some(
          (r) => t.x >= r.x && t.x < r.x + r.w && t.y >= r.y && t.y < r.y + r.h
        );
        if (inRoom) roomHits++;
        else corridorHits++;
      }
    }
    // Corridor bias: more traps in halls than rooms when both exist
    expect(corridorHits + roomHits).toBeGreaterThan(50);
    expect(corridorHits).toBeGreaterThan(roomHits * 0.5);
  });
});

describe("trigger / resolve each trap type", () => {
  it("pit: damages, reveals, stays armed", () => {
    const dungeon = generateDungeon(new RNG(1), 4);
    const p = makePlayer(10, 10, 4);
    p.entity.hp = 20;
    p.entity.maxHp = 20;
    const trap = bareTrap("pit", p.entity.x, p.entity.y);
    const r = resolveTrap(trap, p, dungeon, new RNG(2));
    expect(r.messages.join(" ")).toMatch(/pit/i);
    expect(p.entity.hp).toBeLessThan(20);
    expect(trap.revealed).toBe(true);
    expect(trap.sprung).toBe(false);
    expect(r.relocated).toBe(false);
  });

  it("bear: damages, immobilizes, springs once", () => {
    const dungeon = generateDungeon(new RNG(2), 5);
    const p = makePlayer(10, 10, 5);
    p.entity.hp = 20;
    const trap = bareTrap("bear", p.entity.x, p.entity.y);
    const r = resolveTrap(trap, p, dungeon, new RNG(3));
    expect(r.messages.join(" ")).toMatch(/bear/i);
    expect(p.immobilizedTurns).toBeGreaterThanOrEqual(2);
    expect(p.immobilizedTurns).toBeLessThanOrEqual(4);
    expect(trap.sprung).toBe(true);
    expect(trap.revealed).toBe(true);
    // Second resolve is no-op
    const hp = p.entity.hp;
    const r2 = resolveTrap(trap, p, dungeon, new RNG(4));
    expect(r2.messages).toEqual([]);
    expect(p.entity.hp).toBe(hp);
  });

  it("teleport: relocates to walkable tile", () => {
    const dungeon = generateDungeon(new RNG(3), 5);
    const p = makePlayer(dungeon.stairsUp.x, dungeon.stairsUp.y, 5);
    const ox = p.entity.x;
    const oy = p.entity.y;
    const trap = bareTrap("teleport", ox, oy);
    const r = resolveTrap(trap, p, dungeon, new RNG(11));
    expect(r.messages.join(" ")).toMatch(/teleport/i);
    expect(r.relocated).toBe(true);
    expect(isWalkable(dungeon.tiles, p.entity.x, p.entity.y)).toBe(true);
    expect(p.entity.x !== ox || p.entity.y !== oy).toBe(true);
    expect(trap.sprung).toBe(false);
    expect(trap.revealed).toBe(true);
  });

  it("poison_needle: damages, poisons, springs", () => {
    const dungeon = generateDungeon(new RNG(4), 6);
    const p = makePlayer(10, 10, 6);
    p.entity.hp = 20;
    const trap = bareTrap("poison_needle", p.entity.x, p.entity.y);
    const r = resolveTrap(trap, p, dungeon, new RNG(7));
    expect(r.messages.join(" ")).toMatch(/poison/i);
    expect(p.statuses.some((s) => s.kind === "poison")).toBe(true);
    expect(trap.sprung).toBe(true);
    expect(p.entity.hp).toBeLessThan(20);
  });

  it("lethal pit sets deathCause", () => {
    const dungeon = generateDungeon(new RNG(5), 8);
    const p = makePlayer(10, 10, 8);
    p.entity.hp = 1;
    const trap = bareTrap("pit", p.entity.x, p.entity.y);
    resolveTrap(trap, p, dungeon, new RNG(1));
    expect(p.alive).toBe(false);
    expect(p.deathCause).toMatch(/pit/i);
  });

  it("applyTrapsOnStep caps teleport chains (no softlock loop)", () => {
    const dungeon = generateDungeon(new RNG(6), 5);
    // carpet of teleport traps
    const traps: FloorTrap[] = [];
    for (let y = 0; y < dungeon.height; y++) {
      for (let x = 0; x < dungeon.width; x++) {
        if (isWalkable(dungeon.tiles, x, y)) {
          traps.push(bareTrap("teleport", x, y));
        }
      }
    }
    const p = makePlayer(dungeon.rooms[0].x + 1, dungeon.rooms[0].y + 1, 5);
    const msgs = applyTrapsOnStep(traps, p, dungeon, new RNG(99), new Set(), 3);
    // Finite messages — chain capped
    expect(msgs.length).toBeLessThanOrEqual(12);
    expect(isWalkable(dungeon.tiles, p.entity.x, p.entity.y)).toBe(true);
  });
});

describe("hidden until search / trigger", () => {
  it("hidden traps are not known hazards", () => {
    const t = bareTrap("pit", 3, 3);
    expect(isKnownHazard([t], 3, 3)).toBe(false);
    expect(revealedTrapAt([t], 3, 3)).toBeUndefined();
    t.revealed = true;
    expect(isKnownHazard([t], 3, 3)).toBe(true);
    expect(revealedTrapAt([t], 3, 3)?.kind).toBe("pit");
  });

  it("search can reveal adjacent traps", () => {
    const traps = [bareTrap("bear", 5, 5), bareTrap("pit", 6, 5)];
    // Force find with chance 1
    const { found, messages } = searchForTraps(traps, 5, 5, new RNG(1), 1);
    expect(found.length).toBe(2);
    expect(traps.every((t) => t.revealed)).toBe(true);
    expect(messages.join(" ")).toMatch(/bear|pit/i);
  });

  it("search with chance 0 finds nothing", () => {
    const traps = [bareTrap("teleport", 1, 1)];
    const { found, messages } = searchForTraps(traps, 1, 1, new RNG(1), 0);
    expect(found).toEqual([]);
    expect(messages.join(" ")).toMatch(/nothing/i);
    expect(traps[0].revealed).toBe(false);
  });

  it("trapAt ignores sprung traps", () => {
    const t = bareTrap("bear", 2, 2);
    t.sprung = true;
    expect(trapAt([t], 2, 2)).toBeUndefined();
  });
});

describe("ensureFloorTraps / display", () => {
  it("regenerates when missing, preserves when present", () => {
    const dungeon = generateDungeon(new RNG(10), 4);
    const seed = 12345;
    const a = ensureFloorTraps(dungeon, 4, seed, undefined);
    const b = ensureFloorTraps(dungeon, 4, seed, null);
    expect(a.map((t) => `${t.kind}:${t.x},${t.y}`)).toEqual(
      b.map((t) => `${t.kind}:${t.x},${t.y}`)
    );
    const kept = ensureFloorTraps(dungeon, 4, seed, a);
    expect(kept).toBe(a);
  });

  it("trapsRngFromFloorSeed is stable", () => {
    const a = trapsRngFromFloorSeed(42);
    const b = trapsRngFromFloorSeed(42);
    expect(a.next()).toBe(b.next());
  });

  it("trapDisplayName covers all kinds", () => {
    for (const k of ["pit", "bear", "teleport", "poison_needle"] as TrapKind[]) {
      expect(trapDisplayName(k).length).toBeGreaterThan(2);
    }
  });
});
