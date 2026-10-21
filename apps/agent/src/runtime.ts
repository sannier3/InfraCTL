import { getAction } from "@infra/types";
import type { AgentConfig, InventoryBody, ResourcesBody } from "@infra/schemas";
import { backoffDelayMs } from "@infra/utils";
import { runRegisteredAction } from "./actions/registry.js";
import { cpuUsageFromSamples, type CpuSample, type SystemProbe } from "./adapters/local-linux/probe.js";
import type { ProcessRunner } from "./process/types.js";
import type { ServerClient } from "./transport/client.js";
import { LogShipper } from "./transport/log-shipper.js";
import type { Logger } from "@infra/utils";

export async function runAgent(input: {
  config: AgentConfig;
  client: ServerClient;
  runner: ProcessRunner;
  probe: SystemProbe;
  logger: Logger;
  signal: AbortSignal;
}): Promise<void> {
  if (input.config.agent.type !== "linux-node") {
    throw new Error("Cette version implémente uniquement linux-node. Le mode proxmox-node n'exécute encore aucune commande.");
  }
  const state = { running: 0, apt: 0, cpu: null as CpuSample | null };
  await untilOnline(input, state);
  await sendInventory(input);
  const loops = [
    loop(input.config.intervals.heartbeatSeconds * 1000, input.signal, () =>
      input.client.heartbeat(heartbeatPayload(input.config, state)),
    ),
    loop(input.config.intervals.inventorySeconds * 1000, input.signal, () => sendInventory(input)),
    loop(input.config.intervals.resourcesSeconds * 1000, input.signal, async () => {
      if (input.config.metrics.source !== "LOCAL_AGENT") {
        return;
      }
      const body = await collectResources(input.probe, state);
      await input.client.resources(body);
    }),
    jobLoop(input, state),
  ];
  await Promise.all(loops);
}

async function untilOnline(
  input: { config: AgentConfig; client: ServerClient; logger: Logger; signal: AbortSignal },
  state: { running: number },
): Promise<void> {
  let attempt = 0;
  while (!input.signal.aborted) {
    try {
      await input.client.heartbeat(heartbeatPayload(input.config, state));
      return;
    } catch {
      input.logger.warn({ attempt }, "serveur injoignable");
      await sleep(backoffDelayMs(attempt), input.signal);
      attempt += 1;
    }
  }
}

async function sendInventory(input: { config: AgentConfig; client: ServerClient; probe: SystemProbe }): Promise<void> {
  const info = await input.probe.inspect();
  const body: InventoryBody = {
    hostname: info.hostname,
    ...(input.config.machine.displayName ? { displayName: input.config.machine.displayName } : {}),
    machineType: input.config.machine.type,
    metricsSource: input.config.metrics.source,
    status: "RUNNING",
    os: {
      ...(info.os.id ? { id: info.os.id } : {}),
      ...(info.os.name ? { name: info.os.name } : {}),
      ...(info.os.version ? { version: info.os.version } : {}),
      ...(info.os.prettyName ? { prettyName: info.os.prettyName } : {}),
      kernel: info.kernel,
      arch: info.arch,
    },
    ...(input.config.proxmox.clusterId && input.config.proxmox.vmid
      ? { proxmox: { clusterId: input.config.proxmox.clusterId, vmid: input.config.proxmox.vmid } }
      : {}),
  };
  await input.client.inventory(body);
}

async function collectResources(
  probe: SystemProbe,
  state: { cpu: CpuSample | null },
): Promise<ResourcesBody> {
  const [info, cpu, network, disk] = await Promise.all([
    probe.inspect(),
    probe.readCpu(),
    probe.readNetwork(),
    probe.readDisk(),
  ]);
  const cpuUsage = cpuUsageFromSamples(state.cpu, cpu);
  state.cpu = cpu;
  return {
    timestamp: new Date().toISOString(),
    cpuUsage,
    memoryUsed: Math.max(0, info.memory.totalBytes - info.memory.freeBytes),
    memoryTotal: info.memory.totalBytes,
    diskUsed: disk?.used ?? null,
    diskTotal: disk?.total ?? null,
    networkRx: network?.rx ?? null,
    networkTx: network?.tx ?? null,
    uptime: info.uptimeSeconds,
  };
}

