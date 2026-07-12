/**
 * GrokHack browser voluntary compute Web Worker.
 *
 * Protocol (play.js posts jobs here; WS uses compute_offer / compute_job /
 * compute_result / compute_ack):
 *   main → { type:"solve", job_id, job_type, payload }
 *   worker → { type:"solved", job_id, ok, result?, error?, ms }
 *
 * Solvers MUST match server re-validation in server/compute.ts:
 *   hash_check      → serverHashCheck (SHA-256 hex prefix 16 of "challenge:nonce")
 *   fov_rays        → src/dungeon.ts computeFOV (multi-ray + 3×3 near fill)
 *   pathfind_bfs    → serverPathfindBfs (cardinal BFS; target accepted even if unwalkable)
 *   gen_validation  → isWalkable floors + isFullyConnected-equivalent BFS
 *
 * dungeon_seed_search is intentionally unsupported: generateDungeon + theme packs
 * + ensureConnectivity live only in src/dungeon.ts / server and cannot be
 * duplicated here without importing server code. play.js omits this job_type
 * from compute_offer; if assigned, we return ok:false.
 *
 * Trust: results are never combat/world authority — server always re-validates.
 */
/** Normalize tile grid the same way server/compute normalizeTiles does. */
function normalizeTiles(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const tiles = [];
  for (const row of raw) {
    if (!Array.isArray(row)) return null;
    tiles.push(row.map((c) => String(c)[0]));
  }
  return tiles;
}

async function sha256Prefix16(str) {
  if (globalThis.crypto?.subtle) {
    const data = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
  }
  // Must match Node createHash("sha256").digest("hex").slice(0, 16)
  throw new Error("crypto.subtle required for hash_check");
}

/** Match src/dungeon.ts isWalkable */
function isWalkable(tiles, x, y) {
  if (y < 0 || x < 0 || y >= tiles.length || x >= tiles[0].length) return false;
  const t = tiles[y][x];
  return t === "." || t === ">" || t === "<" || t === "+";
}

/** Match src/dungeon.ts blocksVision */
function blocksVision(tiles, x, y) {
  if (y < 0 || x < 0 || y >= tiles.length || x >= tiles[0].length) return true;
  return tiles[y][x] === "#";
}

/** Match src/dungeon.ts computeFOV (multi-ray + adjacent fill). */
function computeFOV(tiles, ox, oy, radius) {
  const visible = new Set([`${ox},${oy}`]);
  const height = tiles.length;
  const width = tiles[0]?.length ?? 0;
  const r2 = radius * radius;
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < width && y < height) visible.add(`${x},${y}`);
  };
  const rays = Math.max(64, radius * 16);
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let prevX = ox;
    let prevY = oy;
    for (let step = 1; step <= radius + 1; step++) {
      const x = ox + Math.round(cos * step);
      const y = oy + Math.round(sin * step);
      if (x === prevX && y === prevY) continue;
      prevX = x;
      prevY = y;
      if (x < 0 || y < 0 || x >= width || y >= height) break;
      const dist2 = (x - ox) * (x - ox) + (y - oy) * (y - oy);
      if (dist2 > r2 + radius) break;
      mark(x, y);
      if (blocksVision(tiles, x, y)) break;
    }
  }
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) mark(ox + dx, oy + dy);
  }
  return visible;
}

/** Match server/compute.ts serverPathfindBfs */
function pathfindBfs(tiles, sx, sy, tx, ty) {
  if (sx === tx && sy === ty) return { path: [`${sx},${sy}`], dist: 0 };
  const key = (x, y) => `${x},${y}`;
  const q = [{ x: sx, y: sy }];
  const prev = new Map();
  prev.set(key(sx, sy), null);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (q.length) {
    const cur = q.shift();
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const k = key(nx, ny);
      if (prev.has(k)) continue;
      // Target accepted without isWalkable (matches serverPathfindBfs)
      if (nx === tx && ny === ty) {
        prev.set(k, key(cur.x, cur.y));
        const path = [k];
        let p = prev.get(k) ?? null;
        while (p) {
          path.push(p);
          p = prev.get(p) ?? null;
        }
        path.reverse();
        return { path, dist: path.length - 1 };
      }
      if (!isWalkable(tiles, nx, ny)) continue;
      prev.set(k, key(cur.x, cur.y));
      q.push({ x: nx, y: ny });
    }
  }
  return { path: null, dist: -1 };
}

/**
 * Match serverGenValidation = floorCount(isWalkable) + isFullyConnected.
 * BFS from first row-major walkable tile; connected iff all floors reached.
 */
function genValidation(tiles) {
  let floorCount = 0;
  const floors = [];
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < (tiles[0]?.length ?? 0); x++) {
      if (isWalkable(tiles, x, y)) {
        floorCount++;
        floors.push({ x, y });
      }
    }
  }
  if (floors.length === 0) return { connected: false, floorCount: 0 };
  const start = floors[0];
  const seen = new Set([`${start.x},${start.y}`]);
  const q = [start];
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (q.length) {
    const cur = q.shift();
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      if (!isWalkable(tiles, nx, ny)) continue;
      seen.add(k);
      q.push({ x: nx, y: ny });
    }
  }
  return { connected: seen.size === floors.length, floorCount };
}

async function solve(jobType, payload) {
  switch (jobType) {
    case "hash_check": {
      const challenge = String(payload.challenge ?? "");
      const nonceStart = Number(payload.nonceStart ?? 0);
      // Match serverHashCheck clamp [1, 64]
      const count = Math.min(Math.max(Number(payload.count) || 1, 1), 64);
      const digests = [];
      for (let i = 0; i < count; i++) {
        digests.push(await sha256Prefix16(`${challenge}:${nonceStart + i}`));
      }
      return { digests };
    }
    case "fov_rays": {
      const tiles = normalizeTiles(payload.tiles);
      if (!tiles) throw new Error("bad tiles");
      const cells = [
        ...computeFOV(tiles, Number(payload.ox), Number(payload.oy), Number(payload.radius)),
      ].sort();
      return { cells };
    }
    case "pathfind_bfs": {
      const tiles = normalizeTiles(payload.tiles);
      if (!tiles) throw new Error("bad tiles");
      return pathfindBfs(
        tiles,
        Number(payload.sx),
        Number(payload.sy),
        Number(payload.tx),
        Number(payload.ty)
      );
    }
    case "gen_validation": {
      const tiles = normalizeTiles(payload.tiles);
      if (!tiles) throw new Error("bad tiles");
      return genValidation(tiles);
    }
    case "dungeon_seed_search":
      // Unsupported: needs generateDungeon + isFullyConnected from src/dungeon.ts
      // (full generator with themes/packs). Server-only job type.
      throw new Error(
        "dungeon_seed_search not supported in browser worker (requires server generateDungeon)"
      );
    default:
      throw new Error("unknown job_type " + jobType);
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "solve") return;
  const t0 = performance.now();
  try {
    const result = await solve(msg.job_type, msg.payload || {});
    self.postMessage({
      type: "solved",
      job_id: msg.job_id,
      ok: true,
      result,
      ms: Math.round(performance.now() - t0),
    });
  } catch (e) {
    self.postMessage({
      type: "solved",
      job_id: msg.job_id,
      ok: false,
      error: String(e?.message || e),
      ms: Math.round(performance.now() - t0),
    });
  }
};
