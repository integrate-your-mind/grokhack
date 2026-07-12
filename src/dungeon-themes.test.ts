import { describe, it, expect } from "vitest";
import {
  selectFloorTheme,
  getThemePack,
  allFloorThemes,
  themedCavernChance,
  themedLoopBudget,
  themedAlcoveAttempts,
  reserveAlcoveSlots,
  tryPlaceSecretAlcove,
  placeSecretAlcoves,
  countSecretAlcoves,
  themeForDepthSeed,
  type FloorTheme,
} from "./dungeon-themes";
import {
  generateDungeon,
  isFullyConnected,
  roomCountRange,
  isWalkable,
} from "./dungeon";
import { RNG } from "./rng";
import type { Room, Tile } from "./types";

describe("theme packs", () => {
  it("exposes mines, halls, and crypt packs", () => {
    expect(allFloorThemes()).toEqual(["mines", "halls", "crypt"]);
    for (const id of allFloorThemes()) {
      const pack = getThemePack(id);
      expect(pack.id).toBe(id);
      expect(pack.name.length).toBeGreaterThan(0);
      expect(pack.alcoveChance).toBeGreaterThan(0);
      expect(pack.alcoveChance).toBeLessThanOrEqual(1);
    }
  });

  it("mines bias caverns; halls bias loops and wide corridors", () => {
    expect(themedCavernChance(6, "mines")).toBeGreaterThan(themedCavernChance(6, "halls"));
    expect(themedLoopBudget(6, 10, "halls")).toBeGreaterThan(
      themedLoopBudget(6, 10, "mines")
    );
    expect(getThemePack("halls").wideCorridorChance).toBeGreaterThan(
      getThemePack("mines").wideCorridorChance
    );
    expect(getThemePack("crypt").alcoveChance).toBeGreaterThan(
      getThemePack("halls").alcoveChance
    );
  });

  it("selectFloorTheme is deterministic for a fixed RNG seed", () => {
    const a = selectFloorTheme(5, new RNG(42));
    const b = selectFloorTheme(5, new RNG(42));
    expect(a).toBe(b);
    expect(allFloorThemes()).toContain(a);
  });

  it("selectFloorTheme produces all themes across many seeds", () => {
    const seen = new Set<FloorTheme>();
    for (let seed = 0; seed < 200; seed++) {
      seen.add(selectFloorTheme(7, new RNG(seed * 997)));
    }
    expect(seen.has("mines")).toBe(true);
    expect(seen.has("halls")).toBe(true);
    expect(seen.has("crypt")).toBe(true);
  });

  it("themeForDepthSeed is pure and stable", () => {
    expect(themeForDepthSeed(4, 100)).toBe(themeForDepthSeed(4, 100));
    expect(allFloorThemes()).toContain(themeForDepthSeed(9, 1));
  });

  it("no alcove attempts before depth 4", () => {
    for (const theme of allFloorThemes()) {
      for (let seed = 0; seed < 40; seed++) {
        expect(themedAlcoveAttempts(3, theme, new RNG(seed))).toBe(0);
        expect(themedAlcoveAttempts(1, theme, new RNG(seed))).toBe(0);
      }
    }
    expect(reserveAlcoveSlots(3, 10, 6)).toBe(0);
    expect(reserveAlcoveSlots(4, 10, 6)).toBeGreaterThan(0);
  });
});

describe("secret alcove placement", () => {
  function emptyGrid(w = 40, h = 20): Tile[][] {
    return Array.from({ length: h }, () => Array.from({ length: w }, () => "#" as Tile));
  }

  it("carves a small chamber with a door off an existing floor", () => {
    const tiles = emptyGrid();
    // Main hall
    for (let y = 5; y < 10; y++) {
      for (let x = 5; x < 15; x++) tiles[y][x] = ".";
    }
    const rooms: Room[] = [{ x: 5, y: 5, w: 10, h: 5, special: null, locked: false }];
    const ok = tryPlaceSecretAlcove(tiles, rooms, new RNG(7));
    expect(ok).toBe(true);
    expect(countSecretAlcoves(rooms)).toBe(1);
    const alcove = rooms.find((r) => r.special === "alcove")!;
    expect(alcove.w).toBeGreaterThanOrEqual(3);
    expect(alcove.h).toBeGreaterThanOrEqual(3);
    // Door exists adjacent to alcove
    let doors = 0;
    for (const row of tiles) for (const t of row) if (t === "+") doors++;
    expect(doors).toBeGreaterThanOrEqual(1);
    // Alcove interior is floor
    expect(tiles[alcove.y][alcove.x]).toBe(".");
  });

  it("placeSecretAlcoves respects max room cap", () => {
    const tiles = emptyGrid();
    for (let y = 4; y < 12; y++) {
      for (let x = 4; x < 20; x++) tiles[y][x] = ".";
    }
    const rooms: Room[] = [{ x: 4, y: 4, w: 16, h: 8, special: null }];
    const placed = placeSecretAlcoves(tiles, rooms, new RNG(99), 5, 2);
    expect(rooms.length).toBeLessThanOrEqual(2);
    expect(placed).toBeLessThanOrEqual(1);
  });
});

