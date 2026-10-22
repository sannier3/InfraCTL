import { paginationMeta } from "@infra/utils";
import type { AgentRecord, JobLogRecord, JobRecord, LinkRecord, MachineRecord, ProxmoxNodeRecord, UpdateCount } from "../database/records.js";

export function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export function presentAgent(agent: AgentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    type: agent.type,
    version: agent.version,
    presence: agent.presence,
    lastSeenAt: iso(agent.lastSeenAt),
    registeredAt: agent.registeredAt.toISOString(),
    maxConcurrency: agent.maxConcurrency,
    capabilities: agent.capabilities,
    reportedRunning: agent.reportedRunning,
    reportedQueued: agent.reportedQueued,
    reportedCapacity: agent.reportedCapacity,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

export function proxmoxIdentity(machineId: string, links: LinkRecord[], nodes: ProxmoxNodeRecord[]) {
  const link = links.find((item) => item.machineId === machineId) ?? null;
  const node = link
    ? (nodes.find((item) => item.id === link.currentNodeId) ?? null)
    : (nodes.find((item) => item.machineId === machineId) ?? null);
  if (!link && !node) {
    return null;
  }
  return { vmid: link?.vmid ?? null, nodeName: node?.name ?? null };
}

export function presentMachine(
  machine: MachineRecord,
  proxmox: { vmid: number | null; nodeName: string | null } | null = null,
  updates: UpdateCount | null = null,
) {
  const details = machine.details;
  return {
    id: machine.id,
    hostname: machine.hostname,
    displayName: machine.displayName,
    type: machine.type,
    status: machine.status,
    metricsSource: machine.metricsSource,
    agentId: machine.agentId,
    lastSeenAt: iso(machine.lastSeenAt),
    lastStateChangeAt: machine.lastStateChangeAt.toISOString(),
    hiddenAt: iso(machine.hiddenAt),
    addresses: details?.addresses ?? [],
    updates: updates
      ? {
          availableCount: updates.availableCount,
          securityCount: updates.securityCount,
          requiresReboot: updates.requiresReboot,
        }
      : null,
    system: details
      ? {
          prettyName: details.prettyName ?? null,
          kernel: details.kernel ?? null,
          arch: details.arch ?? null,
        }
      : null,
    proxmox,
    createdAt: machine.createdAt.toISOString(),
    updatedAt: machine.updatedAt.toISOString(),
  };
}

export function presentJob(job: JobRecord) {
  return {
    id: job.id,
    parentId: job.parentId,
    action: job.action,
    category: job.category,
    executionKind: job.executionKind,
    agentId: job.agentId,
    machineId: job.machineId,
    targetType: job.targetType,
    status: job.status,
    requestedBy: job.requestedBy,
    createdAt: job.createdAt.toISOString(),
    assignedAt: iso(job.assignedAt),
    dispatchedAt: iso(job.dispatchedAt),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
    acknowledgedAt: iso(job.acknowledgedAt),
    resolvedExecutable: job.resolvedExecutable,
    resolvedArguments: job.resolvedArguments,
    result: presentResult(job.result),
    exitCode: job.exitCode,
    durationMs: job.durationMs,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
  };
}

export function presentLog(log: JobLogRecord) {
  return {
    id: log.id,
    jobId: log.jobId,
    sequence: log.sequence,
    timestamp: log.timestamp.toISOString(),
    stream: log.stream,
    data: log.data,
  };
}

export function presentPage<T, R>(items: T[], total: number, page: number, limit: number, map: (item: T) => R) {
  return {
    data: items.map(map),
    pagination: paginationMeta(total, page, limit),
  };
}

function presentResult(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  return result as Record<string, unknown>;
}
