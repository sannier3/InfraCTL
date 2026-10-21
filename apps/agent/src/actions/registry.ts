import { getAction, type ActionName } from "@infra/types";
import type { AgentConfig, AgentJob } from "@infra/schemas";
import { APT_CHECK_ARGS, APT_CHECK_EXECUTABLE, SAFE_PROCESS_ENV } from "../adapters/local-linux/apt.js";
import type { SystemProbe } from "../adapters/local-linux/probe.js";
import type { ProcessRunner } from "../process/types.js";
import { parseAptSimulation } from "./apt/parse.js";

export type ActionLog = (stream: "stdout" | "stderr" | "system", data: string) => void;

export type ActionContext = {
  job: AgentJob;
  runner: ProcessRunner;
  probe: SystemProbe;
  log: ActionLog;
  config: AgentConfig;
  signal: AbortSignal;
};

export type ActionOutcome = {
  status: "SUCCESS" | "FAILED" | "SKIPPED" | "INTERRUPTED";
  exitCode: number | null;
  errorCode?: string;
  errorMessage?: string;
  result?: Record<string, unknown>;
  executable: string | null;
  args: string[] | null;
};

export type ActionHandler = (context: ActionContext) => Promise<ActionOutcome>;

export function ensureLocalTarget(job: AgentJob): { ok: true } | { ok: false; code: string; message: string } {
  if (job.target.machineType === "LXC" || job.target.guest) {
    return {
      ok: false,
      code: "INCOMPATIBLE_TARGET",
      message: "cet agent local n'exécute pas une cible LXC",
    };
  }
  if (job.target.machineType !== "VM" && job.target.machineType !== "PHYSICAL" && job.target.machineType !== "PROXMOX_NODE") {
    return { ok: false, code: "INCOMPATIBLE_TARGET", message: "type de machine incompatible" };
  }
  return { ok: true };
}

export async function runRegisteredAction(context: ActionContext): Promise<ActionOutcome> {
  const handler = HANDLERS[context.job.action];
  if (!handler || !getAction(context.job.action).enabled) {
    return {
      status: "FAILED",
      exitCode: null,
      errorCode: "ACTION_NOT_IMPLEMENTED",
      errorMessage: "action non implémentée sur cet agent",
      executable: null,
      args: null,
    };
  }
  return handler(context);
}

const HANDLERS: Partial<Record<ActionName, ActionHandler>> = {
  "system.info": systemInfo,
  "apt.check": aptCheck,
};

async function systemInfo(context: ActionContext): Promise<ActionOutcome> {
  const local = ensureLocalTarget(context.job);
  if (!local.ok) {
    return {
      status: "SKIPPED",
      exitCode: null,
      errorCode: local.code,
      errorMessage: local.message,
      executable: null,
      args: null,
    };
  }
  const info = await context.probe.inspect();
  context.log("system", `system.info ${info.hostname}`);
  return {
    status: "SUCCESS",
    exitCode: 0,
    executable: null,
    args: null,
    result: {
      hostname: info.hostname,
      kernel: info.kernel,
      arch: info.arch,
      platform: info.platform,
      uptimeSeconds: info.uptimeSeconds,
      os: info.os,
      cpu: info.cpu,
      memory: info.memory,
      rebootRequired: info.rebootRequired,
      agentVersion: context.config.agent.version,
    },
  };
}

async function aptCheck(context: ActionContext): Promise<ActionOutcome> {
  const local = ensureLocalTarget(context.job);
  if (!local.ok) {
    return {
      status: "SKIPPED",
      exitCode: null,
      errorCode: local.code,
      errorMessage: local.message,
      executable: null,
      args: null,
    };
  }
  const args = [...APT_CHECK_ARGS];
  const result = await context.runner.run({
    executable: APT_CHECK_EXECUTABLE,
    args,
    timeoutMs: getAction("apt.check").timeoutMs,
    env: SAFE_PROCESS_ENV,
    allowSigkill: true,
    sigkillAfterMs: 5_000,
    signal: context.signal,
    onChunk: (chunk) => context.log(chunk.stream, chunk.data),
  });
  if (context.signal.aborted) {
    return {
      status: "INTERRUPTED",
      exitCode: result.exitCode,
      errorCode: "AGENT_SHUTDOWN",
      errorMessage: "agent arrêté pendant apt.check",
      executable: APT_CHECK_EXECUTABLE,
      args,
    };
  }
  if (result.timedOut) {
    return {
      status: "INTERRUPTED",
      exitCode: result.exitCode,
      errorCode: "TIMEOUT",
      errorMessage: "apt.check a dépassé son délai",
      executable: APT_CHECK_EXECUTABLE,
      args,
    };
  }
  if (result.exitCode !== 0) {
    return {
      status: "FAILED",
      exitCode: result.exitCode,
      errorCode: "PROCESS_FAILED",
      errorMessage: result.stderr.trim().slice(0, 500) || "apt-get a échoué",
      executable: APT_CHECK_EXECUTABLE,
      args,
    };
  }
  const parsed = parseAptSimulation(result.stdout);
  const rebootRequired = await context.probe.rebootRequired();
  return {
    status: "SUCCESS",
    exitCode: 0,
    executable: APT_CHECK_EXECUTABLE,
    args,
    result: { ...parsed, requiresReboot: rebootRequired },
  };
}
