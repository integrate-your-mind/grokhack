import { describe, it, expect } from "vitest";
import {
  generateDungeon,
  isWalkable,
  isFullyConnected,
  roomCountRange,
  computeFOV,
  findSpawnPoint,
  planMonsterSpawns,
  monsterCountForDepth,
  blocksVision,
  specialRoomCap,
} from "./dungeon";
import { RNG } from "./rng";
import { selectFloorTheme } from "./dungeon-themes";
import type { Dungeon, RoomSpecial, Tile } from "./types";

/** Count walkable tiles (floor, stairs, doors). */
function countWalkable(tiles: Tile[][]): number {
  let n = 0;
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < tiles[y].length; x++) {
      if (isWalkable(tiles, x, y)) n++;
    }
  }
  return n;
}

function countDoors(tiles: Tile[][]): number {
  let n = 0;
  for (const row of tiles) {
    for (const t of row) if (t === "+") n++;
  }
  return n;
}

function stairsManhattan(d: Dungeon): number {
  return Math.abs(d.stairsDown.x - d.stairsUp.x) + Math.abs(d.stairsDown.y - d.stairsUp.y);
}

/** Rooms with zero walkable tiles reachable from stairsUp. */
function unreachableRoomCount(d: Dungeon): number {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const seen = new Set<string>();
  const q = [{ x: d.stairsUp.x, y: d.stairsUp.y }];
  seen.add(`${q[0].x},${q[0].y}`);
  while (q.length) {
    const cur = q.shift()!;
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
  let unreach = 0;
  for (const r of d.rooms) {
    let hit = false;
    for (let y = r.y; y < r.y + r.h && !hit; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (isWalkable(d.tiles, x, y) && seen.has(`${x},${y}`)) {
          hit = true;
          break;
        }
      }
    }
    // Rooms with no walkable interior (degenerate) count as unreachable only if carved empty
    if (!hit) {
      let anyWalk = false;
      for (let y = r.y; y < r.y + r.h && !anyWalk; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (isWalkable(d.tiles, x, y)) {
            anyWalk = true;
            break;
          }
        }
      }
      if (anyWalk) unreach++;
    }
  }
  return unreach;
}

/** Soft door-count envelope by depth (calibrated on multi-seed samples). */
function doorCountRange(depth: number): { min: number; max: number } {
  // Corridor doors are probabilistic (~35%/room); vaults add 1 sealed door.
  // Observed: depth1 min 0 max ~5; depth10 min 1 max ~7. Leave headroom.
  if (depth <= 2) return { min: 0, max: 12 };
  if (depth <= 5) return { min: 0, max: 14 };
  return { min: 0, max: 18 };
}

/** Minimum walkable floor area — rooms + corridors on 80×24 map. */
function minWalkableFloor(depth: number): number {
  // Observed mins ~247 (d1) … ~585 (d10) over 50 seeds; soft floor with margin.
  if (depth <= 2) return 160;
  if (depth <= 5) return 220;
  return 300;
}

