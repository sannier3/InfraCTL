import type { AptCheckResult, AptPackageChange } from "@infra/schemas";

const INST_CURRENT =
  /^Inst\s+(\S+)\s+\[([^\]]+)\]\s+\((\S+)(?:\s+(\S+))?(?:\s+\[([^\]]+)\])?\)\s*$/;
const INST_NEW = /^Inst\s+(\S+)\s+\((\S+)(?:\s+(\S+))?(?:\s+\[([^\]]+)\])?\)\s*$/;
const REMOVE = /^Remv\s+(\S+)(?:\s+\[([^\]]+)\])?(?:\s+\[([^\]]+)\])?\s*$/;

export function parseAptSimulation(stdout: string): Omit<AptCheckResult, "requiresReboot"> {
  const packages: AptPackageChange[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const current = INST_CURRENT.exec(line);
    if (current) {
      packages.push({
        name: current[1] ?? "",
        currentVersion: current[2] ?? null,
        newVersion: current[3] ?? null,
        architecture: current[5] ?? null,
        action: "upgrade",
        security: isSecurity(current[4]),
      });
      continue;
    }
    const fresh = INST_NEW.exec(line);
    if (fresh?.[1]) {
      packages.push({
        name: fresh[1],
        currentVersion: null,
        newVersion: fresh[2] ?? null,
        architecture: fresh[4] ?? null,
        action: "install",
        security: isSecurity(fresh[3]),
      });
      continue;
    }
    const removal = REMOVE.exec(line);
    if (removal && removal[1]) {
      packages.push({
        name: removal[1],
        currentVersion: removal[2] ?? null,
        newVersion: null,
        architecture: removal[3] ?? null,
        action: "remove",
        security: false,
      });
    }
  }
  const available = packages.filter((pkg) => pkg.action === "upgrade" || pkg.action === "install");
  return {
    availableCount: available.length,
    securityCount: available.filter((pkg) => pkg.security).length,
    requiresConfirmation: packages.some((pkg) => pkg.action === "remove"),
    packages,
  };
}

function isSecurity(source: string | undefined): boolean {
  return typeof source === "string" && source.toLowerCase().includes("security");
}