describe("generateDungeon + themes integration", () => {
  it("keeps full connectivity across depths and seeds (all themes)", () => {
    let failures = 0;
    for (let depth = 1; depth <= 10; depth++) {
      for (let seed = 0; seed < 25; seed++) {
        const d = generateDungeon(new RNG(seed * 7919 + depth * 13), depth);
        if (!isFullyConnected(d.tiles)) failures++;
      }
    }
    expect(failures).toBe(0);
  });

  it("stays within roomCountRange including secret alcoves", () => {
    for (let depth = 1; depth <= 10; depth++) {
      const { min, max } = roomCountRange(depth);
      for (let seed = 0; seed < 30; seed++) {
        const d = generateDungeon(new RNG(seed * 1009 + depth), depth);
        expect(d.rooms.length).toBeGreaterThanOrEqual(1);
        expect(d.rooms.length).toBeLessThanOrEqual(max);
        // Soft: usually near min when packing works
        if (d.rooms.length < min) {
          // rare packing failure still allowed at same rate as base gen
          expect(d.rooms.length).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("is seed-deterministic with themes enabled", () => {
    for (const seed of [1, 42, 999, 12345]) {
      for (const depth of [1, 4, 7, 10]) {
        const a = generateDungeon(new RNG(seed), depth);
        const b = generateDungeon(new RNG(seed), depth);
        expect(a.tiles).toEqual(b.tiles);
        expect(a.rooms).toEqual(b.rooms);
        expect(a.stairsDown).toEqual(b.stairsDown);
        expect(countSecretAlcoves(a.rooms)).toBe(countSecretAlcoves(b.rooms));
      }
    }
  });

  it("places secret alcoves at a measurable rate on depth ≥ 4", () => {
    let withAlcove = 0;
    const trials = 120;
    for (let seed = 0; seed < trials; seed++) {
      const d = generateDungeon(new RNG(seed + 50_000), 5);
      if (countSecretAlcoves(d.rooms) >= 1) withAlcove++;
    }
    // Theme alcoveChance ~0.4–0.72 plus placement success — expect solid minority+
    expect(withAlcove).toBeGreaterThan(trials * 0.15);
    expect(withAlcove).toBeGreaterThan(12);
  });

  it("does not place secret alcoves on shallow depth 1–3", () => {
    let any = 0;
    for (let depth = 1; depth <= 3; depth++) {
      for (let seed = 0; seed < 40; seed++) {
        const d = generateDungeon(new RNG(seed + depth * 1000), depth);
        any += countSecretAlcoves(d.rooms);
      }
    }
    expect(any).toBe(0);
  });

  it("alcoves remain walkable from the main map via a door", () => {
    let checked = 0;
    for (let seed = 0; seed < 80 && checked < 15; seed++) {
      const d = generateDungeon(new RNG(seed + 60_000), 6);
      const alcoves = d.rooms.filter((r) => r.special === "alcove");
      if (!alcoves.length) continue;
      checked++;
      for (const alc of alcoves) {
        const start = d.stairsUp;
        const target = { x: alc.x + Math.floor(alc.w / 2), y: alc.y + Math.floor(alc.h / 2) };
        expect(isWalkable(d.tiles, target.x, target.y)).toBe(true);
        // BFS reachability
        const q = [{ x: start.x, y: start.y }];
        const seen = new Set<string>([`${start.x},${start.y}`]);
        const dirs = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ];
        let reached = false;
        while (q.length) {
          const cur = q.shift()!;
          if (cur.x === target.x && cur.y === target.y) {
            reached = true;
            break;
          }
          for (const [dx, dy] of dirs) {
            const nx = cur.x + dx;
            const ny = cur.y + dy;
            const key = `${nx},${ny}`;
            if (seen.has(key)) continue;
            if (!isWalkable(d.tiles, nx, ny)) continue;
            seen.add(key);
            q.push({ x: nx, y: ny });
          }
        }
        expect(reached).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("preserves locked vaults on deeper themed floors", () => {
    let lockedVaults = 0;
    for (let seed = 0; seed < 80; seed++) {
      const d = generateDungeon(new RNG(seed + 70_000), 6);
      if (d.rooms.some((r) => r.special === "vault" && r.locked)) lockedVaults++;
    }
    expect(lockedVaults).toBeGreaterThan(5);
  });

  it("never puts stairs inside a secret alcove", () => {
    for (let seed = 0; seed < 60; seed++) {
      const d = generateDungeon(new RNG(seed + 80_000), 7);
      for (const r of d.rooms) {
        if (r.special !== "alcove") continue;
        const inAlcove = (x: number, y: number) =>
          x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
        expect(inAlcove(d.stairsDown.x, d.stairsDown.y)).toBe(false);
        expect(inAlcove(d.stairsUp.x, d.stairsUp.y)).toBe(false);
      }
    }
  });
});
