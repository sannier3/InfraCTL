import { z } from "zod";
import { actionCategorySchema, machineTypeSchema, metricsSourceSchema } from "@infra/schemas";

export const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

export const paginationSchema = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    pages: z.number().int(),
  })
  .strict();

const iso = z.string().datetime();

export const agentResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["proxmox-node", "linux-node"]),
    version: z.string(),
    presence: z.enum(["ONLINE", "UNREACHABLE", "OFFLINE"]),
    lastSeenAt: iso.nullable(),
    registeredAt: iso,
    maxConcurrency: z.number().int(),
    capabilities: z.array(z.string()),
    reportedRunning: z.number().int(),
    reportedQueued: z.number().int(),
    reportedCapacity: z.number().int(),
    createdAt: iso,
    updatedAt: iso,
  })
  .strict();

export const machineResponseSchema = z
  .object({
    id: z.string().uuid(),
    hostname: z.string(),
    displayName: z.string(),
    type: machineTypeSchema,
    status: z.enum(["RUNNING", "STOPPED", "UNKNOWN", "OFFLINE"]),
    metricsSource: metricsSourceSchema,
    agentId: z.string().nullable(),
    lastSeenAt: iso.nullable(),
    lastStateChangeAt: iso,
    hiddenAt: iso.nullable(),
    addresses: z.array(z.string()).max(8),
    updates: z
      .object({
        availableCount: z.number().int(),
        securityCount: z.number().int().nullable(),
        requiresReboot: z.boolean(),
      })
      .strict()
      .nullable(),
    system: z
      .object({
        prettyName: z.string().nullable(),
        kernel: z.string().nullable(),
        arch: z.string().nullable(),
      })
      .strict()
      .nullable(),
    proxmox: z
      .object({
        vmid: z.number().int().nullable(),
        nodeName: z.string().nullable(),
        clusterId: z.string().uuid().nullable(),
        clusterName: z.string().nullable(),
      })
      .strict()
      .nullable(),
    createdAt: iso,
    updatedAt: iso,
  })
  .strict();

export const jobResponseSchema = z
  .object({
    id: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    action: z.string(),
    category: actionCategorySchema,
    executionKind: z.enum(["PARENT", "LEAF"]),
    agentId: z.string().nullable(),
    machineId: z.string().uuid().nullable(),
    targetType: z.string(),
    status: z.enum([
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
    ]),
    requestedBy: z.string().nullable(),
    createdAt: iso,
    assignedAt: iso.nullable(),
    dispatchedAt: iso.nullable(),
    startedAt: iso.nullable(),
    finishedAt: iso.nullable(),
    acknowledgedAt: iso.nullable(),
    resolvedExecutable: z.string().nullable(),
    resolvedArguments: z.array(z.string()).nullable(),
    result: z.record(z.string(), z.unknown()).nullable(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .strict();

export const logResponseSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    sequence: z.number().int(),
    timestamp: iso,
    stream: z.enum(["STDOUT", "STDERR", "SYSTEM"]),
    data: z.string(),
  })
  .strict();

export const healthResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    database: z.enum(["ok", "error"]),
    agents: z
      .object({
        online: z.number().int(),
        unreachable: z.number().int(),
        offline: z.number().int(),
      })
      .strict(),
    jobs: z
      .object({
        queued: z.number().int(),
        running: z.number().int(),
      })
      .strict(),
  })
  .strict();

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      data: z.array(item),
      pagination: paginationSchema,
    })
    .strict();
}

export function withErrors(success: z.ZodTypeAny, status = 200): Record<number, z.ZodTypeAny> {
  return {
    [status]: success,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema,
  };
}
