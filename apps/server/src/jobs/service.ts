import { randomUUID } from "node:crypto";
import type { ActionRequest, AgentJob } from "@infra/schemas";
import { agentJobSchema, agentTargetSchema, aptCheckResultSchema } from "@infra/schemas";
import {
  ACTION_CATALOG,
  ERROR_CODES,
  canTransition,
  getAction,
  isInterruptErrorCode,
  isSkipErrorCode,
  isTerminalStatus,
  type ActionCategory,
  type JobStatus,
} from "@infra/types";
import type { JobRecord, MachineRecord } from "../database/records.js";
import type { Store } from "../database/store.js";
import { AppError } from "../errors.js";
import type { Mutex } from "../lock.js";
import { evaluateAdmission, type Limits } from "./admission.js";
import { chooseAgentHost } from "./hosts.js";
import { aggregateParentStatus, elapsedMs, parentCounts, parentOutcome } from "./parents.js";

export type Principal = { kind: "admin" | "reader" };

export type AgentJobView = AgentJob;

const UNRESOLVED = new Set<JobStatus>(["UNKNOWN", "INTERRUPTED", "REQUIRES_CONFIRMATION"]);

export class JobService {
  constructor(
    private readonly store: Store,
    private readonly lock: Mutex,
    private readonly limits: Limits,
    private dispatchLeaseMs: number,
    private readonly deadlineGraceMs: number,
  ) {}

  private readonly aptConcurrency = new Map<string, number>();

  setDispatchLeaseMs(ms: number): void {
    this.dispatchLeaseMs = ms;
  }

  setAgentApt(agentId: string, aptConcurrency: number): void {
    this.aptConcurrency.set(agentId, aptConcurrency);
  }

  preview(request: ActionRequest): Promise<{ machines: Array<{ id: string; displayName: string; type: string; blockers: Array<{ id: string; action: string; status: JobStatus; errorMessage: string | null; createdAt: string }> }> }> {
    return this.run(() => this.previewUnlocked(request));
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.lock.run(operation);
  }

  create(principal: Principal, request: ActionRequest, now: Date): Promise<JobRecord> {
    return this.run(() => this.createUnlocked(principal, request, now));
  }

  cancel(principal: Principal, jobId: string, now: Date): Promise<JobRecord> {
    return this.run(() => this.cancelUnlocked(principal, jobId, now));
  }

  acknowledge(principal: Principal, jobId: string, now: Date): Promise<JobRecord> {
    return this.run(() => this.acknowledgeUnlocked(principal, jobId, now));
  }

  start(agentId: string, jobId: string, now: Date): Promise<{ status: "RUNNING" | "CANCELLED" | "REJECTED"; execute: boolean }> {
    return this.run(() => this.startUnlocked(agentId, jobId, now));
  }

  complete(
    agentId: string,
    jobId: string,
    body: {
      exitCode: number | null;
      durationMs: number;
      resolvedExecutable: string | null;
      resolvedArguments: string[] | null;
      result?: Record<string, unknown>;
    },
    now: Date,
  ): Promise<JobRecord> {
    return this.run(() => this.completeUnlocked(agentId, jobId, body, now));
  }

  fail(
    agentId: string,
    jobId: string,
    body: {
      exitCode: number | null;
      durationMs: number;
      resolvedExecutable: string | null;
      resolvedArguments: string[] | null;
      errorCode: string;
      errorMessage: string;
      result?: Record<string, unknown>;
    },
    now: Date,
  ): Promise<JobRecord> {
    return this.run(() => this.failUnlocked(agentId, jobId, body, now));
  }

  appendLogs(
    agentId: string,
    jobId: string,
    entries: Array<{ stream: "stdout" | "stderr" | "system"; timestamp: string; data: string }>,
  ): Promise<void> {
    return this.run(() => this.appendLogsUnlocked(agentId, jobId, entries));
  }

