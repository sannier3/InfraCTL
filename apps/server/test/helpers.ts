import { Buffer } from "node:buffer";
import { serverConfigSchema, type ServerConfig } from "@infra/schemas";
import { headerValues, sign } from "@infra/protocol";
import { encryptSecret } from "../src/crypto/secrets.js";
import type { MemoryStore } from "../src/database/memory-store.js";
import type { AgentRecord } from "../src/database/records.js";

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

export function testConfig(overrides?: Partial<ServerConfig["concurrency"]>): ServerConfig {
  return serverConfigSchema.parse({
    server: { bind: "127.0.0.1", port: 8080, logLevel: "error", exposeSwagger: false, bodyLimitBytes: 1_048_576 },
    database: { url: "mysql://infra:infra_dev_password@127.0.0.1:3306/infra_manager" },
    auth: { apiToken: "dev-admin-token-change", readToken: "dev-reader-token-change" },
    security: {
      credentialsKey: TEST_KEY,
      hmacWindowSeconds: 60,
      longPollSeconds: 1,
      dispatchLeaseSeconds: 120,
    },
    agents: { unreachableAfterSeconds: 30, offlineAfterSeconds: 60 },
    inventory: { hideStoppedAfterSeconds: 300 },
    metrics: { retentionDays: 7 },
    concurrency: {
      global: 20,
      perAgent: 4,
      perProxmoxNode: 4,
      aptPerProxmoxNode: 2,
      perMachineWrite: 1,
      proxmoxHostMaintenancePerCluster: 1,
      ...overrides,
    },
    scheduler: { tickMs: 1000, noncePurgeEveryTicks: 60, metricPurgeEveryTicks: 3600 },
  });
}

export async function registerAgent(
  store: MemoryStore,
  input: Partial<AgentRecord> & { id: string; secret: string },
): Promise<void> {
  const now = new Date("2026-01-15T12:00:00.000Z");
  await store.insertAgent({
    secretCiphertext: encryptSecret(input.secret, Buffer.from(TEST_KEY, "base64")),
    agent: {
      id: input.id,
      name: input.name ?? input.id,
      type: input.type ?? "linux-node",
      version: input.version ?? "1.0.0",
      presence: input.presence ?? "ONLINE",
      lastSeenAt: input.lastSeenAt === undefined ? now : input.lastSeenAt,
      registeredAt: input.registeredAt ?? now,
      maxConcurrency: input.maxConcurrency ?? 4,
      capabilities: input.capabilities ?? ["system", "apt", "local.metrics"],
      reportedRunning: 0,
      reportedQueued: 0,
      reportedCapacity: input.maxConcurrency ?? 4,
      createdAt: now,
      updatedAt: now,
    },
  });
}

export function signed(input: {
  method: string;
  path: string;
  body?: string;
  secret: string;
  agentId: string;
  now: Date;
  nonce: string;
}): { headers: Record<string, string>; payload?: string } {
  const body = input.body ?? "";
  const timestamp = String(input.now.getTime());
  const signature = sign(input.secret, {
    method: input.method,
    pathname: input.path,
    query: "",
    timestamp,
    nonce: input.nonce,
    body,
  });
  return {
    headers: {
      ...headerValues({ agentId: input.agentId, timestamp, nonce: input.nonce, signature }),
      ...(body.length > 0 ? { "content-type": "application/json" } : {}),
    },
    ...(body.length > 0 ? { payload: body } : {}),
  };
}
