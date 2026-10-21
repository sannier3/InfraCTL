export type ListedGuest = {
  vmid: number;
  name: string;
  status: "running" | "stopped";
  lock: string | null;
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

export function pctListArgs(): readonly string[] {
  return ["list", "--output-format", "json"];
}

export function qmListArgs(): readonly string[] {
  return ["list", "--output-format", "json"];
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
    const name = typeof record.name === "string" ? record.name : "";
    if (!Number.isInteger(vmid) || (status !== "running" && status !== "stopped") || name.length === 0) {
      continue;
    }
    const lock = typeof record.lock === "string" && record.lock.length > 0 ? record.lock : null;
    guests.push({ vmid, name, status, lock });
  }
  return guests;
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
