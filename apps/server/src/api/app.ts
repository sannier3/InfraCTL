import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import {
  actionRequestSchema,
  agentJobSchema,
  heartbeatBodySchema,
  inventoryBodySchema,
  jobCompleteBodySchema,
  jobFailBodySchema,
  jobLogsBodySchema,
  jobStartResponseSchema,
  paginationQuerySchema,
  resourcesBodySchema,
} from "@infra/schemas";
import { ERROR_CODES, JOB_STATUSES, MACHINE_STATUSES, MACHINE_TYPES } from "@infra/types";
import { createAgentAuth, createApiAuth, requireAgentId } from "../auth/http.js";
import { decodeCredentialsKey } from "../crypto/secrets.js";
import type { Store } from "../database/store.js";
import { AppError } from "../errors.js";
import { InventoryService } from "../inventory/service.js";
import { JobService, type Principal } from "../jobs/service.js";
import { Mutex } from "../lock.js";
import { JobWaitHub } from "../scheduler/hub.js";
import { Scheduler } from "../scheduler/scheduler.js";
import type { ServerConfig } from "@infra/schemas";
import {
  agentResponseSchema,
  errorResponseSchema,
  healthResponseSchema,
  jobResponseSchema,
  logResponseSchema,
  machineResponseSchema,
  pageSchema,
  withErrors,
} from "./http-schemas.js";
import { presentAgent, presentJob, presentLog, presentMachine, presentPage, iso } from "./present.js";

export type AppDeps = {
  config: ServerConfig;
  store: Store;
  now?: () => Date;
  startScheduler?: boolean;
  credentialsKey?: Buffer;
};

const idParams = z.object({ id: z.string().min(1).max(128) }).strict();
const machineQuery = paginationQuerySchema.extend({
  includeHidden: z.enum(["true", "false"]).optional(),
  type: z.enum(MACHINE_TYPES).optional(),
  status: z.enum(MACHINE_STATUSES).optional(),
  clusterId: z.string().min(1).max(128).optional(),
});
const jobQuery = paginationQuerySchema.extend({
  status: z.enum(JOB_STATUSES).optional(),
  machineId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
});
const alertQuery = paginationQuerySchema.extend({
  openOnly: z.enum(["true", "false"]).optional(),
});

const clusterSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    type: z.literal("PROXMOX"),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const nodeSchema = z
  .object({
    id: z.string().uuid(),
    clusterId: z.string().uuid(),
    name: z.string(),
    machineId: z.string().uuid(),
    agentId: z.string().nullable(),
    version: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const metricSchema = z
  .object({
    id: z.string().uuid(),
    machineId: z.string().uuid(),
    timestamp: z.string().datetime(),
    cpuUsage: z.number(),
    memoryUsed: z.number(),
    memoryTotal: z.number(),
    diskUsed: z.number().nullable(),
    diskTotal: z.number().nullable(),
    networkRx: z.number().nullable(),
    networkTx: z.number().nullable(),
    uptime: z.number().nullable(),
  })
  .strict();

const updateSchema = z
  .object({
    id: z.string().uuid(),
    machineId: z.string().uuid(),
    jobId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    availableCount: z.number().int(),
    securityCount: z.number().int().nullable(),
    requiresReboot: z.boolean(),
    requiresConfirmation: z.boolean(),
    packages: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          currentVersion: z.string().nullable(),
          newVersion: z.string().nullable(),
          architecture: z.string().nullable(),
          changeType: z.string(),
          security: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const alertSchema = z
  .object({
    id: z.string().uuid(),
    dedupeKey: z.string(),
    severity: z.enum(["INFO", "WARNING", "CRITICAL"]),
    title: z.string(),
    message: z.string(),
    machineId: z.string().uuid().nullable(),
    agentId: z.string().nullable(),
    clusterId: z.string().uuid().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export async function buildApp(deps: AppDeps): Promise<{
  app: FastifyInstance;
  jobs: JobService;
  inventory: InventoryService;
  scheduler: Scheduler;
  hub: JobWaitHub;
}> {
  const now = deps.now ?? (() => new Date());
  const key = deps.credentialsKey ?? decodeCredentialsKey(deps.config.security.credentialsKey);
  const lock = new Mutex();
  const hub = new JobWaitHub();
  const jobs = new JobService(
    deps.store,
    lock,
    deps.config.concurrency,
    deps.config.security.dispatchLeaseSeconds * 1000,
    60_000,
  );
  const inventory = new InventoryService(deps.store, lock, {
    unreachableAfterSeconds: deps.config.agents.unreachableAfterSeconds,
    offlineAfterSeconds: deps.config.agents.offlineAfterSeconds,
    hideStoppedAfterSeconds: deps.config.inventory.hideStoppedAfterSeconds,
  });
  const scheduler = new Scheduler(jobs, inventory, deps.store, hub, {
    tickMs: deps.config.scheduler.tickMs,
    noncePurgeEveryTicks: deps.config.scheduler.noncePurgeEveryTicks,
    metricPurgeEveryTicks: deps.config.scheduler.metricPurgeEveryTicks,
    retentionDays: deps.config.metrics.retentionDays,
    now,
    onError: (error: unknown) => {
      const name = error instanceof Error ? error.name : "Error";
      process.stderr.write(`${JSON.stringify({ level: "error", message: "erreur du scheduler", name })}\n`);
    },
  });

  const app = Fastify({
    logger: {
      level: deps.config.server.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers['x-signature']",
          "secret",
          "password",
          "token",
          "*.secret",
          "*.password",
          "*.token",
          "*.secretCiphertext",
        ],
        censor: "[redacted]",
      },
    },
    bodyLimit: deps.config.server.bodyLimitBytes,
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("rawBody", "");
  app.decorateRequest("agentId", "");
  app.decorateRequest("principal", undefined);
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const raw = typeof body === "string" ? body : "";
    request.rawBody = raw;
    if (raw.trim().length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw) as unknown);
    } catch {
      done(new AppError(400, ERROR_CODES.VALIDATION_ERROR, "JSON invalide"), undefined);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: { code: ERROR_CODES.VALIDATION_ERROR, message: "requête invalide" } });
    }
    request.log.error({ name: error instanceof Error ? error.name : "Error" }, "erreur interne");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "erreur interne" } });
  });
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: { code: ERROR_CODES.NOT_FOUND, message: "route introuvable" } });
  });

  if (deps.config.server.exposeSwagger) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: "Infra Manager",
          version: "1.0.0",
          description: "API de supervision et de maintenance contrôlée. Aucune commande shell n'est acceptée.",
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
  }

  const apiAuth = createApiAuth({
    admin: deps.config.auth.apiToken,
    ...(deps.config.auth.readToken ? { reader: deps.config.auth.readToken } : {}),
  });
  const agentAuth = createAgentAuth({
    store: deps.store,
    key,
    windowMs: deps.config.security.hmacWindowSeconds * 1000,
    now,
  });

  app.get("/api/v1/health", { schema: { response: { 200: healthResponseSchema } } }, async () => {
    try {
      await deps.store.ping();
    } catch {
      return {
        status: "degraded" as const,
        database: "error" as const,
        agents: { online: 0, unreachable: 0, offline: 0 },
        jobs: { queued: 0, running: 0 },
      };
    }
    const [agents, queued, running] = await Promise.all([
      deps.store.listAgents(),
      deps.store.listJobsByStatuses(["QUEUED"]),
      deps.store.listJobsByStatuses(["RUNNING"]),
    ]);
    return {
      status: "ok" as const,
      database: "ok" as const,
      agents: {
        online: agents.filter((agent) => agent.presence === "ONLINE").length,
        unreachable: agents.filter((agent) => agent.presence === "UNREACHABLE").length,
        offline: agents.filter((agent) => agent.presence === "OFFLINE").length,
      },
      jobs: {
        queued: queued.filter((job) => job.executionKind === "LEAF").length,
        running: running.filter((job) => job.executionKind === "LEAF").length,
      },
    };
  });

  app.register(async (raw) => {
    const scope = raw.withTypeProvider<ZodTypeProvider>();
    scope.addHook("preHandler", apiAuth);
    scope.get("/agents", { schema: { querystring: paginationQuerySchema, response: withErrors(pageSchema(agentResponseSchema)) } }, async (request) => {
      const all = await deps.store.listAgents();
      const start = (request.query.page - 1) * request.query.limit;
      return presentPage(all.slice(start, start + request.query.limit), all.length, request.query.page, request.query.limit, presentAgent);
    });
    scope.get("/agents/:id", { schema: { params: idParams, response: withErrors(agentResponseSchema) } }, async (request) => {
      const agent = await deps.store.findAgent(request.params.id);
      if (!agent) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "agent introuvable");
      }
      return presentAgent(agent);
    });
    scope.get("/clusters", { schema: { querystring: paginationQuerySchema, response: withErrors(pageSchema(clusterSchema)) } }, async (request) => {
      const all = await deps.store.listClusters();
      const start = (request.query.page - 1) * request.query.limit;
      return presentPage(all.slice(start, start + request.query.limit), all.length, request.query.page, request.query.limit, (cluster) => ({
        id: cluster.id,
        name: cluster.name,
        slug: cluster.slug,
        type: cluster.type,
        createdAt: cluster.createdAt.toISOString(),
        updatedAt: cluster.updatedAt.toISOString(),
      }));
    });
    scope.get("/clusters/:id", { schema: { params: idParams, response: withErrors(clusterSchema) } }, async (request) => {
      const cluster = await deps.store.findCluster(request.params.id);
      if (!cluster) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "cluster introuvable");
      }
      return {
        id: cluster.id,
        name: cluster.name,
        slug: cluster.slug,
        type: cluster.type,
        createdAt: cluster.createdAt.toISOString(),
        updatedAt: cluster.updatedAt.toISOString(),
      };
    });
    scope.get("/nodes", { schema: { querystring: paginationQuerySchema, response: withErrors(pageSchema(nodeSchema)) } }, async (request) => {
      const all = await deps.store.listNodes();
      const start = (request.query.page - 1) * request.query.limit;
      return presentPage(all.slice(start, start + request.query.limit), all.length, request.query.page, request.query.limit, (node) => ({
        ...node,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
      }));
    });
    scope.get("/nodes/:id", { schema: { params: idParams, response: withErrors(nodeSchema) } }, async (request) => {
      const node = await deps.store.findNode(request.params.id);
      if (!node) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "nœud introuvable");
      }
      return { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString() };
    });
    scope.get("/machines", { schema: { querystring: machineQuery, response: withErrors(pageSchema(machineResponseSchema)) } }, async (request) => {
      const page = await deps.store.listMachines({
        page: request.query.page,
        limit: request.query.limit,
        includeHidden: request.query.includeHidden === "true",
        ...(request.query.type ? { type: request.query.type } : {}),
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.clusterId ? { clusterId: request.query.clusterId } : {}),
      });
      return presentPage(page.items, page.total, request.query.page, request.query.limit, presentMachine);
    });
    scope.get("/machines/:id", { schema: { params: idParams, response: withErrors(machineResponseSchema) } }, async (request) => {
      const machine = await deps.store.findMachine(request.params.id);
      if (!machine) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "machine introuvable");
      }
      return presentMachine(machine);
    });
    scope.get(
      "/machines/:id/resources",
      { schema: { params: idParams, querystring: paginationQuerySchema, response: withErrors(z.object({ current: metricSchema.nullable(), history: pageSchema(metricSchema) }).strict()) } },
      async (request) => {
        const machine = await deps.store.findMachine(request.params.id);
        if (!machine) {
          throw new AppError(404, ERROR_CODES.NOT_FOUND, "machine introuvable");
        }
        const [current, history] = await Promise.all([
          deps.store.latestMetric(machine.id),
          deps.store.listMetrics(machine.id, request.query),
        ]);
        const mapMetric = (metric: NonNullable<typeof current>) => ({
          id: metric.id,
          machineId: metric.machineId,
          timestamp: metric.timestamp.toISOString(),
          cpuUsage: metric.cpuUsage,
          memoryUsed: metric.memoryUsed,
          memoryTotal: metric.memoryTotal,
          diskUsed: metric.diskUsed,
          diskTotal: metric.diskTotal,
          networkRx: metric.networkRx,
          networkTx: metric.networkTx,
          uptime: metric.uptime,
        });
        return {
          current: current ? mapMetric(current) : null,
          history: presentPage(history.items, history.total, request.query.page, request.query.limit, mapMetric),
        };
      },
    );
    scope.get(
      "/machines/:id/updates",
      { schema: { params: idParams, querystring: paginationQuerySchema, response: withErrors(pageSchema(updateSchema)) } },
      async (request) => {
        const machine = await deps.store.findMachine(request.params.id);
        if (!machine) {
          throw new AppError(404, ERROR_CODES.NOT_FOUND, "machine introuvable");
        }
        const page = await deps.store.listSnapshots(machine.id, request.query);
        return presentPage(page.items, page.total, request.query.page, request.query.limit, (snapshot) => ({
          ...snapshot,
          createdAt: snapshot.createdAt.toISOString(),
        }));
      },
    );
    scope.get("/machines/:id/jobs", { schema: { params: idParams, querystring: jobQuery, response: withErrors(pageSchema(jobResponseSchema)) } }, async (request) => {
      const machine = await deps.store.findMachine(request.params.id);
      if (!machine) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "machine introuvable");
      }
      const page = await jobs.list({
        page: request.query.page,
        limit: request.query.limit,
        machineId: machine.id,
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.parentId ? { parentId: request.query.parentId } : {}),
      });
      return presentPage(page.items, page.total, request.query.page, request.query.limit, presentJob);
    });
    scope.get("/jobs", { schema: { querystring: jobQuery, response: withErrors(pageSchema(jobResponseSchema)) } }, async (request) => {
      const page = await jobs.list({
        page: request.query.page,
        limit: request.query.limit,
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.machineId ? { machineId: request.query.machineId } : {}),
        ...(request.query.parentId ? { parentId: request.query.parentId } : {}),
      });
      return presentPage(page.items, page.total, request.query.page, request.query.limit, presentJob);
    });
    scope.get("/jobs/:id", { schema: { params: idParams, response: withErrors(jobResponseSchema) } }, async (request) => {
      const job = await jobs.get(request.params.id);
      if (!job) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "job introuvable");
      }
      return presentJob(job);
    });
    scope.get("/jobs/:id/logs", { schema: { params: idParams, querystring: paginationQuerySchema, response: withErrors(pageSchema(logResponseSchema)) } }, async (request) => {
      const job = await jobs.get(request.params.id);
      if (!job) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "job introuvable");
      }
      const page = await jobs.logs(job.id, request.query.page, request.query.limit);
      return presentPage(page.items, page.total, request.query.page, request.query.limit, presentLog);
    });
    scope.post("/actions", { schema: { body: actionRequestSchema, response: withErrors(jobResponseSchema) } }, async (request) => {
      const principal = principalOf(request.principal);
      const job = await jobs.create(principal, request.body, now());
      return presentJob(job);
    });
    scope.post("/jobs/:id/cancel", { schema: { params: idParams, response: withErrors(jobResponseSchema) } }, async (request) => {
      return presentJob(await jobs.cancel(principalOf(request.principal), request.params.id, now()));
    });
    scope.post("/jobs/:id/acknowledge", { schema: { params: idParams, response: withErrors(jobResponseSchema) } }, async (request) => {
      return presentJob(await jobs.acknowledge(principalOf(request.principal), request.params.id, now()));
    });
    scope.get("/alerts", { schema: { querystring: alertQuery, response: withErrors(pageSchema(alertSchema)) } }, async (request) => {
      const page = await deps.store.listAlerts({
        page: request.query.page,
        limit: request.query.limit,
        openOnly: request.query.openOnly !== "false",
      });
      return presentPage(page.items, page.total, request.query.page, request.query.limit, (alert) => ({
        id: alert.id,
        dedupeKey: alert.dedupeKey,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        machineId: alert.machineId,
        agentId: alert.agentId,
        clusterId: alert.clusterId,
        resolvedAt: iso(alert.resolvedAt),
        createdAt: alert.createdAt.toISOString(),
      }));
    });
  }, { prefix: "/api/v1" });

  app.register(async (raw) => {
    const scope = raw.withTypeProvider<ZodTypeProvider>();
    scope.addHook("preHandler", agentAuth);
    scope.post("/heartbeat", { schema: { body: heartbeatBodySchema, response: withErrors(z.object({ status: z.literal("ok") }).strict()) } }, async (request) => {
      await inventory.heartbeat(requireAgentId(request), request.body, now());
      return { status: "ok" as const };
    });
    scope.post("/inventory", { schema: { body: inventoryBodySchema, response: withErrors(machineResponseSchema) } }, async (request) => {
      return presentMachine(await inventory.applyInventory(requireAgentId(request), request.body, now()));
    });
    scope.post("/resources", { schema: { body: resourcesBodySchema, response: withErrors(z.object({ status: z.literal("ok") }).strict()) } }, async (request) => {
      await inventory.ingestResources(requireAgentId(request), request.body, now());
      return { status: "ok" as const };
    });
    scope.get("/jobs/next", { schema: { response: { 200: agentJobSchema, 204: z.null(), 401: errorResponseSchema } } }, async (request, reply) => {
      const agentId = requireAgentId(request);
      const immediate = await jobs.claimNext(agentId, now());
      if (immediate) {
        return immediate;
      }
      const waiter = hub.wait(agentId, deps.config.security.longPollSeconds * 1000);
      const raced = await jobs.claimNext(agentId, now());
      if (raced) {
        waiter.cancel();
        return raced;
      }
      request.raw.once("close", () => waiter.cancel());
      const reason = await waiter.done;
      if (reason === "aborted" || reply.sent) {
        return reply;
      }
      const job = reason === "notified" ? await jobs.claimNext(agentId, now()) : null;
      if (!job) {
        return reply.code(204).send(null);
      }
      return job;
    });
    scope.post("/jobs/:id/start", { schema: { params: idParams, response: withErrors(jobStartResponseSchema) } }, async (request) => {
      return jobs.start(requireAgentId(request), request.params.id, now());
    });
    scope.post("/jobs/:id/logs", { schema: { params: idParams, body: jobLogsBodySchema, response: withErrors(z.object({ accepted: z.number().int() }).strict()) } }, async (request) => {
      await jobs.appendLogs(requireAgentId(request), request.params.id, request.body.entries);
      return { accepted: request.body.entries.length };
    });
    scope.post("/jobs/:id/complete", { schema: { params: idParams, body: jobCompleteBodySchema, response: withErrors(jobResponseSchema) } }, async (request) => {
      return presentJob(await jobs.complete(requireAgentId(request), request.params.id, request.body, now()));
    });
    scope.post("/jobs/:id/fail", { schema: { params: idParams, body: jobFailBodySchema, response: withErrors(jobResponseSchema) } }, async (request) => {
      return presentJob(await jobs.fail(requireAgentId(request), request.params.id, request.body, now()));
    });
  }, { prefix: "/api/v1/agent" });

  if (deps.startScheduler !== false) {
    scheduler.start();
    void scheduler.tick();
  }

  app.addHook("onClose", async () => {
    scheduler.stop();
  });

  return { app, jobs, inventory, scheduler, hub };
}

function principalOf(principal: Principal | null | undefined): Principal {
  if (!principal) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "jeton API requis");
  }
  return principal;
}
