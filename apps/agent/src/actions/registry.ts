import { getAction, type ActionName } from "@infra/types";
import type { AgentConfig, AgentJob } from "@infra/schemas";
import {
  APT_CHECK_ARGS,
  APT_CHECK_EXECUTABLE,
  APT_DIST_CHECK_ARGS,
  APT_DIST_UPGRADE_ARGS,
  APT_REFRESH_ARGS,
  APT_UPGRADE_ARGS,
  APT_UPGRADE_EXECUTABLE,
  SAFE_PROCESS_ENV,
} from "../adapters/local-linux/apt.js";
import type { ProcessResult, ProcessRunner } from "../process/types.js";
import type { SystemProbe } from "../adapters/local-linux/probe.js";
import { collectProxmoxInventory } from "../proxmox/collect.js";
import { lxcIndexArgs, parsePveVersion } from "../proxmox/parse.js";
import { parseAptSimulation } from "./apt/parse.js";
import { lineArg, placeCommand, resolvePlace, unitArg, type Place } from "./target.js";
import type { ServerClient } from "../transport/client.js";

export type ActionLog = (stream: "stdout" | "stderr" | "system", data: string) => void;

export type ActionContext = {
  job: AgentJob;
  runner: ProcessRunner;
  probe: SystemProbe;
  log: ActionLog;
  config: AgentConfig;
  signal: AbortSignal;
  client?: ServerClient;
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

const HANDLERS: Record<ActionName, ActionHandler> = {
  "system.info": systemInfo,
  "system.rebootRequired": rebootRequired,
  "system.reboot": (context) => runFixed(context, "systemctl", ["reboot"], "system.reboot"),
  "system.shutdown": (context) => runFixed(context, "systemctl", ["poweroff"], "system.shutdown"),
  "apt.refresh": (context) => runFixed(context, APT_CHECK_EXECUTABLE, [...APT_REFRESH_ARGS], "apt.refresh"),
  "apt.check": aptCheck,
  "apt.upgrade": aptUpgrade,
  "systemd.failed": (context) =>
    runFixed(context, "systemctl", ["--failed", "--no-legend", "--plain", "--no-pager"], "systemd.failed", true),
  "systemd.serviceStatus": serviceStatus,
  "systemd.restart": restartUnit,
  "journal.system": journalSystem,
  "journal.service": journalService,
  "proxmox.nodeInfo": nodeInfo,
  "proxmox.inventory": proxmoxInventory,
  "proxmox.resources": (context) =>
    runFixed(context, "pvesh", ["get", "/cluster/resources", "--output-format", "json"], "proxmox.resources", true),
  "proxmox.host.update": hostUpdate,
  "lxc.info": lxcInfo,
  "lxc.resources": lxcResources,
};

async function systemInfo(context: ActionContext): Promise<ActionOutcome> {
  const opened = await openPlace(context);
  if (isOutcome(opened)) {
    return opened;
  }
  if (opened.place.kind === "lxc") {
    const hostname = await runChecked(context, placeCommand(opened.place, "hostname", []), "system.info");
    if (!hostname.ok) {
      return hostname.outcome;
    }
    const kernel = await runChecked(context, placeCommand(opened.place, "uname", ["-r"]), "system.info");
    if (!kernel.ok) {
      return kernel.outcome;
    }
    const arch = await runChecked(context, placeCommand(opened.place, "uname", ["-m"]), "system.info");
    if (!arch.ok) {
      return arch.outcome;
    }
    return {
      status: "SUCCESS",
      exitCode: 0,
      executable: "pct",
      args: ["exec", opened.place.vmid, "--", "hostname"],
      result: {
        hostname: hostname.result.stdout.trim(),
        kernel: kernel.result.stdout.trim(),
        arch: arch.result.stdout.trim(),
        agentVersion: context.config.agent.version,
      },
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

async function rebootRequired(context: ActionContext): Promise<ActionOutcome> {
  const opened = await openPlace(context);
  if (isOutcome(opened)) {
    return opened;
  }
  if (opened.place.kind === "local") {
    return {
      status: "SUCCESS",
      exitCode: 0,
      executable: null,
      args: null,
      result: { rebootRequired: await context.probe.rebootRequired() },
    };
  }
  const command = placeCommand(opened.place, "test", ["-e", "/var/run/reboot-required"]);
  const run = await runChecked(context, command, "system.rebootRequired", new Set([0, 1]));
  if (!run.ok) {
    return run.outcome;
  }
  return {
    status: "SUCCESS",
    exitCode: run.result.exitCode,
    executable: command.executable,
    args: command.args,
    result: { rebootRequired: run.result.exitCode === 0 },
  };
}

async function aptCheck(context: ActionContext): Promise<ActionOutcome> {
  const opened = await openPlace(context);
  if (isOutcome(opened)) {
    return opened;
  }
  const command = placeCommand(opened.place, APT_CHECK_EXECUTABLE, APT_CHECK_ARGS);
  const run = await runChecked(context, command, "apt.check");
  if (!run.ok) {
    return run.outcome;
  }
  const parsed = parseAptSimulation(run.result.stdout);
  const rebootRequired = await readReboot(context, opened.place);
  return {
    status: "SUCCESS",
    exitCode: 0,
    executable: command.executable,
    args: command.args,
    result: { ...parsed, requiresReboot: rebootRequired },
  };
}

async function aptUpgrade(context: ActionContext): Promise<ActionOutcome> {
  return applyUpgrade(context, "apt.upgrade", [...APT_CHECK_ARGS], [...APT_UPGRADE_ARGS], getAction("apt.upgrade").timeoutMs);
}

async function hostUpdate(context: ActionContext): Promise<ActionOutcome> {
  const opened = await openPlace(context);
  if (isOutcome(opened)) {
    return opened;
  }
  const refresh = placeCommand(opened.place, APT_CHECK_EXECUTABLE, APT_REFRESH_ARGS);
  const updated = await runChecked(context, refresh, "proxmox.host.update");
  if (!updated.ok) {
    return updated.outcome;
  }
  return applyUpgrade(
    context,
    "proxmox.host.update",
    [...APT_DIST_CHECK_ARGS],
    [...APT_DIST_UPGRADE_ARGS],
    getAction("proxmox.host.update").timeoutMs,
    opened.place,
  );
}

async function serviceStatus(context: ActionContext): Promise<ActionOutcome> {
  const unit = unitArg(context.job.target.parameters?.unit);
  if (!unit) {
    return invalidUnit();
  }
  return runFixed(
    context,
    "systemctl",
    ["show", unit, "--property=Id,ActiveState,SubState,UnitFileState", "--no-pager"],
    "systemd.serviceStatus",
    true,
  );
}

async function restartUnit(context: ActionContext): Promise<ActionOutcome> {
  const unit = unitArg(context.job.target.parameters?.unit);
  if (!unit) {
    return invalidUnit();
  }
  return runFixed(context, "systemctl", ["restart", unit], "systemd.restart");
}

async function journalSystem(context: ActionContext): Promise<ActionOutcome> {
  return runFixed(
    context,
    "journalctl",
    ["-n", lineArg(context.job.target.parameters?.lines), "--no-pager", "-o", "short-iso"],
    "journal.system",
    true,
  );
}

async function journalService(context: ActionContext): Promise<ActionOutcome> {
  const unit = unitArg(context.job.target.parameters?.unit);
  if (!unit) {
    return invalidUnit();
  }
  return runFixed(
    context,
    "journalctl",
    ["-u", unit, "-n", lineArg(context.job.target.parameters?.lines), "--no-pager", "-o", "short-iso"],
    "journal.service",
    true,
  );
}

async function nodeInfo(context: ActionContext): Promise<ActionOutcome> {
  const opened = await openPlace(context);
  if (isOutcome(opened)) {
    return opened;
  }
  const version = await runChecked(context, { executable: "pveversion", args: [] }, "proxmox.nodeInfo");
  if (!version.ok) {
    return version.outcome;
  }
  const status = await runChecked(
    context,
    { executable: "pvesh", args: ["get", "/nodes/localhost/status", "--output-format", "json"] },
    "proxmox.nodeInfo",
  );
  if (!status.ok) {
    return status.outcome;
  }
  return {
    status: "SUCCESS",
    exitCode: 0,
    executable: "pvesh",
    args: ["get", "/nodes/localhost/status", "--output-format", "json"],
    result: {
      version: parsePveVersion(version.result.stdout),
      status: clip(status.result.stdout),
    },
  };
}

async function proxmoxInventory(context: ActionContext): Promise<ActionOutcome> {
  const opened = await openPlace(context);
  if (isOutcome(opened)) {
    return opened;
  }
  const collected = await collectProxmoxInventory(context.config, context.runner, context.probe);
  if (!collected) {
    return {
      status: "FAILED",
      exitCode: null,
      errorCode: "CONFIG_INVALID",
      errorMessage: "cluster Proxmox absent de la configuration",
      executable: null,
      args: null,
    };
  }
  if (collected.listError) {
    return {
      status: "FAILED",
      exitCode: 1,
      errorCode: "PROCESS_FAILED",
      errorMessage: collected.listError,
      executable: "pvesh",
      args: [...lxcIndexArgs()],
    };
  }
  await context.client?.inventory(collected.body);
  return {
    status: "SUCCESS",
    exitCode: 0,
    executable: "pvesh",
    args: [...lxcIndexArgs()],
    result: { node: collected.body.node ?? null, guests: collected.body.guests ?? [] },
  };
}

async function lxcInfo(context: ActionContext): Promise<ActionOutcome> {
  const opened = await openPlace(context);
  if (isOutcome(opened) || opened.place.kind !== "lxc") {
    return isOutcome(opened)
      ? opened
      : {
          status: "SKIPPED",
          exitCode: null,
          errorCode: "INCOMPATIBLE_TARGET",
          errorMessage: "lxc.info vise un conteneur",
          executable: null,
          args: null,
        };
  }
  const config = await runChecked(context, { executable: "pct", args: ["config", opened.place.vmid] }, "lxc.info");
  if (!config.ok) {
    return config.outcome;
  }
  const hostname = await runChecked(context, placeCommand(opened.place, "hostname", []), "lxc.info");
  return {
    status: "SUCCESS",
    exitCode: 0,
    executable: "pct",
    args: ["config", opened.place.vmid],
    result: {
      vmid: Number(opened.place.vmid),
      hostname: hostname.ok ? hostname.result.stdout.trim() : null,
      config: clip(config.result.stdout),
    },
  };
}

async function lxcResources(context: ActionContext): Promise<ActionOutcome> {
  const opened = await openPlace(context);
  if (isOutcome(opened) || opened.place.kind !== "lxc") {
    return isOutcome(opened)
      ? opened
      : {
          status: "SKIPPED",
          exitCode: null,
          errorCode: "INCOMPATIBLE_TARGET",
          errorMessage: "lxc.resources vise un conteneur",
          executable: null,
          args: null,
        };
  }
  const args = ["get", `/nodes/localhost/lxc/${opened.place.vmid}/status/current`, "--output-format", "json"];
  const run = await runChecked(context, { executable: "pvesh", args }, "lxc.resources");
  if (!run.ok) {
    return run.outcome;
  }
  return {
    status: "SUCCESS",
    exitCode: 0,
    executable: "pvesh",
    args,
    result: { status: clip(run.result.stdout) },
  };
}

async function applyUpgrade(
  context: ActionContext,
  label: ActionName,
  previewArgs: string[],
  upgradeArgs: string[],
  budget: number,
  knownPlace?: Place,
): Promise<ActionOutcome> {
  const opened = knownPlace ? { place: knownPlace } : await openPlace(context);
  if (isOutcome(opened)) {
    return opened;
  }
  const started = Date.now();
  const preview = placeCommand(opened.place, APT_CHECK_EXECUTABLE, previewArgs);
  const simulated = await runChecked(context, preview, label, new Set([0]), Math.min(getAction("apt.check").timeoutMs, budget));
  if (!simulated.ok) {
    return simulated.outcome;
  }
  const parsed = parseAptSimulation(simulated.result.stdout);
  const rebootRequired = await readReboot(context, opened.place);
  const result = { ...parsed, requiresReboot: rebootRequired };
  if (parsed.requiresConfirmation) {
    context.log("system", `${label} arrêté : la simulation retire des paquets`);
    return {
      status: "FAILED",
      exitCode: 0,
      errorCode: "REQUIRES_CONFIRMATION",
      errorMessage: "la simulation retire des paquets ; l'installation n'a pas démarré",
      executable: preview.executable,
      args: preview.args,
      result,
    };
  }
  if (parsed.availableCount === 0) {
    context.log("system", `${label} : aucun paquet à installer`);
    return {
      status: "SUCCESS",
      exitCode: 0,
      executable: preview.executable,
      args: preview.args,
      result,
    };
  }
  const remaining = budget - (Date.now() - started);
  if (remaining < 1_000) {
    return {
      status: "INTERRUPTED",
      exitCode: null,
      errorCode: "TIMEOUT",
      errorMessage: `${label} a dépassé son délai`,
      executable: preview.executable,
      args: preview.args,
    };
  }
  const upgrade = placeCommand(opened.place, APT_UPGRADE_EXECUTABLE, upgradeArgs);
  const applied = await runChecked(context, upgrade, label, new Set([0]), remaining);
  if (!applied.ok) {
    return applied.outcome;
  }
  return {
    status: "SUCCESS",
    exitCode: 0,
    executable: upgrade.executable,
    args: upgrade.args,
    result: { ...parsed, requiresReboot: await readReboot(context, opened.place) },
  };
}

async function runFixed(
  context: ActionContext,
  executable: string,
  args: readonly string[],
  label: ActionName,
  keepText = false,
): Promise<ActionOutcome> {
  const opened = await openPlace(context);
  if (isOutcome(opened)) {
    return opened;
  }
  const command = placeCommand(opened.place, executable, args);
  const run = await runChecked(context, command, label);
  if (!run.ok) {
    return run.outcome;
  }
  return {
    status: "SUCCESS",
    exitCode: 0,
    executable: command.executable,
    args: command.args,
    ...(keepText ? { result: { text: clip(run.result.stdout) } } : {}),
  };
}

async function openPlace(context: ActionContext): Promise<{ place: Place } | ActionOutcome> {
  const resolved = await resolvePlace(context.job, context.config, context.runner, context.signal);
  if (!resolved.ok) {
    return {
      status: "SKIPPED",
      exitCode: null,
      errorCode: resolved.code,
      errorMessage: resolved.message,
      executable: null,
      args: null,
    };
  }
  return { place: resolved.place };
}

function isOutcome(value: { place: Place } | ActionOutcome): value is ActionOutcome {
  return "status" in value;
}

function invalidUnit(): ActionOutcome {
  return {
    status: "FAILED",
    exitCode: null,
    errorCode: "VALIDATION_ERROR",
    errorMessage: "unité systemd requise",
    executable: null,
    args: null,
  };
}

function clip(text: string): string {
  return text.slice(0, 65_536);
}

async function readReboot(context: ActionContext, place: Place): Promise<boolean> {
  if (place.kind === "local") {
    return context.probe.rebootRequired();
  }
  const command = placeCommand(place, "test", ["-e", "/var/run/reboot-required"]);
  const run = await runChecked(context, command, "apt.check", new Set([0, 1]));
  return run.ok && run.result.exitCode === 0;
}

async function runChecked(
  context: ActionContext,
  command: { executable: string; args: string[] },
  label: ActionName,
  accepted: ReadonlySet<number> = new Set([0]),
  timeoutMs = getAction(label).timeoutMs,
): Promise<{ ok: true; result: ProcessResult } | { ok: false; outcome: ActionOutcome }> {
  const { executable, args } = command;
  const result = await context.runner.run({
    executable,
    args,
    timeoutMs,
    env: SAFE_PROCESS_ENV,
    allowSigkill: true,
    sigkillAfterMs: 5_000,
    signal: context.signal,
    onChunk: (chunk) => context.log(chunk.stream, chunk.data),
  });
  if (context.signal.aborted) {
    return {
      ok: false,
      outcome: {
        status: "INTERRUPTED",
        exitCode: result.exitCode,
        errorCode: "AGENT_SHUTDOWN",
        errorMessage: `agent arrêté pendant ${label}`,
        executable,
        args,
      },
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      outcome: {
        status: "INTERRUPTED",
        exitCode: result.exitCode,
        errorCode: "TIMEOUT",
        errorMessage: `${label} a dépassé son délai`,
        executable,
        args,
      },
    };
  }
  if (result.exitCode === null || !accepted.has(result.exitCode)) {
    return {
      ok: false,
      outcome: {
        status: "FAILED",
        exitCode: result.exitCode,
        errorCode: "PROCESS_FAILED",
        errorMessage: result.stderr.trim().slice(0, 500) || "apt-get a échoué",
        executable,
        args,
      },
    };
  }
  return { ok: true, result };
}
