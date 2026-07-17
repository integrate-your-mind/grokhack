import { generateDungeon } from "../../src/dungeon";
import { RNG } from "../../src/rng";
import type { Tile } from "../../src/types";

export const FLOOR_GENERATOR_VERSION = 1;
export const FLOOR_SIMULATION_PROFILE = "movement_plain_v1";

/** Keep older versions here while any persisted floor can still reference them. */
export function supportsFloorGeneratorVersion(version: number): boolean {
  return version === 1;
}

export interface FloorBootstrapCell {
  x: number;
  y: number;
  tile: Tile;
  spawnRank: number | null;
}

export interface FloorBootstrap {
  seed: number;
  generatorVersion: number;
  simulationProfile: typeof FLOOR_SIMULATION_PROFILE;
  width: number;
  height: number;
  entryX: number;
  entryY: number;
  cellCount: number;
  mapHash: string;
  cells: readonly FloorBootstrapCell[];
}

function fnv32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function fnv64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function hasPlainNeighbor(tiles: readonly (readonly Tile[])[], x: number, y: number): boolean {
  return (
    tiles[y - 1]?.[x] === "." ||
    tiles[y + 1]?.[x] === "." ||
    tiles[y]?.[x - 1] === "." ||
    tiles[y]?.[x + 1] === "."
  );
}

/**
 * Builds the persisted geometry for a new Floor Durable Object.
 *
 * The canonical object name is the only identity input. The generated cells,
 * seed, version, and map hash are all persisted by the caller in one SQLite
 * transaction, so eviction never depends on rerunning a possibly newer
 * generator implementation.
 */
export function buildFloorBootstrap(
  floorObjectName: string,
  depth: number,
  generatorVersion = FLOOR_GENERATOR_VERSION,
): FloorBootstrap {
  if (!supportsFloorGeneratorVersion(generatorVersion)) {
    throw new Error("floor_generator_version_unsupported");
  }
  const seed = fnv32(
    `grokhack:floor-bootstrap:v${generatorVersion}:${floorObjectName}`,
  ) || 1;
  const dungeon = generateDungeon(new RNG(seed), depth);
  const spawnCandidates: Array<{ x: number; y: number; score: number }> = [];

  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      if (dungeon.tiles[y]?.[x] !== "." || !hasPlainNeighbor(dungeon.tiles, x, y)) continue;
      if (
        (dungeon.stairsDown.x === x && dungeon.stairsDown.y === y) ||
        (dungeon.stairsUp.x === x && dungeon.stairsUp.y === y)
      ) {
        continue;
      }
      spawnCandidates.push({
        x,
        y,
        score: fnv32(`grokhack:floor-spawn:v1:${seed}:${x}:${y}`),
      });
    }
  }
  spawnCandidates.sort((left, right) =>
    left.score - right.score || left.y - right.y || left.x - right.x,
  );
  const entry = spawnCandidates[0];
  if (!entry) throw new Error("floor_generator_has_no_safe_spawn");

  const spawnRanks = new Map(
    spawnCandidates.map((candidate, rank) => [`${candidate.x},${candidate.y}`, rank]),
  );
  const cells: FloorBootstrapCell[] = [];
  const mapRows: string[] = [];
  for (let y = 0; y < dungeon.height; y++) {
    const row = dungeon.tiles[y];
    if (!row || row.length !== dungeon.width) throw new Error("floor_generator_invalid_width");
    mapRows.push(row.join(""));
    for (let x = 0; x < dungeon.width; x++) {
      const tile = row[x];
      if (tile === undefined) throw new Error("floor_generator_missing_cell");
      cells.push({
        x,
        y,
        tile,
        spawnRank: spawnRanks.get(`${x},${y}`) ?? null,
      });
    }
  }
  const spawnOrder = spawnCandidates.map(({ x, y }) => `${x},${y}`).join(";");
  const mapIdentity = [
    generatorVersion,
    seed,
    depth,
    dungeon.width,
    dungeon.height,
    mapRows.join("\n"),
    spawnOrder,
  ].join("|");

  return {
    seed,
    generatorVersion,
    simulationProfile: FLOOR_SIMULATION_PROFILE,
    width: dungeon.width,
    height: dungeon.height,
    entryX: entry.x,
    entryY: entry.y,
    cellCount: cells.length,
    mapHash: fnv64(mapIdentity),
    cells,
  };
}