  claimNext(agentId: string, now: Date): Promise<AgentJobView | null> {
    return this.run(() => this.claimUnlocked(agentId, now));
  }

  async list(query: {
    page: number;
    limit: number;
    status?: JobStatus;
    machineId?: string;
    parentId?: string;
    rootsOnly?: boolean;
  }) {
    return this.store.listJobs(query);
  }

  get(id: string): Promise<JobRecord | null> {
    return this.store.findJob(id);
  }

  logs(id: string, page: number, limit: number) {
    return this.store.listLogs(id, { page, limit });
  }

  async assignUnlocked(now: Date, notify: (agentId: string) => void): Promise<void> {
    const jobs = await this.store.listJobsByStatuses([
      "QUEUED",
      "ASSIGNED",
      "RUNNING",
      "UNKNOWN",
      "INTERRUPTED",
      "REQUIRES_CONFIRMATION",
      "SUCCESS",
      "FAILED",
      "SKIPPED",
      "CANCELLED",
    ]);
    const queued = jobs
      .filter((job) => job.executionKind === "LEAF" && job.status === "QUEUED")
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    for (const candidate of queued) {
      const current = await this.store.findJob(candidate.id);
      if (!current || current.status !== "QUEUED") {
        continue;
      }
      if (current.parentId) {
        const parent = await this.store.findJob(current.parentId);
        if (parent?.status === "CANCELLED") {
          await this.transition(current, "CANCELLED", { finishedAt: now }, now);
          continue;
        }
      }
      const actionName = current.action;
      if (!isCatalogAction(actionName)) {
        await this.transition(
          current,
          "FAILED",
          { finishedAt: now, errorCode: ERROR_CODES.ACTION_DISABLED, errorMessage: "action inconnue" },
          now,
        );
        continue;
      }
      const action = getAction(actionName);
      if (!current.machineId) {
        await this.transition(
          current,
          "FAILED",
          { finishedAt: now, errorCode: ERROR_CODES.TARGET_NOT_FOUND, errorMessage: "cible absente" },
          now,
        );
        continue;
      }
      const machine = await this.store.findMachine(current.machineId);
      if (!machine) {
        await this.transition(
          current,
          "SKIPPED",
          { finishedAt: now, errorCode: ERROR_CODES.TARGET_NOT_FOUND, errorMessage: "la machine n'existe plus" },
          now,
        );
        continue;
      }
      const world = await this.world();
      const admission = evaluateAdmission({
        action,
        machine,
        agents: world.agents,
        machines: world.machines,
        nodes: world.nodes,
        links: world.links,
        jobs,
        limits: this.limits,
      });
      if (admission.decision === "wait") {
        continue;
      }
      if (admission.decision === "skip" || admission.decision === "reject") {
        const status = admission.decision === "skip" ? "SKIPPED" : "FAILED";
        const updated = await this.transition(
          current,
          status,
          { finishedAt: now, errorCode: admission.code, errorMessage: admission.message },
          now,
        );
        if (updated) {
          replaceJob(jobs, updated);
          await this.system(updated.id, now, admission.message);
        }
        continue;
      }
      const updated = await this.transition(
        current,
        "ASSIGNED",
        { agentId: admission.agentId, assignedAt: now, dispatchedAt: null },
        now,
      );
      if (updated) {
        replaceJob(jobs, updated);
        notify(admission.agentId);
      }
    }
    await this.refreshOpenParents(now);
  }

