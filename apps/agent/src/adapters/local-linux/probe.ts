import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import { cpuPercent, parseOsRelease, parseProcNetDev, parseProcStat } from "./system.js";

export type SystemSnapshot = {
  hostname: string;
  kernel: string;
  arch: string;
  platform: string;
  uptimeSeconds: number;
  os: {
    id?: string;
    name?: string;
    version?: string;
    prettyName?: string;
  };
  cpu: { model: string; cores: number };
  memory: { totalBytes: number; freeBytes: number };
  rebootRequired: boolean;
};

export type CpuSample = { idle: number; total: number };

export interface SystemProbe {
  inspect(): Promise<SystemSnapshot>;
  addresses(): string[];
  rebootRequired(): Promise<boolean>;
  readCpu(): Promise<CpuSample | null>;
  readNetwork(): Promise<{ rx: number; tx: number } | null>;
  readDisk(): Promise<{ used: number; total: number } | null>;
}

export class LinuxSystemProbe implements SystemProbe {
  async inspect(): Promise<SystemSnapshot> {
    const release = await readOptional("/etc/os-release");
    const osRelease = release ? parseOsRelease(release) : {};
    const cpus = os.cpus();
    const first = cpus[0];
    return {
      hostname: os.hostname(),
      kernel: os.release(),
      arch: os.arch(),
      platform: os.platform(),
      uptimeSeconds: Math.round(os.uptime()),
      os: osRelease,
      cpu: { model: first?.model ?? "unknown", cores: cpus.length },
      memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
      rebootRequired: await this.rebootRequired(),
    };
  }

  addresses(): string[] {
    return selectAddresses(os.networkInterfaces());
  }

  async rebootRequired(): Promise<boolean> {
    try {
      await fs.access("/var/run/reboot-required", fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async readCpu(): Promise<CpuSample | null> {
    const stat = await readOptional("/proc/stat");
    if (!stat) {
      return null;
    }
    return parseProcStat(stat);
  }

  async readNetwork(): Promise<{ rx: number; tx: number } | null> {
    const content = await readOptional("/proc/net/dev");
    if (!content) {
      return null;
    }
    return parseProcNetDev(content);
  }

  async readDisk(): Promise<{ used: number; total: number } | null> {
    const statfs = (fs as { statfs?: (path: string) => Promise<{ blocks: number; bfree: number; bsize: number }> }).statfs;
    if (!statfs) {
      return null;
    }
    try {
      const stats = await statfs("/");
      return {
        total: stats.blocks * stats.bsize,
        used: (stats.blocks - stats.bfree) * stats.bsize,
      };
    } catch {
      return null;
    }
  }
}

export function cpuUsageFromSamples(previous: CpuSample | null, next: CpuSample | null): number {
  if (!next) {
    return 0;
  }
  return cpuPercent(previous, next);
}

export function selectAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const found: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries || name === "lo") {
      continue;
    }
    for (const entry of entries) {
      if (entry.internal || !usableAddress(entry.address)) {
        continue;
      }
      found.push(entry.address);
    }
  }
  const ipv4 = found.filter((address) => address.includes(".") && !address.includes(":"));
  const ipv6 = found.filter((address) => address.includes(":"));
  return [...new Set([...ipv4, ...ipv6])].slice(0, 8);
}

function usableAddress(address: string): boolean {
  return address.length > 0 && address !== "::1" && !address.startsWith("fe80:") && !address.startsWith("169.254.");
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}
