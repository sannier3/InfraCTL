import type { AgentConfig, InventoryBody } from "@infra/schemas";
import { SAFE_PROCESS_ENV } from "../adapters/local-linux/apt.js";
import type { SystemProbe } from "../adapters/local-linux/probe.js";
import type { ProcessRunner } from "../process/types.js";
import { lxcIndexArgs, parseGuestList, parseInterfaceAddresses, parsePveVersion, qemuIndexArgs } from "./parse.js";

export type ProxmoxInventoryCollection = {
  body: InventoryBody;
  listError: string | null;
};

export async function collectProxmoxInventory(
  config: AgentConfig,
  runner: ProcessRunner,
  probe: SystemProbe,
): Promise<ProxmoxInventoryCollection | null> {
  const clusterId = config.proxmox.clusterId;
  if (config.agent.type !== "proxmox-node" || !clusterId) {
    return null;
  }
  const info = await probe.inspect();
  const versionRun = await runner.run({
    executable: "pveversion",
    args: [],
    timeoutMs: 15_000,
    env: SAFE_PROCESS_ENV,
    allowSigkill: true,
    sigkillAfterMs: 5_000,
  });
  const lxc = await runner.run({
    executable: "pvesh",
    args: [...lxcIndexArgs()],
    timeoutMs: 30_000,
    env: SAFE_PROCESS_ENV,
    allowSigkill: true,
    sigkillAfterMs: 5_000,
  });
  const qemu = await runner.run({
    executable: "pvesh",
    args: [...qemuIndexArgs()],
    timeoutMs: 30_000,
    env: SAFE_PROCESS_ENV,
    allowSigkill: true,
    sigkillAfterMs: 5_000,
  });
  const version = versionRun.exitCode === 0 ? parsePveVersion(versionRun.stdout) : null;
  const body: InventoryBody = {
    hostname: info.hostname,
    ...(config.machine.displayName ? { displayName: config.machine.displayName } : {}),
    machineType: "PROXMOX_NODE",
    metricsSource: config.metrics.source,
    status: "RUNNING",
    os: {
      ...(info.os.id ? { id: info.os.id } : {}),
      ...(info.os.name ? { name: info.os.name } : {}),
      ...(info.os.version ? { version: info.os.version } : {}),
      ...(info.os.prettyName ? { prettyName: info.os.prettyName } : {}),
      kernel: info.kernel,
      arch: info.arch,
    },
    addresses: probe.addresses(),
    node: {
      clusterId,
      name: info.hostname,
      ...(version ? { version } : {}),
    },
  };
  const lxcGuests = lxc.exitCode === 0 ? readGuestIndex(lxc.stdout) : null;
  const qemuGuests = qemu.exitCode === 0 ? readGuestIndex(qemu.stdout) : null;
  let listError: string | null = null;
  if (lxcGuests && qemuGuests) {
    body.guests = [
      ...lxcGuests.map((guest) => toReport(guest, "LXC")),
      ...qemuGuests.map((guest) => toReport(guest, "QEMU")),
    ];
  } else {
    listError = [
      describeListFailure("lxc", lxc.exitCode, lxc.stderr, lxcGuests),
      describeListFailure("qemu", qemu.exitCode, qemu.stderr, qemuGuests),
    ]
      .filter((line) => line.length > 0)
      .join(" ; ");
  }
  if (body.guests) {
    body.guests = await attachAddresses(runner, body.guests);
  }
  return { body, listError };
}

async function attachAddresses(
  runner: ProcessRunner,
  guests: NonNullable<InventoryBody["guests"]>,
): Promise<NonNullable<InventoryBody["guests"]>> {
  const running = guests.filter((guest) => guest.status === "running");
  const found = new Map<string, string[]>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < running.length) {
      const guest = running[cursor];
      cursor += 1;
      if (!guest) {
        continue;
      }
      const addresses = await readGuestAddresses(runner, guest.guestType, guest.vmid);
      if (addresses && addresses.length > 0) {
        found.set(`${guest.guestType}:${guest.vmid}`, addresses);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, running.length) }, () => worker()));
  return guests.map((guest) => {
    const addresses = found.get(`${guest.guestType}:${guest.vmid}`);
    return addresses ? { ...guest, addresses } : guest;
  });
}

async function readGuestAddresses(runner: ProcessRunner, guestType: "LXC" | "QEMU", vmid: number): Promise<string[] | undefined> {
  if (!Number.isInteger(vmid) || vmid < 1 || vmid > 999_999_999) {
    return undefined;
  }
  const path =
    guestType === "LXC"
      ? `/nodes/localhost/lxc/${vmid}/interfaces`
      : `/nodes/localhost/qemu/${vmid}/agent/network-get-interfaces`;
  const run = await runner.run({
    executable: "pvesh",
    args: ["get", path, "--output-format", "json"],
    timeoutMs: 8_000,
    env: SAFE_PROCESS_ENV,
    allowSigkill: true,
    sigkillAfterMs: 2_000,
  });
  if (run.exitCode !== 0) {
    return undefined;
  }
  const addresses = parseInterfaceAddresses(run.stdout);
  return addresses.length > 0 ? addresses : undefined;
}

function readGuestIndex(stdout: string): ReturnType<typeof parseGuestList> | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("[")) {
    return null;
  }
  try {
    return parseGuestList(trimmed);
  } catch {
    return null;
  }
}

function toReport(
  guest: ReturnType<typeof parseGuestList>[number],
  guestType: "LXC" | "QEMU",
): NonNullable<InventoryBody["guests"]>[number] {
  return {
    vmid: guest.vmid,
    guestType,
    name: guest.name,
    status: guest.status,
    ...(guest.cpu !== undefined ? { cpu: guest.cpu } : {}),
    ...(guest.memoryUsed !== undefined ? { memoryUsed: guest.memoryUsed } : {}),
    ...(guest.memoryTotal !== undefined ? { memoryTotal: guest.memoryTotal } : {}),
    ...(guest.diskUsed !== undefined ? { diskUsed: guest.diskUsed } : {}),
    ...(guest.diskTotal !== undefined ? { diskTotal: guest.diskTotal } : {}),
    ...(guest.uptime !== undefined ? { uptime: guest.uptime } : {}),
  };
}

function describeListFailure(
  kind: string,
  exitCode: number | null,
  stderr: string,
  guests: ReturnType<typeof parseGuestList> | null,
): string {
  if (exitCode === 0 && guests) {
    return "";
  }
  const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 300);
  if (exitCode !== 0) {
    return detail.length > 0 ? `pvesh ${kind} (${exitCode}) ${detail}` : `pvesh ${kind} (${exitCode ?? "absent"})`;
  }
  return `pvesh ${kind} n'a pas renvoyé de tableau JSON`;
}