  async recoverUnlocked(now: Date): Promise<void> {
    const jobs = await this.store.listJobsByStatuses(["ASSIGNED", "RUNNING"]);
    const agents = await this.store.listAgents();
    for (const job of jobs) {
      if (job.executionKind !== "LEAF") {
        continue;
      }
      const agent = agents.find((item) => item.id === job.agentId) ?? null;
      if (job.status === "ASSIGNED") {
        const leaseExpired =
          job.dispatchedAt !== null && now.getTime() - job.dispatchedAt.getTime() >= this.dispatchLeaseMs;
        if (leaseExpired) {
          await this.store.compareAndSetJob(job.id, "ASSIGNED", { dispatchedAt: null });
          continue;
        }
        if (job.dispatchedAt === null && agent?.presence !== "ONLINE") {
          await this.transition(job, "QUEUED", { agentId: null, assignedAt: null, dispatchedAt: null }, now);
        } else if (job.dispatchedAt && agent?.presence === "OFFLINE") {
          await this.transition(job, "QUEUED", { agentId: null, assignedAt: null, dispatchedAt: null }, now);
        }
        continue;
      }
      const action = isCatalogAction(job.action) ? getAction(job.action) : null;
      const deadline = (job.startedAt?.getTime() ?? job.createdAt.getTime()) + (action?.timeoutMs ?? 60_000) + this.deadlineGraceMs;
      if (agent?.presence === "OFFLINE") {
        await this.transition(
          job,
          "UNKNOWN",
          {
            finishedAt: now,
            errorCode: ERROR_CODES.AGENT_LOST,
            errorMessage: "l'agent a disparu pendant l'exécution ; le résultat n'est pas connu",
          },
          now,
        );
        await this.system(job.id, now, "passage en UNKNOWN : agent offline pendant l'exécution");
        continue;
      }
      if (now.getTime() > deadline) {
        await this.transition(
          job,
          "UNKNOWN",
          {
            finishedAt: now,
            errorCode: ERROR_CODES.JOB_DEADLINE_EXCEEDED,
            errorMessage: "délai dépassé sans résultat ; le job n'est pas relancé",
          },
          now,
        );
        await this.system(job.id, now, "passage en UNKNOWN : délai dépassé");
      }
    }
  }

  private async createUnlocked(principal: Principal, request: ActionRequest, now: Date): Promise<JobRecord> {
    const action = getAction(request.action);
    if (principal.kind === "reader" && action.category !== "READ") {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, "cette catégorie d'action exige un administrateur");
    }
    if (!action.enabled) {
      throw new AppError(422, ERROR_CODES.ACTION_DISABLED, `${action.name} n'est pas activée dans cette version`);
    }
    const selected = await this.selectMachines(request);
    const explicit = request.selector.type === "machine" || request.selector.type === "machines" || request.selector.type === "agents";
    const compatible = selected.filter((machine) => action.supportedTargets.includes(machine.type));
    if (explicit && compatible.length !== selected.length) {
      throw new AppError(422, ERROR_CODES.INCOMPATIBLE_TARGET, "une cible ne prend pas en charge cette action");
    }
    if (compatible.length === 0) {
      throw new AppError(422, ERROR_CODES.NO_TARGETS, "aucune cible compatible");
    }
    if (request.acknowledgeBlockers && action.mutating) {
      await this.acknowledgeBlockers(compatible.map((machine) => machine.id), now);
    }
    const links = await this.store.listLinks();
    const makeLeaf = async (machine: MachineRecord, parentId: string | null): Promise<JobRecord> => {
      const link = links.find((item) => item.machineId === machine.id) ?? null;
      const target = agentTargetSchema.parse({
        machineId: machine.id,
        machineType: machine.type,
        hostname: machine.hostname,
        ...(machine.type === "LXC" && link
          ? { guest: { vmid: link.vmid, guestType: link.guestType, clusterId: link.clusterId } }
          : {}),
        ...(request.parameters ? { parameters: request.parameters } : {}),
      });
      const job: JobRecord = {
        id: randomUUID(),
        parentId,
        action: action.name,
        category: action.category,
        executionKind: "LEAF",
        agentId: null,
        machineId: machine.id,
        targetType: "machine",
        targetData: target,
        status: "QUEUED",
        requestedBy: request.requestedBy ?? null,
        createdAt: now,
        assignedAt: null,
        dispatchedAt: null,
        startedAt: null,
        finishedAt: null,
        acknowledgedAt: null,
        resolvedExecutable: null,
        resolvedArguments: null,
        result: null,
        exitCode: null,
        durationMs: null,
        errorCode: null,
        errorMessage: null,
      };
      await this.store.insertJob(job);
      return job;
    };

