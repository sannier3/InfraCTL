import type { Capability } from "@infra/types";
import { agentJobSchema, jobStartResponseSchema, type AgentConfig, type AgentJob, type InventoryBody, type ResourcesBody } from "@infra/schemas";
import { createNonce, headerValues, sign, splitUrl } from "@infra/protocol";

export type LogEntry = {
  stream: "stdout" | "stderr" | "system";
  timestamp: string;
  data: string;
};

export class ServerClient {
  constructor(
    private readonly config: AgentConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  baseUrl(): string {
    return `${this.config.server.protocol}://${this.config.server.host}:${this.config.server.port}`;
  }

  async heartbeat(input: {
    running: number;
    queued: number;
    capacity: number;
    capabilities: Capability[];
    aptConcurrency: number;
  }): Promise<unknown> {
    const response = await this.send("POST", "/api/v1/agent/heartbeat", {
      agentId: this.config.agent.id,
      version: this.config.agent.version,
      type: this.config.agent.type,
      jobs: { running: input.running, queued: input.queued, capacity: input.capacity },
      capabilities: input.capabilities,
      aptConcurrency: input.aptConcurrency,
    });
    return response.body;
  }

  async inventory(body: InventoryBody): Promise<void> {
    await this.send("POST", "/api/v1/agent/inventory", body);
  }

  async resources(body: ResourcesBody): Promise<void> {
    await this.send("POST", "/api/v1/agent/resources", body);
  }

  async nextJob(): Promise<AgentJob | null> {
    const response = await this.send("GET", "/api/v1/agent/jobs/next", undefined, this.config.server.longPollTimeoutMs);
    if (response.status === 204) {
      return null;
    }
    const parsed = agentJobSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new Error("job refusé : le serveur a envoyé un payload invalide");
    }
    return parsed.data;
  }

  async start(jobId: string): Promise<{ status: "RUNNING" | "CANCELLED" | "REJECTED"; execute: boolean }> {
    const response = await this.send("POST", `/api/v1/agent/jobs/${jobId}/start`);
    return jobStartResponseSchema.parse(response.body);
  }

  async logs(jobId: string, entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.send("POST", `/api/v1/agent/jobs/${jobId}/logs`, { entries });
  }

  async complete(
    jobId: string,
    body: {
      exitCode: number | null;
      durationMs: number;
      resolvedExecutable: string | null;
      resolvedArguments: string[] | null;
      result?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.send("POST", `/api/v1/agent/jobs/${jobId}/complete`, body);
  }

  async fail(
    jobId: string,
    body: {
      exitCode: number | null;
      durationMs: number;
      resolvedExecutable: string | null;
      resolvedArguments: string[] | null;
      errorCode: string;
      errorMessage: string;
      result?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.send("POST", `/api/v1/agent/jobs/${jobId}/fail`, body);
  }

  private async send(
    method: string,
    path: string,
    payload?: unknown,
    timeoutMs = this.config.server.requestTimeoutMs,
  ): Promise<{ status: number; body: unknown }> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const url = new URL(path, this.baseUrl());
    const parts = splitUrl(url);
    const timestamp = String(this.now());
    const nonce = createNonce();
    const signature = sign(this.config.agent.secret, {
      method,
      pathname: parts.pathname,
      query: parts.query,
      timestamp,
      nonce,
      body,
    });
    const headers = new Headers({
      ...headerValues({
        agentId: this.config.agent.id,
        timestamp,
        nonce,
        signature,
      }),
      accept: "application/json",
    });
    if (body.length > 0) {
      headers.set("content-type", "application/json");
    }
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body.length > 0 ? body : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;
    if (response.status >= 400) {
      throw new Error(`requête agent refusée (${response.status})`);
    }
    return { status: response.status, body: parsed };
  }
}
