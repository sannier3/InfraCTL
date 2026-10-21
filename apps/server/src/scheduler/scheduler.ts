import type { Store } from "../database/store.js";
import type { InventoryService } from "../inventory/service.js";
import type { JobService } from "../jobs/service.js";
import type { JobWaitHub } from "./hub.js";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private running = false;

  constructor(
    private readonly jobs: JobService,
    private readonly inventory: InventoryService,
    private readonly store: Store,
    private readonly hub: JobWaitHub,
    private readonly options: {
      tickMs: number;
      noncePurgeEveryTicks: number;
      metricPurgeEveryTicks: number;
      retentionDays: number;
      now: () => Date;
      onError: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const now = this.options.now();
      await this.jobs.run(async () => {
        await this.inventory.refreshUnlocked(now);
        await this.jobs.recoverUnlocked(now);
        await this.jobs.assignUnlocked(now, (agentId) => {
          this.hub.notify(agentId);
        });
        this.ticks += 1;
        if (this.ticks % this.options.noncePurgeEveryTicks === 0) {
          await this.store.purgeNonces(now);
        }
        if (this.ticks % this.options.metricPurgeEveryTicks === 0) {
          const before = new Date(now.getTime() - this.options.retentionDays * 86_400_000);
          await this.store.purgeMetricsBefore(before);
        }
      });
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.running = false;
    }
  }
}
