import { randomUUID } from "node:crypto";
import type {
  AgentRecord,
  AgentUpdate,
  AlertRecord,
  ClusterRecord,
  JobListQuery,
  JobLogRecord,
  JobRecord,
  JobUpdate,
  LinkRecord,
  MachineListQuery,
  MachineRecord,
  MachineUpdate,
  MetricRecord,
  NonceRecord,
  PageQuery,
  InstalledResult,
  PackageHit,
  ProxmoxNodeRecord,
  UpdateCount,
  UpdateSnapshotRecord,
} from "./records.js";
import type { NewAgent, NewSnapshot, Page, Store } from "./store.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function pageOf<T>(items: T[], query: PageQuery): Page<T> {
  const start = (query.page - 1) * query.limit;
  return {
    items: items.slice(start, start + query.limit).map((item) => clone(item)),
    total: items.length,
  };
}

export class MemoryStore implements Store {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly secrets = new Map<string, string>();
  private readonly nonces: NonceRecord[] = [];
  private readonly machines = new Map<string, MachineRecord>();
  private readonly clusters = new Map<string, ClusterRecord>();
  private readonly nodes = new Map<string, ProxmoxNodeRecord>();
  private readonly links = new Map<string, LinkRecord>();
  private readonly metrics: MetricRecord[] = [];
  private readonly snapshots: UpdateSnapshotRecord[] = [];
  private readonly jobs = new Map<string, JobRecord>();
  private readonly logs: JobLogRecord[] = [];
  private readonly logSequence = new Map<string, number>();
  private readonly alerts = new Map<string, AlertRecord>();

  async ping(): Promise<void> {
    return undefined;
  }

  async insertAgent(input: NewAgent): Promise<"created" | "exists"> {
    if (this.agents.has(input.agent.id)) {
      return "exists";
    }
    this.agents.set(input.agent.id, clone(input.agent));
    this.secrets.set(input.agent.id, input.secretCiphertext);
    return "created";
  }

  async rotateAgentSecret(agentId: string, secretCiphertext: string): Promise<boolean> {
    if (!this.agents.has(agentId)) {
      return false;
    }
    this.secrets.set(agentId, secretCiphertext);
    return true;
  }

  async deleteAgent(id: string): Promise<boolean> {
    if (!this.agents.delete(id)) {
      return false;
    }
    this.secrets.delete(id);
    const kept = this.nonces.filter((nonce) => nonce.agentId !== id);
    this.nonces.length = 0;
    this.nonces.push(...kept);
    for (const [machineId, machine] of this.machines) {
      if (machine.agentId === id) {
        this.machines.set(machineId, { ...machine, agentId: null });
      }
    }
    for (const [nodeId, node] of this.nodes) {
      if (node.agentId === id) {
        this.nodes.set(nodeId, { ...node, agentId: null });
      }
    }
    for (const [jobId, job] of this.jobs) {
      if (job.agentId === id) {
        this.jobs.set(jobId, { ...job, agentId: null });
      }
    }
    for (const [alertId, alert] of this.alerts) {
      if (alert.agentId === id) {
        this.alerts.set(alertId, { ...alert, agentId: null });
      }
    }
    return true;
  }

  async findAgent(id: string): Promise<AgentRecord | null> {
    const agent = this.agents.get(id);
    return agent ? clone(agent) : null;
  }

  async findAgentSecret(id: string): Promise<string | null> {
    return this.secrets.get(id) ?? null;
  }

