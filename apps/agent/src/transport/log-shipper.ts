import type { LogEntry, ServerClient } from "./client.js";

export class LogShipper {
  private entries: LogEntry[] = [];
  private bytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: Pick<ServerClient, "logs">,
    private readonly jobId: string,
  ) {}

  push(stream: LogEntry["stream"], data: string): void {
    if (data.length === 0) {
      return;
    }
    let offset = 0;
    while (offset < data.length) {
      const chunk = data.slice(offset, offset + 8_000);
      offset += chunk.length;
      this.entries.push({ stream, timestamp: new Date().toISOString(), data: chunk });
      this.bytes += chunk.length;
    }
    if (this.bytes >= 8_192) {
      this.chain = this.chain.then(() => this.flush());
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.chain = this.chain.then(() => this.flush());
      }, 500);
      this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.entries.length === 0) {
      return;
    }
    const batch = this.entries.splice(0, 100);
    this.bytes = this.entries.reduce((sum, entry) => sum + entry.data.length, 0);
    try {
      await this.client.logs(this.jobId, batch);
    } catch {
      this.entries = [...batch, ...this.entries].slice(-200);
      this.bytes = this.entries.reduce((sum, entry) => sum + entry.data.length, 0);
    }
  }
}
