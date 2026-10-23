import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type {
  AgentRecord,
  InstalledResult,
  AgentUpdate,
  AlertRecord,
  ClusterRecord,
  JobListQuery,
  JobLogRecord,
  JobRecord,
  JobUpdate,
  LinkRecord,
  MachineDetails,
  MachineListQuery,
  MachineRecord,
  MachineUpdate,
  MetricRecord,
  NonceRecord,
  PageQuery,
  PackageHit,
  ProxmoxNodeRecord,
  UpdateCount,
  UpdateSnapshotRecord,
} from "./records.js";
import type { NewAgent, NewSnapshot, Page, Store } from "./store.js";

const agentTypeToDb = {
  "proxmox-node": "proxmox_node",
  "linux-node": "linux_node",
} as const;

const agentTypeFromDb = {
  proxmox_node: "proxmox-node",
  linux_node: "linux-node",
} as const;

export class PrismaStore implements Store {
  constructor(private readonly prisma: PrismaClient) {}

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async insertAgent(input: NewAgent): Promise<"created" | "exists"> {
    try {
      await this.prisma.agent.create({
        data: {
          id: input.agent.id,
          name: input.agent.name,
          type: agentTypeToDb[input.agent.type],
          version: input.agent.version,
          presence: input.agent.presence,
          lastSeenAt: input.agent.lastSeenAt,
          registeredAt: input.agent.registeredAt,
          maxConcurrency: input.agent.maxConcurrency,
          capabilities: input.agent.capabilities,
          reportedRunning: input.agent.reportedRunning,
          reportedQueued: input.agent.reportedQueued,
          reportedCapacity: input.agent.reportedCapacity,
          createdAt: input.agent.createdAt,
          updatedAt: input.agent.updatedAt,
          credential: { create: { secretCiphertext: input.secretCiphertext } },
        },
      });
      return "created";
    } catch (error) {
      if (isUnique(error)) {
        return "exists";
      }
      throw error;
    }
  }

  async rotateAgentSecret(agentId: string, secretCiphertext: string): Promise<boolean> {
    const result = await this.prisma.agentCredential.updateMany({
      where: { agentId },
      data: { secretCiphertext },
    });
    return result.count === 1;
  }

  async deleteAgent(id: string): Promise<boolean> {
    try {
      await this.prisma.agent.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  async findAgent(id: string): Promise<AgentRecord | null> {
    const row = await this.prisma.agent.findUnique({ where: { id } });
    return row ? mapAgent(row) : null;
  }

  async findAgentSecret(id: string): Promise<string | null> {
    const row = await this.prisma.agentCredential.findUnique({ where: { agentId: id } });
    return row?.secretCiphertext ?? null;
  }

  async listAgents(): Promise<AgentRecord[]> {
    const rows = await this.prisma.agent.findMany({ orderBy: { id: "asc" } });
    return rows.map(mapAgent);
  }

  async updateAgent(id: string, patch: AgentUpdate): Promise<AgentRecord | null> {
    try {
      const row = await this.prisma.agent.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.type !== undefined ? { type: agentTypeToDb[patch.type] } : {}),
          ...(patch.version !== undefined ? { version: patch.version } : {}),
          ...(patch.presence !== undefined ? { presence: patch.presence } : {}),
          ...(patch.lastSeenAt !== undefined ? { lastSeenAt: patch.lastSeenAt } : {}),
          ...(patch.maxConcurrency !== undefined ? { maxConcurrency: patch.maxConcurrency } : {}),
          ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
          ...(patch.reportedRunning !== undefined ? { reportedRunning: patch.reportedRunning } : {}),
          ...(patch.reportedQueued !== undefined ? { reportedQueued: patch.reportedQueued } : {}),
          ...(patch.reportedCapacity !== undefined ? { reportedCapacity: patch.reportedCapacity } : {}),
        },
      });
      return mapAgent(row);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async insertNonce(nonce: NonceRecord): Promise<"ok" | "replay"> {
    try {
      await this.prisma.agentNonce.create({ data: nonce });
      return "ok";
    } catch (error) {
      if (isUnique(error)) {
        return "replay";
      }
      throw error;
    }
  }