  async listAgents(): Promise<AgentRecord[]> {
    return [...this.agents.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((agent) => clone(agent));
  }

  async updateAgent(id: string, patch: AgentUpdate): Promise<AgentRecord | null> {
    const current = this.agents.get(id);
    if (!current) {
      return null;
    }
    const next = { ...current, ...patch, updatedAt: new Date() };
    this.agents.set(id, next);
    return clone(next);
  }

  async insertNonce(nonce: NonceRecord): Promise<"ok" | "replay"> {
    if (this.nonces.some((item) => item.agentId === nonce.agentId && item.nonce === nonce.nonce)) {
      return "replay";
    }
    this.nonces.push(clone(nonce));
    return "ok";
  }

  async purgeNonces(now: Date): Promise<number> {
    const before = this.nonces.length;
    const kept = this.nonces.filter((nonce) => nonce.expiresAt.getTime() >= now.getTime());
    this.nonces.length = 0;
    this.nonces.push(...kept);
    return before - kept.length;
  }

  async insertMachine(machine: MachineRecord): Promise<void> {
    this.machines.set(machine.id, clone(machine));
  }

  async updateMachine(id: string, patch: MachineUpdate): Promise<MachineRecord | null> {
    const current = this.machines.get(id);
    if (!current) {
      return null;
    }
    const next = { ...current, ...patch, updatedAt: new Date() };
    this.machines.set(id, next);
    return clone(next);
  }

  async findMachine(id: string): Promise<MachineRecord | null> {
    const machine = this.machines.get(id);
    return machine ? clone(machine) : null;
  }

  async findMachineByAgent(agentId: string): Promise<MachineRecord | null> {
    const machine = [...this.machines.values()].find((item) => item.agentId === agentId);
    return machine ? clone(machine) : null;
  }

  async listMachines(query: MachineListQuery): Promise<Page<MachineRecord>> {
    const clusterMachineIds = query.clusterId
      ? new Set(
          [...this.links.values()]
            .filter((link) => link.clusterId === query.clusterId)
            .map((link) => link.machineId)
            .concat(
              [...this.nodes.values()]
                .filter((node) => node.clusterId === query.clusterId)
                .map((node) => node.machineId),
            ),
        )
      : null;
    const items = [...this.machines.values()]
      .filter((machine) => (query.includeHidden ? true : machine.hiddenAt === null))
      .filter((machine) => (query.type ? machine.type === query.type : true))
      .filter((machine) => (query.status ? machine.status === query.status : true))
      .filter((machine) => (clusterMachineIds ? clusterMachineIds.has(machine.id) : true))
      .sort((left, right) => left.hostname.localeCompare(right.hostname));
    return pageOf(items, query);
  }

  async listAllMachines(): Promise<MachineRecord[]> {
    return [...this.machines.values()].map((machine) => clone(machine));
  }

  async upsertCluster(cluster: ClusterRecord): Promise<ClusterRecord> {
    const existing = [...this.clusters.values()].find((item) => item.slug === cluster.slug);
    if (existing) {
      const next = { ...existing, name: cluster.name, updatedAt: new Date() };
      this.clusters.set(existing.id, next);
      return clone(next);
    }
    this.clusters.set(cluster.id, clone(cluster));
    return clone(cluster);
  }

  async findCluster(idOrSlug: string): Promise<ClusterRecord | null> {
    const byId = this.clusters.get(idOrSlug);
    if (byId) {
      return clone(byId);
    }
    const bySlug = [...this.clusters.values()].find((item) => item.slug === idOrSlug);
    return bySlug ? clone(bySlug) : null;
  }

  async listClusters(): Promise<ClusterRecord[]> {
    return [...this.clusters.values()]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((cluster) => clone(cluster));
  }

  async upsertNode(node: ProxmoxNodeRecord): Promise<ProxmoxNodeRecord> {
    const existing = [...this.nodes.values()].find(
      (item) => item.clusterId === node.clusterId && item.name === node.name,
    );
    if (existing) {
      const next = {
        ...existing,
        machineId: node.machineId,
        agentId: node.agentId,
        version: node.version,
        updatedAt: new Date(),
      };
      this.nodes.set(existing.id, next);
      return clone(next);
    }
    this.nodes.set(node.id, clone(node));
    return clone(node);
  }

  async listNodes(): Promise<ProxmoxNodeRecord[]> {
    return [...this.nodes.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((node) => clone(node));
  }

  async findNode(id: string): Promise<ProxmoxNodeRecord | null> {
    const node = this.nodes.get(id);
    return node ? clone(node) : null;
  }

  async findNodeByMachine(machineId: string): Promise<ProxmoxNodeRecord | null> {
    const node = [...this.nodes.values()].find((item) => item.machineId === machineId);
    return node ? clone(node) : null;
  }

  async findNodeByName(clusterId: string, name: string): Promise<ProxmoxNodeRecord | null> {
    const node = [...this.nodes.values()].find((item) => item.clusterId === clusterId && item.name === name);
    return node ? clone(node) : null;
  }

  async upsertLink(link: LinkRecord): Promise<LinkRecord> {
    const occupant = [...this.links.values()].find(
      (item) =>
        item.machineId !== link.machineId &&
        item.currentNodeId !== null &&
        item.currentNodeId === link.currentNodeId &&
        item.vmid === link.vmid,
    );
    if (occupant) {
      throw new Error("ce VMID est déjà inventorié sur ce nœud");
    }
    this.links.set(link.machineId, clone(link));
    return clone(link);
  }

  async deleteLink(machineId: string): Promise<void> {
    this.links.delete(machineId);
  }

  async listLinks(): Promise<LinkRecord[]> {
    return [...this.links.values()].map((link) => clone(link));
  }

  async findLinkByMachine(machineId: string): Promise<LinkRecord | null> {
    const link = this.links.get(machineId);
    return link ? clone(link) : null;
  }

  async findLinkByGuest(clusterId: string, vmid: number): Promise<LinkRecord | null> {
    const links = await this.findLinksByGuest(clusterId, vmid);
    return links[0] ?? null;
  }

  async findLinksByGuest(clusterId: string, vmid: number): Promise<LinkRecord[]> {
    return [...this.links.values()]
      .filter((item) => item.clusterId === clusterId && item.vmid === vmid)
      .map((item) => clone(item));
  }

  async findLinkByNodeGuest(nodeId: string, vmid: number): Promise<LinkRecord | null> {
    const link = [...this.links.values()].find((item) => item.currentNodeId === nodeId && item.vmid === vmid);
    return link ? clone(link) : null;
  }

  async insertMetric(metric: MetricRecord): Promise<void> {
    this.metrics.push(clone(metric));
  }

  async listMetrics(machineId: string, query: PageQuery): Promise<Page<MetricRecord>> {
    const items = this.metrics
      .filter((metric) => metric.machineId === machineId)
      .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime());
    return pageOf(items, query);
  }

  async latestMetric(machineId: string): Promise<MetricRecord | null> {
    const items = this.metrics
      .filter((metric) => metric.machineId === machineId)
      .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime());
    return items[0] ? clone(items[0]) : null;
  }

