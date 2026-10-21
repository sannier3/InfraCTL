import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Mutex } from "../src/lock.js";
import { MemoryStore } from "../src/database/memory-store.js";
import { InventoryService } from "../src/inventory/service.js";
import type { AgentRecord, MachineRecord } from "../src/database/records.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");

function service(store: MemoryStore, hideStoppedAfterSeconds = 300): InventoryService {
  return new InventoryService(store, new Mutex(), {
    unreachableAfterSeconds: 30,
    offlineAfterSeconds: 60,
    hideStoppedAfterSeconds,
  });
}

describe("présence et inventaire", () => {
  it("masque une machine arrêtée depuis plus de cinq minutes et la réaffiche", async () => {
    const store = new MemoryStore();
    const stopped = machine(randomUUID(), "STOPPED", new Date(NOW.getTime() - 6 * 60_000));
    const recent = machine(randomUUID(), "STOPPED", new Date(NOW.getTime() - 60_000));
    await store.insertMachine(stopped);
    await store.insertMachine(recent);
    await service(store).refresh(NOW);
    expect((await store.findMachine(stopped.id))?.hiddenAt).not.toBeNull();
    expect((await store.findMachine(recent.id))?.hiddenAt).toBeNull();

    await store.updateMachine(stopped.id, { status: "RUNNING", lastStateChangeAt: NOW });
    await service(store).refresh(NOW);
    expect((await store.findMachine(stopped.id))?.hiddenAt).toBeNull();
  });

  it("passe les guests en UNKNOWN et ouvre une seule alerte si le nœud est offline", async () => {
    const store = new MemoryStore();
    const clusterId = randomUUID();
    const nodeMachine = machine(randomUUID(), "RUNNING", NOW, "PROXMOX_NODE");
    const guestA = machine(randomUUID(), "RUNNING", NOW, "LXC");
    const guestB = machine(randomUUID(), "RUNNING", NOW, "VM");
    const guestC = machine(randomUUID(), "STOPPED", NOW, "LXC");
    await store.insertMachine(nodeMachine);
    await store.insertMachine(guestA);
    await store.insertMachine(guestB);
    await store.insertMachine(guestC);
    await store.insertAgent({
      secretCiphertext: "enc:v1:aa:bb:cc",
      agent: agent("pve02"),
    });
    await store.upsertCluster({ id: clusterId, name: "prod", slug: "prod", type: "PROXMOX", createdAt: NOW, updatedAt: NOW });
    const node = await store.upsertNode({
      id: randomUUID(),
      clusterId,
      name: "pve02",
      machineId: nodeMachine.id,
      agentId: "pve02",
      version: "8.2",
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const [guest, vmid, guestType] of [
      [guestA, 201, "LXC"],
      [guestB, 202, "QEMU"],
      [guestC, 203, "LXC"],
    ] as const) {
      await store.upsertLink({
        machineId: guest.id,
        clusterId,
        currentNodeId: node.id,
        vmid,
        guestType,
      });
    }
    await store.updateAgent("pve02", { presence: "OFFLINE", lastSeenAt: new Date(NOW.getTime() - 120_000) });
    await service(store).refresh(NOW);
    expect((await store.findMachine(nodeMachine.id))?.status).toBe("OFFLINE");
    expect((await store.findMachine(guestA.id))?.status).toBe("UNKNOWN");
    expect((await store.findMachine(guestB.id))?.status).toBe("UNKNOWN");
    expect((await store.findMachine(guestC.id))?.status).toBe("UNKNOWN");
    const alerts = await store.listAlerts({ page: 1, limit: 20, openOnly: true });
    expect(alerts.total).toBe(1);
    expect(alerts.items[0]?.title).toBe("pve02 offline");
    expect(alerts.items[0]?.message).toContain("3 guests unavailable");
  });

  it("déplace un guest migré vers le nouveau nœud sans le supprimer", async () => {
    const store = new MemoryStore();
    const inventory = service(store);
    await store.insertAgent({ secretCiphertext: "x", agent: agent("pve01", "proxmox-node") });
    await store.insertAgent({ secretCiphertext: "y", agent: agent("pve03", "proxmox-node") });
    await inventory.applyInventory("pve01", nodeInventory("pve01", "prod", [{ vmid: 101, guestType: "LXC", name: "ct", status: "running" }]), NOW);
    const first = await store.findLinkByGuest((await store.findCluster("prod"))!.id, 101);
    expect(first?.currentNodeId).toBeTruthy();
    const machineId = first?.machineId;
    await inventory.applyInventory("pve03", nodeInventory("pve03", "prod", [{ vmid: 101, guestType: "LXC", name: "ct", status: "running" }]), NOW);
    const moved = await store.findLinkByGuest((await store.findCluster("prod"))!.id, 101);
    expect(moved?.machineId).toBe(machineId);
    expect(moved?.currentNodeId).not.toBe(first?.currentNodeId);
    expect(await store.listAllMachines()).toHaveLength(3);
  });
});

function machine(
  id: string,
  status: MachineRecord["status"],
  lastStateChangeAt: Date,
  type: MachineRecord["type"] = "PHYSICAL",
): MachineRecord {
  return {
    id,
    hostname: id.slice(0, 8),
    displayName: id.slice(0, 8),
    type,
    status,
    metricsSource: type === "PHYSICAL" ? "LOCAL_AGENT" : "PROXMOX",
    agentId: null,
    lastSeenAt: NOW,
    lastStateChangeAt,
    hiddenAt: null,
    details: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function agent(id: string, type: AgentRecord["type"] = "proxmox-node"): AgentRecord {
  return {
    id,
    name: id,
    type,
    version: "1.0.0",
    presence: "ONLINE",
    lastSeenAt: NOW,
    registeredAt: NOW,
    maxConcurrency: 4,
    capabilities: ["proxmox.inventory", "lxc.exec", "apt"],
    reportedRunning: 0,
    reportedQueued: 0,
    reportedCapacity: 4,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function nodeInventory(name: string, clusterId: string, guests: Array<{ vmid: number; guestType: "LXC" | "QEMU"; name: string; status: "running" | "stopped" }>) {
  return {
    hostname: name,
    machineType: "PROXMOX_NODE" as const,
    metricsSource: "PROXMOX" as const,
    status: "RUNNING" as const,
    os: { kernel: "6.8.0", arch: "x64" },
    node: { clusterId, name, version: "8.2.2" },
    guests,
  };
}
