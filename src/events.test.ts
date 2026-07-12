/**
 * TICKET-WE-01 — floor events (reinforce / migration / haunt).
 */
import { describe, it, expect } from "vitest";
import { generateDungeon } from "./dungeon";
import { monsterCountRange } from "./entities";
import { RNG } from "./rng";
import {
  createFloorEventBook,
  ensureFloorEventBook,
  forceReinforceIfSparse,
  forceMigration,
  forceHaunt,
  isFloorSparse,
  isTutorialQuiet,
  maybeFireFloorEvent,
  notePollution,
  entitiesFromEventSpawns,
  tickBloodMoon,
  type FloorEventContext,
} from "./events";

function makeCtx(
  overrides: Partial<FloorEventContext> & { seed?: number } = {}
): FloorEventContext {
  const seed = overrides.seed ?? 42;
  const depth = overrides.depth ?? 5;
  const dungeon = overrides.dungeon ?? generateDungeon(new RNG(seed), depth);
  const bandMin = overrides.bandMin ?? monsterCountRange(depth).min;
  const occupied = overrides.occupied ?? new Set<string>();
  occupied.add(`${dungeon.stairsUp.x},${dungeon.stairsUp.y}`);
  return {
    depth,
    turn: overrides.turn ?? 50,
    monsterCount: overrides.monsterCount ?? 0,
    bandMin,
    pollution: overrides.pollution ?? 0,
    dungeon,
    occupied,
    playerPos: overrides.playerPos ?? {
      x: dungeon.stairsUp.x,
      y: dungeon.stairsUp.y,
    },
    hasGraveyard:
      overrides.hasGraveyard ??
      dungeon.rooms.some((r) => r.special === "graveyard"),
    book: overrides.book ?? createFloorEventBook(),
  };
}

describe("TICKET-WE-01 sparse / tutorial gates", () => {
  it("isFloorSparse is true below 60% of band.min", () => {
    expect(isFloorSparse(5, 10)).toBe(true); // 50%
    expect(isFloorSparse(6, 10)).toBe(false); // 60% exactly not sparse
    expect(isFloorSparse(5.9, 10)).toBe(true);
  });

  it("tutorial quiet on d1 first 20 turns", () => {
    expect(isTutorialQuiet(1, 0)).toBe(true);
    expect(isTutorialQuiet(1, 19)).toBe(true);
    expect(isTutorialQuiet(1, 20)).toBe(false);
    expect(isTutorialQuiet(2, 5)).toBe(false);
  });

  it("maybeFireFloorEvent returns null during d1 tutorial window", () => {
    const ctx = makeCtx({ depth: 1, turn: 10, monsterCount: 0, bandMin: 20 });
    // Many seeds — must never fire
    for (let s = 0; s < 30; s++) {
      const r = maybeFireFloorEvent(ctx, new RNG(s * 99 + 1));
      expect(r).toBeNull();
    }
  });
});

describe("TICKET-WE-01 reinforce", () => {
  it("forceReinforceIfSparse spawns 1–3 hostiles on empty floor", () => {
    const bandMin = monsterCountRange(6).min;
    const ctx = makeCtx({
      depth: 6,
      turn: 100,
      monsterCount: 0,
      bandMin,
      seed: 1234,
    });
    expect(isFloorSparse(ctx.monsterCount, bandMin)).toBe(true);

    const result = forceReinforceIfSparse(ctx, new RNG(77));
    expect(result).not.toBeNull();
    expect(result!.id).toBe("reinforce");
    expect(result!.message.length).toBeGreaterThan(5);
    expect(result!.spawns).toBeDefined();
    expect(result!.spawns!.length).toBeGreaterThanOrEqual(1);
    expect(result!.spawns!.length).toBeLessThanOrEqual(3);

    const ents = entitiesFromEventSpawns(result!.spawns!, 6);
    expect(ents.every((e) => e.hp > 0 && !e.isPlayer)).toBe(true);
  });

  it("seeded sparse floor eventually fires reinforce via maybeFireFloorEvent", () => {
    const bandMin = monsterCountRange(5).min;
    const dungeon = generateDungeon(new RNG(999), 5);
    let fired = false;
    let spawnCount = 0;

    for (let seed = 0; seed < 40 && !fired; seed++) {
      const book = createFloorEventBook();
      // Simulate sparse floor over many turns past tutorial
      for (let turn = 40; turn <= 200; turn++) {
        const occupied = new Set<string>([
          `${dungeon.stairsUp.x},${dungeon.stairsUp.y}`,
        ]);
        const ctx = makeCtx({
          depth: 5,
          turn,
          monsterCount: Math.floor(bandMin * 0.3), // clearly sparse
          bandMin,
          dungeon,
          occupied,
          book,
          seed: 999,
        });
        const r = maybeFireFloorEvent(ctx, new RNG(seed * 1000 + turn));
        if (r?.id === "reinforce" && r.spawns?.length) {
          fired = true;
          spawnCount = r.spawns.length;
          break;
        }
      }
    }
    expect(fired).toBe(true);
    expect(spawnCount).toBeGreaterThanOrEqual(1);
  });

  it("does not reinforce when floor is full enough", () => {
    const bandMin = 20;
    const ctx = makeCtx({
      depth: 5,
      turn: 100,
      monsterCount: 18, // 90% of band
      bandMin,
    });
    expect(isFloorSparse(18, 20)).toBe(false);
    expect(forceReinforceIfSparse(ctx, new RNG(1))).toBeNull();
  });
});