  async purgeMetricsBefore(before: Date): Promise<number> {
    const beforeCount = this.metrics.length;
    const kept = this.metrics.filter((metric) => metric.timestamp.getTime() >= before.getTime());
    this.metrics.length = 0;
    this.metrics.push(...kept);
    return beforeCount - kept.length;
  }

  async insertSnapshot(snapshot: NewSnapshot): Promise<UpdateSnapshotRecord> {
    const stored: UpdateSnapshotRecord = {
      ...snapshot,
      packages: snapshot.packages.map((pkg) => ({
        id: pkg.id ?? randomUUID(),
        name: pkg.name,
        currentVersion: pkg.currentVersion,
        newVersion: pkg.newVersion,
        architecture: pkg.architecture,
        changeType: pkg.changeType,
        security: pkg.security,
      })),
    };
    this.snapshots.push(clone(stored));
    return clone(stored);
  }

  async listSnapshots(machineId: string, query: PageQuery): Promise<Page<UpdateSnapshotRecord>> {
    const items = this.snapshots
      .filter((snapshot) => snapshot.machineId === machineId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return pageOf(items, query);
  }

  async latestUpdateCounts(machineIds: string[]): Promise<UpdateCount[]> {
    const wanted = new Set(machineIds);
    const latest = new Map<string, UpdateSnapshotRecord>();
    for (const snapshot of this.snapshots) {
      if (!wanted.has(snapshot.machineId)) continue;
      const current = latest.get(snapshot.machineId);
      if (!current || snapshot.createdAt.getTime() > current.createdAt.getTime()) {
        latest.set(snapshot.machineId, snapshot);
      }
    }
    return [...latest.values()].map((snapshot) => ({
      machineId: snapshot.machineId,
      availableCount: snapshot.availableCount,
      securityCount: snapshot.securityCount,
      requiresReboot: snapshot.requiresReboot,
    }));
  }

  async latestPackageHits(): Promise<PackageHit[]> {
    const latest = new Map<string, UpdateSnapshotRecord>();
    for (const snapshot of this.snapshots) {
      const current = latest.get(snapshot.machineId);
      if (!current || snapshot.createdAt.getTime() > current.createdAt.getTime()) {
        latest.set(snapshot.machineId, snapshot);
      }
    }
    const hits: PackageHit[] = [];
    for (const snapshot of latest.values()) {
      for (const pkg of snapshot.packages) {
        hits.push({
          machineId: snapshot.machineId,
          name: pkg.name,
          currentVersion: pkg.currentVersion,
          newVersion: pkg.newVersion,
          changeType: pkg.changeType,
          security: pkg.security,
        });
      }
    }
    return hits;
  }

  async latestInstalledResults(): Promise<InstalledResult[]> {
    const latest = new Map<string, JobRecord>();
    for (const job of this.jobs.values()) {
      if (job.action !== "apt.packages" || job.status !== "SUCCESS" || !job.machineId || !job.finishedAt) {
        continue;
      }
      const current = latest.get(job.machineId);
      if (!current?.finishedAt || job.finishedAt.getTime() > current.finishedAt.getTime()) {
        latest.set(job.machineId, job);
      }
    }
    return [...latest.values()].flatMap((job) => (job.machineId ? [{ machineId: job.machineId, result: job.result }] : []));
  }

  async latestSurveyResults(): Promise<InstalledResult[]> {
    return this.latestActionResults("runtime.survey");
  }

  private latestActionResults(action: JobRecord["action"]): InstalledResult[] {
    const latest = new Map<string, JobRecord>();
    for (const job of this.jobs.values()) {
      if (job.action !== action || job.status !== "SUCCESS" || !job.machineId || !job.finishedAt) {
        continue;
      }
      const current = latest.get(job.machineId);
      if (!current?.finishedAt || job.finishedAt.getTime() > current.finishedAt.getTime()) {
        latest.set(job.machineId, job);
      }
    }
    return [...latest.values()].flatMap((job) => (job.machineId ? [{ machineId: job.machineId, result: job.result }] : []));
  }

  async insertJob(job: JobRecord): Promise<void> {
    this.jobs.set(job.id, clone(job));
  }

  async findJob(id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    return job ? clone(job) : null;
  }

  async listJobs(query: JobListQuery): Promise<Page<JobRecord>> {
    const items = [...this.jobs.values()]
      .filter((job) => (query.status ? job.status === query.status : true))
      .filter((job) => (query.machineId ? job.machineId === query.machineId : true))
      .filter((job) => (query.parentId ? job.parentId === query.parentId : true))
      .filter((job) => (query.rootsOnly && !query.parentId ? job.parentId === null : true))
      .filter((job) => (query.agentId ? job.agentId === query.agentId : true))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return pageOf(items, query);
  }

  async listJobsByStatuses(statuses: JobRecord["status"][]): Promise<JobRecord[]> {
    const allowed = new Set(statuses);
    return [...this.jobs.values()]
      .filter((job) => allowed.has(job.status))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((job) => clone(job));
  }

  async listChildren(parentId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.parentId === parentId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((job) => clone(job));
  }

  async compareAndSetJob(id: string, expected: JobRecord["status"], patch: JobUpdate): Promise<JobRecord | null> {
    const current = this.jobs.get(id);
    if (!current || current.status !== expected) {
      return null;
    }
    const next = { ...current, ...patch };
    this.jobs.set(id, next);
    return clone(next);
  }

  async appendLogs(
    jobId: string,
    entries: Array<Omit<JobLogRecord, "id" | "sequence">>,
  ): Promise<JobLogRecord[]> {
    let sequence = this.logSequence.get(jobId) ?? 0;
    const stored: JobLogRecord[] = [];
    for (const entry of entries) {
      sequence += 1;
      const row: JobLogRecord = { ...entry, id: randomUUID(), jobId, sequence };
      this.logs.push(row);
      stored.push(clone(row));
    }
    this.logSequence.set(jobId, sequence);
    return stored;
  }

  async listLogs(jobId: string, query: PageQuery): Promise<Page<JobLogRecord>> {
    const items = this.logs
      .filter((log) => log.jobId === jobId)
      .sort((left, right) => left.sequence - right.sequence);
    return pageOf(items, query);
  }

  async upsertAlert(alert: AlertRecord): Promise<AlertRecord> {
    const existing = [...this.alerts.values()].find((item) => item.dedupeKey === alert.dedupeKey);
    if (!existing) {
      this.alerts.set(alert.id, clone(alert));
      return clone(alert);
    }
    const next: AlertRecord = {
      ...existing,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      machineId: alert.machineId,
      agentId: alert.agentId,
      clusterId: alert.clusterId,
      resolvedAt: null,
      updatedAt: new Date(),
    };
    this.alerts.set(existing.id, next);
    return clone(next);
  }

  async resolveAlert(dedupeKey: string, now: Date): Promise<void> {
    const existing = [...this.alerts.values()].find((item) => item.dedupeKey === dedupeKey);
    if (!existing || existing.resolvedAt) {
      return;
    }
    this.alerts.set(existing.id, { ...existing, resolvedAt: now, updatedAt: now });
  }

  async listAlerts(query: PageQuery & { openOnly: boolean }): Promise<Page<AlertRecord>> {
    const items = [...this.alerts.values()]
      .filter((alert) => (query.openOnly ? alert.resolvedAt === null : true))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return pageOf(items, query);
  }

  async findAlertByDedupe(dedupeKey: string): Promise<AlertRecord | null> {
    const alert = [...this.alerts.values()].find((item) => item.dedupeKey === dedupeKey);
    return alert ? clone(alert) : null;
  }
}
