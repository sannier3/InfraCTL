import {
  ACTION_CATALOG,
  ACTION_NAMES,
  actionRequiresHostMaintenance,
  agentHasCapabilities,
  type ActionDefinition,
  type ActionName,
  type AgentPresence,
  type MachineStatus,
  type MachineType,
} from "@infra/types";
import type { JobRecord } from "../database/records.js";

export type Limits = {
  global: number;
  perAgent: number;
  perProxmoxNode: number;
  aptPerProxmoxNode: number;
  perMachineWrite: number;
  proxmoxHostMaintenancePerCluster: number;
};

export type WorldAgent = {
  id: string;
  presence: AgentPresence;
  maxConcurrency: number;
  capabilities: readonly string[];
  aptConcurrency?: number;
};

export type WorldMachine = {
  id: string;
  type: MachineType;
  status: MachineStatus;
  agentId: string | null;
};

export type WorldNode = {
  id: string;
  clusterId: string;
  name: string;
  machineId: string;
  agentId: string | null;
  machineStatus: MachineStatus;
};

export type WorldLink = {
  machineId: string;
  clusterId: string;
  currentNodeId: string | null;
  vmid: number;
};

export type Admission =
  | { decision: "assign"; agentId: string }
  | { decision: "wait" }
  | { decision: "skip"; code: string; message: string }
  | { decision: "reject"; code: string; message: string };

const UNRESOLVED = new Set(["UNKNOWN", "INTERRUPTED", "REQUIRES_CONFIRMATION"]);

export function evaluateAdmission(input: {
  action: ActionDefinition;
  machine: WorldMachine;
  agents: readonly WorldAgent[];
  machines: readonly WorldMachine[];
  nodes: readonly WorldNode[];
  links: readonly WorldLink[];
  jobs: readonly JobRecord[];
  limits: Limits;
}): Admission {
  if (!input.action.supportedTargets.includes(input.machine.type)) {
    return {
      decision: "skip",
      code: "INCOMPATIBLE_TARGET",
      message: `${input.action.name} ne prend pas en charge ${input.machine.type}`,
    };
  }
  if (!input.action.enabled) {
    return {
      decision: "reject",
      code: "ACTION_DISABLED",
      message: `${input.action.name} n'est pas activée`,
    };
  }

  const route = resolveRoute(input.machine, input.agents, input.nodes, input.links);
  if (route.decision !== "ready") {
    return route.decision === "wait"
      ? { decision: "wait" }
      : { decision: "skip", code: route.code, message: route.message };
  }

  const agent = input.agents.find((item) => item.id === route.agentId);
  if (!agent || !agentHasCapabilities(agent.capabilities, input.action.capabilities)) {
    return {
      decision: "skip",
      code: "INCOMPATIBLE_TARGET",
      message: "l'agent ne possède pas les capacités requises",
    };
  }

  const unresolved = input.jobs.some((job) => {
    if (job.machineId !== input.machine.id || job.acknowledgedAt || !UNRESOLVED.has(job.status)) {
      return false;
    }
    const definition = safeAction(job.action);
    return definition?.mutating === true && definition.neverAutoRetry;
  });
  if (unresolved && input.action.mutating) {
    return { decision: "wait" };
  }

  const active = input.jobs.filter(
    (job) => job.executionKind === "LEAF" && (job.status === "ASSIGNED" || job.status === "RUNNING"),
  );
  if (active.length >= input.limits.global) {
    return { decision: "wait" };
  }
  const aptBudget = Math.max(input.limits.aptPerProxmoxNode, agent.aptConcurrency ?? 0);
  const perAgent = input.action.countsAsApt
    ? Math.min(agent.maxConcurrency, aptBudget)
    : Math.min(input.limits.perAgent, agent.maxConcurrency);
  if (active.filter((job) => job.agentId === agent.id).length >= perAgent) {
    return { decision: "wait" };
  }

  const onMachine = active.filter((job) => job.machineId === input.machine.id);
  const mutatingOnMachine = onMachine.filter((job) => safeAction(job.action)?.mutating === true);
  if (input.action.mutating && onMachine.length > 0) {
    return { decision: "wait" };
  }
  if (!input.action.mutating && mutatingOnMachine.length >= input.limits.perMachineWrite) {
    return { decision: "wait" };
  }

  const nodeId = route.proxmoxNodeId;
  if (nodeId) {
    const onNode = active.filter((job) => executionNodeId(job, input.machines, input.nodes, input.links) === nodeId);
    if (input.action.countsAsApt) {
      const aptOnNode = onNode.filter((job) => safeAction(job.action)?.countsAsApt === true);
      if (aptOnNode.length >= aptBudget) {
        return { decision: "wait" };
      }
    } else if (onNode.length >= input.limits.perProxmoxNode) {
      return { decision: "wait" };
    }
  }

  if (actionRequiresHostMaintenance(input.action, input.machine.type) && route.clusterId) {
    const maintenance = active.filter((job) => {
      const definition = safeAction(job.action);
      const machine = input.machines.find((item) => item.id === job.machineId);
      if (!definition || !machine || !actionRequiresHostMaintenance(definition, machine.type)) {
        return false;
      }
      return clusterIdOf(job, input.machines, input.nodes, input.links) === route.clusterId;
    });
    if (maintenance.length >= input.limits.proxmoxHostMaintenancePerCluster) {
      return { decision: "wait" };
    }
  }

  return { decision: "assign", agentId: route.agentId };
}