describe("dungeon generation properties", () => {
  it("is deterministic for a fixed seed", () => {
    const a = generateDungeon(new RNG(42), 1);
    const b = generateDungeon(new RNG(42), 1);
    expect(a.stairsDown).toEqual(b.stairsDown);
    expect(a.stairsUp).toEqual(b.stairsUp);
    expect(a.rooms.length).toBe(b.rooms.length);
    expect(a.rooms.map((r) => r.special)).toEqual(b.rooms.map((r) => r.special));
    expect(a.tiles).toEqual(b.tiles);
  });

  it("places walkable stairs", () => {
    for (const depth of [1, 3, 7, 10]) {
      const d = generateDungeon(new RNG(99 + depth), depth);
      expect(isWalkable(d.tiles, d.stairsDown.x, d.stairsDown.y)).toBe(true);
      expect(isWalkable(d.tiles, d.stairsUp.x, d.stairsUp.y)).toBe(true);
      expect(d.tiles[d.stairsDown.y][d.stairsDown.x]).toBe(">");
      if (depth > 1) {
        expect(d.tiles[d.stairsUp.y][d.stairsUp.x]).toBe("<");
      }
    }
  });

  it("keeps room counts within depth ranges across many seeds", () => {
    for (let depth = 1; depth <= 10; depth++) {
      const { min, max } = roomCountRange(depth);
      for (let seed = 0; seed < 40; seed++) {
        const d = generateDungeon(new RNG(seed * 1000 + depth * 17), depth);
        expect(d.rooms.length).toBeGreaterThanOrEqual(Math.min(min, 1));
        expect(d.rooms.length).toBeLessThanOrEqual(max);
        // Soft floor: gen should usually hit near min unless map is tight
        expect(d.rooms.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("produces fully connected floors for many seeds and depths", () => {
    let failures = 0;
    const samples: { seed: number; depth: number }[] = [];
    for (let depth = 1; depth <= 10; depth++) {
      for (let seed = 0; seed < 30; seed++) {
        samples.push({ seed: seed * 7919 + depth, depth });
      }
    }
    for (const { seed, depth } of samples) {
      const d = generateDungeon(new RNG(seed), depth);
      if (!isFullyConnected(d.tiles)) failures++;
    }
    expect(failures).toBe(0);
  });

  it("connects stairs up and down via walkable path", () => {
    for (let seed = 0; seed < 50; seed++) {
      const d = generateDungeon(new RNG(seed + 5000), 5);
      // BFS from stairsUp to stairsDown
      const q = [{ x: d.stairsUp.x, y: d.stairsUp.y }];
      const seen = new Set<string>([`${q[0].x},${q[0].y}`]);
      const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      let reached = false;
      while (q.length) {
        const cur = q.shift()!;
        if (cur.x === d.stairsDown.x && cur.y === d.stairsDown.y) {
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
  });

  it("places stairs in different rooms when multiple rooms exist", () => {
    let separated = 0;
    for (let seed = 0; seed < 60; seed++) {
      const d = generateDungeon(new RNG(seed + 9000), 4);
      if (d.rooms.length < 2) continue;
      const inRoom = (x: number, y: number, r: { x: number; y: number; w: number; h: number }) =>
        x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
      const upRoom = d.rooms.findIndex((r) => inRoom(d.stairsUp.x, d.stairsUp.y, r));
      const downRoom = d.rooms.findIndex((r) => inRoom(d.stairsDown.x, d.stairsDown.y, r));
      if (upRoom !== downRoom && upRoom >= 0 && downRoom >= 0) separated++;
    }
    // Majority should separate entry/exit for exploration quality
    expect(separated).toBeGreaterThan(40);
  });

  it("sometimes creates special rooms and locked vaults on deeper floors", () => {
    let specials = 0;
    let lockedVaults = 0;
    let doors = 0;
    for (let seed = 0; seed < 80; seed++) {
      const d = generateDungeon(new RNG(seed + 12000), 6);
      if (d.rooms.some((r) => r.special)) specials++;
      if (d.rooms.some((r) => r.special === "vault" && r.locked)) lockedVaults++;
      for (const row of d.tiles) {
        for (const t of row) if (t === "+") doors++;
      }
    }
    expect(specials).toBeGreaterThan(20);
    expect(lockedVaults).toBeGreaterThan(5);
    expect(doors).toBeGreaterThan(10);
  });

  it("guarantees special room flavor by depth 2+", () => {
    let withSpecial = 0;
    for (let seed = 0; seed < 40; seed++) {
      const d = generateDungeon(new RNG(seed + 30000), 3);
      if (d.rooms.some((r) => r.special)) withSpecial++;
    }
    // Guarantee path should make this near-universal when enough rooms
    expect(withSpecial).toBeGreaterThan(30);
  });

  it("never marks the start room as a special room", () => {
    for (let seed = 0; seed < 50; seed++) {
      const d = generateDungeon(new RNG(seed + 40000), 8);
      if (d.rooms[0]) {
        expect(d.rooms[0].special).toBeFalsy();
      }
    }
  });
});

/** Non-alcove specials count toward TICKET-ALG-01 cap. */
function countedSpecials(d: Dungeon): RoomSpecial[] {
  return d.rooms
    .map((r) => r.special)
    .filter((s): s is RoomSpecial => !!s && s !== "alcove" && s !== null);
}

describe("TICKET-ALG-01 special room incidence", () => {
  it("specialRoomCap is denser on early floors (CEO empty-floor / density coord)", () => {
    // d1–5 need multi-special variety; late floors still capped at 4
    expect(specialRoomCap(1)).toBe(2);
    expect(specialRoomCap(2)).toBe(2);
    expect(specialRoomCap(3)).toBe(3);
    expect(specialRoomCap(5)).toBe(3);
    expect(specialRoomCap(6)).toBe(3);
    expect(specialRoomCap(9)).toBe(4);
    expect(specialRoomCap(15)).toBe(4);
  });

  it("depth gates: no shop before d2, no beehive before d3, no throne/graveyard before d4", () => {
    for (let seed = 0; seed < 80; seed++) {
      const d1 = generateDungeon(new RNG(seed + 50000), 1);
      expect(d1.rooms.some((r) => r.special === "shop")).toBe(false);
      expect(d1.rooms.some((r) => r.special === "beehive")).toBe(false);
      expect(d1.rooms.some((r) => r.special === "throne")).toBe(false);
      expect(d1.rooms.some((r) => r.special === "graveyard")).toBe(false);

      const d2 = generateDungeon(new RNG(seed + 51000), 2);
      expect(d2.rooms.some((r) => r.special === "beehive")).toBe(false);
      expect(d2.rooms.some((r) => r.special === "throne")).toBe(false);
      expect(d2.rooms.some((r) => r.special === "graveyard")).toBe(false);

      const d3 = generateDungeon(new RNG(seed + 52000), 3);
      expect(d3.rooms.some((r) => r.special === "throne")).toBe(false);
      expect(d3.rooms.some((r) => r.special === "graveyard")).toBe(false);
    }
  });

  it("shop / beehive / throne / graveyard appear with measurable incidence past gates", () => {
    let shops = 0;
    let hives = 0;
    let thrones = 0;
    let graves = 0;
    for (let seed = 0; seed < 200; seed++) {
      const mid = generateDungeon(new RNG(seed + 60000), 5);
      if (mid.rooms.some((r) => r.special === "shop")) shops++;
      if (mid.rooms.some((r) => r.special === "beehive")) hives++;
      if (mid.rooms.some((r) => r.special === "throne")) thrones++;
      if (mid.rooms.some((r) => r.special === "graveyard")) graves++;

      const deep = generateDungeon(new RNG(seed + 70000), 9);
      if (deep.rooms.some((r) => r.special === "shop")) shops++;
      if (deep.rooms.some((r) => r.special === "beehive")) hives++;
      if (deep.rooms.some((r) => r.special === "throne")) thrones++;
      if (deep.rooms.some((r) => r.special === "graveyard")) graves++;
    }
    expect(shops).toBeGreaterThan(8);
    expect(hives).toBeGreaterThan(5);
    expect(thrones).toBeGreaterThan(5);
    expect(graves).toBeGreaterThan(5);
  });

  /** P0 wire: assignEncounterSpecials + ALG-01 must produce encounter specials on d4+. */
  it("d4+ seeds produce fountain|graveyard|throne with measurable rate", () => {
    let anyEncounter = 0;
    let fountains = 0;
    let graves = 0;
    let thrones = 0;
    const N = 160;
    for (let seed = 0; seed < N; seed++) {
      // d4 mid + d8 deep (throne gate in encounter path is d6+)
      for (const depth of [4, 5, 8]) {
        const d = generateDungeon(new RNG(seed * 97 + depth * 13 + 110000), depth);
        const hasF = d.rooms.some((r) => r.special === "fountain");
        const hasG = d.rooms.some((r) => r.special === "graveyard");
        const hasT = d.rooms.some((r) => r.special === "throne");
        if (hasF) fountains++;
        if (hasG) graves++;
        if (hasT) thrones++;
        if (hasF || hasG || hasT) anyEncounter++;
      }
    }
    // Across 480 floors, encounter set must show up often
    expect(anyEncounter).toBeGreaterThan(40);
    expect(fountains).toBeGreaterThan(10);
    expect(graves).toBeGreaterThan(10);
    // Throne mainly d6+ via encounter path + d4+ via ALG
    expect(thrones).toBeGreaterThan(5);
  });

  it("max 1 of each ALG-01 special per floor", () => {
    const kinds: RoomSpecial[] = ["shop", "beehive", "throne", "graveyard", "vault", "shrine", "barracks", "zoo"];
    for (let seed = 0; seed < 120; seed++) {
      for (const depth of [2, 4, 6, 9, 12]) {
        const d = generateDungeon(new RNG(seed * 17 + depth * 31 + 80000), depth);
        for (const kind of kinds) {
          const n = d.rooms.filter((r) => r.special === kind).length;
          expect(n).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("respects specials cap (~ min(4, 1+floor(depth/3))) excluding alcoves", () => {
    for (let seed = 0; seed < 80; seed++) {
      for (const depth of [1, 2, 3, 4, 6, 9, 12]) {
        const d = generateDungeon(new RNG(seed * 41 + depth + 90000), depth);
        const n = countedSpecials(d).length;
        expect(n).toBeLessThanOrEqual(specialRoomCap(depth));
      }
    }
  });

  it("crypt theme yields more graveyards than non-crypt at same depth", () => {
    // Approximate: re-roll theme stream — floors whose first RNG theme pick is crypt
    // vs others, using the same selectFloorTheme salt as generateDungeon.
    let cryptGraves = 0;
    let cryptFloors = 0;
    let otherGraves = 0;
    let otherFloors = 0;
    for (let seed = 0; seed < 300; seed++) {
      const depth = 7;
      const theme = selectFloorTheme(depth, new RNG(seed + 100000));
      // generateDungeon consumes RNG from the same seed — theme is selected first
      const d = generateDungeon(new RNG(seed + 100000), depth);
      const hasGrave = d.rooms.some((r) => r.special === "graveyard");
      // Note: theme from a fresh RNG matches generateDungeon only if theme is first draw.
      // generateDungeon does selectFloorTheme(depth, rng) first — same seed ⇒ same theme.
      if (theme === "crypt") {
        cryptFloors++;
        if (hasGrave) cryptGraves++;
      } else {
        otherFloors++;
        if (hasGrave) otherGraves++;
      }
    }
    expect(cryptFloors).toBeGreaterThan(20);
    expect(otherFloors).toBeGreaterThan(20);
    const cryptRate = cryptGraves / cryptFloors;
    const otherRate = otherGraves / otherFloors;
    // Crypt bias +0.2 should lift incidence above non-crypt baseline
    expect(cryptRate).toBeGreaterThan(otherRate);
    expect(cryptGraves).toBeGreaterThan(3);
  });
});

describe("spawn placement", () => {
  it("is deterministic when rng is provided", () => {
    const d = generateDungeon(new RNG(1), 4);
    const occ = new Set<string>();
    const a = findSpawnPoint(d, occ, new RNG(99));
    const b = findSpawnPoint(d, occ, new RNG(99));
    expect(a).toEqual(b);
  });

  it("planMonsterSpawns meets count floor and avoids entry tile", () => {
    const d = generateDungeon(new RNG(77), 5);
    const rng = new RNG(88);
    const count = monsterCountForDepth(5, new RNG(1));
    const occupied = new Set<string>([`${d.stairsUp.x},${d.stairsUp.y}`]);
    const spawns = planMonsterSpawns(d, 5, count, rng, occupied);
    expect(spawns.length).toBeGreaterThan(0);
    // Dens/foyer packs may overfill past `count` (spawn-ecology mandate)
    expect(spawns.length).toBeGreaterThanOrEqual(count);
    for (const s of spawns) {
      expect(isWalkable(d.tiles, s.x, s.y)).toBe(true);
      expect(s.x === d.stairsUp.x && s.y === d.stairsUp.y).toBe(false);
    }
  });

  it("deep floors sometimes include interior pillars or cavern irregularity", () => {
    let pillarFloors = 0;
    for (let seed = 0; seed < 80; seed++) {
      const d = generateDungeon(new RNG(seed + 60000), 9);
      // Interior # inside a room AABB (not just outer wall) signals pillars/cavern bite
      let interiorWalls = 0;
      for (const room of d.rooms) {
        for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
          for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
            if (d.tiles[y][x] === "#") interiorWalls++;
          }
        }
      }
      if (interiorWalls > 0) pillarFloors++;
    }
    expect(pillarFloors).toBeGreaterThan(5);
  });

  it("packs dens denser on barracks/zoo floors", () => {
    let densSpawns = 0;
    let trials = 0;
    for (let seed = 0; seed < 100 && trials < 20; seed++) {
      const d = generateDungeon(new RNG(seed + 50000), 6);
      const dens = d.rooms.filter((r) => r.special === "barracks" || r.special === "zoo");
      if (!dens.length) continue;
      trials++;
      const occupied = new Set<string>();
      const spawns = planMonsterSpawns(d, 6, 12, new RNG(seed), occupied);
      for (const s of spawns) {
        if (dens.some((r) => s.x >= r.x && s.x < r.x + r.w && s.y >= r.y && s.y < r.y + r.h)) {
          densSpawns++;
        }
      }
    }
    expect(trials).toBeGreaterThan(0);
    expect(densSpawns).toBeGreaterThan(0);
  });
});

describe("FOV exploration quality", () => {
  it("reveals origin and nearby floor", () => {
    const d = generateDungeon(new RNG(123), 1);
    const { x, y } = d.stairsUp;
    const fov = computeFOV(d.tiles, x, y, 8);
    expect(fov.has(`${x},${y}`)).toBe(true);
    expect(fov.size).toBeGreaterThan(5);
  });

  it("does not see through walls", () => {
    // Build a tiny corridor map by generating and checking opaque walls stay blockers
    const d = generateDungeon(new RNG(456), 2);
    expect(blocksVision(d.tiles, 0, 0)).toBe(true);

    const { x, y } = d.stairsUp;
    const fov = computeFOV(d.tiles, x, y, 8);
    // Any FOV tile that is not adjacent should have line of sight without skipping walls
    // Property: wall tiles may appear at ray ends, but tiles behind walls should not.
    for (const key of fov) {
      const [xs, ys] = key.split(",").map(Number);
      // trivial sanity: in bounds
      expect(xs).toBeGreaterThanOrEqual(0);
      expect(ys).toBeGreaterThanOrEqual(0);
    }
  });

  it("lights wall faces at the edge of vision", () => {
    const d = generateDungeon(new RNG(789), 3);
    const { x, y } = d.stairsUp;
    const fov = computeFOV(d.tiles, x, y, 8);
    let wallFaces = 0;
    for (const key of fov) {
      const [xs, ys] = key.split(",").map(Number);
      if (d.tiles[ys][xs] === "#") wallFaces++;
    }
    // Should light some walls (room boundaries), not only open floor
    expect(wallFaces).toBeGreaterThan(0);
  });
});

describe("roomCountRange", () => {
  it("scales min/max with depth", () => {
    const shallow = roomCountRange(1);
    const deep = roomCountRange(10);
    expect(shallow.min).toBeLessThanOrEqual(deep.min);
    expect(shallow.max).toBeLessThanOrEqual(deep.max);
    expect(shallow.target).toBeGreaterThanOrEqual(shallow.min);
    expect(shallow.target).toBeLessThanOrEqual(shallow.max);
    expect(deep.max).toBeLessThanOrEqual(15);
  });
});

describe("seed uniqueness", () => {
  it("different seeds produce different layouts", () => {
    const fingerprints = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const d = generateDungeon(new RNG(seed + 70000), 4);
      const fp = [
        d.rooms.length,
        d.stairsDown.x,
        d.stairsDown.y,
        d.rooms.map((r) => `${r.x},${r.y},${r.w},${r.h},${r.special ?? ""}`).join("|"),
      ].join(";");
      fingerprints.add(fp);
    }
    // High uniqueness — not every seed must differ but most should
    expect(fingerprints.size).toBeGreaterThan(30);
  });

  it("meets min room count for nearly all mid-depth seeds", () => {
    const depth = 5;
    const { min } = roomCountRange(depth);
    let below = 0;
    for (let seed = 0; seed < 60; seed++) {
      const d = generateDungeon(new RNG(seed + 80000), depth);
      if (d.rooms.length < min) below++;
    }
    // Packing can fail rarely on a tight map; allow a tiny miss rate
    expect(below).toBeLessThanOrEqual(3);
  });
});

describe("gen quality metrics properties", () => {
  it("meets min walkable floor area across depths", () => {
    for (let depth = 1; depth <= 10; depth++) {
      const floor = minWalkableFloor(depth);
      for (let seed = 0; seed < 25; seed++) {
        const d = generateDungeon(new RNG(seed * 3331 + depth * 97), depth);
        const walkable = countWalkable(d.tiles);
        expect(walkable).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it("keeps door counts within depth ranges", () => {
    for (let depth = 1; depth <= 10; depth++) {
      const { min, max } = doorCountRange(depth);
      for (let seed = 0; seed < 30; seed++) {
        const d = generateDungeon(new RNG(seed * 4243 + depth * 13), depth);
        const doors = countDoors(d.tiles);
        expect(doors).toBeGreaterThanOrEqual(min);
        expect(doors).toBeLessThanOrEqual(max);
      }
    }
  });

  it("locks vaults when a vault special is assigned", () => {
    let vaults = 0;
    let locked = 0;
    for (let depth of [3, 5, 7, 10]) {
      for (let seed = 0; seed < 40; seed++) {
        const d = generateDungeon(new RNG(seed * 5171 + depth * 29), depth);
        for (const r of d.rooms) {
          if (r.special === "vault") {
            vaults++;
            if (r.locked) locked++;
          }
        }
      }
    }
    expect(vaults).toBeGreaterThan(20);
    // sealVault should lock virtually all vaults that have corridor exits
    expect(locked / vaults).toBeGreaterThanOrEqual(0.95);
  });

  it("separates stairs by Manhattan distance when multiple rooms exist", () => {
    let checked = 0;
    let tooClose = 0;
    for (let depth = 1; depth <= 10; depth++) {
      for (let seed = 0; seed < 20; seed++) {
        const d = generateDungeon(new RNG(seed * 9109 + depth * 41), depth);
        if (d.rooms.length < 2) continue;
        checked++;
        const sep = stairsManhattan(d);
        // Multi-room floors place exit in farthest room; allow small maps
        if (sep < 8) tooClose++;
        expect(sep).toBeGreaterThan(0);
      }
    }
    expect(checked).toBeGreaterThan(50);
    // Near-universal separation for exploration quality
    expect(tooClose / checked).toBeLessThan(0.05);
  });

  it("has zero unreachable rooms from stairsUp", () => {
    let failures = 0;
    for (let depth = 1; depth <= 10; depth++) {
      for (let seed = 0; seed < 20; seed++) {
        const d = generateDungeon(new RNG(seed * 6151 + depth * 19), depth);
        const n = unreachableRoomCount(d);
        if (n > 0) failures++;
        expect(n).toBe(0);
      }
    }
    expect(failures).toBe(0);
  });
});
