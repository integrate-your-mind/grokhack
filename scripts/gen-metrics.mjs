#!/usr/bin/env node
/**
 * Dungeon gen quality metrics report.
 *
 * Samples many seeds × depths and prints a JSON summary:
 * room counts, special-room rates, connectivity failures, layout uniqueness.
 *
 * Usage:
 *   node scripts/gen-metrics.mjs
 *   node scripts/gen-metrics.mjs --seeds 50 --depths 1-5
 *
 * Loads TypeScript sources via tsx (re-exec with node --import tsx when needed).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, "..");

if (!process.env.__GEN_METRICS_TSX__) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", __filename, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      cwd: root,
      env: { ...process.env, __GEN_METRICS_TSX__: "1" },
    }
  );
  process.exit(result.status ?? 1);
}

const { generateDungeon, isFullyConnected, isWalkable, roomCountRange } = await import(
  "../src/dungeon.ts"
);
const { RNG } = await import("../src/rng.ts");

function parseArgs(argv) {
  let seeds = 200;
  let depthLo = 1;
  let depthHi = 10;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seeds" && argv[i + 1]) seeds = Math.max(1, parseInt(argv[++i], 10));
    else if (a === "--depths" && argv[i + 1]) {
      const m = String(argv[++i]).match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        depthLo = parseInt(m[1], 10);
        depthHi = parseInt(m[2], 10);
      }
    }
  }
  return { seeds, depthLo, depthHi };
}

function countWalkable(tiles) {
  let n = 0;
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < tiles[y].length; x++) {
      if (isWalkable(tiles, x, y)) n++;
    }
  }
  return n;
}

function countDoors(tiles) {
  let n = 0;
  for (const row of tiles) {
    for (const t of row) if (t === "+") n++;
  }
  return n;
}

function stairsManhattan(d) {
  return Math.abs(d.stairsDown.x - d.stairsUp.x) + Math.abs(d.stairsDown.y - d.stairsUp.y);
}

function layoutFingerprint(d) {
  return [
    d.rooms.length,
    d.stairsDown.x,
    d.stairsDown.y,
    d.stairsUp.x,
    d.stairsUp.y,
    d.rooms.map((r) => `${r.x},${r.y},${r.w},${r.h},${r.special ?? ""},${r.locked ? "L" : ""}`).join("|"),
  ].join(";");
}

/** Rooms with walkable tiles that cannot be reached from stairsUp. */
function unreachableRoomCount(d) {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const seen = new Set();
  const q = [{ x: d.stairsUp.x, y: d.stairsUp.y }];
  seen.add(`${q[0].x},${q[0].y}`);
  while (q.length) {
    const cur = q.shift();
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
    let anyWalk = false;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (!isWalkable(d.tiles, x, y)) continue;
        anyWalk = true;
        if (seen.has(`${x},${y}`)) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (anyWalk && !hit) unreach++;
  }
  return unreach;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function minMax(arr) {
  if (!arr.length) return { min: 0, max: 0 };
  return { min: Math.min(...arr), max: Math.max(...arr) };
}

function main() {
  const { seeds, depthLo, depthHi } = parseArgs(process.argv.slice(2));
  const byDepth = {};
  let totalConnectivityFailures = 0;
  let totalUnreachableRoomFailures = 0;
  let totalLayouts = 0;
  const globalFingerprints = new Set();

  const t0 = Date.now();

  for (let depth = depthLo; depth <= depthHi; depth++) {
    const roomCounts = [];
    const walkable = [];
    const doors = [];
    const seps = [];
    const specials = { vault: 0, shrine: 0, barracks: 0, zoo: 0 };
    let floorsWithSpecial = 0;
    let vaultRooms = 0;
    let lockedVaults = 0;
    let connectivityFailures = 0;
    let unreachableRoomFailures = 0;
    let unreachableRoomTotal = 0;
    const fingerprints = new Set();
    const range = roomCountRange(depth);

    for (let i = 0; i < seeds; i++) {
      const seed = i * 10007 + depth * 17;
      const d = generateDungeon(new RNG(seed), depth);
      totalLayouts++;

      roomCounts.push(d.rooms.length);
      walkable.push(countWalkable(d.tiles));
      doors.push(countDoors(d.tiles));
      seps.push(stairsManhattan(d));

      let hasSpecial = false;
      for (const r of d.rooms) {
        if (!r.special) continue;
        hasSpecial = true;
        if (specials[r.special] !== undefined) specials[r.special]++;
        if (r.special === "vault") {
          vaultRooms++;
          if (r.locked) lockedVaults++;
        }
      }
      if (hasSpecial) floorsWithSpecial++;

      if (!isFullyConnected(d.tiles)) {
        connectivityFailures++;
        totalConnectivityFailures++;
      }

      const unreach = unreachableRoomCount(d);
      unreachableRoomTotal += unreach;
      if (unreach > 0) {
        unreachableRoomFailures++;
        totalUnreachableRoomFailures++;
      }

      const fp = layoutFingerprint(d);
      fingerprints.add(fp);
      globalFingerprints.add(`${depth}:${fp}`);
    }

    const rc = minMax(roomCounts);
    const wc = minMax(walkable);
    const dc = minMax(doors);
    const sc = minMax(seps);

    byDepth[depth] = {
      samples: seeds,
      roomCountRange: range,
      rooms: {
        mean: +mean(roomCounts).toFixed(2),
        min: rc.min,
        max: rc.max,
        belowMin: roomCounts.filter((n) => n < range.min).length,
        aboveMax: roomCounts.filter((n) => n > range.max).length,
      },
      walkableFloor: {
        mean: +mean(walkable).toFixed(1),
        min: wc.min,
        max: wc.max,
      },
      doors: {
        mean: +mean(doors).toFixed(2),
        min: dc.min,
        max: dc.max,
      },
      stairsManhattan: {
        mean: +mean(seps).toFixed(1),
        min: sc.min,
        max: sc.max,
      },
      specialRates: {
        /** Fraction of floors with ≥1 special room */
        anySpecial: +(floorsWithSpecial / seeds).toFixed(3),
        /** Mean count per floor for each special type */
        vault: +(specials.vault / seeds).toFixed(3),
        shrine: +(specials.shrine / seeds).toFixed(3),
        barracks: +(specials.barracks / seeds).toFixed(3),
        zoo: +(specials.zoo / seeds).toFixed(3),
      },
      vaultLockRate: vaultRooms ? +(lockedVaults / vaultRooms).toFixed(3) : null,
      connectivityFailures,
      unreachableRoomFailures,
      unreachableRoomsTotal: unreachableRoomTotal,
      layoutUniqueness: {
        unique: fingerprints.size,
        samples: seeds,
        rate: +(fingerprints.size / seeds).toFixed(3),
      },
    };
  }

  const report = {
    meta: {
      seedsPerDepth: seeds,
      depths: `${depthLo}-${depthHi}`,
      totalLayouts,
      elapsedMs: Date.now() - t0,
      generator: "generateDungeon",
    },
    summary: {
      connectivityFailures: totalConnectivityFailures,
      unreachableRoomFailures: totalUnreachableRoomFailures,
      globalUniqueLayouts: globalFingerprints.size,
      /** Must stay 0 for ship-quality gen */
      ok:
        totalConnectivityFailures === 0 && totalUnreachableRoomFailures === 0,
    },
    byDepth,
  };

  console.log(JSON.stringify(report, null, 2));

  if (!report.summary.ok) {
    console.error(
      `\n[gen-metrics] FAIL: connectivityFailures=${totalConnectivityFailures} unreachableRoomFailures=${totalUnreachableRoomFailures}`
    );
    process.exit(1);
  }
}

main();
