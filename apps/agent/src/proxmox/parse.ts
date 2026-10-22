export type ListedGuest = {
  vmid: number;
  name: string;
  status: "running" | "stopped";
  lock: string | null;
  cpu?: number;
  memoryUsed?: number;
  memoryTotal?: number;
  diskUsed?: number;
  diskTotal?: number;
  uptime?: number;
};

const KNOWN_LOCKS = new Set([
  "backup",
  "create",
  "destroy",
  "disk",
  "fstrim",
  "migrate",
  "mounted",
  "rollback",
  "snapshot",
]);

export function lxcIndexArgs(): readonly string[] {
  return ["get", "/nodes/localhost/lxc", "--output-format", "json"];
}

export function qemuIndexArgs(): readonly string[] {
  return ["get", "/nodes/localhost/qemu", "--output-format", "json"];
}

export function parseGuestList(stdout: string): ListedGuest[] {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[")) {
    return parseJsonList(trimmed);
  }
  return parseTable(trimmed);
}

export function pctStatusArgs(vmid: number): readonly [string, string] {
  if (!Number.isInteger(vmid) || vmid < 1 || vmid > 999_999_999) {
    throw new Error("vmid invalide");
  }
  return ["status", String(vmid)];
}

export function parsePveVersion(stdout: string): string | null {
  const match = /pve-manager\/([0-9][^/\s]*)/.exec(stdout);
  const version = match?.[1];
  if (!version || version.length > 128) {
    return null;
  }
  return version;
}

export function interpretPctStatus(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): "running" | "stopped" | "missing" | "unknown" {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (text.includes("does not exist") || text.includes("no such") || text.includes("not exist")) {
    return "missing";
  }
  if (text.includes("status: running")) {
    return "running";
  }
  if (text.includes("status: stopped")) {
    return "stopped";
  }
  if (exitCode === 0 && text.includes("running")) {
    return "running";
  }
  return "unknown";
}

function parseJsonList(stdout: string): ListedGuest[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const guests: ListedGuest[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const vmid = Number(record.vmid);
    const status = record.status;
    if (!Number.isInteger(vmid) || vmid < 1 || (status !== "running" && status !== "stopped")) {
      continue;
    }
    const rawName = typeof record.name === "string" ? record.name.trim() : "";
    const name = (rawName.length > 0 ? rawName : String(vmid)).slice(0, 255);
    const lock = typeof record.lock === "string" && record.lock.length > 0 ? record.lock : null;
    const cpu = cpuPercent(record.cpu, record.maxcpu ?? record.cpus);
    const memoryUsed = optionalBytes(record.mem);
    const memoryTotal = optionalBytes(record.maxmem);
    const diskUsed = optionalBytes(record.disk);
    const diskTotal = optionalBytes(record.maxdisk);
    const uptime = optionalBytes(record.uptime);
    guests.push({
      vmid,
      name,
      status,
      lock,
      ...(cpu !== undefined ? { cpu } : {}),
      ...(memoryUsed !== undefined ? { memoryUsed } : {}),
      ...(memoryTotal !== undefined ? { memoryTotal } : {}),
      ...(diskUsed !== undefined ? { diskUsed } : {}),
      ...(diskTotal !== undefined ? { diskTotal } : {}),
      ...(uptime !== undefined ? { uptime } : {}),
    });
  }
  return guests;
}

export function parseInterfaceAddresses(stdout: string): string[] {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("[") >= 0 ? trimmed.indexOf("[") : trimmed.indexOf("{");
  if (start < 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start));
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { result?: unknown }).result)
      ? (parsed as { result: unknown[] }).result
      : [];
  const found: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const record = row as Record<string, unknown>;
    collectAddress(found, record.inet);
    collectAddress(found, record.inet6);
    if (Array.isArray(record["ip-addresses"])) {
      for (const item of record["ip-addresses"]) {
        if (item && typeof item === "object") {
          collectAddress(found, (item as { "ip-address"?: unknown })["ip-address"]);
        }
      }
    }
  }
  return found.slice(0, 8);
}

function collectAddress(found: string[], value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const address = value.split("/")[0]?.trim() ?? "";
  if (!address || address === "::1" || address.startsWith("127.") || address.startsWith("fe80:") || address.startsWith("169.254.")) {
    return;
  }
  if (!found.includes(address)) {
    found.push(address);
  }
}

function cpuPercent(cpu: unknown, cores: unknown): number | undefined {
  if (typeof cpu !== "number" || !Number.isFinite(cpu) || cpu < 0) {
    return undefined;
  }
  const allocated = typeof cores === "number" && Number.isFinite(cores) && cores > 0 ? cores : 1;
  const percent = Math.round((cpu / allocated) * 1000) / 10;
  if (percent > 1024) {
    return 1024;
  }
  return percent;
}

function optionalBytes(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

function parseTable(stdout: string): ListedGuest[] {
  const guests: ListedGuest[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.toLowerCase().startsWith("vmid")) {
      continue;
    }
    const tokens = line.split(/\s+/);
    const vmid = Number(tokens[0]);
    const status = tokens[1];
    if (!Number.isInteger(vmid) || (status !== "running" && status !== "stopped")) {
      continue;
    }
    const rest = tokens.slice(2);
    let lock: string | null = null;
    let name = rest[0] ?? "";
    if (rest.length >= 2 && rest[0] && KNOWN_LOCKS.has(rest[0])) {
      lock = rest[0];
      name = rest.slice(1).join(" ");
    } else {
      name = rest.join(" ");
    }
    if (name.length === 0) {
      continue;
    }
    guests.push({ vmid, name, status, lock });
  }
  return guests;
}
