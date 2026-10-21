import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG } from "@infra/types";
import { buildApp } from "../src/api/app.js";
import { MemoryStore } from "../src/database/memory-store.js";
import type { JobRecord, MachineRecord } from "../src/database/records.js";
import { evaluateAdmission } from "../src/jobs/admission.js";
import { aggregateParentStatus } from "../src/jobs/parents.js";
import { registerAgent, signed, testConfig } from "./helpers.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");
const SECRET = "agent-secret-value-1";

describe("API et scheduler", () => {
  it("protège le replay HMAC et refuse une signature fausse", async () => {
    const store = new MemoryStore();
    await registerAgent(store, { id: "edge-01", secret: SECRET });
    const built = await buildApp({ config: testConfig(), store, now: () => NOW, startScheduler: false });
    const base = await listen(built.app);
    const body = JSON.stringify({
      agentId: "edge-01",
      version: "1.0.0",
      type: "linux-node",
      jobs: { running: 0, queued: 0, capacity: 4 },
      capabilities: ["system", "apt", "local.metrics"],
    });
    const first = signed({
      method: "POST",
      path: "/api/v1/agent/heartbeat",
      body,
      secret: SECRET,
      agentId: "edge-01",
      now: NOW,
      nonce: "abc123abc123abc123abc123abc123ab",
    });
    const ok = await fetch(`${base}/api/v1/agent/heartbeat`, {
      method: "POST",
      headers: first.headers,
      body: first.payload,
    });
    expect(ok.status).toBe(200);
    const replay = await fetch(`${base}/api/v1/agent/heartbeat`, {
      method: "POST",
      headers: first.headers,
      body: first.payload,
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: "REPLAY_DETECTED" } });

    const forged = signed({
      method: "POST",
      path: "/api/v1/agent/heartbeat",
      body,
      secret: "another-secret-value",
      agentId: "edge-01",
      now: NOW,
      nonce: "def123def123def123def123def123de",
    });
    const denied = await fetch(`${base}/api/v1/agent/heartbeat`, {
      method: "POST",
      headers: forged.headers,
      body: forged.payload,
    });
    expect(denied.status).toBe(401);
    await built.app.close();
  });

  it("exécute system.info sans champ de commande et conserve l'audit", async () => {
    const store = new MemoryStore();
    await registerAgent(store, { id: "edge-01", secret: SECRET });
    const built = await buildApp({ config: testConfig(), store, now: () => NOW, startScheduler: false });
    const base = await listen(built.app);
    await inventory(store);
    const created = await fetch(`${base}/api/v1/actions`, {
      method: "POST",
      headers: { authorization: "Bearer dev-admin-token-change", "content-type": "application/json" },
      body: JSON.stringify({ action: "system.info", selector: { type: "fleet" }, requestedBy: "ops" }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { id: string; executionKind: string };
    const parentId = createdBody.id;
    expect(createdBody.executionKind).toBe("PARENT");
    await built.scheduler.tick();
    const nonce = "11112222333344445555666677778888";
    const poll = signed({
      method: "GET",
      path: "/api/v1/agent/jobs/next",
      secret: SECRET,
      agentId: "edge-01",
      now: NOW,
      nonce,
    });
    const next = await fetch(`${base}/api/v1/agent/jobs/next`, { method: "GET", headers: poll.headers });
    expect(next.status).toBe(200);
    const job = (await next.json()) as { jobId: string; action: string; command?: string };
    expect(job.action).toBe("system.info");
    expect(job).not.toHaveProperty("command");
    expect(JSON.stringify(job)).not.toContain("bash");

    const start = signed({
      method: "POST",
      path: `/api/v1/agent/jobs/${job.jobId}/start`,
      secret: SECRET,
      agentId: "edge-01",
      now: NOW,
      nonce: "22223333444455556666777788889999",
    });
    const started = await fetch(`${base}/api/v1/agent/jobs/${job.jobId}/start`, {
      method: "POST",
      headers: start.headers,
    });
    expect(await started.json()).toMatchObject({ execute: true, status: "RUNNING" });

    const logsBody = JSON.stringify({
      entries: [{ stream: "system", timestamp: NOW.toISOString(), data: "ok" }],
    });
    const logs = signed({
      method: "POST",
      path: `/api/v1/agent/jobs/${job.jobId}/logs`,
      body: logsBody,
      secret: SECRET,
      agentId: "edge-01",
      now: NOW,
      nonce: "33334444555566667777888899990000",
    });
    expect(
      (
        await fetch(`${base}/api/v1/agent/jobs/${job.jobId}/logs`, {
          method: "POST",
          headers: logs.headers,
          body: logs.payload,
        })
      ).status,
    ).toBe(200);

    const completeBody = JSON.stringify({
      exitCode: 0,
      durationMs: 12,
      resolvedExecutable: null,
      resolvedArguments: null,
      result: { hostname: "edge-01" },
    });
    const complete = signed({
      method: "POST",
      path: `/api/v1/agent/jobs/${job.jobId}/complete`,
      body: completeBody,
      secret: SECRET,
      agentId: "edge-01",
      now: NOW,
      nonce: "44445555666677778888999900001111",
    });
    const done = await fetch(`${base}/api/v1/agent/jobs/${job.jobId}/complete`, {
      method: "POST",
      headers: complete.headers,
      body: complete.payload,
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: "SUCCESS", result: { hostname: "edge-01" } });
    const parent = await fetch(`${base}/api/v1/jobs/${parentId}`, {
      headers: { authorization: "Bearer dev-admin-token-change" },
    });
    expect(await parent.json()).toMatchObject({ status: "SUCCESS", result: { counts: { SUCCESS: 1 } } });
    await built.app.close();
  });

  it("ne relance pas un job UNKNOWN et bloque une écriture non acquittée", async () => {
    const store = new MemoryStore();
    const machineId = randomUUID();
    await registerAgent(store, { id: "edge-01", secret: SECRET });
    await store.insertMachine(machine(machineId, "edge-01"));
    await store.insertJob(job({
      id: randomUUID(),
      machineId,
      action: "apt.upgrade",
      category: "WRITE",
      status: "UNKNOWN",
      agentId: "edge-01",
      errorCode: "AGENT_LOST",
    }));
    const built = await buildApp({ config: testConfig(), store, now: () => NOW, startScheduler: false });
    await built.scheduler.tick();
    const still = await store.listJobsByStatuses(["UNKNOWN"]);
    expect(still).toHaveLength(1);
    expect(still[0]?.status).toBe("UNKNOWN");

    const queuedId = randomUUID();
    await store.insertJob(job({
      id: queuedId,
      machineId,
      action: "apt.check",
      category: "READ",
      status: "QUEUED",
    }));
    await built.scheduler.tick();
    const apt = await store.findJob(queuedId);
    expect(apt?.status).toBe("ASSIGNED");
    await built.app.close();
  });

  it("ignore un apt.check pendant un apt.upgrade sur la même machine", async () => {
    const store = new MemoryStore();
    const machineId = randomUUID();
    const otherId = randomUUID();
    await registerAgent(store, { id: "edge-01", secret: SECRET, maxConcurrency: 4 });
    await store.insertMachine(machine(machineId, "edge-01", "host-a"));
    await store.insertMachine(machine(otherId, "edge-01", "host-b"));
    await store.insertJob(job({
      id: randomUUID(),
      machineId,
      action: "apt.upgrade",
      category: "WRITE",
      status: "RUNNING",
      agentId: "edge-01",
    }));
    const blocked = randomUUID();
    const free = randomUUID();
    await store.insertJob(job({ id: blocked, machineId, action: "apt.check", category: "READ", status: "QUEUED" }));
    await store.insertJob(job({ id: free, machineId: otherId, action: "apt.check", category: "READ", status: "QUEUED" }));
    const built = await buildApp({ config: testConfig(), store, now: () => NOW, startScheduler: false });
    await built.scheduler.tick();
    expect((await store.findJob(blocked))?.status).toBe("QUEUED");
    expect((await store.findJob(free))?.status).toBe("ASSIGNED");
    await built.app.close();
  });

  it("agrège un parent sans faire échouer le lot sur un SKIPPED", () => {
    expect(aggregateParentStatus(["SUCCESS", "SUCCESS", "SKIPPED"])).toBe("SUCCESS");
    expect(aggregateParentStatus(["SUCCESS", "FAILED"])).toBe("FAILED");
    expect(aggregateParentStatus(["UNKNOWN", "SUCCESS"])).toBe("UNKNOWN");
    expect(aggregateParentStatus(["QUEUED", "QUEUED"])).toBe("QUEUED");
    expect(aggregateParentStatus(["RUNNING", "QUEUED"])).toBe("RUNNING");
  });

  it("résout un LXC vers le nœud courant et pas vers l'ancien", () => {
    const clusterId = randomUUID();
    const nodeA = randomUUID();
    const nodeB = randomUUID();
    const guest = randomUUID();
    const base = {
      action: { ...ACTION_CATALOG["apt.check"] },
      agents: [
        { id: "pve01", presence: "ONLINE" as const, maxConcurrency: 4, capabilities: ["apt", "lxc.exec", "system"] },
        { id: "pve02", presence: "ONLINE" as const, maxConcurrency: 4, capabilities: ["apt", "lxc.exec", "system"] },
      ],
      machines: [
        { id: nodeA, type: "PROXMOX_NODE" as const, status: "RUNNING" as const, agentId: "pve01" },
        { id: nodeB, type: "PROXMOX_NODE" as const, status: "RUNNING" as const, agentId: "pve02" },
        { id: guest, type: "LXC" as const, status: "RUNNING" as const, agentId: null },
      ],
      nodes: [
        { id: nodeA, clusterId, name: "pve01", machineId: nodeA, agentId: "pve01", machineStatus: "RUNNING" as const },
        { id: nodeB, clusterId, name: "pve02", machineId: nodeB, agentId: "pve02", machineStatus: "RUNNING" as const },
      ],
      jobs: [],
      limits: testConfig().concurrency,
    };
    const onA = evaluateAdmission({
      ...base,
      machine: base.machines[2]!,
      links: [{ machineId: guest, clusterId, currentNodeId: nodeA, vmid: 101 }],
    });
    const onB = evaluateAdmission({
      ...base,
      machine: base.machines[2]!,
      links: [{ machineId: guest, clusterId, currentNodeId: nodeB, vmid: 101 }],
    });
    expect(onA).toEqual({ decision: "assign", agentId: "pve01" });
    expect(onB).toEqual({ decision: "assign", agentId: "pve02" });
  });
});

async function inventory(store: MemoryStore): Promise<void> {
  const machineId = randomUUID();
  await store.insertMachine(machine(machineId, "edge-01"));
}

async function listen(app: { listen: (options: { host: string; port: number }) => Promise<string>; server: { address: () => string | { port: number } | null } }): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("port introuvable");
  }
  return `http://127.0.0.1:${address.port}`;
}

function machine(id: string, agentId: string, hostname = "edge-01"): MachineRecord {
  return {
    id,
    hostname,
    displayName: hostname,
    type: "PHYSICAL",
    status: "RUNNING",
    metricsSource: "LOCAL_AGENT",
    agentId,
    lastSeenAt: NOW,
    lastStateChangeAt: NOW,
    hiddenAt: null,
    details: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function job(input: Partial<JobRecord> & Pick<JobRecord, "id" | "machineId" | "action" | "category" | "status">): JobRecord {
  return {
    parentId: null,
    executionKind: "LEAF",
    agentId: null,
    targetType: "machine",
    targetData: {
      machineId: input.machineId,
      machineType: "PHYSICAL",
      hostname: "edge-01",
    },
    requestedBy: "ops",
    createdAt: NOW,
    assignedAt: null,
    dispatchedAt: null,
    startedAt: input.status === "RUNNING" ? NOW : null,
    finishedAt: null,
    acknowledgedAt: null,
    resolvedExecutable: null,
    resolvedArguments: null,
    result: null,
    exitCode: null,
    durationMs: null,
    errorCode: input.errorCode ?? null,
    errorMessage: null,
    ...input,
  };
}
