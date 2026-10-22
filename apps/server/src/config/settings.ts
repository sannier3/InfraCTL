import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { formatConfigIssues, serverConfigSchema, type ServerConfig } from "@infra/schemas";
import { z } from "zod";

const positiveInt = z.number().int().positive();
const positiveSeconds = z.number().int().min(1).max(86_400);

export const settingsPatchSchema = z
  .object({
    server: z
      .object({
        bind: z.string().trim().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
        exposeSwagger: z.boolean().optional(),
        bodyLimitBytes: z.number().int().min(1024).max(5_000_000).optional(),
      })
      .strict()
      .optional(),
    security: z
      .object({
        hmacWindowSeconds: positiveSeconds.optional(),
        longPollSeconds: z.number().int().min(1).max(120).optional(),
        dispatchLeaseSeconds: positiveSeconds.optional(),
      })
      .strict()
      .optional(),
    agents: z
      .object({
        unreachableAfterSeconds: positiveSeconds.optional(),
        offlineAfterSeconds: positiveSeconds.optional(),
      })
      .strict()
      .optional(),
    inventory: z
      .object({
        hideStoppedAfterSeconds: positiveSeconds.optional(),
      })
      .strict()
      .optional(),
    metrics: z
      .object({
        retentionDays: z.number().int().min(1).max(3650).optional(),
      })
      .strict()
      .optional(),
    concurrency: z
      .object({
        global: positiveInt.optional(),
        perAgent: positiveInt.optional(),
        perProxmoxNode: positiveInt.optional(),
        aptPerProxmoxNode: positiveInt.optional(),
        perMachineWrite: positiveInt.optional(),
        proxmoxHostMaintenancePerCluster: positiveInt.optional(),
      })
      .strict()
      .optional(),
    scheduler: z
      .object({
        tickMs: z.number().int().min(200).max(60_000).optional(),
        noncePurgeEveryTicks: positiveInt.optional(),
        metricPurgeEveryTicks: positiveInt.optional(),
      })
      .strict()
      .optional(),
    ui: z
      .object({
        enabled: z.boolean().optional(),
        sessionHours: z.number().int().min(1).max(720).optional(),
        noCache: z.boolean().optional(),
      })
      .strict()
      .optional(),
    secrets: z
      .object({
        apiToken: z.string().min(16).max(512).optional(),
        readToken: z.string().min(16).max(512).nullable().optional(),
        databaseUrl: z.string().trim().min(1).optional(),
        uiPassword: z.string().min(12).max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export type PublicSettings = {
  server: ServerConfig["server"];
  security: Omit<ServerConfig["security"], "credentialsKey">;
  agents: ServerConfig["agents"];
  inventory: ServerConfig["inventory"];
  metrics: ServerConfig["metrics"];
  concurrency: ServerConfig["concurrency"];
  scheduler: ServerConfig["scheduler"];
  ui: { enabled: boolean; sessionHours: number; noCache: boolean };
  secrets: { apiToken: true; readToken: boolean; databaseUrl: true; uiPassword: boolean; credentialsKey: true };
  restart: string[];
};

export const RESTART_FIELDS = [
  "server.bind",
  "server.port",
  "server.logLevel",
  "server.exposeSwagger",
  "server.bodyLimitBytes",
  "database.url",
  "ui.enabled",
];

export function publicSettings(config: ServerConfig): PublicSettings {
  return {
    server: { ...config.server },
    security: {
      hmacWindowSeconds: config.security.hmacWindowSeconds,
      longPollSeconds: config.security.longPollSeconds,
      dispatchLeaseSeconds: config.security.dispatchLeaseSeconds,
    },
    agents: { ...config.agents },
    inventory: { ...config.inventory },
    metrics: { ...config.metrics },
    concurrency: { ...config.concurrency },
    scheduler: { ...config.scheduler },
    ui: {
      enabled: config.ui.enabled,
      sessionHours: config.ui.sessionHours,
      noCache: config.ui.noCache,
    },
    secrets: {
      apiToken: true,
      readToken: Boolean(config.auth.readToken),
      databaseUrl: true,
      uiPassword: Boolean(config.ui.password),
      credentialsKey: true,
    },
    restart: RESTART_FIELDS,
  };
}

export function applySettingsPatch(config: ServerConfig, patch: SettingsPatch): ServerConfig {
  const next = structuredClone(config);
  assignDefined(next.server, patch.server);
  assignDefined(next.security, patch.security);
  assignDefined(next.agents, patch.agents);
  assignDefined(next.inventory, patch.inventory);
  assignDefined(next.metrics, patch.metrics);
  assignDefined(next.concurrency, patch.concurrency);
  assignDefined(next.scheduler, patch.scheduler);
  assignDefined(next.ui, patch.ui);
  if (patch.secrets?.apiToken) next.auth.apiToken = patch.secrets.apiToken;
  if (patch.secrets?.readToken === null) delete next.auth.readToken;
  else if (patch.secrets?.readToken) next.auth.readToken = patch.secrets.readToken;
  if (patch.secrets?.databaseUrl) next.database.url = patch.secrets.databaseUrl;
  if (patch.secrets?.uiPassword) next.ui.password = patch.secrets.uiPassword;
  const parsed = serverConfigSchema.safeParse(next);
  if (!parsed.success) {
    throw new Error(formatConfigIssues(parsed.error));
  }
  return parsed.data;
}

export function copySettings(target: ServerConfig, next: ServerConfig): void {
  Object.assign(target.server, next.server);
  target.database.url = next.database.url;
  target.auth.apiToken = next.auth.apiToken;
  if (next.auth.readToken) target.auth.readToken = next.auth.readToken;
  else delete target.auth.readToken;
  Object.assign(target.security, { ...next.security, credentialsKey: target.security.credentialsKey });
  Object.assign(target.agents, next.agents);
  Object.assign(target.inventory, next.inventory);
  Object.assign(target.metrics, next.metrics);
  Object.assign(target.concurrency, next.concurrency);
  Object.assign(target.scheduler, next.scheduler);
  target.ui.enabled = next.ui.enabled;
  target.ui.password = next.ui.password;
  target.ui.sessionHours = next.ui.sessionHours;
  target.ui.noCache = next.ui.noCache;
}

export function writeServerConfig(filePath: string, config: ServerConfig): void {
  const doc = parseDocument(readFileSync(filePath, "utf8"));
  const set = (path: string[], value: unknown): void => {
    doc.setIn(path, value);
  };
  set(["server", "bind"], config.server.bind);
  set(["server", "port"], config.server.port);
  set(["server", "logLevel"], config.server.logLevel);
  set(["server", "exposeSwagger"], config.server.exposeSwagger);
  set(["server", "bodyLimitBytes"], config.server.bodyLimitBytes);
  set(["database", "url"], config.database.url);
  set(["auth", "apiToken"], config.auth.apiToken);
  if (config.auth.readToken) set(["auth", "readToken"], config.auth.readToken);
  else doc.deleteIn(["auth", "readToken"]);
  set(["security", "hmacWindowSeconds"], config.security.hmacWindowSeconds);
  set(["security", "longPollSeconds"], config.security.longPollSeconds);
  set(["security", "dispatchLeaseSeconds"], config.security.dispatchLeaseSeconds);
  set(["agents", "unreachableAfterSeconds"], config.agents.unreachableAfterSeconds);
  set(["agents", "offlineAfterSeconds"], config.agents.offlineAfterSeconds);
  set(["inventory", "hideStoppedAfterSeconds"], config.inventory.hideStoppedAfterSeconds);
  set(["metrics", "retentionDays"], config.metrics.retentionDays);
  set(["concurrency", "global"], config.concurrency.global);
  set(["concurrency", "perAgent"], config.concurrency.perAgent);
  set(["concurrency", "perProxmoxNode"], config.concurrency.perProxmoxNode);
  set(["concurrency", "aptPerProxmoxNode"], config.concurrency.aptPerProxmoxNode);
  set(["concurrency", "perMachineWrite"], config.concurrency.perMachineWrite);
  set(["concurrency", "proxmoxHostMaintenancePerCluster"], config.concurrency.proxmoxHostMaintenancePerCluster);
  set(["scheduler", "tickMs"], config.scheduler.tickMs);
  set(["scheduler", "noncePurgeEveryTicks"], config.scheduler.noncePurgeEveryTicks);
  set(["scheduler", "metricPurgeEveryTicks"], config.scheduler.metricPurgeEveryTicks);
  set(["ui", "enabled"], config.ui.enabled);
  if (config.ui.password) set(["ui", "password"], config.ui.password);
  set(["ui", "sessionHours"], config.ui.sessionHours);
  set(["ui", "noCache"], config.ui.noCache);
  writeFileSync(filePath, String(doc));
}

function assignDefined<T extends object>(target: T, patch: Partial<T> | undefined): void {
  if (!patch) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (target as Record<string, unknown>)[key] = value;
    }
  }
}