  async purgeNonces(now: Date): Promise<number> {
    const result = await this.prisma.agentNonce.deleteMany({ where: { expiresAt: { lt: now } } });
    return result.count;
  }

  async insertMachine(machine: MachineRecord): Promise<void> {
    await this.prisma.machine.create({ data: machineData(machine) });
  }

  async updateMachine(id: string, patch: MachineUpdate): Promise<MachineRecord | null> {
    try {
      const row = await this.prisma.machine.update({
        where: { id },
        data: {
          ...(patch.hostname !== undefined ? { hostname: patch.hostname } : {}),
          ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.metricsSource !== undefined ? { metricsSource: patch.metricsSource } : {}),
          ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
          ...(patch.lastSeenAt !== undefined ? { lastSeenAt: patch.lastSeenAt } : {}),
          ...(patch.lastStateChangeAt !== undefined ? { lastStateChangeAt: patch.lastStateChangeAt } : {}),
          ...(patch.hiddenAt !== undefined ? { hiddenAt: patch.hiddenAt } : {}),
          ...(patch.details !== undefined ? { details: jsonOrNull(patch.details) } : {}),
        },
      });
      return mapMachine(row);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async findMachine(id: string): Promise<MachineRecord | null> {
    const row = await this.prisma.machine.findUnique({ where: { id } });
    return row ? mapMachine(row) : null;
  }

  async findMachineByAgent(agentId: string): Promise<MachineRecord | null> {
    const row = await this.prisma.machine.findFirst({ where: { agentId } });
    return row ? mapMachine(row) : null;
  }

  async listMachines(query: MachineListQuery): Promise<Page<MachineRecord>> {
    const where: Prisma.MachineWhereInput = {
      ...(query.includeHidden ? {} : { hiddenAt: null }),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    if (query.clusterId) {
      const [links, nodes] = await Promise.all([
        this.prisma.machineProxmoxLink.findMany({ where: { clusterId: query.clusterId }, select: { machineId: true } }),
        this.prisma.proxmoxNode.findMany({ where: { clusterId: query.clusterId }, select: { machineId: true } }),
      ]);
      const ids = [...new Set([...links.map((link) => link.machineId), ...nodes.map((node) => node.machineId)])];
      if (ids.length === 0) {
        return { items: [], total: 0 };
      }
      where.id = { in: ids };
    }
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.machine.count({ where }),
      this.prisma.machine.findMany({
        where,
        orderBy: { hostname: "asc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return { items: rows.map(mapMachine), total };
  }

  async listAllMachines(): Promise<MachineRecord[]> {
    const rows = await this.prisma.machine.findMany();
    return rows.map(mapMachine);
  }

  async upsertCluster(cluster: ClusterRecord): Promise<ClusterRecord> {
    const row = await this.prisma.cluster.upsert({
      where: { slug: cluster.slug },
      create: cluster,
      update: { name: cluster.name },
    });
    return row;
  }

  async findCluster(idOrSlug: string): Promise<ClusterRecord | null> {
    const row = await this.prisma.cluster.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });
    return row;
  }

  async listClusters(): Promise<ClusterRecord[]> {
    return this.prisma.cluster.findMany({ orderBy: { slug: "asc" } });
  }

  async upsertNode(node: ProxmoxNodeRecord): Promise<ProxmoxNodeRecord> {
    return this.prisma.proxmoxNode.upsert({
      where: { clusterId_name: { clusterId: node.clusterId, name: node.name } },
      create: node,
      update: { machineId: node.machineId, agentId: node.agentId, version: node.version },
    });
  }

  async listNodes(): Promise<ProxmoxNodeRecord[]> {
    return this.prisma.proxmoxNode.findMany({ orderBy: { name: "asc" } });
  }

  async findNode(id: string): Promise<ProxmoxNodeRecord | null> {
    return this.prisma.proxmoxNode.findUnique({ where: { id } });
  }

  async findNodeByMachine(machineId: string): Promise<ProxmoxNodeRecord | null> {
    return this.prisma.proxmoxNode.findUnique({ where: { machineId } });
  }

  async findNodeByName(clusterId: string, name: string): Promise<ProxmoxNodeRecord | null> {
    return this.prisma.proxmoxNode.findUnique({ where: { clusterId_name: { clusterId, name } } });
  }

  async upsertLink(link: LinkRecord): Promise<LinkRecord> {
    const existing = await this.prisma.machineProxmoxLink.findUnique({
      where: { clusterId_vmid: { clusterId: link.clusterId, vmid: link.vmid } },
    });
    if (existing) {
      return this.prisma.machineProxmoxLink.update({
        where: { machineId: existing.machineId },
        data: { currentNodeId: link.currentNodeId, guestType: link.guestType },
      });
    }
    return this.prisma.machineProxmoxLink.create({ data: link });
  }

  async deleteLink(machineId: string): Promise<void> {
    await this.prisma.machineProxmoxLink.deleteMany({ where: { machineId } });
  }

  async listLinks(): Promise<LinkRecord[]> {
    return this.prisma.machineProxmoxLink.findMany();
  }

  async findLinkByMachine(machineId: string): Promise<LinkRecord | null> {
    return this.prisma.machineProxmoxLink.findUnique({ where: { machineId } });
  }

  async findLinkByGuest(clusterId: string, vmid: number): Promise<LinkRecord | null> {
    return this.prisma.machineProxmoxLink.findUnique({ where: { clusterId_vmid: { clusterId, vmid } } });
  }

  async insertMetric(metric: MetricRecord): Promise<void> {
    await this.prisma.metric.create({
      data: {
        id: metric.id,
        machineId: metric.machineId,
        timestamp: metric.timestamp,
        cpuUsage: metric.cpuUsage,
        memoryUsed: BigInt(metric.memoryUsed),
        memoryTotal: BigInt(metric.memoryTotal),
        diskUsed: toBig(metric.diskUsed),
        diskTotal: toBig(metric.diskTotal),
        networkRx: toBig(metric.networkRx),
        networkTx: toBig(metric.networkTx),
        uptime: toBig(metric.uptime),
      },
    });
  }

  async listMetrics(machineId: string, query: PageQuery): Promise<Page<MetricRecord>> {
    const where = { machineId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.metric.count({ where }),
      this.prisma.metric.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return { items: rows.map(mapMetric), total };
  }

  async latestMetric(machineId: string): Promise<MetricRecord | null> {
    const row = await this.prisma.metric.findFirst({ where: { machineId }, orderBy: { timestamp: "desc" } });
    return row ? mapMetric(row) : null;
  }

  async purgeMetricsBefore(before: Date): Promise<number> {
    const result = await this.prisma.metric.deleteMany({ where: { timestamp: { lt: before } } });
    return result.count;
  }

  async insertSnapshot(snapshot: NewSnapshot): Promise<UpdateSnapshotRecord> {
    const row = await this.prisma.updateSnapshot.create({
      data: {
        id: snapshot.id,
        machineId: snapshot.machineId,
        jobId: snapshot.jobId,
        createdAt: snapshot.createdAt,
        availableCount: snapshot.availableCount,
        securityCount: snapshot.securityCount,
        requiresReboot: snapshot.requiresReboot,
        requiresConfirmation: snapshot.requiresConfirmation,
        packages: {
          create: snapshot.packages.map((pkg) => ({
            name: pkg.name,
            currentVersion: pkg.currentVersion,
            newVersion: pkg.newVersion,
            architecture: pkg.architecture,
            changeType: pkg.changeType,
            security: pkg.security,
          })),
        },
      },
      include: { packages: true },
    });
    return mapSnapshot(row);
  }

  async listSnapshots(machineId: string, query: PageQuery): Promise<Page<UpdateSnapshotRecord>> {
    const where = { machineId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.updateSnapshot.count({ where }),
      this.prisma.updateSnapshot.findMany({
        where,
        include: { packages: true },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return { items: rows.map(mapSnapshot), total };
  }

  async latestUpdateCounts(machineIds: string[]): Promise<UpdateCount[]> {
    if (machineIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.$queryRaw<Array<{
      machineId: string;
      availableCount: number | bigint;
      securityCount: number | bigint | null;
      requiresReboot: boolean | number;
    }>>(Prisma.sql`
      SELECT s.machineId AS machineId, s.availableCount AS availableCount, s.securityCount AS securityCount, s.requiresReboot AS requiresReboot
      FROM UpdateSnapshot s
      INNER JOIN (
        SELECT machineId, MAX(createdAt) AS createdAt
        FROM UpdateSnapshot
        WHERE machineId IN (${Prisma.join(machineIds)})
        GROUP BY machineId
      ) latest ON latest.machineId = s.machineId AND latest.createdAt = s.createdAt
    `);
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      if (seen.has(row.machineId)) {
        return [];
      }
      seen.add(row.machineId);
      return [{
        machineId: row.machineId,
        availableCount: Number(row.availableCount),
        securityCount: row.securityCount === null ? null : Number(row.securityCount),
        requiresReboot: Boolean(row.requiresReboot),
      }];
    });
  }

  async latestPackageHits(): Promise<PackageHit[]> {
    const rows = await this.prisma.$queryRaw<Array<{
      machineId: string;
      name: string;
      currentVersion: string | null;
      newVersion: string | null;
      changeType: string;
      security: boolean | number;
    }>>(Prisma.sql`
      SELECT s.machineId AS machineId, p.name AS name, p.currentVersion AS currentVersion, p.newVersion AS newVersion, p.changeType AS changeType, p.security AS security
      FROM UpdatePackage p
      INNER JOIN UpdateSnapshot s ON s.id = p.snapshotId
      INNER JOIN (
        SELECT machineId, MAX(createdAt) AS createdAt
        FROM UpdateSnapshot
        GROUP BY machineId
      ) latest ON latest.machineId = s.machineId AND latest.createdAt = s.createdAt
    `);
    return rows.map((row) => ({
      machineId: row.machineId,
      name: row.name,
      currentVersion: row.currentVersion,
      newVersion: row.newVersion,
      changeType: row.changeType,
      security: Boolean(row.security),
    }));
  }

  async latestInstalledResults(): Promise<InstalledResult[]> {
    const rows = await this.prisma.$queryRaw<Array<{ machineId: string; result: unknown }>>(Prisma.sql`
      SELECT j.machineId AS machineId, j.result AS result
      FROM Job j
      INNER JOIN (
        SELECT machineId, MAX(finishedAt) AS finishedAt
        FROM Job
        WHERE action = 'apt.packages' AND status = 'SUCCESS' AND machineId IS NOT NULL AND finishedAt IS NOT NULL
        GROUP BY machineId
      ) latest ON latest.machineId = j.machineId AND latest.finishedAt = j.finishedAt
      WHERE j.action = 'apt.packages' AND j.status = 'SUCCESS'
    `);
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      if (seen.has(row.machineId)) {
        return [];
      }
      seen.add(row.machineId);
      const result = typeof row.result === "string" ? parseJson(row.result) : row.result;
      return [{ machineId: row.machineId, result }];
    });
  }

  async latestSurveyResults(): Promise<InstalledResult[]> {
    return this.latestActionResults("runtime.survey");
  }

  private async latestActionResults(action: string): Promise<InstalledResult[]> {
    const rows = await this.prisma.$queryRaw<Array<{ machineId: string; result: unknown }>>(Prisma.sql`
      SELECT j.machineId AS machineId, j.result AS result
      FROM Job j
      INNER JOIN (
        SELECT machineId, MAX(finishedAt) AS finishedAt
        FROM Job
        WHERE action = ${action} AND status = 'SUCCESS' AND machineId IS NOT NULL AND finishedAt IS NOT NULL
        GROUP BY machineId
      ) latest ON latest.machineId = j.machineId AND latest.finishedAt = j.finishedAt
      WHERE j.action = ${action} AND j.status = 'SUCCESS'
    `);
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      if (seen.has(row.machineId)) {
        return [];
      }
      seen.add(row.machineId);
      const result = typeof row.result === "string" ? parseJson(row.result) : row.result;
      return [{ machineId: row.machineId, result }];
    });
  }

  async insertJob(job: JobRecord): Promise<void> {
    await this.prisma.job.create({ data: jobWrite(job) });
  }

  async findJob(id: string): Promise<JobRecord | null> {
    const row = await this.prisma.job.findUnique({ where: { id } });
    return row ? mapJob(row) : null;
  }

  async listJobs(query: JobListQuery): Promise<Page<JobRecord>> {
    const where: Prisma.JobWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.machineId ? { machineId: query.machineId } : {}),
      ...(query.parentId ? { parentId: query.parentId } : query.rootsOnly ? { parentId: null } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.job.count({ where }),
      this.prisma.job.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return { items: rows.map(mapJob), total };
  }

  async listJobsByStatuses(statuses: JobRecord["status"][]): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { status: { in: statuses } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapJob);
  }

  async listChildren(parentId: string): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({ where: { parentId }, orderBy: { createdAt: "asc" } });
    return rows.map(mapJob);
  }

