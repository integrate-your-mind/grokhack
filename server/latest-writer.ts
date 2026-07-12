export interface LatestWriterOptions {
  initialDelayMs?: number;
  retryBackoffMs?: number;
  onError?: (error: unknown) => void;
}

interface VersionedValue<T> {
  sequence: number;
  value: T;
}

interface ActiveWrite<T> extends VersionedValue<T> {
  promise: Promise<void>;
}

/** O(1) latest-wins writer: one active write and one pending value at most. */
export class LatestSingleFlightWriter<T> {
  private pending: VersionedValue<T> | undefined;
  private active: ActiveWrite<T> | undefined;
  private nextSequence = 0;
  private durableSequence = 0;
  private initialTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private flushers = 0;
  private readonly initialDelayMs: number;
  private readonly retryBackoffMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly write: (value: T) => Promise<void>,
    options: LatestWriterOptions = {},
  ) {
    this.initialDelayMs = Math.max(0, options.initialDelayMs ?? 0);
    this.retryBackoffMs = Math.max(1, options.retryBackoffMs ?? 1_000);
    this.onError = options.onError ?? (() => {});
  }

  schedule(value: T): void {
    this.pending = { sequence: ++this.nextSequence, value };
    if (!this.active && !this.initialTimer && !this.retryTimer) this.armInitialWrite();
  }

  async flush(value?: T): Promise<void> {
    if (value !== undefined) {
      this.pending = { sequence: ++this.nextSequence, value };
    }
    const targetSequence = this.pending?.sequence ?? this.active?.sequence ?? this.durableSequence;
    this.flushers += 1;
    this.clearTimers();
    try {
      while (this.durableSequence < targetSequence) {
        if (!this.active) this.startPendingWrite();
        const current = this.active;
        if (!current) throw new Error("latest-writer lost its pending durability target");
        try {
          await current.promise;
        } catch (error) {
          // A superseded write may fail while flush waits for a newer value.
          // Continue forward to the target; fail only when the target itself failed.
          if (targetSequence <= current.sequence) throw error;
        }
      }
    } finally {
      this.flushers -= 1;
      if (this.flushers === 0 && !this.active && this.pending) this.armRetry();
    }
  }

  private armInitialWrite(): void {
    if (this.initialDelayMs === 0) {
      this.startPendingWrite();
      return;
    }
    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined;
      this.startPendingWrite();
    }, this.initialDelayMs);
  }

  private armRetry(): void {
    if (this.retryTimer || this.active || !this.pending) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.startPendingWrite();
    }, this.retryBackoffMs);
  }

  private startPendingWrite(): void {
    if (this.active || !this.pending) return;
    this.clearTimers();
    const next = this.pending;
    this.pending = undefined;
    let promise: Promise<void>;
    try {
      promise = Promise.resolve(this.write(next.value));
    } catch (error) {
      promise = Promise.reject(error);
    }
    const active: ActiveWrite<T> = { ...next, promise };
    this.active = active;
    void promise.then(
      () => this.completeSuccess(active),
      (error: unknown) => this.completeFailure(active, error),
    );
  }

  private completeSuccess(completed: ActiveWrite<T>): void {
    if (this.active !== completed) return;
    this.active = undefined;
    this.durableSequence = Math.max(this.durableSequence, completed.sequence);
    // Under continuous load, drain at sink throughput without accumulating work.
    if (this.pending) this.startPendingWrite();
  }

  private completeFailure(completed: ActiveWrite<T>, error: unknown): void {
    if (this.active !== completed) return;
    this.active = undefined;
    if (!this.pending || this.pending.sequence < completed.sequence) {
      this.pending = { sequence: completed.sequence, value: completed.value };
    }
    this.onError(error);
    if (this.flushers > 0 && this.pending.sequence > completed.sequence) {
      this.startPendingWrite();
    } else if (this.flushers === 0) {
      this.armRetry();
    }
  }

  private clearTimers(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.initialTimer = undefined;
    this.retryTimer = undefined;
  }
}
