import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const positiveInt = z.number().int().positive();
const positiveSeconds = z.number().int().min(1).max(86_400);

export const agentRuntimeSchema = z
  .object({
    server: z
      .object({
        protocol: z.enum(["http", "https"]).optional(),
        host: z.string().trim().min(1).max(255).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        requestTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
        longPollTimeoutMs: z.number().int().min(5_000).max(180_000).optional(),
      })
      .strict()
      .optional(),
    machine: z
      .object({
        type: z.enum(["VM", "PHYSICAL"]).optional(),
        displayName: z.string().trim().min(1).max(255).optional(),
      })
      .strict()
      .optional(),
    intervals: z
      .object({
        heartbeatSeconds: positiveSeconds.optional(),
        inventorySeconds: positiveSeconds.optional(),
        resourcesSeconds: positiveSeconds.optional(),
      })
      .strict()
      .optional(),
    concurrency: z
      .object({
        total: positiveInt.optional(),
        apt: positiveInt.optional(),
      })
      .strict()
      .optional(),
    metrics: z
      .object({
        source: z.enum(["PROXMOX", "LOCAL_AGENT"]).optional(),
      })
      .strict()
      .optional(),
    proxmox: z
      .object({
        enabled: z.boolean().optional(),
        clusterId: z.string().trim().min(1).max(128).optional(),
        vmid: z.number().int().min(1).max(999_999_999).optional(),
      })
      .strict()
      .optional(),
    logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
    version: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.concurrency?.apt !== undefined && value.concurrency.total !== undefined && value.concurrency.apt > value.concurrency.total) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "la concurrence APT dépasse le total", path: ["concurrency", "apt"] });
    }
    if (value.proxmox?.enabled && !value.proxmox.clusterId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "un nœud Proxmox exige un identifiant de cluster", path: ["proxmox", "clusterId"] });
    }
    if (value.metrics?.source === "PROXMOX" && (!value.proxmox?.clusterId || value.proxmox.vmid === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "les métriques Proxmox exigent un cluster et un VMID", path: ["metrics", "source"] });
    }
  });

export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;

export class AgentSettingsStore {
  private readonly values = new Map<string, AgentRuntime>();

  constructor(private readonly filePath: string | null) {
    if (!filePath || !existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      for (const [id, value] of Object.entries(parsed)) {
        const runtime = agentRuntimeSchema.safeParse(value);
        if (runtime.success) this.values.set(id, runtime.data);
      }
    } catch {
      // Un fichier illisible ne bloque pas le démarrage. Le prochain enregistrement le réécrit.
    }
  }

  get(agentId: string): AgentRuntime | null {
    return this.values.get(agentId) ?? null;
  }

  save(agentId: string, value: AgentRuntime): AgentRuntime {
    this.values.set(agentId, value);
    this.persist();
    return value;
  }

  remove(agentId: string): void {
    this.values.delete(agentId);
    this.persist();
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.values), null, 2));
  }
}