describe("TICKET-WE-01 migration + haunt", () => {
  it("forceMigration spawns a barracks-like pack on d3+", () => {
    const dungeon = generateDungeon(new RNG(50), 4);
    const bandMin = monsterCountRange(4).min;
    const ctx = makeCtx({
      depth: 4,
      turn: 50,
      monsterCount: bandMin,
      bandMin,
      dungeon,
      seed: 50,
    });
    const r = forceMigration(ctx, new RNG(99991));
    expect(r).not.toBeNull();
    expect(r!.id).toBe("migration");
    expect(r!.spawns!.length).toBeGreaterThanOrEqual(3);
    expect(r!.message).toMatch(/migrat|pack/i);
  });

  it("forceHaunt spawns undead near player / graveyard", () => {
    const dungeon = generateDungeon(new RNG(77), 7);
    if (dungeon.rooms[1]) dungeon.rooms[1].special = "graveyard";
    const bandMin = monsterCountRange(7).min;
    const ctx = makeCtx({
      depth: 7,
      turn: 40,
      monsterCount: bandMin,
      bandMin,
      dungeon,
      hasGraveyard: true,
    });
    const haunt = forceHaunt(ctx, new RNG(88881));
    expect(haunt).not.toBeNull();
    expect(haunt!.message).toMatch(/chill|dead|grave/i);
    expect(haunt!.spawns?.length).toBeGreaterThanOrEqual(1);
    expect(
      haunt!.spawns!.every((s) => s.kind === "skeleton" || s.kind === "wraith")
    ).toBe(true);
  });

  it("maybeFireFloorEvent can select migration with well-mixed seeds", () => {
    const dungeon = generateDungeon(new RNG(50), 4);
    const bandMin = monsterCountRange(4).min;
    let hit = false;
    // High mixed seeds so first LCG draw is not stuck in mid-band
    for (let i = 0; i < 300; i++) {
      const seed = (i * 2654435761 + 0x9e3779b9) >>> 0;
      const book = createFloorEventBook();
      const ctx = makeCtx({
        depth: 4,
        turn: 50,
        monsterCount: bandMin,
        bandMin,
        dungeon,
        book,
      });
      const r = maybeFireFloorEvent(ctx, new RNG(seed));
      if (r?.id === "migration") {
        hit = true;
        break;
      }
    }
    expect(hit).toBe(true);
  });
});

describe("TICKET-WE-01 pollution / blood_moon prep", () => {
  it("notePollution accumulates", () => {
    const book = createFloorEventBook();
    notePollution(book, 3);
    notePollution(book, 2);
    expect(book.pollution).toBe(5);
  });

  it("ensureFloorEventBook backfills", () => {
    const b = ensureFloorEventBook({ lastEventTurn: 1 } as never);
    expect(b.pollution).toBe(0);
    expect(b.lastReinforceCheckTurn).toBe(0);
  });

  it("tickBloodMoon decays", () => {
    const book = createFloorEventBook();
    book.bloodMoonTurnsLeft = 2;
    expect(tickBloodMoon(book)).toBe(true);
    expect(book.bloodMoonTurnsLeft).toBe(1);
    expect(tickBloodMoon(book)).toBe(false);
    expect(book.bloodMoonTurnsLeft).toBe(0);
  });
});
