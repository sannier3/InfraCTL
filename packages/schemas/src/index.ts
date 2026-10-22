import { z } from "zod";
import {
  ACTION_CATEGORIES,
  ACTION_NAMES,
  AGENT_TYPES,
  CAPABILITIES,
  GUEST_TYPES,
  LOG_STREAMS,
  MACHINE_TYPES,
  METRICS_SOURCES,
  type ActionName,
  type AgentType,
  type Capability,
  type GuestType,
  type LogStream,
  type MachineType,
  type MetricsSource,
  type ActionCategory,
} from "@infra/types";

function enumOf<T extends string>(values: readonly T[]): z.ZodEnum<[T, ...T[]]> {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error("énumération vide");
  }
  return z.enum([first, ...rest]);
}

const nonEmpty = z.string().trim().min(1);

export const agentIdSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "identifiant d'agent invalide");

export const uuidSchema = z.string().uuid();

export const vmidSchema = z.number().int().min(1).max(999_999_999);

export const systemdUnitSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:@._\\-]{0,127}$/, "nom d'unité systemd invalide");

export const actionNameSchema = enumOf<ActionName>(ACTION_NAMES);
export const actionCategorySchema = enumOf<ActionCategory>(ACTION_CATEGORIES);
export const agentTypeSchema = enumOf<AgentType>(AGENT_TYPES);
export const machineTypeSchema = enumOf<MachineType>(MACHINE_TYPES);
export const metricsSourceSchema = enumOf<MetricsSource>(METRICS_SOURCES);
export const guestTypeSchema = enumOf<GuestType>(GUEST_TYPES);
export const capabilitySchema = enumOf<Capability>(CAPABILITIES);
export const logStreamSchema = enumOf<LogStream>(LOG_STREAMS);

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const selectorSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("machine"),
      id: uuidSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("machines"),
      ids: z.array(uuidSchema).min(1).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("proxmox-node"),
      id: nonEmpty.max(128),
      includeGuests: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cluster"),
      id: nonEmpty.max(128),
      includeGuests: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fleet"),
    })
    .strict(),
]);
export type Selector = z.infer<typeof selectorSchema>;

