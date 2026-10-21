export type WaitReason = "notified" | "timeout" | "aborted";

type Waiter = {
  id: symbol;
  timer: NodeJS.Timeout;
  resolve: (reason: WaitReason) => void;
};

/**
 * Réveille le long polling lorsqu'un job est assigné.
 * Une nouvelle attente annule la précédente pour le même agent.
 */
export class JobWaitHub {
  private readonly waiters = new Map<string, Waiter>();

  notify(agentId: string): void {
    const waiter = this.waiters.get(agentId);
    if (!waiter) {
      return;
    }
    this.finish(agentId, waiter, "notified");
  }

  wait(agentId: string, timeoutMs: number): {
    done: Promise<WaitReason>;
    cancel: () => void;
  } {
    const previous = this.waiters.get(agentId);
    if (previous) {
      this.finish(agentId, previous, "aborted");
    }
    const id = Symbol(agentId);
    let resolveWait: (reason: WaitReason) => void = () => undefined;
    const done = new Promise<WaitReason>((resolve) => {
      resolveWait = resolve;
    });
    const timer = setTimeout(() => {
      const current = this.waiters.get(agentId);
      if (current?.id === id) {
        this.finish(agentId, current, "timeout");
      }
    }, timeoutMs);
    timer.unref();
    const waiter: Waiter = { id, timer, resolve: resolveWait };
    this.waiters.set(agentId, waiter);
    return {
      done,
      cancel: () => {
        const current = this.waiters.get(agentId);
        if (current?.id === id) {
          this.finish(agentId, current, "aborted");
        }
      },
    };
  }

  private finish(agentId: string, waiter: Waiter, reason: WaitReason): void {
    clearTimeout(waiter.timer);
    if (this.waiters.get(agentId)?.id === waiter.id) {
      this.waiters.delete(agentId);
    }
    waiter.resolve(reason);
  }
}