function safeAction(name: string): ActionDefinition | null {
  if (!(ACTION_NAMES as readonly string[]).includes(name)) {
    return null;
  }
  return ACTION_CATALOG[name as ActionName];
}

type Route =
  | { decision: "ready"; agentId: string; proxmoxNodeId: string | null; clusterId: string | null }
  | { decision: "wait" }
  | { decision: "skip"; code: string; message: string };

export function resolveRoute(
  machine: WorldMachine,
  agents: readonly WorldAgent[],
  nodes: readonly WorldNode[],
  links: readonly WorldLink[],
): Route {
  const link = links.find((item) => item.machineId === machine.id) ?? null;
  if (machine.type === "LXC") {
    return routeViaNode(link, nodes, agents, "SKIPPED_NODE_UNAVAILABLE");
  }
  if (machine.type === "VM" && link?.currentNodeId) {
    const node = nodes.find((item) => item.id === link.currentNodeId);
    if (!node || node.machineStatus === "OFFLINE") {
      return {
        decision: "skip",
        code: "SKIPPED_NODE_UNAVAILABLE",
        message: "le nœud Proxmox de cette VM est indisponible",
      };
    }
  }
  if (machine.type === "PROXMOX_NODE") {
    const node = nodes.find((item) => item.machineId === machine.id);
    if (machine.status === "OFFLINE") {
      return { decision: "skip", code: "SKIPPED_OFFLINE", message: "le nœud Proxmox est offline" };
    }
    return routeToAgent(machine.agentId ?? node?.agentId ?? null, agents, node?.id ?? null, node?.clusterId ?? null, "SKIPPED_OFFLINE");
  }
  return routeToAgent(machine.agentId, agents, null, link?.clusterId ?? null, "SKIPPED_OFFLINE");
}

function routeViaNode(
  link: WorldLink | null,
  nodes: readonly WorldNode[],
  agents: readonly WorldAgent[],
  offlineCode: string,
): Route {
  if (!link?.currentNodeId) {
    return { decision: "skip", code: offlineCode, message: "aucun nœud courant pour ce guest" };
  }
  const node = nodes.find((item) => item.id === link.currentNodeId);
  if (!node || node.machineStatus === "OFFLINE") {
    return { decision: "skip", code: offlineCode, message: "le nœud Proxmox est indisponible" };
  }
  return routeToAgent(node.agentId, agents, node.id, node.clusterId, offlineCode);
}

function routeToAgent(
  agentId: string | null,
  agents: readonly WorldAgent[],
  proxmoxNodeId: string | null,
  clusterId: string | null,
  offlineCode: string,
): Route {
  if (!agentId) {
    return { decision: "skip", code: "NO_AGENT", message: "aucun agent n'est associé à cette machine" };
  }
  const agent = agents.find((item) => item.id === agentId);
  if (!agent || agent.presence === "OFFLINE") {
    return { decision: "skip", code: offlineCode, message: "l'agent est offline" };
  }
  if (agent.presence === "UNREACHABLE") {
    return { decision: "wait" };
  }
  return { decision: "ready", agentId: agent.id, proxmoxNodeId, clusterId };
}

export function executionNodeId(
  job: Pick<JobRecord, "machineId">,
  machines: readonly WorldMachine[],
  nodes: readonly WorldNode[],
  links: readonly WorldLink[],
): string | null {
  if (!job.machineId) {
    return null;
  }
  const machine = machines.find((item) => item.id === job.machineId);
  if (!machine) {
    return null;
  }
  if (machine.type === "LXC") {
    return links.find((item) => item.machineId === machine.id)?.currentNodeId ?? null;
  }
  if (machine.type === "PROXMOX_NODE") {
    return nodes.find((item) => item.machineId === machine.id)?.id ?? null;
  }
  return null;
}

function clusterIdOf(
  job: Pick<JobRecord, "machineId">,
  machines: readonly WorldMachine[],
  nodes: readonly WorldNode[],
  links: readonly WorldLink[],
): string | null {
  if (!job.machineId) {
    return null;
  }
  const machine = machines.find((item) => item.id === job.machineId);
  if (!machine) {
    return null;
  }
  if (machine.type === "PROXMOX_NODE") {
    return nodes.find((item) => item.machineId === machine.id)?.clusterId ?? null;
  }
  return links.find((item) => item.machineId === machine.id)?.clusterId ?? null;
}
