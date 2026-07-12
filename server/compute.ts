/**
 * Voluntary compute contribution pool.
 *
 * Clients (browser Web Workers, telnet agents, agent bots) offer spare cycles.
 * Server assigns lightweight jobs; always re-validates results server-side.
 * Never trust clients for authoritative combat/world outcomes.
 *
 * Protocol (WS JSON / telnet JSON-lines):
 *   client → compute_offer  { capacity, job_types?, name? }
 *   server → compute_job    { job_id, job_type, payload, deadline_ms }
 *   client → compute_result { job_id, ok, result?, error?, ms? }
 *   server → compute_ack    { job_id, accepted, score?, total_score?, reason? }
 */

import { createHash, randomUUID } from "node:crypto";
import { computeFOV, generateDungeon, isFullyConnected, isWalkable } from "../src/dungeon.js";
import { RNG } from "../src/rng.js";
import type { Tile } from "../src/types.js";
import { awardComputeCredits } from "./credits.js";

export type ComputeJobType =
  | "fov_rays"
  | "pathfind_bfs"
  | "dungeon_seed_search"
  | "hash_check"
  | "gen_validation";

export const ALL_JOB_TYPES: ComputeJobType[] = [
  "fov_rays",
  "pathfind_bfs",
  "dungeon_seed_search",
  "hash_check",
  "gen_validation",
];

export interface ComputeWorker {
  id: string;
  name: string;
  capacity: number;
  jobTypes: Set<ComputeJobType>;
  inFlight: number;
  score: number;
  completed: number;
  rejected: number;
  lastActive: number;
  transport: "websocket" | "telnet" | "unknown";
  /** Deliver a JSON-serializable message to this worker. */
  send: (msg: Record<string, unknown>) => void;
}

export interface QueuedJob {
  id: string;
  jobType: ComputeJobType;
  payload: Record<string, unknown>;
  /** Expected authoritative result (server-side). */
  expected: unknown;
  enqueuedAt: number;
  deadlineMs: number;
  assignedTo?: string;
  assignedAt?: number;
}

export interface ComputeMetrics {
  enabled: true;
  workers: number;
  workersIdle: number;
  queueDepth: number;
  inFlight: number;
  completed: number;
  rejected: number;
  expired: number;
  byType: Record<string, { completed: number; rejected: number }>;
  topContributors: { name: string; score: number; completed: number; rejected: number }[];
  goldTipReady: false;
  note: string;
}

const DEFAULT_DEADLINE_MS = 8_000;
/** Hard cap on queued + in-flight jobs (DoS bound). */
export const MAX_QUEUE = 64;
const MAX_IN_FLIGHT_PER_WORKER = 4;
/** Hard cap on concurrent compute workers (memory / dispatch DoS bound). */
export const MAX_WORKERS = 256;
const JOB_TTL_MS = 30_000;
const SYNTHETIC_INTERVAL_MS = 2_500;
/** Max compute_result messages accepted per worker per rolling minute. */
const MAX_RESULTS_PER_WORKER_PER_MIN = 120;

