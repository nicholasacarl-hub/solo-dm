/**
 * A small concurrency limiter: at most `limit` tasks run at once, the rest wait their turn in order
 * (a priority task goes to the front). A task still waiting can be abandoned with its AbortSignal.
 */

interface Waiter {
  grant: () => void;
}

export interface QueueOptions {
  signal?: AbortSignal;
  /** Jump the queue (the player is waiting on this one, e.g. a portrait). */
  priority?: boolean;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

export class TaskQueue {
  private active = 0;
  private waiting: Waiter[] = [];

  constructor(private readonly limit: number) {}

  /** Tasks running now. */
  get running(): number {
    return this.active;
  }

  /** Tasks waiting for a free slot. */
  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>, opts: QueueOptions = {}): Promise<T> {
    await this.acquire(opts);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire({ signal, priority }: QueueOptions): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiting = this.waiting.filter((w) => w !== waiter);
        reject(abortReason(signal!));
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (priority) this.waiting.unshift(waiter);
      else this.waiting.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    // The slot passes straight to the next task, so nothing can slip in between.
    if (next) next.grant();
    else this.active -= 1;
  }
}
