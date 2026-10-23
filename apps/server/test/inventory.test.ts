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

  it("garde deux machines quand deux nœuds annoncent le même VMID", async () => {
    const store = new MemoryStore();
    const inventory = service(store);
    await store.insertAgent({ secretCiphertext: "x", agent: agent("pve01", "proxmox-node") });
    await store.insertAgent({ secretCiphertext: "y", agent: agent("pve03", "proxmox-node") });
    const guests = [
      { vmid: 112, guestType: "LXC" as const, name: "JBS-SYNOLOGY-VM", status: "running" as const },
      { vmid: 117, guestType: "LXC" as const, name: "MySql", status: "running" as const },
    ];
    await inventory.applyInventory("pve01", nodeInventory("pve", "pve", guests), NOW);
    await inventory.applyInventory(
      "pve03",
      nodeInventory("pve-r730", "pve", [
        { vmid: 112, guestType: "QEMU", name: "JBS-SYNOLOGY-VM", status: "running" },
        { vmid: 117, guestType: "LXC", name: "MySql", status: "running" },
      ]),
      NOW,
    );
    await inventory.applyInventory("pve01", nodeInventory("pve", "pve", guests), NOW);
    const clusterId = (await store.findCluster("pve"))!.id;
    const links = await store.findLinksByGuest(clusterId, 112);
    expect(links).toHaveLength(2);
    const machines = await Promise.all(links.map((link) => store.findMachine(link.machineId)));
    expect(new Set(machines.map((item) => item?.type))).toEqual(new Set(["LXC", "VM"]));
    const mysql = await store.findLinksByGuest(clusterId, 117);
    expect(mysql).toHaveLength(2);
    expect(new Set(mysql.map((link) => link.currentNodeId)).size).toBe(2);
    const again = await store.findLinkByNodeGuest(links[0]!.currentNodeId!, 112);
    expect(again?.machineId).toBe(links[0]?.machineId);
  });

  it("rattache une VM avec agent au VMID d'un nœud et masque la fiche d'inventaire", async () => {
    const store = new MemoryStore();
    const inventory = service(store);
    await store.insertAgent({ secretCiphertext: "x", agent: agent("pve01", "proxmox-node") });
    await inventory.applyInventory("pve01", nodeInventory("pve01", "prod", [{ vmid: 104, guestType: "QEMU", name: "vm-104", status: "running" }]), NOW);
    const cluster = await store.findCluster("prod");
    const node = (await store.listNodes())[0];
    const placeholder = await store.findLinkByGuest(cluster!.id, 104);
    const vm = machine(randomUUID(), "RUNNING", NOW, "VM");
    vm.agentId = "vm-agent";
    vm.hostname = "vm-agent";
    vm.displayName = "VM agent";
    vm.metricsSource = "LOCAL_AGENT";
    await store.insertMachine(vm);
    await inventory.linkVm(vm.id, node!.id, 104, NOW);
    const link = await store.findLinkByGuest(cluster!.id, 104);
    expect(link?.machineId).toBe(vm.id);
    expect(link?.currentNodeId).toBe(node!.id);
    expect(link?.guestType).toBe("QEMU");
    const hidden = await store.findMachine(placeholder!.machineId);
    expect(hidden?.status).toBe("STOPPED");
    expect(hidden?.hiddenAt).not.toBeNull();
    await inventory.applyInventory("pve01", nodeInventory("pve01", "prod", [{ vmid: 104, guestType: "QEMU", name: "vm-104", status: "running" }]), NOW);
    expect((await store.findLinkByGuest(cluster!.id, 104))?.machineId).toBe(vm.id);
    expect((await store.findMachine(vm.id))?.agentId).toBe("vm-agent");
  });

  it("retire le lien d'une VM qui a un agent et laisse l'inventaire recréer le guest", async () => {
    const store = new MemoryStore();
    const inventory = service(store);
    await store.insertAgent({ secretCiphertext: "x", agent: agent("pve01", "proxmox-node") });
    await inventory.applyInventory("pve01", nodeInventory("pve01", "prod", [{ vmid: 104, guestType: "QEMU", name: "vm-104", status: "running" }]), NOW);
    const cluster = await store.findCluster("prod");
    const node = (await store.listNodes())[0];
    const vm = machine(randomUUID(), "RUNNING", NOW, "VM");
    vm.agentId = "vm-agent";
    vm.displayName = "VM agent";
    await store.insertMachine(vm);
    await inventory.linkVm(vm.id, node!.id, 104, NOW);
    const unlinked = await inventory.unlinkVm(vm.id, NOW);
    expect(unlinked.agentId).toBe("vm-agent");
    expect(unlinked.hiddenAt).toBeNull();
    expect(await store.findLinkByMachine(vm.id)).toBeNull();
    await inventory.applyInventory("pve01", nodeInventory("pve01", "prod", [{ vmid: 104, guestType: "QEMU", name: "vm-104", status: "running" }]), NOW);
    const restored = await store.findLinkByGuest(cluster!.id, 104);
    expect(restored?.machineId).not.toBe(vm.id);
    expect((await store.findMachine(vm.id))?.agentId).toBe("vm-agent");
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
