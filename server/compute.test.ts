import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import {
  ComputePool,
  resetComputePool,
  clientSolveJob,
  makeMiniMap,
  serverPathfindBfs,
  serverFovResult,
  serverHashCheck,
  serverGenValidation,
  serverSeedSearch,
  sanitizeComputeWorkerName,
  MAX_QUEUE,
  MAX_WORKERS,
  ALL_JOB_TYPES,
  type ComputeJobType,
} from "./compute.js";
import { isWalkable } from "../src/dungeon.js";
import { dataPath } from "./data-paths.js";

const CREDITS = dataPath("store", "credits.json");
const CREDITS_BAK = dataPath("store", "credits.compute-test.bak");

describe("compute pure solvers", () => {
  it("hash_check is deterministic", () => {
    const a = serverHashCheck("challenge", 0, 4);
    const b = serverHashCheck("challenge", 0, 4);
    expect(a.digests).toEqual(b.digests);
    expect(a.digests).toHaveLength(4);
    expect(a.digests[0]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("pathfind_bfs finds a path on mini map", () => {
    const tiles = makeMiniMap(42);
    const floors: { x: number; y: number }[] = [];
    for (let y = 0; y < tiles.length; y++) {
      for (let x = 0; x < tiles[0].length; x++) {
        if (isWalkable(tiles, x, y)) floors.push({ x, y });
      }
    }
    expect(floors.length).toBeGreaterThan(2);
    const a = floors[0];
    const b = floors[floors.length - 1];
    const r = serverPathfindBfs(tiles, a.x, a.y, b.x, b.y);
    expect(r.path).not.toBeNull();
    expect(r.path![0]).toBe(`${a.x},${a.y}`);
    expect(r.path![r.path!.length - 1]).toBe(`${b.x},${b.y}`);
  });

  it("fov_rays includes origin", () => {
    const tiles = makeMiniMap(7);
    let ox = 1;
    let oy = 1;
    outer: for (let y = 0; y < tiles.length; y++) {
      for (let x = 0; x < tiles[0].length; x++) {
        if (isWalkable(tiles, x, y)) {
          ox = x;
          oy = y;
          break outer;
        }
      }
    }
    const r = serverFovResult(tiles, ox, oy, 6);
    expect(r.cells).toContain(`${ox},${oy}`);
    expect(r.cells).toEqual([...r.cells].sort());
  });

  it("gen_validation counts floors", () => {
    const tiles = makeMiniMap(1);
    const r = serverGenValidation(tiles);
    expect(r.floorCount).toBeGreaterThan(0);
    expect(typeof r.connected).toBe("boolean");
  });

  it("dungeon_seed_search returns found or not", () => {
    const r = serverSeedSearch({ depth: 1, startSeed: 1, maxTries: 8, minRooms: 3 });
    expect(r.tries).toBeGreaterThan(0);
    if (r.found) {
      expect(typeof r.seed).toBe("number");
      expect((r.rooms ?? 0) >= 3).toBe(true);
    }
  });
});

describe("ComputePool protocol", () => {
  let pool: ComputePool;
  let sent: Record<string, unknown>[];

  beforeEach(async () => {
    pool = resetComputePool();
    sent = [];
    if (fs.existsSync(CREDITS)) fs.copyFileSync(CREDITS, CREDITS_BAK);
    if (fs.existsSync(CREDITS)) fs.unlinkSync(CREDITS);
    const { resetCreditJobIdCache } = await import("./credits.js");
    resetCreditJobIdCache();
  });

  afterEach(() => {
    pool.stop();
    if (fs.existsSync(CREDITS_BAK)) {
      fs.copyFileSync(CREDITS_BAK, CREDITS);
      fs.unlinkSync(CREDITS_BAK);
    }
  });

  function makeSend() {
    return (msg: Record<string, unknown>) => {
      sent.push(msg);
    };
  }

  it("registers offer and dispatches a job", () => {
    pool.enqueueForTests("hash_check");
    pool.handleOffer("w1", { capacity: 1, name: "TestBot", job_types: ["hash_check"] }, makeSend());
    expect(sent.some((m) => m.type === "compute_ready")).toBe(true);
    const jobMsg = sent.find((m) => m.type === "compute_job");
    expect(jobMsg).toBeTruthy();
    expect(jobMsg!.job_type).toBe("hash_check");
    expect(jobMsg!.job_id).toBeTruthy();
  });

  it("accepts correct compute_result and scores worker", () => {
    pool.enqueueForTests("hash_check");
    pool.handleOffer("w1", { capacity: 1, name: "Helper", job_types: ["hash_check"] }, makeSend());
    const jobMsg = sent.find((m) => m.type === "compute_job")!;
    const result = clientSolveJob(
      jobMsg.job_type as ComputeJobType,
      jobMsg.payload as Record<string, unknown>
    );
    sent.length = 0;
    pool.handleResult("w1", {
      job_id: jobMsg.job_id as string,
      ok: true,
      result,
      ms: 3,
    });
    const ack = sent.find((m) => m.type === "compute_ack");
    expect(ack).toBeTruthy();
    expect(ack!.accepted).toBe(true);
    expect(ack!.total_score).toBe(1);
    const metrics = pool.getMetrics();
    expect(metrics.completed).toBe(1);
    expect(metrics.rejected).toBe(0);
    expect(metrics.topContributors[0]?.name).toBe("Helper");
    expect(metrics.topContributors[0]?.score).toBe(1);
  });

  it("rejects mismatched results (trust model)", () => {
    pool.enqueueForTests("hash_check");
    pool.handleOffer("w1", { capacity: 1, name: "Evil", job_types: ["hash_check"] }, makeSend());
    const jobMsg = sent.find((m) => m.type === "compute_job")!;
    sent.length = 0;
    pool.handleResult("w1", {
      job_id: jobMsg.job_id as string,
      ok: true,
      result: { digests: ["deadbeefdeadbeef"] },
    });
    const ack = sent.find((m) => m.type === "compute_ack");
    expect(ack!.accepted).toBe(false);
    expect(ack!.reason).toBe("validation_mismatch");
    expect(pool.getMetrics().rejected).toBe(1);
    expect(pool.getWorker("w1")!.score).toBe(0);
  });

  it("validates all job types end-to-end", () => {
    for (const jt of ALL_JOB_TYPES) {
      sent = [];
      pool = resetComputePool();
      const enq = pool.enqueueForTests(jt);
      expect(enq).toBeTruthy();
      pool.handleOffer(
        `w-${jt}`,
        { capacity: 1, name: jt, job_types: [jt] },
        (m) => sent.push(m)
      );
      const jobMsg = sent.find((m) => m.type === "compute_job");
      expect(jobMsg, `job for ${jt}`).toBeTruthy();
      const result = clientSolveJob(
        jobMsg!.job_type as ComputeJobType,
        jobMsg!.payload as Record<string, unknown>
      );
      sent = [];
      pool.handleResult(`w-${jt}`, {
        job_id: jobMsg!.job_id as string,
        ok: true,
        result,
      });
      const ack = sent.find((m) => m.type === "compute_ack");
      expect(ack?.accepted, `${jt} should accept`).toBe(true);
      pool.stop();
    }
  });

  it("metrics expose queue and trust note", () => {
    const m = pool.getMetrics();
    expect(m.enabled).toBe(true);
    expect(m.goldTipReady).toBe(false);
    expect(m.note).toMatch(/re-validates|validates/i);
  });

  it("unregister requeues in-flight work", () => {
    pool.enqueueForTests("fov_rays");
    pool.handleOffer("w1", { capacity: 1, job_types: ["fov_rays"] }, makeSend());
    expect(pool.getMetrics().inFlight).toBe(1);
    pool.unregisterWorker("w1");
    expect(pool.getWorker("w1")).toBeUndefined();
    // job back on queue
    expect(pool.getQueueDepth()).toBeGreaterThanOrEqual(1);
  });

  it("capacity>1 dispatches multiple in-flight jobs", () => {
    pool.enqueueForTests("hash_check");
    pool.enqueueForTests("hash_check");
    pool.enqueueForTests("hash_check");
    pool.handleOffer(
      "w-multi",
      { capacity: 2, name: "Multi", job_types: ["hash_check"] },
      makeSend()
    );
    const jobs = sent.filter((m) => m.type === "compute_job");
    expect(jobs.length).toBe(2);
    expect(pool.getMetrics().inFlight).toBe(2);
    expect(pool.getWorker("w-multi")!.inFlight).toBe(2);
    expect(pool.getWorker("w-multi")!.capacity).toBe(2);
  });

  it("deadline expiry acks and increments expired metric", () => {
    pool.enqueueForTests("hash_check");
    pool.handleOffer("w1", { capacity: 1, job_types: ["hash_check"] }, makeSend());
    const jobMsg = sent.find((m) => m.type === "compute_job");
    expect(jobMsg).toBeTruthy();
    const jobId = jobMsg!.job_id as string;
    sent.length = 0;

    // Force assignedAt into the past so expireStale trips without waiting 9s+
    const assigned = (pool as unknown as { assigned: Map<string, { assignedAt?: number; deadlineMs: number }> })
      .assigned.get(jobId);
    expect(assigned).toBeTruthy();
    assigned!.assignedAt = Date.now() - (assigned!.deadlineMs + 2000);

    (pool as unknown as { expireStale: () => void }).expireStale();

    const ack = sent.find((m) => m.type === "compute_ack");
    expect(ack).toBeTruthy();
    expect(ack!.accepted).toBe(false);
    expect(ack!.reason).toBe("deadline_exceeded");
    expect(ack!.job_id).toBe(jobId);
    expect(pool.getMetrics().expired).toBeGreaterThanOrEqual(1);
    expect(pool.getWorker("w1")!.inFlight).toBe(0);
  });

  it("rejects result from wrong worker (trust: assignedTo must match)", () => {
    pool.enqueueForTests("hash_check");
    pool.handleOffer("owner", { capacity: 1, job_types: ["hash_check"] }, makeSend());
    const jobMsg = sent.find((m) => m.type === "compute_job")!;
    const result = clientSolveJob(
      jobMsg.job_type as ComputeJobType,
      jobMsg.payload as Record<string, unknown>
    );

    // Second worker registers; must not be able to complete owner's job
    const sent2: Record<string, unknown>[] = [];
    pool.handleOffer("thief", { capacity: 1, job_types: ["hash_check"] }, (m) => sent2.push(m));
    sent2.length = 0;
    pool.handleResult("thief", {
      job_id: jobMsg.job_id as string,
      ok: true,
      result,
    });
    const ack = sent2.find((m) => m.type === "compute_ack");
    expect(ack).toBeTruthy();
    expect(ack!.accepted).toBe(false);
    expect(ack!.reason).toBe("unknown_or_expired_job");
    // Owner's job still in flight; metrics not completed
    expect(pool.getMetrics().inFlight).toBeGreaterThanOrEqual(1);
    expect(pool.getMetrics().completed).toBe(0);
    expect(pool.getWorker("owner")!.score).toBe(0);
  });

  it("compute_offer works without game join (pool-only worker id)", () => {
    // No join/session — just a bare worker id + offer
    pool.enqueueForTests("gen_validation");
    pool.handleOffer(
      "orphan-conn",
      { capacity: 1, name: "Orphan", job_types: ["gen_validation"] },
      makeSend()
    );
    expect(sent.some((m) => m.type === "compute_ready")).toBe(true);
    const jobMsg = sent.find((m) => m.type === "compute_job");
    expect(jobMsg).toBeTruthy();
    expect(jobMsg!.job_type).toBe("gen_validation");
    const result = clientSolveJob(
      jobMsg!.job_type as ComputeJobType,
      jobMsg!.payload as Record<string, unknown>
    );
    sent.length = 0;
    pool.handleResult("orphan-conn", { job_id: jobMsg!.job_id as string, ok: true, result });
    expect(sent.find((m) => m.type === "compute_ack")!.accepted).toBe(true);
  });

  it("result without prior offer is a silent no-op (no crash, no metrics)", () => {
    const before = pool.getMetrics();
    pool.handleResult("never-offered", {
      job_id: "cj_fake",
      ok: true,
      result: { digests: ["00"] },
    });
    const after = pool.getMetrics();
    expect(after.completed).toBe(before.completed);
    expect(after.rejected).toBe(before.rejected);
    expect(after.workers).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("metrics.byType tracks completed and rejected per job type", () => {
    // Complete one hash_check on w-ok
    pool.enqueueForTests("hash_check");
    pool.handleOffer("w-ok", { capacity: 1, name: "Tally", job_types: ["hash_check"] }, makeSend());
    const jobOk = sent.find((m) => m.type === "compute_job")!;
    const good = clientSolveJob(
      jobOk.job_type as ComputeJobType,
      jobOk.payload as Record<string, unknown>
    );
    pool.handleResult("w-ok", { job_id: jobOk.job_id as string, ok: true, result: good });

    // Reject one fov_rays on a fresh worker (avoids warm-queue in-flight on w-ok)
    sent.length = 0;
    pool.enqueueForTests("fov_rays");
    pool.handleOffer("w-bad", { capacity: 1, name: "Evil", job_types: ["fov_rays"] }, makeSend());
    const jobBad = sent.find((m) => m.type === "compute_job" && m.job_type === "fov_rays");
    expect(jobBad).toBeTruthy();
    pool.handleResult("w-bad", {
      job_id: jobBad!.job_id as string,
      ok: true,
      result: { cells: ["nope"] },
    });

    const m = pool.getMetrics();
    expect(m.byType.hash_check.completed).toBe(1);
    expect(m.byType.hash_check.rejected).toBe(0);
    expect(m.byType.fov_rays.completed).toBe(0);
    expect(m.byType.fov_rays.rejected).toBe(1);
    expect(m.completed).toBe(1);
    expect(m.rejected).toBe(1);
  });

  it("re-offer after unregister re-dispatches work", () => {
    pool.enqueueForTests("pathfind_bfs");
    pool.handleOffer("w1", { capacity: 1, name: "Bounce", job_types: ["pathfind_bfs"] }, makeSend());
    expect(sent.some((m) => m.type === "compute_job")).toBe(true);
    expect(pool.getMetrics().inFlight).toBe(1);
    const queueBeforeUnreg = pool.getQueueDepth();

    pool.unregisterWorker("w1");
    expect(pool.getWorker("w1")).toBeUndefined();
    expect(pool.getMetrics().inFlight).toBe(0);
    // In-flight job requeued onto the queue
    expect(pool.getQueueDepth()).toBeGreaterThan(queueBeforeUnreg);

    sent.length = 0;
    pool.handleOffer("w1", { capacity: 1, name: "Bounce", job_types: ["pathfind_bfs"] }, makeSend());
    expect(sent.some((m) => m.type === "compute_ready")).toBe(true);
    const reJob = sent.find((m) => m.type === "compute_job");
    expect(reJob).toBeTruthy();
    expect(reJob!.job_type).toBe("pathfind_bfs");
    expect(pool.getMetrics().inFlight).toBe(1);

    const result = clientSolveJob(
      reJob!.job_type as ComputeJobType,
      reJob!.payload as Record<string, unknown>
    );
    sent.length = 0;
    pool.handleResult("w1", { job_id: reJob!.job_id as string, ok: true, result });
    expect(sent.find((m) => m.type === "compute_ack")!.accepted).toBe(true);
    expect(pool.getWorker("w1")!.score).toBe(1);
  });

  it("mismatch does not mint credits; accept mints exactly once", async () => {
    const { getCredits } = await import("./credits.js");
    pool.enqueueForTests("hash_check");
    pool.handleOffer("w1", { capacity: 1, name: "CreditMe", job_types: ["hash_check"] }, makeSend());
    const jobMsg = sent.find((m) => m.type === "compute_job")!;
    sent.length = 0;
    pool.handleResult("w1", {
      job_id: jobMsg.job_id as string,
      ok: true,
      result: { digests: ["badbadbadbadbadb"] },
    });
    expect(sent.find((m) => m.type === "compute_ack")!.accepted).toBe(false);
    expect(getCredits("CreditMe")).toBeNull();

    // After reject, dispatch may already assign next warm-queue job — use that or enqueue
    let job2 = sent.find((m) => m.type === "compute_job");
    if (!job2) {
      sent.length = 0;
      pool.enqueueForTests("hash_check");
      pool.handleOffer("w1", { capacity: 1, name: "CreditMe", job_types: ["hash_check"] }, makeSend());
      job2 = sent.find((m) => m.type === "compute_job");
    }
    expect(job2).toBeTruthy();
    const good = clientSolveJob(
      job2!.job_type as ComputeJobType,
      job2!.payload as Record<string, unknown>
    );
    const acceptedJobId = job2!.job_id as string;
    sent.length = 0;
    pool.handleResult("w1", { job_id: acceptedJobId, ok: true, result: good });
    expect(sent.find((m) => m.type === "compute_ack")!.accepted).toBe(true);
    expect(getCredits("CreditMe")?.balance).toBe(1);

    // Replay same job_id — no second credit, no score bump
    sent.length = 0;
    const scoreBefore = pool.getWorker("w1")!.score;
    pool.handleResult("w1", { job_id: acceptedJobId, ok: true, result: good });
    const replayAck = sent.find((m) => m.type === "compute_ack");
    expect(replayAck!.accepted).toBe(false);
    expect(replayAck!.reason).toBe("unknown_or_expired_job");
    expect(getCredits("CreditMe")?.balance).toBe(1);
    expect(pool.getWorker("w1")!.score).toBe(scoreBefore);
  });

  it("wrong worker cannot mint credits on stolen job_id", async () => {
    const { getCredits } = await import("./credits.js");
    pool.enqueueForTests("hash_check");
    pool.handleOffer("owner", { capacity: 1, name: "OwnerBot", job_types: ["hash_check"] }, makeSend());
    const jobMsg = sent.find((m) => m.type === "compute_job")!;
    const result = clientSolveJob(
      jobMsg.job_type as ComputeJobType,
      jobMsg.payload as Record<string, unknown>
    );
    const sentThief: Record<string, unknown>[] = [];
    pool.handleOffer("thief", { capacity: 1, name: "ThiefBot", job_types: ["hash_check"] }, (m) =>
      sentThief.push(m)
    );
    sentThief.length = 0;
    pool.handleResult("thief", { job_id: jobMsg.job_id as string, ok: true, result });
    expect(sentThief.find((m) => m.type === "compute_ack")!.accepted).toBe(false);
    expect(getCredits("ThiefBot")).toBeNull();
    expect(getCredits("OwnerBot")).toBeNull();
    expect(pool.getMetrics().completed).toBe(0);
  });

  it("rejects missing job_id and does not credit", async () => {
    const { getCredits } = await import("./credits.js");
    pool.enqueueForTests("hash_check");
    pool.handleOffer("w1", { capacity: 1, name: "NoId", job_types: ["hash_check"] }, makeSend());
    sent.length = 0;
    pool.handleResult("w1", { ok: true, result: { digests: ["00"] } });
    expect(sent.find((m) => m.type === "compute_ack")!.reason).toBe("missing_job_id");
    expect(getCredits("NoId")).toBeNull();
  });

  it("queue depth never exceeds MAX_QUEUE", () => {
    let enqueued = 0;
    for (let i = 0; i < MAX_QUEUE + 40; i++) {
      if (pool.enqueueForTests("hash_check")) enqueued++;
    }
    expect(enqueued).toBeLessThanOrEqual(MAX_QUEUE);
    expect(pool.getQueueDepth() + pool.getMetrics().inFlight).toBeLessThanOrEqual(MAX_QUEUE);
  });

  it("rejects new workers when pool is full (MAX_WORKERS)", () => {
    // Fill with no-op send; use unique ids
    for (let i = 0; i < MAX_WORKERS; i++) {
      const ok = pool.registerWorker({
        id: `fill-${i}`,
        name: `Fill${i}`,
        capacity: 1,
        jobTypes: ["hash_check"],
        send: () => {},
      });
      expect(ok).toBeTruthy();
    }
    expect(pool.getMetrics().workers).toBe(MAX_WORKERS);
    const overflowSent: Record<string, unknown>[] = [];
    pool.handleOffer("overflow", { capacity: 1, name: "Overflow", job_types: ["hash_check"] }, (m) =>
      overflowSent.push(m)
    );
    expect(overflowSent.some((m) => m.reason === "pool_full")).toBe(true);
    expect(pool.getWorker("overflow")).toBeUndefined();
    // Existing worker can re-offer
    const reSent: Record<string, unknown>[] = [];
    pool.handleOffer("fill-0", { capacity: 1, name: "Fill0", job_types: ["hash_check"] }, (m) =>
      reSent.push(m)
    );
    expect(reSent.some((m) => m.type === "compute_ready")).toBe(true);
  });

  it("sanitizes hostile worker names before credit ledger", () => {
    expect(sanitizeComputeWorkerName("../x", "!!!")).toMatch(/^w_/);
    expect(sanitizeComputeWorkerName("Valid_Bot", "fb")).toBe("Valid_Bot");
    expect(sanitizeComputeWorkerName("has space", "GoodName")).toBe("GoodName");
    expect(sanitizeComputeWorkerName("../x", "fallback")).toBe("fallback");
  });

  it("client_reported_failure does not credit and may requeue", async () => {
    const { getCredits } = await import("./credits.js");
    pool.enqueueForTests("hash_check");
    pool.handleOffer("w1", { capacity: 1, name: "Failer", job_types: ["hash_check"] }, makeSend());
    const jobMsg = sent.find((m) => m.type === "compute_job")!;
    sent.length = 0;
    pool.handleResult("w1", {
      job_id: jobMsg.job_id as string,
      ok: false,
      error: "worker_oom",
    });
    const ack = sent.find((m) => m.type === "compute_ack");
    expect(ack!.accepted).toBe(false);
    expect(getCredits("Failer")).toBeNull();
    expect(pool.getMetrics().completed).toBe(0);
    expect(pool.getMetrics().rejected).toBe(1);
  });
});
