import type { DrainHandle } from "./http.js";

export interface ShutdownDependencies {
  world: {
    beginShutdown(): boolean;
    flushAllDurable(): Promise<void>;
  };
  beginTransports(): DrainHandle[];
  flushPersistence(): Promise<void>;
  closePersistence(): Promise<void>;
  drainTimeoutMs?: number;
  durabilityTimeoutMs?: number;
  logError?: (message: string, error: unknown) => void;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Freeze mutations, drain transports, then cross the durable shutdown barrier. */
export async function shutdownRuntime(deps: ShutdownDependencies): Promise<0 | 1> {
  const drainTimeoutMs = deps.drainTimeoutMs ?? 30_000;
  const durabilityTimeoutMs = deps.durabilityTimeoutMs ?? 60_000;
  const logError = deps.logError ?? ((message, error) => console.error(message, error));
  let clean = true;
  let transports: DrainHandle[] = [];

  deps.world.beginShutdown();
  try {
    transports = deps.beginTransports();
    await withTimeout(
      Promise.all(transports.map((transport) => transport.drained)),
      drainTimeoutMs,
      "transport drain",
    );
  } catch (error) {
    clean = false;
    logError("[boot] transport drain failed", error);
    for (const transport of transports) {
      try {
        transport.forceClose();
      } catch (forceError) {
        logError("[boot] transport force-close failed", forceError);
      }
    }
  }

  const durableBarrier = async () => {
    const failures: unknown[] = [];
    for (const [label, operation] of [
      ["world snapshot", () => deps.world.flushAllDurable()],
      ["persistence flush", () => deps.flushPersistence()],
      ["persistence close", () => deps.closePersistence()],
    ] as const) {
      try {
        await operation();
      } catch (error) {
        failures.push(new Error(`${label} failed`, { cause: error }));
      }
    }
    if (failures.length) throw new AggregateError(failures, "durable shutdown barrier failed");
  };

  try {
    await withTimeout(durableBarrier(), durabilityTimeoutMs, "durable shutdown barrier");
  } catch (error) {
    clean = false;
    logError("[boot] shutdown durability failed", error);
  }

  return clean ? 0 : 1;
}
