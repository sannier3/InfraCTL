import { randomUUID } from "node:crypto";
import type { HeartbeatBody, InventoryBody, ResourcesBody } from "@infra/schemas";
import { ERROR_CODES, type MachineStatus, type MachineType } from "@infra/types";
import type { AgentRecord, AlertRecord, MachineRecord, ProxmoxNodeRecord } from "../database/records.js";
import type { Store } from "../database/store.js";
import { AppError } from "../errors.js";
import type { Mutex } from "../lock.js";
import { presenceFromLastSeen, shouldHideStopped } from "./presence.js";

export type InventoryThresholds = {
  unreachableAfterSeconds: number;
  offlineAfterSeconds: number;
  hideStoppedAfterSeconds: number;
};

export class InventoryService {
  constructor(
    private readonly store: Store,
    private readonly lock: Mutex,
    private readonly thresholds: InventoryThresholds,
  ) {}

  heartbeat(agentId: string, body: HeartbeatBody, now: Date): Promise<AgentRecord> {
    return this.lock.run(() => this.heartbeatUnlocked(agentId, body, now));
  }

  applyInventory(agentId: string, body: InventoryBody, now: Date): Promise<MachineRecord> {
    return this.lock.run(() => this.applyInventoryUnlocked(agentId, body, now));
  }

  ingestResources(agentId: string, body: ResourcesBody, now: Date): Promise<void> {
    return this.lock.run(() => this.ingestResourcesUnlocked(agentId, body, now));
  }

  refresh(now: Date): Promise<void> {
    return this.lock.run(() => this.refreshUnlocked(now));
  }

  async refreshUnlocked(now: Date): Promise<void> {
    const agents = await this.store.listAgents();
    for (const agent of agents) {
      const presence = presenceFromLastSeen(
        agent.lastSeenAt,
        now,
        this.thresholds.unreachableAfterSeconds,
        this.thresholds.offlineAfterSeconds,
      );
      if (presence !== agent.presence) {
        await this.store.updateAgent(agent.id, { presence });
      }
    }
    await this.applyPresenceToMachines(now);
    await this.hideStopped(now);
  }

