export const AGENT_TYPES = ["proxmox-node", "linux-node"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_PRESENCES = ["ONLINE", "UNREACHABLE", "OFFLINE"] as const;
export type AgentPresence = (typeof AGENT_PRESENCES)[number];

export const MACHINE_TYPES = ["PROXMOX_NODE", "LXC", "VM", "PHYSICAL"] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

export const MACHINE_STATUSES = ["RUNNING", "STOPPED", "UNKNOWN", "OFFLINE"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export const METRICS_SOURCES = ["PROXMOX", "LOCAL_AGENT"] as const;
export type MetricsSource = (typeof METRICS_SOURCES)[number];

export const GUEST_TYPES = ["LXC", "QEMU"] as const;
export type GuestType = (typeof GUEST_TYPES)[number];

export const CLUSTER_TYPES = ["PROXMOX"] as const;
export type ClusterType = (typeof CLUSTER_TYPES)[number];

export const ACTION_CATEGORIES = ["READ", "WRITE", "CRITICAL"] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

export const JOB_STATUSES = [
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "SKIPPED",
  "INTERRUPTED",
  "UNKNOWN",
  "CANCELLED",
  "REQUIRES_CONFIRMATION",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES = [
  "SUCCESS",
  "FAILED",
  "SKIPPED",
  "INTERRUPTED",
  "UNKNOWN",
  "CANCELLED",
] as const satisfies readonly JobStatus[];

export const ACTIVE_JOB_STATUSES = ["ASSIGNED", "RUNNING"] as const satisfies readonly JobStatus[];

export const LOG_STREAMS = ["STDOUT", "STDERR", "SYSTEM"] as const;
export type LogStream = (typeof LOG_STREAMS)[number];

export const ALERT_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const CAPABILITIES = [
  "system",
  "apt",
  "systemd",
  "journal",
  "local.metrics",
  "proxmox.inventory",
  "proxmox.resources",
  "lxc.exec",
  "proxmox.host",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ACTION_NAMES = [
  "system.info",
  "system.rebootRequired",
  "system.reboot",
  "system.shutdown",
  "apt.refresh",
  "apt.check",
  "apt.upgrade",
  "systemd.failed",
  "systemd.serviceStatus",
  "systemd.restart",
  "journal.system",
  "journal.service",
  "proxmox.nodeInfo",
  "proxmox.inventory",
  "proxmox.resources",
  "proxmox.host.update",
  "lxc.info",
  "lxc.resources",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export type HostMaintenance = "never" | "always" | "when-proxmox-node";

/**
 * Métadonnées partagées d'une action.
 * Le serveur choisit une action par son nom. Seul l'agent connaît l'exécutable.
 * Ce type ne contient volontairement aucun champ de commande.
 */
export type ActionDefinition = {
  name: ActionName;
  category: ActionCategory;
  supportedTargets: readonly MachineType[];
  timeoutMs: number;
  capabilities: readonly Capability[];
  enabled: boolean;
  mutating: boolean;
  countsAsApt: boolean;
  hostMaintenance: HostMaintenance;
  neverAutoRetry: boolean;
};

const LINUX_AND_NODE = ["PROXMOX_NODE", "LXC", "VM", "PHYSICAL"] as const satisfies readonly MachineType[];
const GUEST_AND_HOST = ["PROXMOX_NODE", "LXC", "VM", "PHYSICAL"] as const satisfies readonly MachineType[];

export const ACTION_CATALOG: { readonly [K in ActionName]: ActionDefinition } = {
  "system.info": {
    name: "system.info",
    category: "READ",
    supportedTargets: LINUX_AND_NODE,
    timeoutMs: 15_000,
    capabilities: ["system"],
    enabled: true,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "system.rebootRequired": {
    name: "system.rebootRequired",
    category: "READ",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 15_000,
    capabilities: ["system"],
    enabled: false,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "system.reboot": {
    name: "system.reboot",
    category: "CRITICAL",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 60_000,
    capabilities: ["system"],
    enabled: false,
    mutating: true,
    countsAsApt: false,
    hostMaintenance: "when-proxmox-node",
    neverAutoRetry: true,
  },
  "system.shutdown": {
    name: "system.shutdown",
    category: "CRITICAL",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 60_000,
    capabilities: ["system"],
    enabled: false,
    mutating: true,
    countsAsApt: false,
    hostMaintenance: "when-proxmox-node",
    neverAutoRetry: true,
  },
  "apt.refresh": {
    name: "apt.refresh",
    category: "WRITE",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 10 * 60_000,
    capabilities: ["apt"],
    enabled: false,
    mutating: true,
    countsAsApt: true,
    hostMaintenance: "never",
    neverAutoRetry: true,
  },
  "apt.check": {
    name: "apt.check",
    category: "READ",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 5 * 60_000,
    capabilities: ["apt"],
    enabled: true,
    mutating: false,
    countsAsApt: true,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "apt.upgrade": {
    name: "apt.upgrade",
    category: "WRITE",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 60 * 60_000,
    capabilities: ["apt"],
    enabled: true,
    mutating: true,
    countsAsApt: true,
    hostMaintenance: "never",
    neverAutoRetry: true,
  },
  "systemd.failed": {
    name: "systemd.failed",
    category: "READ",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 15_000,
    capabilities: ["systemd"],
    enabled: false,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "systemd.serviceStatus": {
    name: "systemd.serviceStatus",
    category: "READ",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 15_000,
    capabilities: ["systemd"],
    enabled: false,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "systemd.restart": {
    name: "systemd.restart",
    category: "WRITE",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 60_000,
    capabilities: ["systemd"],
    enabled: false,
    mutating: true,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: true,
  },
  "journal.system": {
    name: "journal.system",
    category: "READ",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 30_000,
    capabilities: ["journal"],
    enabled: false,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "journal.service": {
    name: "journal.service",
    category: "READ",
    supportedTargets: GUEST_AND_HOST,
    timeoutMs: 30_000,
    capabilities: ["journal"],
    enabled: false,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "proxmox.nodeInfo": {
    name: "proxmox.nodeInfo",
    category: "READ",
    supportedTargets: ["PROXMOX_NODE"],
    timeoutMs: 15_000,
    capabilities: ["proxmox.inventory"],
    enabled: false,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "proxmox.inventory": {
    name: "proxmox.inventory",
    category: "READ",
    supportedTargets: ["PROXMOX_NODE"],
    timeoutMs: 30_000,
    capabilities: ["proxmox.inventory"],
    enabled: false,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "proxmox.resources": {
    name: "proxmox.resources",
    category: "READ",
    supportedTargets: ["PROXMOX_NODE"],
    timeoutMs: 30_000,
    capabilities: ["proxmox.resources"],
    enabled: false,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "proxmox.host.update": {
    name: "proxmox.host.update",
    category: "CRITICAL",
    supportedTargets: ["PROXMOX_NODE"],
    timeoutMs: 2 * 60 * 60_000,
    capabilities: ["proxmox.host"],
    enabled: false,
    mutating: true,
    countsAsApt: true,
    hostMaintenance: "always",
    neverAutoRetry: true,
  },
  "lxc.info": {
    name: "lxc.info",
    category: "READ",
    supportedTargets: ["LXC"],
    timeoutMs: 15_000,
    capabilities: ["lxc.exec"],
    enabled: false,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
  "lxc.resources": {
    name: "lxc.resources",
    category: "READ",
    supportedTargets: ["LXC"],
    timeoutMs: 15_000,
    capabilities: ["proxmox.resources"],
    enabled: false,
    mutating: false,
    countsAsApt: false,
    hostMaintenance: "never",
    neverAutoRetry: false,
  },
};

export function getAction(name: ActionName): ActionDefinition {
  return ACTION_CATALOG[name];
}

export function isTerminalStatus(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

export function isActiveStatus(status: JobStatus): boolean {
  return (ACTIVE_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

/**
 * Transitions autorisées. UNKNOWN est terminal : aucune reprise automatique.
 * REQUIRES_CONFIRMATION ne repart en QUEUED que par une action opérateur explicite,
 * qui n'est pas implémentée dans cette version (acknowledge ne relance pas).
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  QUEUED: ["ASSIGNED", "CANCELLED", "SKIPPED", "FAILED"],
  ASSIGNED: ["RUNNING", "QUEUED", "CANCELLED", "SKIPPED", "FAILED"],
  RUNNING: [
    "SUCCESS",
    "FAILED",
    "SKIPPED",
    "INTERRUPTED",
    "UNKNOWN",
    "REQUIRES_CONFIRMATION",
  ],
  REQUIRES_CONFIRMATION: ["CANCELLED"],
  SUCCESS: [],
  FAILED: [],
  SKIPPED: [],
  INTERRUPTED: [],
  UNKNOWN: [],
  CANCELLED: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  REPLAY_DETECTED: "REPLAY_DETECTED",
  TIMESTAMP_OUT_OF_WINDOW: "TIMESTAMP_OUT_OF_WINDOW",
  AGENT_UNAUTHORIZED: "AGENT_UNAUTHORIZED",
  ACTION_DISABLED: "ACTION_DISABLED",
  ACTION_NOT_IMPLEMENTED: "ACTION_NOT_IMPLEMENTED",
  INCOMPATIBLE_TARGET: "INCOMPATIBLE_TARGET",
  NO_TARGETS: "NO_TARGETS",
  NO_AGENT: "NO_AGENT",
  AGENT_OFFLINE: "AGENT_OFFLINE",
  SKIPPED_OFFLINE: "SKIPPED_OFFLINE",
  SKIPPED_STOPPED: "SKIPPED_STOPPED",
  SKIPPED_NODE_UNAVAILABLE: "SKIPPED_NODE_UNAVAILABLE",
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  AGENT_LOST: "AGENT_LOST",
  AGENT_SHUTDOWN: "AGENT_SHUTDOWN",
  JOB_DEADLINE_EXCEEDED: "JOB_DEADLINE_EXCEEDED",
  MUTATING_JOB_UNRESOLVED: "MUTATING_JOB_UNRESOLVED",
  CONFLICT: "CONFLICT",
  JOB_NOT_CANCELLABLE: "JOB_NOT_CANCELLABLE",
  JOB_NOT_ACKNOWLEDGEABLE: "JOB_NOT_ACKNOWLEDGEABLE",
  METRICS_SOURCE_MISMATCH: "METRICS_SOURCE_MISMATCH",
  INVALID_STATE: "INVALID_STATE",
  OVER_CAPACITY: "OVER_CAPACITY",
  PROCESS_FAILED: "PROCESS_FAILED",
  CONFIG_INVALID: "CONFIG_INVALID",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const SKIP_ERROR_CODES = [
  ERROR_CODES.SKIPPED_OFFLINE,
  ERROR_CODES.SKIPPED_STOPPED,
  ERROR_CODES.SKIPPED_NODE_UNAVAILABLE,
  ERROR_CODES.TARGET_NOT_FOUND,
  ERROR_CODES.NO_AGENT,
  ERROR_CODES.AGENT_OFFLINE,
] as const;

export const INTERRUPT_ERROR_CODES = [
  ERROR_CODES.TIMEOUT,
  ERROR_CODES.AGENT_SHUTDOWN,
] as const;

export function isSkipErrorCode(code: string): boolean {
  return (SKIP_ERROR_CODES as readonly string[]).includes(code);
}

export function isInterruptErrorCode(code: string): boolean {
  return (INTERRUPT_ERROR_CODES as readonly string[]).includes(code);
}

export const HMAC_PROTOCOL_VERSION = "INFRACTL-HMAC-V1";

export const HMAC_HEADERS = {
  agentId: "x-agent-id",
  timestamp: "x-timestamp",
  nonce: "x-nonce",
  signature: "x-signature",
} as const;

export const DEFAULT_CAPABILITIES: Record<AgentType, readonly Capability[]> = {
  "linux-node": ["system", "apt", "local.metrics"],
  "proxmox-node": [
    "system",
    "apt",
    "systemd",
    "journal",
    "proxmox.inventory",
    "proxmox.resources",
    "lxc.exec",
    "proxmox.host",
  ],
};

export function actionRequiresHostMaintenance(
  action: ActionDefinition,
  machineType: MachineType,
): boolean {
  if (action.hostMaintenance === "always") {
    return true;
  }
  if (action.hostMaintenance === "when-proxmox-node") {
    return machineType === "PROXMOX_NODE";
  }
  return false;
}

export function agentHasCapabilities(
  available: readonly string[],
  required: readonly string[],
): boolean {
  const set = new Set(available);
  return required.every((capability) => set.has(capability));
}