export const actionRequestSchema = z
  .object({
    action: actionNameSchema,
    requestedBy: z.string().trim().min(1).max(128).optional(),
    selector: selectorSchema,
    parameters: z
      .object({
        unit: systemdUnitSchema.optional(),
        lines: z.number().int().min(1).max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ActionRequest = z.infer<typeof actionRequestSchema>;

export const hmacHeaderSchema = z.object({
  agentId: agentIdSchema,
  timestamp: z.string().regex(/^\d{13}$/, "timestamp millisecondes attendu"),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "nonce invalide"),
  signature: z.string().regex(/^[a-f0-9]{64}$/, "signature hex invalide"),
});
export type HmacHeaders = z.infer<typeof hmacHeaderSchema>;

export const heartbeatBodySchema = z
  .object({
    agentId: agentIdSchema,
    version: z.string().trim().min(1).max(64),
    type: agentTypeSchema,
    jobs: z
      .object({
        running: z.number().int().min(0).max(10_000),
        queued: z.number().int().min(0).max(10_000),
        capacity: z.number().int().min(1).max(10_000),
      })
      .strict(),
    capabilities: z.array(capabilitySchema).max(32),
  })
  .strict();
export type HeartbeatBody = z.infer<typeof heartbeatBodySchema>;

export const proxmoxGuestReportSchema = z
  .object({
    vmid: vmidSchema,
    guestType: guestTypeSchema,
    name: z.string().trim().min(1).max(255),
    status: z.enum(["running", "stopped"]),
    cpu: z.number().min(0).max(1024).optional(),
    memoryUsed: z.number().int().min(0).optional(),
    memoryTotal: z.number().int().min(0).optional(),
    uptime: z.number().int().min(0).optional(),
    diskUsed: z.number().int().min(0).optional(),
    diskTotal: z.number().int().min(0).optional(),
    addresses: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
  })
  .strict();
export type ProxmoxGuestReport = z.infer<typeof proxmoxGuestReportSchema>;

export const inventoryBodySchema = z
  .object({
    hostname: z.string().trim().min(1).max(255),
    displayName: z.string().trim().min(1).max(255).optional(),
    machineType: machineTypeSchema,
    metricsSource: metricsSourceSchema,
    status: z.enum(["RUNNING", "STOPPED"]),
    os: z
      .object({
        id: z.string().max(64).optional(),
        name: z.string().max(128).optional(),
        version: z.string().max(128).optional(),
        prettyName: z.string().max(255).optional(),
        kernel: z.string().max(255),
        arch: z.string().max(32),
      })
      .strict(),
    proxmox: z
      .object({
        clusterId: z.string().trim().min(1).max(128),
        vmid: vmidSchema,
      })
      .strict()
      .optional(),
    node: z
      .object({
        clusterId: z.string().trim().min(1).max(128),
        name: z.string().trim().min(1).max(128),
        version: z.string().max(128).optional(),
      })
      .strict()
      .optional(),
    addresses: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
    guests: z.array(proxmoxGuestReportSchema).max(5_000).optional(),
  })
  .strict();
export type InventoryBody = z.infer<typeof inventoryBodySchema>;

export const resourcesBodySchema = z
  .object({
    timestamp: z.string().datetime(),
    cpuUsage: z.number().min(0).max(1024),
    memoryUsed: z.number().int().min(0),
    memoryTotal: z.number().int().min(0),
    diskUsed: z.number().int().min(0).nullable(),
    diskTotal: z.number().int().min(0).nullable(),
    networkRx: z.number().int().min(0).nullable(),
    networkTx: z.number().int().min(0).nullable(),
    uptime: z.number().int().min(0).nullable(),
  })
  .strict();
export type ResourcesBody = z.infer<typeof resourcesBodySchema>;

export const agentTargetSchema = z
  .object({
    machineId: uuidSchema,
    machineType: machineTypeSchema,
    hostname: z.string().max(255),
    guest: z
      .object({
        vmid: vmidSchema,
        guestType: guestTypeSchema,
        clusterId: uuidSchema,
      })
      .strict()
      .optional(),
    parameters: z
      .object({
        unit: systemdUnitSchema.optional(),
        lines: z.number().int().min(1).max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentTarget = z.infer<typeof agentTargetSchema>;

export const agentJobSchema = z
  .object({
    jobId: uuidSchema,
    action: actionNameSchema,
    category: actionCategorySchema,
    target: agentTargetSchema,
  })
  .strict();
export type AgentJob = z.infer<typeof agentJobSchema>;

export const jobStartResponseSchema = z
  .object({
    status: z.enum(["RUNNING", "CANCELLED", "REJECTED"]),
    execute: z.boolean(),
  })
  .strict();
export type JobStartResponse = z.infer<typeof jobStartResponseSchema>;

export const resolvedCommandAuditSchema = z
  .object({
    resolvedExecutable: z
      .string()
      .regex(/^[A-Za-z0-9_./+-]{1,256}$/)
      .nullable(),
    resolvedArguments: z.array(z.string().max(1024)).max(64).nullable(),
  })
  .strict();

export const jobCompleteBodySchema = resolvedCommandAuditSchema
  .extend({
    exitCode: z.number().int().min(-1).max(255).nullable(),
    durationMs: z.number().int().min(0).max(86_400_000),
    result: z.record(z.unknown()).optional(),
  })
  .strict();
export type JobCompleteBody = z.infer<typeof jobCompleteBodySchema>;

export const jobFailBodySchema = resolvedCommandAuditSchema
  .extend({
    exitCode: z.number().int().min(-1).max(255).nullable(),
    durationMs: z.number().int().min(0).max(86_400_000),
    errorCode: z.string().trim().min(1).max(64),
    errorMessage: z.string().trim().min(1).max(4_000),
    result: z.record(z.unknown()).optional(),
  })
  .strict();
export type JobFailBody = z.infer<typeof jobFailBodySchema>;

export const jobLogEntrySchema = z
  .object({
    stream: z.enum(["stdout", "stderr", "system"]),
    timestamp: z.string().datetime(),
    data: z.string().max(16_384),
  })
  .strict();

export const jobLogsBodySchema = z
  .object({
    entries: z.array(jobLogEntrySchema).min(1).max(100),
  })
  .strict();
export type JobLogsBody = z.infer<typeof jobLogsBodySchema>;

const positiveInt = z.number().int().positive();
const positiveSeconds = z.number().int().min(1).max(86_400);

export const serverConfigSchema = z
  .object({
    server: z
      .object({
        bind: z.string().trim().min(1).default("0.0.0.0"),
        port: z.number().int().min(1).max(65535).default(8080),
        logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
        exposeSwagger: z.boolean().default(true),
        bodyLimitBytes: z.number().int().min(1024).max(5_000_000).default(1_048_576),
      })
      .strict(),
    database: z
      .object({
        url: z.string().trim().min(1),
      })
      .strict(),
    auth: z
      .object({
        apiToken: z.string().min(16).max(512),
        readToken: z.string().min(16).max(512).optional(),
      })
      .strict(),
    security: z
      .object({
        credentialsKey: z.string().min(1),
        hmacWindowSeconds: positiveSeconds.default(60),
        longPollSeconds: z.number().int().min(1).max(120).default(30),
        dispatchLeaseSeconds: positiveSeconds.default(120),
      })
      .strict(),
    agents: z
      .object({
        unreachableAfterSeconds: positiveSeconds.default(30),
        offlineAfterSeconds: positiveSeconds.default(60),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.offlineAfterSeconds <= value.unreachableAfterSeconds) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "offlineAfterSeconds doit être supérieur à unreachableAfterSeconds",
            path: ["offlineAfterSeconds"],
          });
        }
      }),
    inventory: z
      .object({
        hideStoppedAfterSeconds: positiveSeconds.default(300),
      })
      .strict(),
    metrics: z
      .object({
        retentionDays: z.number().int().min(1).max(3650).default(7),
      })
      .strict(),
    concurrency: z
      .object({
        global: positiveInt.default(20),
        perAgent: positiveInt.default(4),
        perProxmoxNode: positiveInt.default(4),
        aptPerProxmoxNode: positiveInt.default(2),
        perMachineWrite: positiveInt.default(1),
        proxmoxHostMaintenancePerCluster: positiveInt.default(1),
      })
      .strict(),
    scheduler: z
      .object({
        tickMs: z.number().int().min(200).max(60_000).default(1000),
        noncePurgeEveryTicks: positiveInt.default(60),
        metricPurgeEveryTicks: positiveInt.default(3600),
      })
      .strict(),
    ui: z
      .object({
        enabled: z.boolean().default(false),
        password: z.string().min(12).max(256).optional(),
        sessionHours: z.number().int().min(1).max(720).default(12),
        noCache: z.boolean().default(true),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.enabled && (value.password === undefined || value.password.length < 12)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["password"],
            message: "mot de passe requis lorsque l'interface est activée",
          });
        }
      })
      .default({ enabled: false, sessionHours: 12, noCache: true }),
  })
  .strict();
