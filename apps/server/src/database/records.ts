import type {
  ActionCategory,
  AgentPresence,
  AgentType,
  AlertSeverity,
  GuestType,
  JobStatus,
  LogStream,
  MachineStatus,
  MachineType,
  MetricsSource,
} from "@infra/types";

export type JobExecutionKind = "PARENT" | "LEAF";

export type AgentRecord = {
  id: string;
  name: string;
  type: AgentType;
  version: string;
  presence: AgentPresence;
  lastSeenAt: Date | null;
  registeredAt: Date;
  maxConcurrency: number;
  capabilities: string[];
  reportedRunning: number;
  reportedQueued: number;
  reportedCapacity: number;
  createdAt: Date;
  updatedAt: Date;
};

export type MachineDetails = {
  osId?: string;
  osName?: string;
  osVersion?: string;
  prettyName?: string;
  kernel?: string;
  arch?: string;
  proxmoxVersion?: string;
};

export type MachineRecord = {
  id: string;
  hostname: string;
  displayName: string;
  type: MachineType;
  status: MachineStatus;
  metricsSource: MetricsSource;
  agentId: string | null;
  lastSeenAt: Date | null;
  lastStateChangeAt: Date;
  hiddenAt: Date | null;
  details: MachineDetails | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ClusterRecord = {
  id: string;
  name: string;
  slug: string;
  type: "PROXMOX";
  createdAt: Date;
  updatedAt: Date;
};

export type ProxmoxNodeRecord = {
  id: string;
  clusterId: string;
  name: string;
  machineId: string;
  agentId: string | null;
  version: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LinkRecord = {
  machineId: string;
  clusterId: string;
  currentNodeId: string | null;
  vmid: number;
  guestType: GuestType;
};

export type MetricRecord = {
  id: string;
  machineId: string;
  timestamp: Date;
  cpuUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number | null;
  diskTotal: number | null;
  networkRx: number | null;
  networkTx: number | null;
  uptime: number | null;
};

export type UpdatePackageRecord = {
  id: string;
  name: string;
  currentVersion: string | null;
  newVersion: string | null;
  architecture: string | null;
  changeType: string;
  security: boolean;
};

export type UpdateSnapshotRecord = {
  id: string;
  machineId: string;
  jobId: string | null;
  createdAt: Date;
  availableCount: number;
  securityCount: number | null;
  requiresReboot: boolean;
  requiresConfirmation: boolean;
  packages: UpdatePackageRecord[];
};

export type JobRecord = {
  id: string;
  parentId: string | null;
  action: string;
  category: ActionCategory;
  executionKind: JobExecutionKind;
  agentId: string | null;
  machineId: string | null;
  targetType: string;
  targetData: unknown;
  status: JobStatus;
  requestedBy: string | null;
  createdAt: Date;
  assignedAt: Date | null;
  dispatchedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  acknowledgedAt: Date | null;
  resolvedExecutable: string | null;
  resolvedArguments: string[] | null;
  result: unknown | null;
  exitCode: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type JobLogRecord = {
  id: string;
  jobId: string;
  sequence: number;
  timestamp: Date;
  stream: LogStream;
  data: string;
};

export type AlertRecord = {
  id: string;
  dedupeKey: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  machineId: string | null;
  agentId: string | null;
  clusterId: string | null;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NonceRecord = {
  agentId: string;
  nonce: string;
  timestamp: Date;
  expiresAt: Date;
};

export type PageQuery = {
  page: number;
  limit: number;
};

export type MachineListQuery = PageQuery & {
  includeHidden: boolean;
  type?: MachineType;
  status?: MachineStatus;
  clusterId?: string;
};

export type JobListQuery = PageQuery & {
  status?: JobStatus;
  machineId?: string;
  parentId?: string;
  agentId?: string;
};

export type AgentUpdate = Partial<
  Pick<
    AgentRecord,
    | "name"
    | "type"
    | "version"
    | "presence"
    | "lastSeenAt"
    | "maxConcurrency"
    | "capabilities"
    | "reportedRunning"
    | "reportedQueued"
    | "reportedCapacity"
  >
>;

export type MachineUpdate = Partial<
  Pick<
    MachineRecord,
    | "hostname"
    | "displayName"
    | "type"
    | "status"
    | "metricsSource"
    | "agentId"
    | "lastSeenAt"
    | "lastStateChangeAt"
    | "hiddenAt"
    | "details"
  >
>;

export type JobUpdate = Partial<
  Pick<
    JobRecord,
    | "status"
    | "agentId"
    | "assignedAt"
    | "dispatchedAt"
    | "startedAt"
    | "finishedAt"
    | "acknowledgedAt"
    | "resolvedExecutable"
    | "resolvedArguments"
    | "result"
    | "exitCode"
    | "durationMs"
    | "errorCode"
    | "errorMessage"
  >
>;
