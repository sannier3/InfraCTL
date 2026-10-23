import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
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
  agentCreateBodySchema,
  agentJobSchema,
  agentSecretBodySchema,
  agentUpdateBodySchema,
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
import { AgentAdmin } from "../agents/admin.js";
import { createSessionService } from "../ui/session.js";
import { registerUi, uiDirectory } from "../ui/routes.js";
import { decodeCredentialsKey } from "../crypto/secrets.js";
import { AgentSettingsStore, agentRuntimeSchema } from "../config/agent-settings.js";
import { applySettingsPatch, copySettings, publicSettings, settingsPatchSchema, writeServerConfig } from "../config/settings.js";
import { formatConfigIssues } from "@infra/schemas";
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
import { presentAgent, presentJob, presentLog, presentMachine, presentPage, proxmoxIdentity, iso } from "./present.js";

export type AppDeps = {
  config: ServerConfig;
  store: Store;
  now?: () => Date;
  startScheduler?: boolean;
  credentialsKey?: Buffer;
  configPath?: string;
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

const fleetPackageMachineSchema = z
  .object({
    id: z.string().uuid(),
    currentVersion: z.string().nullable(),
    newVersion: z.string().nullable(),
    changeType: z.string(),
    security: z.boolean(),
  })
  .strict();

const installedPackageSchema = z
  .object({
    name: z.string(),
    machineCount: z.number().int(),
    versions: z.array(z.string()),
    machines: z.array(z.object({ id: z.string().min(1), version: z.string() }).strict()),
  })
  .strict();

const fleetPackageSchema = z
  .object({
    name: z.string(),
    machineCount: z.number().int(),
    newVersions: z.array(z.string()),
    changeTypes: z.array(z.string()),
    security: z.boolean(),
    machines: z.array(fleetPackageMachineSchema),
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
  const agents = new AgentAdmin(deps.store, key);
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
          "req.headers.cookie",
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
  const uiState = {
    password: deps.config.ui.password ?? "",
    noCache: deps.config.ui.noCache,
    sessionTtlMs: deps.config.ui.sessionHours * 3_600_000,
  };
  app.addHook("onSend", async (_request, reply, payload) => {
    if (!uiState.noCache) return payload;
    void reply.header("cache-control", "no-cache, no-store, must-revalidate");
    void reply.header("pragma", "no-cache");
    return payload;
  });
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
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    const raw = typeof body === "string" ? body : "";
    const params = new URLSearchParams(raw);
    const value: Record<string, string> = {};
    for (const [keyName, item] of params) {
      value[keyName] = item;
    }
    done(null, value);
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

  const session =
    deps.config.ui.enabled && deps.config.ui.password
      ? createSessionService(key, uiState)
      : undefined;
  const authState: { admin: string; reader?: string; session?: NonNullable<typeof session>; now: () => Date } = {
    admin: deps.config.auth.apiToken,
    ...(deps.config.auth.readToken ? { reader: deps.config.auth.readToken } : {}),
    ...(session ? { session } : {}),
    now,
  };
  const apiAuth = createApiAuth(authState);
  const agentAuthDeps = {
    store: deps.store,
    key,
    windowMs: deps.config.security.hmacWindowSeconds * 1000,
    now,
  };
  const agentAuth = createAgentAuth(agentAuthDeps);
  const agentSettings = new AgentSettingsStore(deps.configPath ? join(dirname(deps.configPath), "agent-settings.json") : null);

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
    scope.post("/agents", { schema: { body: agentCreateBodySchema, response: withErrors(agentResponseSchema) } }, async (request) => {
      requireAdmin(request.principal);
      return presentAgent(await agents.register(request.body, now()));
    });
    scope.patch("/agents/:id", { schema: { params: idParams, body: agentUpdateBodySchema, response: withErrors(agentResponseSchema) } }, async (request) => {
      requireAdmin(request.principal);
      return presentAgent(await agents.update(request.params.id, request.body));
    });
    scope.post("/agents/:id/secret", { schema: { params: idParams, body: agentSecretBodySchema, response: withErrors(agentResponseSchema) } }, async (request) => {
      requireAdmin(request.principal);
      return presentAgent(await agents.rotateSecret(request.params.id, request.body));
    });
    scope.delete("/agents/:id", { schema: { params: idParams, response: { 204: z.null(), 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema } } }, async (request, reply) => {
      requireAdmin(request.principal);
      await agents.remove(request.params.id);
      agentSettings.remove(request.params.id);
      return reply.code(204).send(null);
    });
    scope.get("/settings", { schema: { response: { 200: z.any(), 401: errorResponseSchema, 403: errorResponseSchema } } }, async (request) => {
      requireAdmin(request.principal);
      return publicSettings(deps.config);
    });
    scope.put("/settings", { schema: { body: settingsPatchSchema, response: { 200: z.any(), 401: errorResponseSchema, 403: errorResponseSchema, 422: errorResponseSchema } } }, async (request) => {
      requireAdmin(request.principal);
      let next;
      try {
        next = applySettingsPatch(deps.config, request.body);
      } catch (error) {
        throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, error instanceof Error ? error.message : "configuration invalide");
      }
      if (deps.configPath) writeServerConfig(deps.configPath, next);
      copySettings(deps.config, next);
      authState.admin = deps.config.auth.apiToken;
      authState.reader = deps.config.auth.readToken;
      agentAuthDeps.windowMs = deps.config.security.hmacWindowSeconds * 1000;
      uiState.password = deps.config.ui.password ?? "";
      uiState.noCache = deps.config.ui.noCache;
      uiState.sessionTtlMs = deps.config.ui.sessionHours * 3_600_000;
      jobs.setDispatchLeaseMs(deps.config.security.dispatchLeaseSeconds * 1000);
      inventory.setThresholds({
        unreachableAfterSeconds: deps.config.agents.unreachableAfterSeconds,
        offlineAfterSeconds: deps.config.agents.offlineAfterSeconds,
        hideStoppedAfterSeconds: deps.config.inventory.hideStoppedAfterSeconds,
      });
      scheduler.apply({
        tickMs: deps.config.scheduler.tickMs,
        noncePurgeEveryTicks: deps.config.scheduler.noncePurgeEveryTicks,
        metricPurgeEveryTicks: deps.config.scheduler.metricPurgeEveryTicks,
        retentionDays: deps.config.metrics.retentionDays,
      });
      const restartRequired = Boolean(
        request.body.server || request.body.secrets?.databaseUrl || request.body.ui?.enabled !== undefined,
      );
      return { settings: publicSettings(deps.config), restartRequired };
    });
    scope.get("/agents/:id/runtime", { schema: { params: idParams, response: { 200: z.any(), 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema } } }, async (request) => {
      requireAdmin(request.principal);
      const agent = await deps.store.findAgent(request.params.id);
      if (!agent) throw new AppError(404, ERROR_CODES.NOT_FOUND, "agent introuvable");
      return { settings: agentSettings.get(agent.id) };
    });
    scope.put("/agents/:id/runtime", { schema: { params: idParams, body: agentRuntimeSchema, response: { 200: z.any(), 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 422: errorResponseSchema } } }, async (request) => {
      requireAdmin(request.principal);
      const agent = await deps.store.findAgent(request.params.id);
      if (!agent) throw new AppError(404, ERROR_CODES.NOT_FOUND, "agent introuvable");
      const parsed = agentRuntimeSchema.safeParse(request.body);
      if (!parsed.success) throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, formatConfigIssues(parsed.error));
      return { settings: agentSettings.save(agent.id, parsed.data) };
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
    const proxmoxCatalog = async () => {
      const [links, nodes] = await Promise.all([deps.store.listLinks(), deps.store.listNodes()]);
      return { links, nodes };
    };
    scope.get("/updates", { schema: { response: withErrors(z.object({ data: z.array(fleetPackageSchema) }).strict()) } }, async () => {
      return { data: aggregatePackages(await deps.store.latestPackageHits()) };
    });
    scope.get("/packages", { schema: { response: withErrors(z.object({ data: z.array(installedPackageSchema) }).strict()) } }, async () => {
      return { data: aggregateInstalled(await deps.store.latestInstalledResults()) };
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
      const [index, updates] = await Promise.all([
        proxmoxCatalog(),
        deps.store.latestUpdateCounts(page.items.map((machine) => machine.id)),
      ]);
      const byMachine = new Map(updates.map((item) => [item.machineId, item]));
      return presentPage(page.items, page.total, request.query.page, request.query.limit, (machine) =>
        presentMachine(machine, proxmoxIdentity(machine.id, index.links, index.nodes), byMachine.get(machine.id) ?? null),
      );
    });
    scope.get("/machines/:id", { schema: { params: idParams, response: withErrors(machineResponseSchema) } }, async (request) => {
      const machine = await deps.store.findMachine(request.params.id);
      if (!machine) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "machine introuvable");
      }
      const [index, updates] = await Promise.all([
        proxmoxCatalog(),
        deps.store.latestUpdateCounts([machine.id]),
      ]);
      return presentMachine(machine, proxmoxIdentity(machine.id, index.links, index.nodes), updates[0] ?? null);
    });
    scope.post("/machines/:id/proxmox-link", {
      schema: {
        params: idParams,
        body: z.object({ nodeId: z.string().trim().min(1).max(128), vmid: z.number().int().min(1).max(999_999_999) }).strict(),
        response: withErrors(machineResponseSchema),
      },
    }, async (request) => {
      requireAdmin(request.principal);
      const machine = await inventory.linkVm(request.params.id, request.body.nodeId, request.body.vmid, now());
      const [index, updates] = await Promise.all([
        proxmoxCatalog(),
        deps.store.latestUpdateCounts([machine.id]),
      ]);
      return presentMachine(machine, proxmoxIdentity(machine.id, index.links, index.nodes), updates[0] ?? null);
    });
    scope.delete("/machines/:id/proxmox-link", { schema: { params: idParams, response: withErrors(machineResponseSchema) } }, async (request) => {
      requireAdmin(request.principal);
      const machine = await inventory.unlinkVm(request.params.id, now());
      const [index, updates] = await Promise.all([
        proxmoxCatalog(),
        deps.store.latestUpdateCounts([machine.id]),
      ]);
      return presentMachine(machine, proxmoxIdentity(machine.id, index.links, index.nodes), updates[0] ?? null);
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
        ...(request.query.parentId ? { parentId: request.query.parentId } : { rootsOnly: true }),
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
    scope.post("/actions/preview", { schema: { body: actionRequestSchema, response: { 200: z.any(), 401: errorResponseSchema, 422: errorResponseSchema } } }, async (request) => {
      return jobs.preview(request.body);
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
    scope.post("/heartbeat", { schema: { body: heartbeatBodySchema, response: withErrors(z.object({ status: z.literal("ok"), settings: agentRuntimeSchema.optional() }).strict()) } }, async (request) => {
      const agentId = requireAgentId(request);
      await inventory.heartbeat(agentId, request.body, now());
      if (request.body.aptConcurrency !== undefined) {
        jobs.setAgentApt(agentId, request.body.aptConcurrency);
      }
      const settings = agentSettings.get(agentId);
      return settings ? { status: "ok" as const, settings } : { status: "ok" as const };
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

  if (session && deps.config.ui.password) {
    registerUi(app, {
      ui: uiState,
      session,
      now,
      directory: uiDirectory(),
    });
  }

  app.addHook("onClose", async () => {
    scheduler.stop();
  });

  return { app, jobs, inventory, scheduler, hub };
}

function aggregateInstalled(results: Array<{ machineId: string; result: unknown }>) {
  const groups = new Map<string, { versions: Set<string>; machines: Map<string, string> }>();
  for (const row of results) {
    const packages = readInstalledPackages(row.result);
    for (const pkg of packages) {
      const group = groups.get(pkg.name) ?? { versions: new Set<string>(), machines: new Map<string, string>() };
      group.versions.add(pkg.version);
      group.machines.set(row.machineId, pkg.version);
      groups.set(pkg.name, group);
    }
  }
  return [...groups.entries()]
    .map(([name, group]) => ({
      name,
      machineCount: group.machines.size,
      versions: [...group.versions].sort((left, right) => left.localeCompare(right, "fr", { numeric: true })),
      machines: [...group.machines.entries()].map(([id, version]) => ({ id, version })),
    }))
    .sort((left, right) => right.machineCount - left.machineCount || left.name.localeCompare(right.name, "fr"));
}

function readInstalledPackages(result: unknown): Array<{ name: string; version: string }> {
  if (!result || typeof result !== "object" || !("packages" in result)) {
    return [];
  }
  const packages = (result as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) {
    return [];
  }
  const parsed: Array<{ name: string; version: string }> = [];
  for (const item of packages) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const name = "name" in item && typeof item.name === "string" ? item.name : "";
    const version = "version" in item && typeof item.version === "string" ? item.version : "";
    if (name.length > 0 && version.length > 0) {
      parsed.push({ name, version });
    }
  }
  return parsed;
}

function aggregatePackages(hits: Array<{ machineId: string; name: string; currentVersion: string | null; newVersion: string | null; changeType: string; security: boolean }>) {
  const groups = new Map<string, { machines: Map<string, { id: string; currentVersion: string | null; newVersion: string | null; changeType: string; security: boolean }>; versions: Set<string>; changes: Set<string>; security: boolean }>();
  for (const hit of hits) {
    const group = groups.get(hit.name) ?? { machines: new Map(), versions: new Set<string>(), changes: new Set<string>(), security: false };
    if (!group.machines.has(hit.machineId)) {
      group.machines.set(hit.machineId, {
        id: hit.machineId,
        currentVersion: hit.currentVersion,
        newVersion: hit.newVersion,
        changeType: hit.changeType,
        security: hit.security,
      });
    }
    if (hit.newVersion) group.versions.add(hit.newVersion);
    if (hit.changeType) group.changes.add(hit.changeType);
    if (hit.security) group.security = true;
    groups.set(hit.name, group);
  }
  return [...groups.entries()]
    .map(([name, group]) => ({
      name,
      machineCount: group.machines.size,
      newVersions: [...group.versions].sort((left, right) => left.localeCompare(right, "fr")),
      changeTypes: [...group.changes].sort((left, right) => left.localeCompare(right, "fr")),
      security: group.security,
      machines: [...group.machines.values()],
    }))
    .sort((left, right) => right.machineCount - left.machineCount || left.name.localeCompare(right.name, "fr"));
}

function principalOf(principal: Principal | null | undefined): Principal {
  if (!principal) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "jeton API requis");
  }
  return principal;
}

function requireAdmin(principal: Principal | null | undefined): void {
  const resolved = principalOf(principal);
  if (resolved.kind !== "admin") {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "gestion des agents réservée à un administrateur");
  }
}