    if (request.selector.type === "machine") {
      const only = compatible[0];
      if (!only) {
        throw new AppError(422, ERROR_CODES.NO_TARGETS, "aucune cible compatible");
      }
      return makeLeaf(only, null);
    }

    const parent: JobRecord = {
      id: randomUUID(),
      parentId: null,
      action: action.name,
      category: action.category,
      executionKind: "PARENT",
      agentId: null,
      machineId: null,
      targetType: "batch",
      targetData: { kind: "batch", selector: request.selector, childCount: compatible.length },
      status: "QUEUED",
      requestedBy: request.requestedBy ?? null,
      createdAt: now,
      assignedAt: null,
      dispatchedAt: null,
      startedAt: null,
      finishedAt: null,
      acknowledgedAt: null,
      resolvedExecutable: null,
      resolvedArguments: null,
      result: { counts: { QUEUED: compatible.length } },
      exitCode: null,
      durationMs: null,
      errorCode: null,
      errorMessage: null,
    };
    await this.store.insertJob(parent);
    for (const machine of compatible) {
      await makeLeaf(machine, parent.id);
    }
    return parent;
  }

  private async previewUnlocked(request: ActionRequest): Promise<{ machines: Array<{ id: string; displayName: string; type: string; blockers: Array<{ id: string; action: string; status: JobStatus; errorMessage: string | null; createdAt: string }> }> }> {
    const action = getAction(request.action);
    if (!action.enabled || !action.mutating) {
      return { machines: [] };
    }
    const selected = await this.selectMachines(request);
    const compatible = selected.filter((machine) => action.supportedTargets.includes(machine.type));
    const blockers = await this.blockingJobs(compatible.map((machine) => machine.id));
    const machines = compatible.flatMap((machine) => {
      const own = blockers.filter((job) => job.machineId === machine.id);
      if (own.length === 0) {
        return [];
      }
      return [{
        id: machine.id,
        displayName: machine.displayName,
        type: machine.type,
        blockers: own.map((job) => ({
          id: job.id,
          action: job.action,
          status: job.status,
          errorMessage: job.errorMessage,
          createdAt: job.createdAt.toISOString(),
        })),
      }];
    });
    return { machines };
  }

  private async acknowledgeBlockers(machineIds: string[], now: Date): Promise<void> {
    const blockers = await this.blockingJobs(machineIds);
    for (const blocker of blockers) {
      await this.store.compareAndSetJob(blocker.id, blocker.status, { acknowledgedAt: now });
    }
  }

  private async blockingJobs(machineIds: string[]): Promise<JobRecord[]> {
    const ids = new Set(machineIds);
    const jobs = await this.store.listJobsByStatuses(["UNKNOWN", "INTERRUPTED", "REQUIRES_CONFIRMATION"]);
    return jobs.filter((job) => {
      if (!job.machineId || !ids.has(job.machineId) || job.acknowledgedAt) {
        return false;
      }
      if (!isCatalogAction(job.action)) {
        return false;
      }
      const definition = getAction(job.action);
      return definition.mutating && definition.neverAutoRetry;
    });
  }

  private async machinesForAgents(ids: readonly string[]): Promise<MachineRecord[]> {
    const machines = await this.store.listAllMachines();
    const chosen: MachineRecord[] = [];
    for (const id of ids) {
      const agent = await this.store.findAgent(id);
      if (!agent) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "agent introuvable");
      }
      const host = chooseAgentHost(machines, id);
      if (!host) {
        throw new AppError(422, ERROR_CODES.NO_TARGETS, "cet agent n'a pas encore de machine hôte");
      }
      if (!chosen.some((item) => item.id === host.id)) {
        chosen.push(host);
      }
    }
    return chosen;
  }

  private async selectMachines(request: ActionRequest): Promise<MachineRecord[]> {
    const selector = request.selector;
    if (selector.type === "machine") {
      const machine = await this.store.findMachine(selector.id);
      if (!machine) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "machine introuvable");
      }
      return [machine];
    }
    if (selector.type === "machines") {
      const machines: MachineRecord[] = [];
      for (const id of selector.ids) {
        const machine = await this.store.findMachine(id);
        if (!machine) {
          throw new AppError(404, ERROR_CODES.NOT_FOUND, `machine introuvable : ${id}`);
        }
        machines.push(machine);
      }
      return machines;
    }
    if (selector.type === "agents") {
      return this.machinesForAgents(selector.ids);
    }
    if (selector.type === "fleet") {
      const machines = await this.store.listAllMachines();
      return machines.filter((machine) => machine.hiddenAt === null);
    }
    if (selector.type === "cluster") {
      const cluster = await this.store.findCluster(selector.id);
      if (!cluster) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, "cluster introuvable");
      }
      const [nodes, links, machines] = await Promise.all([
        this.store.listNodes(),
        this.store.listLinks(),
        this.store.listAllMachines(),
      ]);
      const ids = new Set(nodes.filter((node) => node.clusterId === cluster.id).map((node) => node.machineId));
      if (selector.includeGuests) {
        for (const link of links) {
          if (link.clusterId === cluster.id) {
            ids.add(link.machineId);
          }
        }
      }
      return machines.filter((machine) => ids.has(machine.id) && machine.hiddenAt === null);
    }
    const [nodes, links, machines] = await Promise.all([
      this.store.listNodes(),
      this.store.listLinks(),
      this.store.listAllMachines(),
    ]);
    const byIdentity = nodes.filter((item) => item.id === selector.id || item.machineId === selector.id);
    const matches = byIdentity.length > 0 ? byIdentity : nodes.filter((item) => item.name === selector.id);
    if (matches.length > 1) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "plusieurs nœuds portent ce nom ; précisez l'identifiant du nœud");
    }
    const node = matches[0];
    if (!node) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "nœud Proxmox introuvable");
    }
    const ids = new Set<string>([node.machineId]);
    if (selector.includeGuests) {
      for (const link of links) {
        if (link.currentNodeId === node.id) {
          ids.add(link.machineId);
        }
      }
    }
    return machines.filter((machine) => ids.has(machine.id) && machine.hiddenAt === null);
  }

  private async cancelUnlocked(principal: Principal, jobId: string, now: Date): Promise<JobRecord> {
    if (principal.kind !== "admin") {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, "annulation réservée à un administrateur");
    }
    const job = await this.requireJob(jobId);
    if (job.status === "RUNNING") {
      throw new AppError(409, ERROR_CODES.JOB_NOT_CANCELLABLE, "un job en cours ne peut pas être annulé à distance");
    }
    if (isTerminalStatus(job.status)) {
      throw new AppError(409, ERROR_CODES.JOB_NOT_CANCELLABLE, "le job est déjà terminé");
    }
    if (job.executionKind === "PARENT") {
      const children = await this.store.listChildren(job.id);
      for (const child of children) {
        if (child.status === "QUEUED" || child.status === "ASSIGNED") {
          await this.transition(child, "CANCELLED", { finishedAt: now }, now);
        }
      }
    }
    const updated = await this.transition(job, "CANCELLED", { finishedAt: now }, now);
    if (!updated) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "le job a changé d'état");
    }
    return updated;
  }

  private async acknowledgeUnlocked(principal: Principal, jobId: string, now: Date): Promise<JobRecord> {
    if (principal.kind !== "admin") {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, "acquittement réservé à un administrateur");
    }
    const job = await this.requireJob(jobId);
    if (!UNRESOLVED.has(job.status)) {
      throw new AppError(409, ERROR_CODES.JOB_NOT_ACKNOWLEDGEABLE, "cet état ne se acquitte pas");
    }
    const updated = await this.store.compareAndSetJob(job.id, job.status, { acknowledgedAt: now });
    if (!updated) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "le job a changé d'état");
    }
    await this.system(job.id, now, "acquitté par un opérateur ; aucune relance automatique");
    return updated;
  }

  private async startUnlocked(agentId: string, jobId: string, now: Date) {
    const job = await this.requireOwned(agentId, jobId);
    if (job.status === "RUNNING") {
      return { status: "RUNNING" as const, execute: false };
    }
    if (job.status === "CANCELLED") {
      return { status: "CANCELLED" as const, execute: false };
    }
    if (job.status !== "ASSIGNED") {
      return { status: "REJECTED" as const, execute: false };
    }
    const updated = await this.transition(job, "RUNNING", { startedAt: now }, now);
    if (!updated) {
      const again = await this.store.findJob(jobId);
      if (again?.status === "RUNNING") {
        return { status: "RUNNING" as const, execute: false };
      }
      return { status: "REJECTED" as const, execute: false };
    }
    return { status: "RUNNING" as const, execute: true };
  }

  private async completeUnlocked(
    agentId: string,
    jobId: string,
    body: {
      exitCode: number | null;
      durationMs: number;
      resolvedExecutable: string | null;
      resolvedArguments: string[] | null;
      result?: Record<string, unknown>;
    },
    now: Date,
  ): Promise<JobRecord> {
    const job = await this.requireOwned(agentId, jobId);
    if (job.status !== "RUNNING") {
      throw new AppError(409, ERROR_CODES.INVALID_STATE, "le job n'est pas en cours");
    }
    const updated = await this.transition(
      job,
      "SUCCESS",
      {
        finishedAt: now,
        exitCode: body.exitCode,
        durationMs: body.durationMs,
        resolvedExecutable: body.resolvedExecutable,
        resolvedArguments: body.resolvedArguments,
        result: body.result ?? null,
      },
      now,
    );
    if (!updated) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "le job a changé d'état");
    }
    await this.persistAptSnapshot(updated, body.result);
    return updated;
  }

  private async failUnlocked(
    agentId: string,
    jobId: string,
    body: {
      exitCode: number | null;
      durationMs: number;
      resolvedExecutable: string | null;
      resolvedArguments: string[] | null;
      errorCode: string;
      errorMessage: string;
      result?: Record<string, unknown>;
    },
    now: Date,
  ): Promise<JobRecord> {
    const job = await this.requireOwned(agentId, jobId);
    let status = statusFromAgentError(body.errorCode);
    if (!canTransition(job.status, status)) {
      status = "FAILED";
    }
    if (job.status !== "RUNNING" && job.status !== "ASSIGNED") {
      throw new AppError(409, ERROR_CODES.INVALID_STATE, "le job ne peut plus échouer");
    }
    const updated = await this.transition(
      job,
      status,
      {
        finishedAt: now,
        exitCode: body.exitCode,
        durationMs: body.durationMs,
        resolvedExecutable: body.resolvedExecutable,
        resolvedArguments: body.resolvedArguments,
        errorCode: body.errorCode,
        errorMessage: body.errorMessage,
        result: body.result ?? null,
      },
      now,
    );
    if (!updated) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "le job a changé d'état");
    }
    await this.persistAptSnapshot(updated, body.result);
    return updated;
  }

  private async appendLogsUnlocked(
    agentId: string,
    jobId: string,
    entries: Array<{ stream: "stdout" | "stderr" | "system"; timestamp: string; data: string }>,
  ): Promise<void> {
    const job = await this.requireOwned(agentId, jobId);
    if (isTerminalStatus(job.status)) {
      throw new AppError(409, ERROR_CODES.INVALID_STATE, "le job est terminé");
    }
    await this.store.appendLogs(
      job.id,
      entries.map((entry) => ({
        jobId: job.id,
        timestamp: new Date(entry.timestamp),
        stream: entry.stream === "stdout" ? "STDOUT" : entry.stream === "stderr" ? "STDERR" : "SYSTEM",
        data: entry.data,
      })),
    );
  }

  private async claimUnlocked(agentId: string, now: Date): Promise<AgentJobView | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const assigned = await this.store.listJobsByStatuses(["ASSIGNED"]);
      const next = assigned.find(
        (job) => job.agentId === agentId && job.dispatchedAt === null && job.executionKind === "LEAF",
      );
      if (!next) {
        return null;
      }
      const claimed = await this.store.compareAndSetJob(next.id, "ASSIGNED", { dispatchedAt: now });
      if (!claimed) {
        continue;
      }
      const parsed = agentJobSchema.safeParse({
        jobId: claimed.id,
        action: claimed.action,
        category: claimed.category,
        target: claimed.targetData,
      });
      if (!parsed.success) {
        await this.transition(
          claimed,
          "FAILED",
          {
            finishedAt: now,
            errorCode: ERROR_CODES.VALIDATION_ERROR,
            errorMessage: "le job assigné est invalide et n'a pas été exécuté",
          },
          now,
        );
        continue;
      }
      return parsed.data;
    }
    return null;
  }

  private async persistAptSnapshot(job: JobRecord, result: Record<string, unknown> | undefined): Promise<void> {
    if (!job.machineId || (job.action !== "apt.check" && job.action !== "apt.upgrade") || !result) {
      return;
    }
    const parsed = aptCheckResultSchema.safeParse({
      availableCount: result.availableCount,
      securityCount: result.securityCount,
      requiresReboot: result.requiresReboot,
      requiresConfirmation: result.requiresConfirmation,
      packages: result.packages,
    });
    if (!parsed.success) {
      return;
    }
    if (job.action === "apt.upgrade" && job.status === "SUCCESS" && parsed.data.availableCount > 0) {
      return;
    }
    await this.store.insertSnapshot({
      id: randomUUID(),
      machineId: job.machineId,
      jobId: job.id,
      createdAt: job.finishedAt ?? new Date(),
      availableCount: parsed.data.availableCount,
      securityCount: parsed.data.securityCount,
      requiresReboot: parsed.data.requiresReboot,
      requiresConfirmation: parsed.data.requiresConfirmation,
      packages: parsed.data.packages.map((pkg) => ({
        name: pkg.name,
        currentVersion: pkg.currentVersion,
        newVersion: pkg.newVersion,
        architecture: pkg.architecture,
        changeType: pkg.action,
        security: pkg.security,
      })),
    });
  }

  private async transition(
    job: JobRecord,
    status: JobStatus,
    patch: Parameters<Store["compareAndSetJob"]>[2],
    now: Date,
  ): Promise<JobRecord | null> {
    if (!canTransition(job.status, status)) {
      return null;
    }
    const updated = await this.store.compareAndSetJob(job.id, job.status, { ...patch, status });
    if (updated?.parentId) {
      await this.refreshParent(updated.parentId, now);
    }
    return updated;
  }

  private async refreshOpenParents(now: Date): Promise<void> {
    const jobs = await this.store.listJobsByStatuses(["QUEUED", "RUNNING"]);
    for (const job of jobs) {
      if (job.executionKind === "PARENT") {
        await this.refreshParent(job.id, now);
      }
    }
  }

  private async refreshParent(parentId: string, now: Date): Promise<void> {
    const parent = await this.store.findJob(parentId);
    if (!parent || parent.executionKind !== "PARENT" || parent.status === "CANCELLED") {
      return;
    }
    if (isTerminalStatus(parent.status) && parent.status !== "UNKNOWN" && parent.exitCode !== null && parent.durationMs !== null) {
      return;
    }
    const children = await this.store.listChildren(parent.id);
    const next = aggregateParentStatus(children.map((child) => child.status));
    const counts = parentCounts(children.map((child) => child.status));
    const outcome = parentOutcome(children);
    const terminal = isTerminalStatus(parent.status) && parent.status !== "UNKNOWN";
    if (terminal) {
      const started = parent.startedAt ?? earliestDate(children.map((child) => child.startedAt));
      await this.store.compareAndSetJob(parent.id, parent.status, {
        result: { counts },
        exitCode: parent.exitCode ?? outcome.exitCode,
        durationMs: parent.durationMs ?? elapsedMs(started, parent.finishedAt),
        agentId: parent.agentId ?? outcome.agentId,
      });
      return;
    }
    if (next === parent.status) {
      await this.store.compareAndSetJob(parent.id, parent.status, {
        result: { counts },
        agentId: outcome.agentId,
      });
      return;
    }
    const startedAt = next === "RUNNING" && !parent.startedAt ? now : parent.startedAt;
    const finishedAt = isTerminalStatus(next) ? now : null;
    await this.store.compareAndSetJob(parent.id, parent.status, {
      status: next,
      result: { counts },
      startedAt,
      finishedAt,
      ...(isTerminalStatus(next) ? { exitCode: outcome.exitCode, durationMs: elapsedMs(startedAt ?? earliestDate(children.map((child) => child.startedAt)) ?? now, now) } : {}),
      agentId: outcome.agentId,
    });
  }

  private async system(jobId: string, now: Date, message: string): Promise<void> {
    await this.store.appendLogs(jobId, [
      { jobId, timestamp: now, stream: "SYSTEM", data: message },
    ]);
  }

  private async requireJob(jobId: string): Promise<JobRecord> {
    const job = await this.store.findJob(jobId);
    if (!job) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "job introuvable");
    }
    return job;
  }

  private async requireOwned(agentId: string, jobId: string): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    if (job.agentId !== agentId) {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, "ce job n'appartient pas à cet agent");
    }
    return job;
  }

  private async world() {
    const [agents, machines, nodes, links] = await Promise.all([
      this.store.listAgents(),
      this.store.listAllMachines(),
      this.store.listNodes(),
      this.store.listLinks(),
    ]);
    return {
      agents: agents.map((agent) => {
        const aptConcurrency = this.aptConcurrency.get(agent.id);
        return aptConcurrency === undefined ? agent : { ...agent, aptConcurrency };
      }),
      machines,
      links,
      nodes: nodes.map((node) => ({
        ...node,
        machineStatus: machines.find((machine) => machine.id === node.machineId)?.status ?? "UNKNOWN",
      })),
    };
  }
}

function earliestDate(values: Array<Date | null>): Date | null {
  const dated = values.filter((value): value is Date => value instanceof Date);
  if (dated.length === 0) {
    return null;
  }
  return dated.reduce((earliest, value) => (value.getTime() < earliest.getTime() ? value : earliest));
}

function statusFromAgentError(code: string): JobStatus {
  if (isSkipErrorCode(code)) {
    return "SKIPPED";
  }
  if (isInterruptErrorCode(code)) {
    return "INTERRUPTED";
  }
  if (code === "REQUIRES_CONFIRMATION") {
    return "REQUIRES_CONFIRMATION";
  }
  return "FAILED";
}

function isCatalogAction(name: string): name is keyof typeof ACTION_CATALOG {
  return Object.prototype.hasOwnProperty.call(ACTION_CATALOG, name);
}

function replaceJob(jobs: JobRecord[], next: JobRecord): void {
  const index = jobs.findIndex((job) => job.id === next.id);
  if (index >= 0) {
    jobs[index] = next;
  } else {
    jobs.push(next);
  }
}

export function assertCategory(principal: Principal, category: ActionCategory): void {
  if (principal.kind === "reader" && category !== "READ") {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "cette catégorie d'action exige un administrateur");
  }
}