export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const agentConfigSchema = z
  .object({
    server: z
      .object({
        protocol: z.enum(["http", "https"]),
        host: z.string().trim().min(1),
        port: z.number().int().min(1).max(65535),
        requestTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
        longPollTimeoutMs: z.number().int().min(5_000).max(180_000).default(45_000),
      })
      .strict(),
    agent: z
      .object({
        id: agentIdSchema,
        name: z.string().trim().min(1).max(128).optional(),
        type: agentTypeSchema,
        secret: z.string().min(16).max(512),
        version: z.string().trim().min(1).max(64).default("1.0.0"),
      })
      .strict(),
    machine: z
      .object({
        type: z.enum(["VM", "PHYSICAL"]).default("PHYSICAL"),
        displayName: z.string().trim().min(1).max(255).optional(),
      })
      .strict()
      .default({ type: "PHYSICAL" }),
    intervals: z
      .object({
        heartbeatSeconds: positiveSeconds.default(10),
        inventorySeconds: positiveSeconds.default(30),
        resourcesSeconds: positiveSeconds.default(30),
      })
      .strict()
      .default({
        heartbeatSeconds: 10,
        inventorySeconds: 30,
        resourcesSeconds: 30,
      }),
    concurrency: z
      .object({
        total: positiveInt.default(4),
        apt: positiveInt.default(2),
      })
      .strict()
      .default({
        total: 4,
        apt: 2,
      }),
    metrics: z
      .object({
        source: metricsSourceSchema.default("LOCAL_AGENT"),
      })
      .strict()
      .default({ source: "LOCAL_AGENT" }),
    proxmox: z
      .object({
        enabled: z.boolean().default(false),
        clusterId: z.string().trim().min(1).max(128).optional(),
        vmid: vmidSchema.optional(),
      })
      .strict()
      .default({ enabled: false }),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.agent.type === "linux-node" && value.proxmox.enabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "proxmox.enabled est réservé au mode proxmox-node",
        path: ["proxmox", "enabled"],
      });
    }
    if (value.agent.type === "proxmox-node") {
      if (!value.proxmox.enabled) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "proxmox.enabled est requis pour un agent proxmox-node",
          path: ["proxmox", "enabled"],
        });
      }
      if (!value.proxmox.clusterId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "proxmox.clusterId est requis pour un agent proxmox-node",
          path: ["proxmox", "clusterId"],
        });
      }
    }
    if (value.metrics.source === "PROXMOX") {
      if (!value.proxmox.clusterId || value.proxmox.vmid === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "metrics.source PROXMOX exige proxmox.clusterId et proxmox.vmid",
          path: ["metrics", "source"],
        });
      }
    }
    if (value.concurrency.apt > value.concurrency.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "concurrency.apt ne peut pas dépasser concurrency.total",
        path: ["concurrency", "apt"],
      });
    }
  });
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const aptPackageChangeSchema = z
  .object({
    name: z.string(),
    currentVersion: z.string().nullable(),
    newVersion: z.string().nullable(),
    architecture: z.string().nullable(),
    action: z.enum(["upgrade", "install", "remove"]),
    security: z.boolean(),
  })
  .strict();