function stableStringify(v: unknown): string {
  // JSON.stringify(undefined) returns undefined (not a string) — must not collapse to equal
  if (v === undefined) return '"__undefined__"';
  if (typeof v === "bigint") return `"${v.toString()}n"`;
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

function resultsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** Sanitize freeform worker credit name — alphanumeric game-name style only. */
export function sanitizeComputeWorkerName(raw: string | undefined, fallback: string): string {
  const trimmed = (raw || "").trim().slice(0, 24);
  if (/^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/.test(trimmed.slice(0, 16))) {
    return trimmed.slice(0, 16);
  }
  const fb = fallback.trim().slice(0, 16);
  if (/^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/.test(fb)) return fb;
  return `w_${fb.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "anon"}`;
}

/** Tiny synthetic walkable map for FOV/pathfind jobs (no full dungeon gen). */
export function makeMiniMap(seed = 1): Tile[][] {
  const w = 16;
  const h = 12;
  const tiles: Tile[][] = Array.from({ length: h }, () =>
    Array.from({ length: w }, () => "#" as Tile)
  );
  // Carve a room + corridor from seed
  const rng = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const rw = 6 + rng(4);
  const rh = 4 + rng(3);
  const rx = 1 + rng(Math.max(1, w - rw - 2));
  const ry = 1 + rng(Math.max(1, h - rh - 2));
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) tiles[y][x] = ".";
  }
  // Horizontal then vertical corridor to far corner
  const tx = w - 3;
  const ty = h - 3;
  let cx = rx + Math.floor(rw / 2);
  let cy = ry + Math.floor(rh / 2);
  while (cx !== tx) {
    tiles[cy][cx] = ".";
    cx += cx < tx ? 1 : -1;
  }
  while (cy !== ty) {
    tiles[cy][cx] = ".";
    cy += cy < ty ? 1 : -1;
  }
  tiles[ty][tx] = ".";
  tiles[ry + 1][rx + 1] = ".";
  return tiles;
}

export function serverPathfindBfs(
  tiles: Tile[][],
  sx: number,
  sy: number,
  tx: number,
  ty: number
): { path: string[]; dist: number } | { path: null; dist: -1 } {
  if (sx === tx && sy === ty) return { path: [`${sx},${sy}`], dist: 0 };
  const key = (x: number, y: number) => `${x},${y}`;
  const q: { x: number; y: number }[] = [{ x: sx, y: sy }];
  const prev = new Map<string, string | null>();
  prev.set(key(sx, sy), null);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (q.length) {
    const cur = q.shift()!;
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const k = key(nx, ny);
      if (prev.has(k)) continue;
      if (nx === tx && ny === ty) {
        prev.set(k, key(cur.x, cur.y));
        // reconstruct
        const path: string[] = [k];
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

export function serverHashCheck(
  challenge: string,
  nonceStart: number,
  count: number
): { digests: string[] } {
  const digests: string[] = [];
  const n = Math.min(Math.max(count, 1), 64);
  for (let i = 0; i < n; i++) {
    const input = `${challenge}:${nonceStart + i}`;
    digests.push(createHash("sha256").update(input).digest("hex").slice(0, 16));
  }
  return { digests };
}

export function serverFovResult(
  tiles: Tile[][],
  ox: number,
  oy: number,
  radius: number
): { cells: string[] } {
  const set = computeFOV(tiles, ox, oy, radius);
  return { cells: [...set].sort() };
}

export function serverGenValidation(tiles: Tile[][]): {
  connected: boolean;
  floorCount: number;
} {
  let floorCount = 0;
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < (tiles[0]?.length ?? 0); x++) {
      if (isWalkable(tiles, x, y)) floorCount++;
    }
  }
  return { connected: isFullyConnected(tiles), floorCount };
}

export function serverSeedSearch(payload: {
  depth: number;
  startSeed: number;
  maxTries: number;
  minRooms?: number;
}): { found: boolean; seed?: number; rooms?: number; tries: number } {
  const depth = Math.max(1, Math.min(10, payload.depth | 0));
  const maxTries = Math.min(Math.max(payload.maxTries | 0, 1), 24);
  const minRooms = payload.minRooms ?? 4;
  let seed = payload.startSeed | 0;
  for (let i = 0; i < maxTries; i++) {
    const d = generateDungeon(new RNG(seed + i), depth);
    if (d.rooms.length >= minRooms && isFullyConnected(d.tiles)) {
      return { found: true, seed: seed + i, rooms: d.rooms.length, tries: i + 1 };
    }
  }
  return { found: false, tries: maxTries };
}

function normalizeTiles(raw: unknown): Tile[][] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const tiles: Tile[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row)) return null;
    tiles.push(row.map((c) => String(c)[0] as Tile));
  }
  return tiles;
}

