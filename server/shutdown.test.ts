import { describe, expect, it, vi } from "vitest";

import { shutdownRuntime } from "./shutdown.js";

describe("shutdown coordinator", () => {
  it("orders freeze, drain, snapshot, flush, and close", async () => {
    const events: string[] = [];
    const code = await shutdownRuntime({
      world: {
        beginShutdown: () => {
          events.push("freeze");
          return true;
        },
        flushAllDurable: async () => {
          events.push("snapshot");
        },
      },
      beginTransports: () => {
        events.push("drain-start");
        return [
          {
            drained: Promise.resolve().then(() => {
              events.push("drained");
            }),
            forceClose: vi.fn(),
          },
        ];
      },
      flushPersistence: async () => {
        events.push("flush");
      },
      closePersistence: async () => {
        events.push("close");
      },
    });

    expect(code).toBe(0);
    expect(events).toEqual(["freeze", "drain-start", "drained", "snapshot", "flush", "close"]);
  });

  it("force-closes a timed-out drain, still flushes, and reports failure", async () => {
    const forceClose = vi.fn();
    const flush = vi.fn(async () => {});
    const code = await shutdownRuntime({
      world: {
        beginShutdown: () => true,
        flushAllDurable: flush,
      },
      beginTransports: () => [
        { drained: new Promise<void>(() => {}), forceClose },
      ],
      flushPersistence: flush,
      closePersistence: flush,
      drainTimeoutMs: 5,
      logError: vi.fn(),
    });

    expect(code).toBe(1);
    expect(forceClose).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledTimes(3);
  });

  it("attempts every durability phase and returns failure when one rejects", async () => {
    const close = vi.fn(async () => {});
    const logError = vi.fn();
    const code = await shutdownRuntime({
      world: {
        beginShutdown: () => true,
        flushAllDurable: async () => {
          throw new Error("disk full");
        },
      },
      beginTransports: () => [],
      flushPersistence: async () => {},
      closePersistence: close,
      logError,
    });

    expect(code).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledOnce();
  });
});