export type AptPackageChange = z.infer<typeof aptPackageChangeSchema>;

export const aptCheckResultSchema = z
  .object({
    availableCount: z.number().int().min(0),
    securityCount: z.number().int().min(0),
    requiresReboot: z.boolean(),
    requiresConfirmation: z.boolean(),
    packages: z.array(aptPackageChangeSchema),
  })
  .strict();
export type AptCheckResult = z.infer<typeof aptCheckResultSchema>;

const agentNameSchema = z.string().trim().min(1).max(128);
const agentSecretSchema = z.string().min(16).max(256);
const agentConcurrencySchema = z.number().int().min(1).max(10_000);
const agentCapabilitiesSchema = z.array(capabilitySchema).min(1).max(32);

export const agentCreateBodySchema = z
  .object({
    id: agentIdSchema,
    name: agentNameSchema.optional(),
    type: agentTypeSchema,
    secret: agentSecretSchema,
    maxConcurrency: agentConcurrencySchema.optional(),
    capabilities: agentCapabilitiesSchema.optional(),
  })
  .strict();
export type AgentCreateBody = z.infer<typeof agentCreateBodySchema>;

export const agentUpdateBodySchema = z
  .object({
    name: agentNameSchema.optional(),
    type: agentTypeSchema.optional(),
    maxConcurrency: agentConcurrencySchema.optional(),
    capabilities: agentCapabilitiesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "aucune modification" });
export type AgentUpdateBody = z.infer<typeof agentUpdateBodySchema>;

export const agentSecretBodySchema = z
  .object({
    secret: agentSecretSchema,
  })
  .strict();
export type AgentSecretBody = z.infer<typeof agentSecretBodySchema>;

export function formatConfigIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(racine)";
      const sensitive = /(secret|password|token|url|key|credential)/i.test(path);
      if (sensitive) {
        return `${path}: ${issue.message}`;
      }
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}