async function jobLoop(
  input: {
    config: AgentConfig;
    client: ServerClient;
    runner: ProcessRunner;
    probe: SystemProbe;
    logger: Logger;
    signal: AbortSignal;
  },
  state: { running: number; apt: number },
): Promise<void> {
  let attempt = 0;
  while (!input.signal.aborted) {
    if (state.running >= input.config.concurrency.total) {
      await sleep(200, input.signal);
      continue;
    }
    try {
      const job = await input.client.nextJob();
      attempt = 0;
      if (!job) {
        continue;
      }
      state.running += 1;
      void executeJob(input, state, job)
        .catch((error: unknown) => {
          input.logger.error({ jobId: job.jobId, name: error instanceof Error ? error.name : "Error" }, "job interrompu");
        })
        .finally(() => {
          state.running -= 1;
        });
    } catch {
      await sleep(backoffDelayMs(attempt), input.signal);
      attempt += 1;
    }
  }
}

async function executeJob(
  input: {
    config: AgentConfig;
    client: ServerClient;
    runner: ProcessRunner;
    probe: SystemProbe;
    logger: Logger;
    signal: AbortSignal;
  },
  state: { apt: number },
  job: Awaited<ReturnType<ServerClient["nextJob"]>> & object,
): Promise<void> {
  if (!job) {
    return;
  }
  const definition = getAction(job.action);
  let aptHeld = false;
  if (definition.countsAsApt) {
    while (state.apt >= input.config.concurrency.apt && !input.signal.aborted) {
      await sleep(200, input.signal);
    }
    state.apt += 1;
    aptHeld = true;
  }
  const started = Date.now();
  const shipper = new LogShipper(input.client, job.jobId);
  try {
    const start = await startWithRetry(input.client, job.jobId, input.signal);
    if (!start.execute) {
      return;
    }
    const outcome = await runRegisteredAction({
      job,
      runner: input.runner,
      probe: input.probe,
      config: input.config,
      signal: input.signal,
      log: (stream, data) => shipper.push(stream, data),
    });
    await shipper.flush();
    const durationMs = Date.now() - started;
    if (outcome.status === "SUCCESS") {
      await input.client.complete(job.jobId, {
        exitCode: outcome.exitCode,
        durationMs,
        resolvedExecutable: outcome.executable,
        resolvedArguments: outcome.args,
        ...(outcome.result ? { result: outcome.result } : {}),
      });
      return;
    }
    await input.client.fail(job.jobId, {
      exitCode: outcome.exitCode,
      durationMs,
      resolvedExecutable: outcome.executable,
      resolvedArguments: outcome.args,
      errorCode: outcome.errorCode ?? "PROCESS_FAILED",
      errorMessage: outcome.errorMessage ?? "échec",
    });
  } finally {
    if (aptHeld) {
      state.apt -= 1;
    }
  }
}

async function startWithRetry(client: ServerClient, jobId: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) {
      return { status: "REJECTED" as const, execute: false };
    }
    try {
      return await client.start(jobId);
    } catch {
      await sleep(backoffDelayMs(attempt), signal);
    }
  }
  return { status: "REJECTED" as const, execute: false };
}

function heartbeatPayload(config: AgentConfig, state: { running: number }) {
  const capabilities: Array<"system" | "apt" | "local.metrics"> = ["system", "apt"];
  if (config.metrics.source === "LOCAL_AGENT") {
    capabilities.push("local.metrics");
  }
  return {
    running: state.running,
    queued: 0,
    capacity: config.concurrency.total,
    capabilities,
  };
}

async function loop(intervalMs: number, signal: AbortSignal, task: () => Promise<void>): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await task();
      attempt = 0;
      await sleep(intervalMs, signal);
    } catch {
      await sleep(backoffDelayMs(attempt), signal);
      attempt += 1;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
