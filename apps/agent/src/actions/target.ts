import type { AgentConfig, AgentJob } from "@infra/schemas";
import { SAFE_PROCESS_ENV } from "../adapters/local-linux/apt.js";
import { interpretPctStatus, pctStatusArgs } from "../proxmox/parse.js";
import type { ProcessRunner } from "../process/types.js";

export type Place = { kind: "local" } | { kind: "lxc"; vmid: string };

export type TargetFailure = { ok: false; code: string; message: string };
export type TargetReady = { ok: true; place: Place };

const UNIT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9:@._\\-]{0,127}$/;

export function vmidArg(vmid: number): string {
  if (!Number.isInteger(vmid) || vmid < 1 || vmid > 999_999_999) {
    throw new Error("vmid invalide");
  }
  return String(vmid);
}

export function unitArg(unit: string | undefined): string | null {
  if (!unit || !UNIT_NAME.test(unit)) {
    return null;
  }
  return unit;
}

export function lineArg(lines: number | undefined): string {
  if (lines === undefined || !Number.isInteger(lines) || lines < 1 || lines > 2000) {
    return "100";
  }
  return String(lines);
}

export function placeCommand(
  place: Place,
  executable: string,
  args: readonly string[],
): { executable: string; args: string[] } {
  if (place.kind === "local") {
    return { executable, args: [...args] };
  }
  return { executable: "pct", args: ["exec", place.vmid, "--", executable, ...args] };
}

export async function resolvePlace(
  job: AgentJob,
  config: AgentConfig,
  runner: ProcessRunner,
  signal: AbortSignal,
): Promise<TargetReady | TargetFailure> {
  const proxmox = config.agent.type === "proxmox-node";
  const type = job.target.machineType;
  const guest = job.target.guest;
  if (type === "LXC" || guest?.guestType === "LXC") {
    if (!proxmox) {
      return { ok: false, code: "INCOMPATIBLE_TARGET", message: "cet agent local n'exécute pas une cible LXC" };
    }
    if (!guest || guest.guestType !== "LXC") {
      return { ok: false, code: "TARGET_NOT_FOUND", message: "vmid LXC absent" };
    }
    let vmid: string;
    try {
      vmid = vmidArg(guest.vmid);
    } catch {
      return { ok: false, code: "VALIDATION_ERROR", message: "vmid invalide" };
    }
    const status = await runner.run({
      executable: "pct",
      args: [...pctStatusArgs(guest.vmid)],
      timeoutMs: 15_000,
      env: SAFE_PROCESS_ENV,
      allowSigkill: true,
      sigkillAfterMs: 5_000,
      signal,
    });
    const state = interpretPctStatus(status.stdout, status.stderr, status.exitCode);
    if (state === "missing") {
      return { ok: false, code: "TARGET_NOT_FOUND", message: "conteneur introuvable" };
    }
    if (state !== "running") {
      return { ok: false, code: "SKIPPED_STOPPED", message: "le conteneur n'est pas démarré" };
    }
    return { ok: true, place: { kind: "lxc", vmid } };
  }
  if (job.action.startsWith("lxc.")) {
    return { ok: false, code: "INCOMPATIBLE_TARGET", message: "action LXC refusée hors conteneur" };
  }
  if (job.action.startsWith("proxmox.")) {
    if (!proxmox || type !== "PROXMOX_NODE") {
      return { ok: false, code: "INCOMPATIBLE_TARGET", message: "action Proxmox réservée au nœud" };
    }
    return { ok: true, place: { kind: "local" } };
  }
  if (proxmox && type === "VM") {
    return { ok: false, code: "INCOMPATIBLE_TARGET", message: "une VM s'exécute par son agent linux-node" };
  }
  if (type !== "VM" && type !== "PHYSICAL" && type !== "PROXMOX_NODE") {
    return { ok: false, code: "INCOMPATIBLE_TARGET", message: "type de machine incompatible" };
  }
  return { ok: true, place: { kind: "local" } };
}
