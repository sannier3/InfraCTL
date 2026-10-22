import type { AgentConfig } from "@infra/schemas";

export function applyRemoteSettings(config: AgentConfig, body: unknown): void {
  if (!body || typeof body !== "object" || !("settings" in body)) return;
  const settings = (body as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object") return;
  const value = settings as Record<string, unknown>;
  assign(config.server, value.server, ["protocol", "host", "port", "requestTimeoutMs", "longPollTimeoutMs"]);
  assign(config.machine, value.machine, ["type", "displayName"]);
  assign(config.intervals, value.intervals, ["heartbeatSeconds", "inventorySeconds", "resourcesSeconds"]);
  assign(config.concurrency, value.concurrency, ["total", "apt"]);
  assign(config.metrics, value.metrics, ["source"]);
  assign(config.proxmox, value.proxmox, ["enabled", "clusterId", "vmid"]);
  if (value.logLevel === "debug" || value.logLevel === "info" || value.logLevel === "warn" || value.logLevel === "error") {
    config.logLevel = value.logLevel;
  }
  if (typeof value.version === "string" && value.version.trim().length > 0) {
    config.agent.version = value.version.trim();
  }
}

function assign(target: object, source: unknown, keys: string[]): void {
  if (!source || typeof source !== "object") return;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) {
      (target as Record<string, unknown>)[key] = record[key];
    }
  }
}
