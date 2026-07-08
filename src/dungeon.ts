import { RNG } from "./rng";
import type { Dungeon, Room, Tile } from "./types";

const WIDTH = 80;
const HEIGHT = 24;
const MAX_ROOMS = 12;
const MIN_ROOM = 4;
const MAX_ROOM = 10;

function createEmptyGrid(): Tile[][] {
  return Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, () => "#" as Tile)
  );
}

function roomsOverlap(a: Room, b: Room, padding = 1): boolean {
  return (
    a.x - padding < b.x + b.w + padding &&
    a.x + a.w + padding > b.x - padding &&
    a.y - padding < b.y + b.h + padding &&
    a.y + a.h + padding > b.y - padding
  );
}

function carveRoom(tiles: Tile[][], room: Room): void {
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      tiles[y][x] = ".";
    }
  }
}

function carveHorizontal(tiles: Tile[][], x1: number, x2: number, y: number): void {
  const start = Math.min(x1, x2);
  const end = Math.max(x1, x2);
  for (let x = start; x <= end; x++) {
    if (tiles[y][x] === "#") tiles[y][x] = ".";
  }
}

function carveVertical(tiles: Tile[][], y1: number, y2: number, x: number): void {
  const start = Math.min(y1, y2);
  const end = Math.max(y1, y2);
  for (let y = start; y <= end; y++) {
    if (tiles[y][x] === "#") tiles[y][x] = ".";
  }
}

function connectRooms(tiles: Tile[][], a: Room, b: Room, rng: RNG): void {
  const ax = rng.int(a.x, a.x + a.w - 1);
  const ay = rng.int(a.y, a.y + a.h - 1);
  const bx = rng.int(b.x, b.x + b.w - 1);
  const by = rng.int(b.y, b.y + b.h - 1);

  if (rng.chance(0.5)) {
    carveHorizontal(tiles, ax, bx, ay);
    carveVertical(tiles, ay, by, bx);
  } else {
    carveVertical(tiles, ay, by, ax);
    carveHorizontal(tiles, ax, bx, by);
  }
}

function floorTiles(tiles: Tile[][]): { x: number; y: number }[] {
  const floors: { x: number; y: number }[] = [];
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < tiles[0].length; x++) {
      if (tiles[y][x] === ".") floors.push({ x, y });
    }
  }
  return floors;
}

export function generateDungeon(rng: RNG, depth: number): Dungeon {
  const tiles = createEmptyGrid();
  const rooms: Room[] = [];

  for (let attempt = 0; attempt < 80 && rooms.length < MAX_ROOMS; attempt++) {
    const w = rng.int(MIN_ROOM, MAX_ROOM);
    const h = rng.int(MIN_ROOM, MAX_ROOM);
    const x = rng.int(1, WIDTH - w - 2);
    const y = rng.int(1, HEIGHT - h - 2);
    const room: Room = { x, y, w, h };

    if (rooms.some((r) => roomsOverlap(r, room))) continue;

    carveRoom(tiles, room);
    if (rooms.length > 0) {
      connectRooms(tiles, rooms[rooms.length - 1], room, rng);
    }
    rooms.push(room);
  }

  // Extra connections for loops
  for (let i = 0; i < Math.min(3, rooms.length - 1); i++) {
    const a = rng.pick(rooms);
    const b = rng.pick(rooms);
    if (a !== b) connectRooms(tiles, a, b, rng);
  }

  const floors = floorTiles(tiles);
  const stairsDown = rng.pick(floors);
  tiles[stairsDown.y][stairsDown.x] = ">";

  const upCandidates = floors.filter(
    (f) => f.x !== stairsDown.x || f.y !== stairsDown.y
  );
  const stairsUp = depth > 1 ? rng.pick(upCandidates) : stairsDown;
  if (depth > 1) tiles[stairsUp.y][stairsUp.x] = "<";

  return {
    width: WIDTH,
    height: HEIGHT,
    tiles,
    rooms,
    stairsDown,
    stairsUp,
  };
}

export function isWalkable(tiles: Tile[][], x: number, y: number): boolean {
  if (x < 0 || y < 0 || y >= tiles.length || x >= tiles[0].length) return false;
  const t = tiles[y][x];
  return t === "." || t === ">" || t === "<";
}

export function findSpawnPoint(
  dungeon: Dungeon,
  occupied: Set<string>
): { x: number; y: number } | null {
  const candidates: { x: number; y: number }[] = [];
  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      const key = `${x},${y}`;
      if (
        dungeon.tiles[y][x] === "." &&
        !occupied.has(key) &&
        !(dungeon.stairsDown.x === x && dungeon.stairsDown.y === y)
      ) {
        candidates.push({ x, y });
      }
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}