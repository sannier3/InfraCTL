export type OsRelease = {
  id?: string;
  name?: string;
  version?: string;
  prettyName?: string;
};

export function parseOsRelease(content: string): OsRelease {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return {
    id: values.get("ID"),
    name: values.get("NAME"),
    version: values.get("VERSION_ID"),
    prettyName: values.get("PRETTY_NAME"),
  };
}

export function parseProcStat(content: string): { idle: number; total: number } | null {
  const line = content.split(/\r?\n/).find((item) => item.startsWith("cpu "));
  if (!line) {
    return null;
  }
  const numbers = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  if (numbers.length < 4) {
    return null;
  }
  const idle = (numbers[3] ?? 0) + (numbers[4] ?? 0);
  const total = numbers.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

export function cpuPercent(
  previous: { idle: number; total: number } | null,
  next: { idle: number; total: number },
): number {
  if (!previous) {
    return 0;
  }
  const total = next.total - previous.total;
  const idle = next.idle - previous.idle;
  if (total <= 0) {
    return 0;
  }
  const busy = Math.min(100, Math.max(0, (1 - idle / total) * 100));
  return Math.round(busy * 10) / 10;
}

export function parseProcNetDev(content: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.includes(":") || line.startsWith("Inter-") || line.startsWith("face")) {
      continue;
    }
    const [namePart, rest] = line.split(":");
    const name = namePart?.trim();
    if (!name || name === "lo" || !rest) {
      continue;
    }
    const fields = rest.trim().split(/\s+/).map((item) => Number(item));
    const received = fields[0];
    const transmitted = fields[8];
    if (typeof received === "number" && Number.isFinite(received)) {
      rx += received;
    }
    if (typeof transmitted === "number" && Number.isFinite(transmitted)) {
      tx += transmitted;
    }
  }
  return { rx, tx };
}