  async compareAndSetJob(id: string, expected: JobRecord["status"], patch: JobUpdate): Promise<JobRecord | null> {
    const result = await this.prisma.job.updateMany({
      where: { id, status: expected },
      data: jobPatch(patch),
    });
    if (result.count !== 1) {
      return null;
    }
    const row = await this.prisma.job.findUnique({ where: { id } });
    return row ? mapJob(row) : null;
  }

  async appendLogs(jobId: string, entries: Array<Omit<JobLogRecord, "id" | "sequence">>): Promise<JobLogRecord[]> {
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.jobLog.aggregate({ where: { jobId }, _max: { sequence: true } });
      let sequence = last._max.sequence ?? 0;
      const stored: JobLogRecord[] = [];
      for (const entry of entries) {
        sequence += 1;
        const row = await tx.jobLog.create({
          data: {
            jobId,
            sequence,
            timestamp: entry.timestamp,
            stream: entry.stream,
            data: entry.data,
          },
        });
        stored.push(row);
      }
      return stored;
    });
  }

  async listLogs(jobId: string, query: PageQuery): Promise<Page<JobLogRecord>> {
    const where = { jobId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.jobLog.count({ where }),
      this.prisma.jobLog.findMany({
        where,
        orderBy: { sequence: "asc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return { items: rows, total };
  }

  async upsertAlert(alert: AlertRecord): Promise<AlertRecord> {
    return this.prisma.alert.upsert({
      where: { dedupeKey: alert.dedupeKey },
      create: alert,
      update: {
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        machineId: alert.machineId,
        agentId: alert.agentId,
        clusterId: alert.clusterId,
        resolvedAt: null,
      },
    });
  }

  async resolveAlert(dedupeKey: string, now: Date): Promise<void> {
    await this.prisma.alert.updateMany({
      where: { dedupeKey, resolvedAt: null },
      data: { resolvedAt: now },
    });
  }

  async listAlerts(query: PageQuery & { openOnly: boolean }): Promise<Page<AlertRecord>> {
    const where = query.openOnly ? { resolvedAt: null } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.alert.count({ where }),
      this.prisma.alert.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return { items: rows, total };
  }

  async findAlertByDedupe(dedupeKey: string): Promise<AlertRecord | null> {
    return this.prisma.alert.findUnique({ where: { dedupeKey } });
  }
}

function mapAgent(row: {
  id: string;
  name: string;
  type: keyof typeof agentTypeFromDb;
  version: string;
  presence: AgentRecord["presence"];
  lastSeenAt: Date | null;
  registeredAt: Date;
  maxConcurrency: number;
  capabilities: Prisma.JsonValue;
  reportedRunning: number;
  reportedQueued: number;
  reportedCapacity: number;
  createdAt: Date;
  updatedAt: Date;
}): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    type: agentTypeFromDb[row.type],
    version: row.version,
    presence: row.presence,
    lastSeenAt: row.lastSeenAt,
    registeredAt: row.registeredAt,
    maxConcurrency: row.maxConcurrency,
    capabilities: stringArray(row.capabilities),
    reportedRunning: row.reportedRunning,
    reportedQueued: row.reportedQueued,
    reportedCapacity: row.reportedCapacity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMachine(row: {
  id: string;
  hostname: string;
  displayName: string;
  type: MachineRecord["type"];
  status: MachineRecord["status"];
  metricsSource: MachineRecord["metricsSource"];
  agentId: string | null;
  lastSeenAt: Date | null;
  lastStateChangeAt: Date;
  hiddenAt: Date | null;
  details: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}): MachineRecord {
  return {
    id: row.id,
    hostname: row.hostname,
    displayName: row.displayName,
    type: row.type,
    status: row.status,
    metricsSource: row.metricsSource,
    agentId: row.agentId,
    lastSeenAt: row.lastSeenAt,
    lastStateChangeAt: row.lastStateChangeAt,
    hiddenAt: row.hiddenAt,
    details: readDetails(row.details),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMetric(row: {
  id: string;
  machineId: string;
  timestamp: Date;
  cpuUsage: number;
  memoryUsed: bigint;
  memoryTotal: bigint;
  diskUsed: bigint | null;
  diskTotal: bigint | null;
  networkRx: bigint | null;
  networkTx: bigint | null;
  uptime: bigint | null;
}): MetricRecord {
  return {
    id: row.id,
    machineId: row.machineId,
    timestamp: row.timestamp,
    cpuUsage: row.cpuUsage,
    memoryUsed: Number(row.memoryUsed),
    memoryTotal: Number(row.memoryTotal),
    diskUsed: fromBig(row.diskUsed),
    diskTotal: fromBig(row.diskTotal),
    networkRx: fromBig(row.networkRx),
    networkTx: fromBig(row.networkTx),
    uptime: fromBig(row.uptime),
  };
}

function mapJob(row: {
  id: string;
  parentId: string | null;
  action: string;
  category: JobRecord["category"];
  executionKind: JobRecord["executionKind"];
  agentId: string | null;
  machineId: string | null;
  targetType: string;
  targetData: Prisma.JsonValue;
  status: JobRecord["status"];
  requestedBy: string | null;
  createdAt: Date;
  assignedAt: Date | null;
  dispatchedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  acknowledgedAt: Date | null;
  resolvedExecutable: string | null;
  resolvedArguments: Prisma.JsonValue | null;
  result: Prisma.JsonValue | null;
  exitCode: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}): JobRecord {
  return {
    id: row.id,
    parentId: row.parentId,
    action: row.action,
    category: row.category,
    executionKind: row.executionKind,
    agentId: row.agentId,
    machineId: row.machineId,
    targetType: row.targetType,
    targetData: row.targetData,
    status: row.status,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
    assignedAt: row.assignedAt,
    dispatchedAt: row.dispatchedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    acknowledgedAt: row.acknowledgedAt,
    resolvedExecutable: row.resolvedExecutable,
    resolvedArguments: readArgs(row.resolvedArguments),
    result: row.result,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

function mapSnapshot(row: {
  id: string;
  machineId: string;
  jobId: string | null;
  createdAt: Date;
  availableCount: number;
  securityCount: number | null;
  requiresReboot: boolean;
  requiresConfirmation: boolean;
  packages: Array<{
    id: string;
    name: string;
    currentVersion: string | null;
    newVersion: string | null;
    architecture: string | null;
    changeType: string;
    security: boolean;
  }>;
}): UpdateSnapshotRecord {
  return {
    id: row.id,
    machineId: row.machineId,
    jobId: row.jobId,
    createdAt: row.createdAt,
    availableCount: row.availableCount,
    securityCount: row.securityCount,
    requiresReboot: row.requiresReboot,
    requiresConfirmation: row.requiresConfirmation,
    packages: row.packages.map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      currentVersion: pkg.currentVersion,
      newVersion: pkg.newVersion,
      architecture: pkg.architecture,
      changeType: pkg.changeType,
      security: pkg.security,
    })),
  };
}

function machineData(machine: MachineRecord): Prisma.MachineCreateInput {
  return {
    id: machine.id,
    hostname: machine.hostname,
    displayName: machine.displayName,
    type: machine.type,
    status: machine.status,
    metricsSource: machine.metricsSource,
    ...(machine.agentId ? { agent: { connect: { id: machine.agentId } } } : {}),
    lastSeenAt: machine.lastSeenAt,
    lastStateChangeAt: machine.lastStateChangeAt,
    hiddenAt: machine.hiddenAt,
    details: jsonOrNull(machine.details),
    createdAt: machine.createdAt,
    updatedAt: machine.updatedAt,
  };
}

function jobWrite(job: JobRecord): Prisma.JobCreateInput {
  return {
    id: job.id,
    ...(job.parentId ? { parent: { connect: { id: job.parentId } } } : {}),
    action: job.action,
    category: job.category,
    executionKind: job.executionKind,
    ...(job.agentId ? { agent: { connect: { id: job.agentId } } } : {}),
    ...(job.machineId ? { machine: { connect: { id: job.machineId } } } : {}),
    targetType: job.targetType,
    targetData: job.targetData as Prisma.InputJsonValue,
    status: job.status,
    requestedBy: job.requestedBy,
    createdAt: job.createdAt,
    assignedAt: job.assignedAt,
    dispatchedAt: job.dispatchedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    acknowledgedAt: job.acknowledgedAt,
    resolvedExecutable: job.resolvedExecutable,
    resolvedArguments: jsonOrNull(job.resolvedArguments),
    result: jsonOrNull(job.result),
    exitCode: job.exitCode,
    durationMs: job.durationMs,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
  };
}

function jobPatch(patch: JobUpdate): Prisma.JobUncheckedUpdateManyInput {
  const data: Prisma.JobUncheckedUpdateManyInput = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.agentId !== undefined) data.agentId = patch.agentId;
  if (patch.assignedAt !== undefined) data.assignedAt = patch.assignedAt;
  if (patch.dispatchedAt !== undefined) data.dispatchedAt = patch.dispatchedAt;
  if (patch.startedAt !== undefined) data.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) data.finishedAt = patch.finishedAt;
  if (patch.acknowledgedAt !== undefined) data.acknowledgedAt = patch.acknowledgedAt;
  if (patch.resolvedExecutable !== undefined) data.resolvedExecutable = patch.resolvedExecutable;
  if (patch.resolvedArguments !== undefined) data.resolvedArguments = jsonOrNull(patch.resolvedArguments);
  if (patch.result !== undefined) data.result = jsonOrNull(patch.result);
  if (patch.exitCode !== undefined) data.exitCode = patch.exitCode;
  if (patch.durationMs !== undefined) data.durationMs = patch.durationMs;
  if (patch.errorCode !== undefined) data.errorCode = patch.errorCode;
  if (patch.errorMessage !== undefined) data.errorMessage = patch.errorMessage;
  return data;
}

function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) {
    return Prisma.JsonNull;
  }
  return value as Prisma.InputJsonValue;
}

function stringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readArgs(value: Prisma.JsonValue | null): string[] | null {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readDetails(value: Prisma.JsonValue | null): MachineDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value;
  const read = (key: string): string | undefined => {
    const nested = record[key];
    return typeof nested === "string" ? nested : undefined;
  };
  return {
    osId: read("osId"),
    osName: read("osName"),
    osVersion: read("osVersion"),
    prettyName: read("prettyName"),
    kernel: read("kernel"),
    arch: read("arch"),
    proxmoxVersion: read("proxmoxVersion"),
    addresses: readAddresses(record.addresses),
  };
}

function readAddresses(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const addresses = value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 64);
  return addresses.length > 0 ? addresses.slice(0, 8) : undefined;
}

function toBig(value: number | null): bigint | null {
  return value === null ? null : BigInt(Math.trunc(value));
}

function fromBig(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

function isUnique(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isMissing(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}