  private async heartbeatUnlocked(agentId: string, body: HeartbeatBody, now: Date): Promise<AgentRecord> {
    if (body.agentId !== agentId) {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, "l'identité signée ne correspond pas au corps");
    }
    const agent = await this.store.findAgent(agentId);
    if (!agent) {
      throw new AppError(401, ERROR_CODES.AGENT_UNAUTHORIZED, "authentification agent refusée");
    }
    if (body.type !== agent.type) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "le type d'agent ne correspond pas à l'enregistrement");
    }
    const updated = await this.store.updateAgent(agent.id, {
      version: body.version,
      presence: "ONLINE",
      lastSeenAt: now,
      capabilities: body.capabilities,
      reportedRunning: body.jobs.running,
      reportedQueued: body.jobs.queued,
      reportedCapacity: body.jobs.capacity,
    });
    if (!updated) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "agent introuvable");
    }
    const machine = await this.store.findMachineByAgent(agent.id);
    if (machine && (machine.status === "OFFLINE" || machine.status === "UNKNOWN")) {
      const nodeDown = await this.nodeOfGuestIsOffline(machine.id);
      if (!nodeDown) {
        await this.store.updateMachine(machine.id, {
          status: "RUNNING",
          lastSeenAt: now,
          lastStateChangeAt: now,
          hiddenAt: null,
        });
      }
    } else if (machine) {
      await this.store.updateMachine(machine.id, { lastSeenAt: now });
    }
    return updated;
  }

  private async applyInventoryUnlocked(agentId: string, body: InventoryBody, now: Date): Promise<MachineRecord> {
    const agent = await this.store.findAgent(agentId);
    if (!agent) {
      throw new AppError(401, ERROR_CODES.AGENT_UNAUTHORIZED, "authentification agent refusée");
    }
    if (body.guests && agent.type !== "proxmox-node") {
      throw new AppError(422, ERROR_CODES.INCOMPATIBLE_TARGET, "seul un agent proxmox-node remonte des guests");
    }
    if (agent.type === "proxmox-node") {
      return this.applyProxmox(agent, body, now);
    }
    if (body.machineType !== "VM" && body.machineType !== "PHYSICAL") {
      throw new AppError(422, ERROR_CODES.INCOMPATIBLE_TARGET, "un agent linux-node décrit une VM ou une machine physique");
    }
    return this.applyLinux(agent, body, now);
  }

  private async applyLinux(agent: AgentRecord, body: InventoryBody, now: Date): Promise<MachineRecord> {
    let existing: MachineRecord | null = null;
    let clusterId: string | null = null;
    if (body.proxmox) {
      const cluster = await this.ensureCluster(body.proxmox.clusterId, now);
      clusterId = cluster.id;
      const link = await this.store.findLinkByGuest(cluster.id, body.proxmox.vmid);
      if (link) {
        existing = await this.store.findMachine(link.machineId);
      }
    }
    existing ??= await this.store.findMachineByAgent(agent.id);
    const machine = await this.saveMachine(existing, {
      agentId: agent.id,
      hostname: body.hostname,
      displayName: body.displayName ?? body.hostname,
      type: body.machineType,
      status: body.status,
      metricsSource: body.metricsSource,
      now,
      details: detailsFrom(body),
    });
    if (body.proxmox && clusterId) {
      const current = await this.store.findLinkByGuest(clusterId, body.proxmox.vmid);
      await this.store.upsertLink({
        machineId: machine.id,
        clusterId,
        currentNodeId: current?.currentNodeId ?? null,
        vmid: body.proxmox.vmid,
        guestType: "QEMU",
      });
    }
    const machines = await this.store.listAllMachines();
    for (const other of machines) {
      if (other.agentId === agent.id && other.id !== machine.id) {
        await this.store.updateMachine(other.id, { agentId: null });
      }
    }
    return (await this.store.findMachine(machine.id)) ?? machine;
  }

  private async applyProxmox(agent: AgentRecord, body: InventoryBody, now: Date): Promise<MachineRecord> {
    if (!body.node) {
      throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "un nœud Proxmox doit envoyer node.clusterId et node.name");
    }
    if (body.machineType !== "PROXMOX_NODE") {
      throw new AppError(422, ERROR_CODES.INCOMPATIBLE_TARGET, "l'inventaire d'un nœud doit être de type PROXMOX_NODE");
    }
    const cluster = await this.ensureCluster(body.node.clusterId, now);
    const existing = await this.store.findMachineByAgent(agent.id);
    const machine = await this.saveMachine(existing, {
      agentId: agent.id,
      hostname: body.hostname,
      displayName: body.displayName ?? body.node.name,
      type: "PROXMOX_NODE",
      status: "RUNNING",
      metricsSource: "PROXMOX",
      now,
      details: { ...detailsFrom(body), proxmoxVersion: body.node.version },
    });
    const node = await this.store.upsertNode({
      id: randomUUID(),
      clusterId: cluster.id,
      name: body.node.name,
      machineId: machine.id,
      agentId: agent.id,
      version: body.node.version ?? null,
      createdAt: now,
      updatedAt: now,
    });
    const reported = new Set<number>();
    for (const guest of body.guests ?? []) {
      reported.add(guest.vmid);
      await this.upsertGuest(cluster.id, node, guest, now);
    }
    const links = await this.store.listLinks();
    for (const link of links) {
      if (link.currentNodeId !== node.id || reported.has(link.vmid)) {
        continue;
      }
      const guest = await this.store.findMachine(link.machineId);
      if (guest && guest.status !== "STOPPED") {
        await this.store.updateMachine(guest.id, {
          status: "STOPPED",
          lastStateChangeAt: now,
        });
      }
    }
    return (await this.store.findMachine(machine.id)) ?? machine;
  }

  private async upsertGuest(
    clusterId: string,
    node: ProxmoxNodeRecord,
    guest: NonNullable<InventoryBody["guests"]>[number],
    now: Date,
  ): Promise<void> {
    const link = await this.store.findLinkByGuest(clusterId, guest.vmid);
    const existing = link ? await this.store.findMachine(link.machineId) : null;
    const type: MachineType = guest.guestType === "LXC" ? "LXC" : "VM";
    const status: MachineStatus = guest.status === "running" ? "RUNNING" : "STOPPED";
    const machine = await this.saveMachine(existing, {
      agentId: existing?.agentId ?? null,
      hostname: existing?.agentId ? existing.hostname : guest.name,
      displayName: existing?.displayName ?? guest.name,
      type,
      status,
      metricsSource: existing?.agentId ? existing.metricsSource : "PROXMOX",
      now,
      details: existing?.details ?? null,
    });
    await this.store.upsertLink({
      machineId: machine.id,
      clusterId,
      currentNodeId: node.id,
      vmid: guest.vmid,
      guestType: guest.guestType,
    });
    if (guest.memoryTotal !== undefined && guest.memoryUsed !== undefined) {
      await this.store.insertMetric({
        id: randomUUID(),
        machineId: machine.id,
        timestamp: now,
        cpuUsage: guest.cpu ?? 0,
        memoryUsed: guest.memoryUsed,
        memoryTotal: guest.memoryTotal,
        diskUsed: guest.diskUsed ?? null,
        diskTotal: guest.diskTotal ?? null,
        networkRx: null,
        networkTx: null,
        uptime: guest.uptime ?? null,
      });
    }
  }

  private async ingestResourcesUnlocked(agentId: string, body: ResourcesBody, now: Date): Promise<void> {
    const machine = await this.store.findMachineByAgent(agentId);
    if (!machine) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "aucune machine associée à cet agent");
    }
    if (machine.metricsSource !== "LOCAL_AGENT") {
      throw new AppError(409, ERROR_CODES.METRICS_SOURCE_MISMATCH, "cette machine reçoit ses métriques depuis Proxmox");
    }
    await this.store.insertMetric({
      id: randomUUID(),
      machineId: machine.id,
      timestamp: new Date(body.timestamp),
      cpuUsage: body.cpuUsage,
      memoryUsed: body.memoryUsed,
      memoryTotal: body.memoryTotal,
      diskUsed: body.diskUsed,
      diskTotal: body.diskTotal,
      networkRx: body.networkRx,
      networkTx: body.networkTx,
      uptime: body.uptime,
    });
    await this.store.updateMachine(machine.id, { lastSeenAt: now });
  }

  private async applyPresenceToMachines(now: Date): Promise<void> {
    const [agents, nodes, links, machines] = await Promise.all([
      this.store.listAgents(),
      this.store.listNodes(),
      this.store.listLinks(),
      this.store.listAllMachines(),
    ]);
    const offlineNodeIds = new Set<string>();
    for (const node of nodes) {
      const agent = agents.find((item) => item.id === node.agentId);
      const machine = machines.find((item) => item.id === node.machineId);
      if (!machine) {
        continue;
      }
      if (agent?.presence === "OFFLINE") {
        offlineNodeIds.add(node.id);
        if (machine.status !== "OFFLINE") {
          await this.changeStatus(machine, "OFFLINE", now);
        }
        const guestIds = links.filter((link) => link.currentNodeId === node.id).map((link) => link.machineId);
        for (const guestId of guestIds) {
          const guest = await this.store.findMachine(guestId);
          if (guest && guest.status !== "UNKNOWN") {
            await this.changeStatus(guest, "UNKNOWN", now);
          }
        }
        await this.openNodeAlert(node, machine.id, guestIds.length, now);
      } else if (agent?.presence === "ONLINE" && machine.status === "OFFLINE") {
        await this.changeStatus(machine, "RUNNING", now);
        await this.store.resolveAlert(`node-offline:${machine.id}`, now);
      } else if (agent?.presence === "ONLINE") {
        await this.store.resolveAlert(`node-offline:${machine.id}`, now);
      }
    }

    for (const agent of agents) {
      if (agent.type !== "linux-node") {
        continue;
      }
      const machine = machines.find((item) => item.agentId === agent.id);
      if (!machine) {
        continue;
      }
      const link = links.find((item) => item.machineId === machine.id);
      if (link?.currentNodeId && offlineNodeIds.has(link.currentNodeId)) {
        continue;
      }
      if (agent.presence === "OFFLINE") {
        if (machine.status !== "OFFLINE" && machine.status !== "STOPPED") {
          await this.changeStatus(machine, "OFFLINE", now);
        }
        await this.openAgentAlert(agent, machine.id, now);
      } else if (agent.presence === "ONLINE") {
        await this.store.resolveAlert(`agent-offline:${agent.id}`, now);
      }
    }
  }

  private async hideStopped(now: Date): Promise<void> {
    const machines = await this.store.listAllMachines();
    for (const machine of machines) {
      const hide = shouldHideStopped(
        machine.status,
        machine.lastStateChangeAt,
        now,
        this.thresholds.hideStoppedAfterSeconds,
      );
      if (hide && machine.hiddenAt === null) {
        await this.store.updateMachine(machine.id, { hiddenAt: now });
      } else if (!hide && machine.hiddenAt !== null && machine.status !== "STOPPED") {
        await this.store.updateMachine(machine.id, { hiddenAt: null });
      }
    }
  }

  private async saveMachine(
    existing: MachineRecord | null,
    input: {
      agentId: string | null;
      hostname: string;
      displayName: string;
      type: MachineType;
      status: MachineStatus;
      metricsSource: MachineRecord["metricsSource"];
      now: Date;
      details: MachineRecord["details"];
    },
  ): Promise<MachineRecord> {
    if (!existing) {
      const created: MachineRecord = {
        id: randomUUID(),
        hostname: input.hostname,
        displayName: input.displayName,
        type: input.type,
        status: input.status,
        metricsSource: input.metricsSource,
        agentId: input.agentId,
        lastSeenAt: input.now,
        lastStateChangeAt: input.now,
        hiddenAt: null,
        details: input.details,
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.store.insertMachine(created);
      return created;
    }
    const statusChanged = existing.status !== input.status;
    const updated = await this.store.updateMachine(existing.id, {
      hostname: input.hostname,
      displayName: input.displayName,
      type: input.type,
      status: input.status,
      metricsSource: input.metricsSource,
      agentId: input.agentId,
      lastSeenAt: input.now,
      lastStateChangeAt: statusChanged ? input.now : existing.lastStateChangeAt,
      hiddenAt: input.status === "RUNNING" ? null : existing.hiddenAt,
      details: input.details,
    });
    return updated ?? existing;
  }

  private async changeStatus(machine: MachineRecord, status: MachineStatus, now: Date): Promise<void> {
    await this.store.updateMachine(machine.id, {
      status,
      lastStateChangeAt: now,
      hiddenAt: status === "STOPPED" ? machine.hiddenAt : null,
    });
  }

  private async openNodeAlert(
    node: ProxmoxNodeRecord,
    machineId: string,
    guests: number,
    now: Date,
  ): Promise<void> {
    const alert: AlertRecord = {
      id: randomUUID(),
      dedupeKey: `node-offline:${machineId}`,
      severity: "CRITICAL",
      title: `${node.name} offline`,
      message: guests > 0 ? `${node.name} offline — ${guests} guests unavailable` : `${node.name} offline`,
      machineId,
      agentId: node.agentId,
      clusterId: node.clusterId,
      acknowledgedAt: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsertAlert(alert);
  }

  private async openAgentAlert(agent: AgentRecord, machineId: string, now: Date): Promise<void> {
    const alert: AlertRecord = {
      id: randomUUID(),
      dedupeKey: `agent-offline:${agent.id}`,
      severity: "WARNING",
      title: `${agent.name} offline`,
      message: `${agent.name} offline`,
      machineId,
      agentId: agent.id,
      clusterId: null,
      acknowledgedAt: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsertAlert(alert);
  }

  private async ensureCluster(slug: string, now: Date) {
    const existing = await this.store.findCluster(slug);
    if (existing) {
      return existing;
    }
    return this.store.upsertCluster({
      id: randomUUID(),
      name: slug,
      slug,
      type: "PROXMOX",
      createdAt: now,
      updatedAt: now,
    });
  }

  private async nodeOfGuestIsOffline(machineId: string): Promise<boolean> {
    const link = await this.store.findLinkByMachine(machineId);
    if (!link?.currentNodeId) {
      return false;
    }
    const node = await this.store.findNode(link.currentNodeId);
    if (!node) {
      return false;
    }
    const machine = await this.store.findMachine(node.machineId);
    return machine?.status === "OFFLINE";
  }
}

function detailsFrom(body: InventoryBody): MachineRecord["details"] {
  return {
    osId: body.os.id,
    osName: body.os.name,
    osVersion: body.os.version,
    prettyName: body.os.prettyName,
    kernel: body.os.kernel,
    arch: body.os.arch,
  };
}
