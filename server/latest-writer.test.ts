import { afterEach, describe, expect, it, vi } from "vitest";

import { LatestSingleFlightWriter } from "./latest-writer.js";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("LatestSingleFlightWriter", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps one write active and drains only the latest pending value", async () => {
    const first = deferred();
    const writes: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const writer = new LatestSingleFlightWriter<number>(async (value) => {
      writes.push(value);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (value === 1) await first.promise;
      } finally {
        concurrent -= 1;
      }
    });

    writer.schedule(1);
    for (let value = 2; value <= 10_000; value += 1) writer.schedule(value);
    expect(writes).toEqual([1]);
    first.resolve();
    await writer.flush();
    expect(writes).toEqual([1, 10_000]);
    expect(maxConcurrent).toBe(1);
  });

  it("does not starve under traffic that never leaves a debounce-sized quiet period", async () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    const writer = new LatestSingleFlightWriter<number>(
      async (value) => {
        writes.push(value);
      },
      { initialDelayMs: 400 },
    );

    for (let value = 1; value <= 20; value += 1) {
      writer.schedule(value);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(writes.length).toBeGreaterThan(1);
    await writer.flush();
    expect(writes.at(-1)).toBe(20);
  });

  it("retains a failed value and retries it without new traffic", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const errors: unknown[] = [];
    const writer = new LatestSingleFlightWriter<number>(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary outage");
      },
      { retryBackoffMs: 500, onError: (error) => errors.push(error) },
    );

    writer.schedule(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
    await writer.flush();
  });

  it("continues to a newer flush target when an older active write fails", async () => {
    const old = deferred();
    const writes: number[] = [];
    const writer = new LatestSingleFlightWriter<number>(async (value) => {
      writes.push(value);
      if (value === 1) await old.promise;
    });
    writer.schedule(1);
    const flushed = writer.flush(2);
    old.reject(new Error("old write failed"));
    await expect(flushed).resolves.toBeUndefined();
    expect(writes).toEqual([1, 2]);
  });

  it("rejects a failed latest flush and permits an explicit retry", async () => {
    let fail = true;
    const writer = new LatestSingleFlightWriter<number>(async () => {
      if (fail) throw new Error("latest failed");
    });
    await expect(writer.flush(1)).rejects.toThrow("latest failed");
    fail = false;
    await expect(writer.flush()).resolves.toBeUndefined();
  });
});