export class ComputePool {
  private workers = new Map<string, ComputeWorker>();
  private queue: QueuedJob[] = [];
  private assigned = new Map<string, QueuedJob>();
  private completed = 0;
  private rejected = 0;
  private expired = 0;
  private byType: Record<string, { completed: number; rejected: number }> = {};
  private syntheticTimer: ReturnType<typeof setInterval> | null = null;
  private jobSeq = 0;
  /** Rolling result counters for per-worker rate limits. */
  private resultBuckets = new Map<string, { count: number; resetAt: number }>();

  constructor() {
    for (const t of ALL_JOB_TYPES) {
      this.byType[t] = { completed: 0, rejected: 0 };
    }
  }

  private allowResult(workerId: string): boolean {
    const now = Date.now();
    let b = this.resultBuckets.get(workerId);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + 60_000 };
      this.resultBuckets.set(workerId, b);
    }
    b.count++;
    if (this.resultBuckets.size > MAX_WORKERS * 2) {
      for (const [k, v] of this.resultBuckets) {
        if (now > v.resetAt) this.resultBuckets.delete(k);
      }
    }
    return b.count <= MAX_RESULTS_PER_WORKER_PER_MIN;
  }

  start(): void {
    if (this.syntheticTimer) return;
    this.syntheticTimer = setInterval(() => this.tick(), SYNTHETIC_INTERVAL_MS);
    // unref so tests / short-lived processes can exit
    if (typeof this.syntheticTimer === "object" && "unref" in this.syntheticTimer) {
      this.syntheticTimer.unref();
    }
  }

  stop(): void {
    if (this.syntheticTimer) {
      clearInterval(this.syntheticTimer);
      this.syntheticTimer = null;
    }
  }

  getMetrics(): ComputeMetrics {
    let idle = 0;
    const contrib: { name: string; score: number; completed: number; rejected: number }[] = [];
    for (const w of this.workers.values()) {
      if (w.inFlight < w.capacity) idle++;
      contrib.push({
        name: w.name,
        score: w.score,
        completed: w.completed,
        rejected: w.rejected,
      });
    }
    contrib.sort((a, b) => b.score - a.score || b.completed - a.completed);
    return {
      enabled: true,
      workers: this.workers.size,
      workersIdle: idle,
      queueDepth: this.queue.length,
      inFlight: this.assigned.size,
      completed: this.completed,
      rejected: this.rejected,
      expired: this.expired,
      byType: { ...Object.fromEntries(Object.entries(this.byType).map(([k, v]) => [k, { ...v }])) },
      topContributors: contrib.slice(0, 10),
      goldTipReady: false,
      note: "Voluntary compute — clients process jobs; server always re-validates. Combat is never client-authoritative.",
    };
  }

  registerWorker(opts: {
    id: string;
    name?: string;
    capacity?: number;
    jobTypes?: string[];
    transport?: ComputeWorker["transport"];
    send: (msg: Record<string, unknown>) => void;
  }): ComputeWorker | null {
    const capacity = Math.max(1, Math.min(opts.capacity ?? 1, MAX_IN_FLIGHT_PER_WORKER));
    const types = new Set<ComputeJobType>();
    const requested = opts.jobTypes?.length ? opts.jobTypes : ALL_JOB_TYPES;
    for (const t of requested) {
      if (ALL_JOB_TYPES.includes(t as ComputeJobType)) types.add(t as ComputeJobType);
    }
    if (types.size === 0) {
      for (const t of ALL_JOB_TYPES) types.add(t);
    }

    const safeName = sanitizeComputeWorkerName(
      opts.name,
      `w_${opts.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)}`
    );

    const existing = this.workers.get(opts.id);
    if (existing) {
      existing.capacity = capacity;
      existing.jobTypes = types;
      existing.name = safeName || existing.name;
      existing.send = opts.send;
      existing.transport = opts.transport ?? existing.transport;
      existing.lastActive = Date.now();
      this.dispatchTo(existing);
      return existing;
    }

    if (this.workers.size >= MAX_WORKERS) {
      return null;
    }

    const worker: ComputeWorker = {
      id: opts.id,
      name: safeName,
      capacity,
      jobTypes: types,
      inFlight: 0,
      score: 0,
      completed: 0,
      rejected: 0,
      lastActive: Date.now(),
      transport: opts.transport ?? "unknown",
      send: opts.send,
    };
    this.workers.set(opts.id, worker);
    this.ensureWarmQueue();
    this.dispatchTo(worker);
    return worker;
  }

  unregisterWorker(id: string): void {
    const w = this.workers.get(id);
    if (!w) return;
    // Requeue in-flight jobs assigned to this worker
    for (const [jobId, job] of this.assigned) {
      if (job.assignedTo === id) {
        this.assigned.delete(jobId);
        job.assignedTo = undefined;
        job.assignedAt = undefined;
        if (this.queue.length < MAX_QUEUE) this.queue.push(job);
      }
    }
    this.workers.delete(id);
    this.resultBuckets.delete(id);
  }

  handleOffer(
    workerId: string,
    msg: { capacity?: number; job_types?: string[]; name?: string },
    send: (m: Record<string, unknown>) => void,
    transport: ComputeWorker["transport"] = "websocket"
  ): void {
    this.start();
    const w = this.registerWorker({
      id: workerId,
      name: msg.name,
      capacity: msg.capacity,
      jobTypes: msg.job_types,
      transport,
      send,
    });
    if (!w) {
      send({
        type: "compute_ack",
        accepted: false,
        reason: "pool_full",
        note: `Compute pool at capacity (${MAX_WORKERS} workers). Retry later.`,
      });
      return;
    }
    send({
      type: "compute_ready",
      worker: w.name,
      capacity: w.capacity,
      job_types: [...w.jobTypes],
      score: w.score,
      note: "Jobs will arrive as compute_job. Reply with compute_result. Server validates all results.",
    });
  }

  handleResult(
    workerId: string,
    msg: { job_id?: string; ok?: boolean; result?: unknown; error?: string; ms?: number }
  ): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.lastActive = Date.now();

    if (!this.allowResult(workerId)) {
      w.send({
        type: "compute_ack",
        job_id: msg.job_id,
        accepted: false,
        reason: "rate_limited",
        total_score: w.score,
      });
      return;
    }

    const jobId = msg.job_id;
    if (!jobId || typeof jobId !== "string" || jobId.length > 80) {
      w.send({ type: "compute_ack", accepted: false, reason: "missing_job_id" });
      return;
    }

    const job = this.assigned.get(jobId);
    if (!job || job.assignedTo !== workerId) {
      w.send({ type: "compute_ack", job_id: jobId, accepted: false, reason: "unknown_or_expired_job" });
      return;
    }

    // Drop from assigned before validation so replay cannot double-credit
    this.assigned.delete(jobId);
    w.inFlight = Math.max(0, w.inFlight - 1);

    if (msg.ok === false) {
      this.rejected++;
      this.byType[job.jobType].rejected++;
      w.rejected++;
      // Requeue for another worker (or same later) — bounded by MAX_QUEUE + JOB_TTL
      if (this.queue.length < MAX_QUEUE) {
        job.assignedTo = undefined;
        job.assignedAt = undefined;
        this.queue.push(job);
      }
      w.send({
        type: "compute_ack",
        job_id: jobId,
        accepted: false,
        reason: msg.error || "client_reported_failure",
        total_score: w.score,
      });
      this.dispatchAll();
      return;
    }

    // Authoritative re-check — never trust client (combat/world never use this path)
    const accepted = resultsEqual(msg.result, job.expected);
    if (accepted) {
      this.completed++;
      this.byType[job.jobType].completed++;
      w.completed++;
      w.score += 1;
      // Phase-1 economy: durable compute credits only after server accept (jobId-idempotent)
      const acc = awardComputeCredits(w.name, 1, { jobType: job.jobType, jobId });
      w.send({
        type: "compute_ack",
        job_id: jobId,
        accepted: true,
        score: 1,
        total_score: w.score,
        credits: acc?.balance,
        job_type: job.jobType,
        ms: typeof msg.ms === "number" ? msg.ms : undefined,
      });
    } else {
      this.rejected++;
      this.byType[job.jobType].rejected++;
      w.rejected++;
      w.send({
        type: "compute_ack",
        job_id: jobId,
        accepted: false,
        reason: "validation_mismatch",
        total_score: w.score,
      });
    }

    this.dispatchTo(w);
    this.dispatchAll();
  }

  /** Build a validated job with expected result (server authority). */
  enqueueSynthetic(preferredType?: ComputeJobType): QueuedJob | null {
    if (this.queue.length + this.assigned.size >= MAX_QUEUE) return null;

    const types = preferredType
      ? [preferredType]
      : ([
          "hash_check",
          "fov_rays",
          "pathfind_bfs",
          "gen_validation",
          "dungeon_seed_search",
        ] as ComputeJobType[]);
    // Weighted pick: cheaper jobs more often
    const weights: Record<ComputeJobType, number> = {
      hash_check: 4,
      fov_rays: 3,
      pathfind_bfs: 3,
      gen_validation: 2,
      dungeon_seed_search: 1,
    };
    let pool = types.flatMap((t) => Array(weights[t] || 1).fill(t) as ComputeJobType[]);
    if (preferredType) pool = [preferredType];
    const jobType = pool[Math.floor(Math.random() * pool.length)];

    const built = this.buildJob(jobType);
    if (!built) return null;
    this.queue.push(built);
    return built;
  }

  private buildJob(jobType: ComputeJobType): QueuedJob | null {
    this.jobSeq++;
    const id = `cj_${this.jobSeq}_${randomUUID().slice(0, 8)}`;
    const enqueuedAt = Date.now();

    try {
      switch (jobType) {
        case "hash_check": {
          const challenge = `gh_${enqueuedAt.toString(36)}_${this.jobSeq}`;
          const nonceStart = this.jobSeq * 17;
          const count = 8 + (this.jobSeq % 8);
          const payload = { challenge, nonceStart, count };
          const expected = serverHashCheck(challenge, nonceStart, count);
          return {
            id,
            jobType,
            payload,
            expected,
            enqueuedAt,
            deadlineMs: DEFAULT_DEADLINE_MS,
          };
        }
        case "fov_rays": {
          const tiles = makeMiniMap(this.jobSeq * 97 + 3);
          let ox = 2;
          let oy = 2;
          // find a walkable origin
          outer: for (let y = 0; y < tiles.length; y++) {
            for (let x = 0; x < tiles[0].length; x++) {
              if (isWalkable(tiles, x, y)) {
                ox = x;
                oy = y;
                break outer;
              }
            }
          }
          const radius = 5 + (this.jobSeq % 4);
          const payload = { tiles, ox, oy, radius };
          const expected = serverFovResult(tiles, ox, oy, radius);
          return {
            id,
            jobType,
            payload,
            expected,
            enqueuedAt,
            deadlineMs: DEFAULT_DEADLINE_MS,
          };
        }
        case "pathfind_bfs": {
          const tiles = makeMiniMap(this.jobSeq * 53 + 11);
          const floors: { x: number; y: number }[] = [];
          for (let y = 0; y < tiles.length; y++) {
            for (let x = 0; x < tiles[0].length; x++) {
              if (isWalkable(tiles, x, y)) floors.push({ x, y });
            }
          }
          if (floors.length < 2) return null;
          const a = floors[0];
          const b = floors[floors.length - 1];
          const payload = { tiles, sx: a.x, sy: a.y, tx: b.x, ty: b.y };
          const expected = serverPathfindBfs(tiles, a.x, a.y, b.x, b.y);
          return {
            id,
            jobType,
            payload,
            expected,
            enqueuedAt,
            deadlineMs: DEFAULT_DEADLINE_MS,
          };
        }
        case "gen_validation": {
          // Mix: mini map or real dungeon snippet
          let tiles: Tile[][];
          if (this.jobSeq % 3 === 0) {
            const d = generateDungeon(new RNG(1000 + this.jobSeq), 1 + (this.jobSeq % 3));
            tiles = d.tiles;
          } else {
            tiles = makeMiniMap(this.jobSeq * 13);
          }
          const payload = { tiles };
          const expected = serverGenValidation(tiles);
          return {
            id,
            jobType,
            payload,
            expected,
            enqueuedAt,
            deadlineMs: DEFAULT_DEADLINE_MS,
          };
        }
        case "dungeon_seed_search": {
          const depth = 1 + (this.jobSeq % 4);
          const startSeed = 50_000 + this.jobSeq * 97;
          const maxTries = 6;
          const minRooms = 4;
          const payload = { depth, startSeed, maxTries, minRooms };
          const expected = serverSeedSearch(payload);
          return {
            id,
            jobType,
            payload,
            expected,
            enqueuedAt,
            deadlineMs: 12_000,
          };
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private supportedJobTypes(): ComputeJobType[] {
    const set = new Set<ComputeJobType>();
    for (const w of this.workers.values()) {
      for (const t of w.jobTypes) set.add(t);
    }
    return set.size ? [...set] : ALL_JOB_TYPES;
  }

  private ensureWarmQueue(): void {
    // Keep a few jobs ready when workers are present — only types someone can run
    const supported = this.supportedJobTypes();
    const target = Math.min(8, Math.max(2, this.workers.size * 2));
    while (this.queue.length < target && this.queue.length + this.assigned.size < MAX_QUEUE) {
      const pick = supported[Math.floor(Math.random() * supported.length)];
      if (!this.enqueueSynthetic(pick)) break;
    }
  }

  private expireStale(): void {
    const now = Date.now();
    // expire assigned
    for (const [jobId, job] of this.assigned) {
      const age = now - (job.assignedAt ?? job.enqueuedAt);
      if (age > (job.deadlineMs || DEFAULT_DEADLINE_MS) + 1000) {
        this.assigned.delete(jobId);
        this.expired++;
        const w = job.assignedTo ? this.workers.get(job.assignedTo) : undefined;
        if (w) {
          w.inFlight = Math.max(0, w.inFlight - 1);
          w.send({
            type: "compute_ack",
            job_id: jobId,
            accepted: false,
            reason: "deadline_exceeded",
            total_score: w.score,
          });
        }
        // drop expired — do not infinite-retry heavy seed jobs forever
        if (now - job.enqueuedAt < JOB_TTL_MS && this.queue.length < MAX_QUEUE) {
          job.assignedTo = undefined;
          job.assignedAt = undefined;
          this.queue.push(job);
        }
      }
    }
    // drop ancient queue items
    this.queue = this.queue.filter((j) => now - j.enqueuedAt < JOB_TTL_MS);
  }

  private dispatchTo(w: ComputeWorker): void {
    while (w.inFlight < w.capacity) {
      const idx = this.queue.findIndex((j) => w.jobTypes.has(j.jobType));
      if (idx < 0) break;
      const job = this.queue.splice(idx, 1)[0];
      job.assignedTo = w.id;
      job.assignedAt = Date.now();
      this.assigned.set(job.id, job);
      w.inFlight++;
      w.lastActive = Date.now();
      w.send({
        type: "compute_job",
        job_id: job.id,
        job_type: job.jobType,
        payload: job.payload,
        deadline_ms: job.deadlineMs,
      });
    }
  }

  private dispatchAll(): void {
    for (const w of this.workers.values()) {
      if (w.inFlight < w.capacity) this.dispatchTo(w);
    }
  }

  private tick(): void {
    this.expireStale();
    if (this.workers.size === 0) return;
    this.ensureWarmQueue();
    this.dispatchAll();
  }

  /** Test helper: force one job of a type onto the queue. */
  enqueueForTests(jobType: ComputeJobType): QueuedJob | null {
    return this.enqueueSynthetic(jobType);
  }

  /** Test helper */
  getWorker(id: string): ComputeWorker | undefined {
    return this.workers.get(id);
  }

  /** Test helper */
  getQueueDepth(): number {
    return this.queue.length;
  }
}

/** Process-wide pool (shared by WS + telnet). */
let globalPool: ComputePool | null = null;

export function getComputePool(): ComputePool {
  if (!globalPool) {
    globalPool = new ComputePool();
    globalPool.start();
  }
  return globalPool;
}

/** Reset for unit tests. */
export function resetComputePool(): ComputePool {
  if (globalPool) globalPool.stop();
  globalPool = new ComputePool();
  return globalPool;
}

/** Client-side pure helpers (also used by tests to simulate workers). */
export function clientSolveJob(
  jobType: ComputeJobType,
  payload: Record<string, unknown>
): unknown {
  switch (jobType) {
    case "hash_check": {
      const challenge = String(payload.challenge ?? "");
      const nonceStart = Number(payload.nonceStart ?? 0);
      const count = Number(payload.count ?? 1);
      return serverHashCheck(challenge, nonceStart, count);
    }
    case "fov_rays": {
      const tiles = normalizeTiles(payload.tiles);
      if (!tiles) throw new Error("bad tiles");
      return serverFovResult(tiles, Number(payload.ox), Number(payload.oy), Number(payload.radius));
    }
    case "pathfind_bfs": {
      const tiles = normalizeTiles(payload.tiles);
      if (!tiles) throw new Error("bad tiles");
      return serverPathfindBfs(
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
      return serverGenValidation(tiles);
    }
    case "dungeon_seed_search": {
      return serverSeedSearch({
        depth: Number(payload.depth ?? 1),
        startSeed: Number(payload.startSeed ?? 0),
        maxTries: Number(payload.maxTries ?? 4),
        minRooms: payload.minRooms !== undefined ? Number(payload.minRooms) : undefined,
      });
    }
    default:
      throw new Error(`unknown job type ${jobType}`);
  }
}

export const COMPUTE_PROTOCOL_DOCS = {
  name: "GrokHack voluntary compute",
  summary:
    "Offer spare CPU between turns. Server queues lightweight jobs (FOV, BFS, seed search, hash, gen validation), assigns via compute_job, and always re-validates compute_result. Combat and world authority stay on the server.",
  messages: {
    compute_offer: {
      type: "compute_offer",
      capacity: 2,
      job_types: ALL_JOB_TYPES,
      name: "MyBot",
    },
    compute_job: {
      type: "compute_job",
      job_id: "cj_…",
      job_type: "hash_check",
      payload: {},
      deadline_ms: 8000,
    },
    compute_result: {
      type: "compute_result",
      job_id: "cj_…",
      ok: true,
      result: {},
      ms: 12,
    },
    compute_ack: {
      type: "compute_ack",
      job_id: "cj_…",
      accepted: true,
      score: 1,
      total_score: 5,
    },
  },
  job_types: {
    fov_rays: "Ray-cast FOV cells from (ox,oy) on a tile grid",
    pathfind_bfs: "Cardinal BFS path between two walkable cells",
    dungeon_seed_search: "Search seeds for a connected dungeon with min rooms",
    hash_check: "SHA-256 prefix digests for challenge:nonce range",
    gen_validation: "Connectivity + floor-count of a tile grid",
  },
  trust:
    "Server recomputes every result. Never used for combat outcomes, damage, loot rolls, or movement authority.",
  telnet: "Send :compute on then JSON-lines, or paste compute_offer JSON while connected.",
  metrics: "/api/status → compute",
  gold_tip: "Optional in-game gold tips for top contributors — planned, not live (goldTipReady=false).",
};
