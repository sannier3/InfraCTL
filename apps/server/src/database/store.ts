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
  ProxmoxNodeRecord,
  UpdatePackageRecord,
  UpdateSnapshotRecord,
} from "./records.js";

export type Page<T> = {
  items: T[];
  total: number;
};

export type NewAgent = {
  agent: AgentRecord;
  secretCiphertext: string;
};

export type NewSnapshot = Omit<UpdateSnapshotRecord, "packages"> & {
  packages: Array<Omit<UpdatePackageRecord, "id"> & { id?: string }>;
};

export interface Store {
  ping(): Promise<void>;
  insertAgent(input: NewAgent): Promise<"created" | "exists">;
  rotateAgentSecret(agentId: string, secretCiphertext: string): Promise<boolean>;
  findAgent(id: string): Promise<AgentRecord | null>;
  findAgentSecret(id: string): Promise<string | null>;
  listAgents(): Promise<AgentRecord[]>;
  updateAgent(id: string, patch: AgentUpdate): Promise<AgentRecord | null>;
  insertNonce(nonce: NonceRecord): Promise<"ok" | "replay">;
  purgeNonces(now: Date): Promise<number>;
  insertMachine(machine: MachineRecord): Promise<void>;
  updateMachine(id: string, patch: MachineUpdate): Promise<MachineRecord | null>;
  findMachine(id: string): Promise<MachineRecord | null>;
  findMachineByAgent(agentId: string): Promise<MachineRecord | null>;
  listMachines(query: MachineListQuery): Promise<Page<MachineRecord>>;
  listAllMachines(): Promise<MachineRecord[]>;
  upsertCluster(cluster: ClusterRecord): Promise<ClusterRecord>;
  findCluster(idOrSlug: string): Promise<ClusterRecord | null>;
  listClusters(): Promise<ClusterRecord[]>;
  upsertNode(node: ProxmoxNodeRecord): Promise<ProxmoxNodeRecord>;
  listNodes(): Promise<ProxmoxNodeRecord[]>;
  findNode(id: string): Promise<ProxmoxNodeRecord | null>;
  findNodeByMachine(machineId: string): Promise<ProxmoxNodeRecord | null>;
  findNodeByName(clusterId: string, name: string): Promise<ProxmoxNodeRecord | null>;
  upsertLink(link: LinkRecord): Promise<LinkRecord>;
  listLinks(): Promise<LinkRecord[]>;
  findLinkByMachine(machineId: string): Promise<LinkRecord | null>;
  findLinkByGuest(clusterId: string, vmid: number): Promise<LinkRecord | null>;
  insertMetric(metric: MetricRecord): Promise<void>;
  listMetrics(machineId: string, query: PageQuery): Promise<Page<MetricRecord>>;
  latestMetric(machineId: string): Promise<MetricRecord | null>;
  purgeMetricsBefore(before: Date): Promise<number>;
  insertSnapshot(snapshot: NewSnapshot): Promise<UpdateSnapshotRecord>;
  listSnapshots(machineId: string, query: PageQuery): Promise<Page<UpdateSnapshotRecord>>;
  insertJob(job: JobRecord): Promise<void>;
  findJob(id: string): Promise<JobRecord | null>;
  listJobs(query: JobListQuery): Promise<Page<JobRecord>>;
  listJobsByStatuses(statuses: JobRecord["status"][]): Promise<JobRecord[]>;
  listChildren(parentId: string): Promise<JobRecord[]>;
  compareAndSetJob(id: string, expected: JobRecord["status"], patch: JobUpdate): Promise<JobRecord | null>;
  appendLogs(jobId: string, entries: Array<Omit<JobLogRecord, "id" | "sequence">>): Promise<JobLogRecord[]>;
  listLogs(jobId: string, query: PageQuery): Promise<Page<JobLogRecord>>;
  upsertAlert(alert: AlertRecord): Promise<AlertRecord>;
  resolveAlert(dedupeKey: string, now: Date): Promise<void>;
  listAlerts(query: PageQuery & { openOnly: boolean }): Promise<Page<AlertRecord>>;
  findAlertByDedupe(dedupeKey: string): Promise<AlertRecord | null>;
}
