export type Listener = {
  protocol: "tcp" | "udp";
  address: string;
  port: number;
};

export type DockerContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  ports: string;
};

export type ComposeProject = {
  directory: string;
  file: string;
  active: boolean;
  services: number;
  running: number;
};

export type SurveyCommand = {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
};

const COMPOSE_PATH = /^\/opt(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){1,6}\/(?:docker-compose\.ya?ml|compose\.ya?ml)$/;
const DOCKER_STATE = new Set(["created", "restarting", "running", "removing", "paused", "exited", "dead"]);
const ENABLED_STATE = new Set(["enabled", "disabled", "static", "indirect", "masked", "generated", "transient", "not-found"]);

export function parseListeners(stdout: string): Listener[] {
  const seen = new Set<string>();
  const listeners: Listener[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const proto = parts[0]?.toLowerCase();
    const local = parts[4];
    if ((proto !== "tcp" && proto !== "udp") || !local) {
      continue;
    }
    const endpoint = splitEndpoint(local);
    if (!endpoint) {
      continue;
    }
    const key = `${proto} ${endpoint.address} ${endpoint.port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    listeners.push({ protocol: proto, address: endpoint.address, port: endpoint.port });
    if (listeners.length >= 400) {
      break;
    }
  }
  return listeners;
}

export function acceptComposePath(input: string): { directory: string; file: string } | null {
  const path = input.trim();
  if (!COMPOSE_PATH.test(path)) {
    return null;
  }
  const slash = path.lastIndexOf("/");
  return { directory: path.slice(0, slash), file: path.slice(slash + 1) };
}

export function parseDockerPs(stdout: string): DockerContainer[] {
  const containers: DockerContainer[] = [];
  for (const item of readJsonItems(stdout).slice(0, 200)) {
    const id = textField(item, "ID").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
    const name = textField(item, "Names").replace(/^\//, "").slice(0, 128);
    const image = textField(item, "Image").slice(0, 200);
    const rawState = textField(item, "State").toLowerCase();
    if (id.length < 4 || name.length === 0 || image.length === 0) {
      continue;
    }
    containers.push({
      id,
      name,
      image,
      state: DOCKER_STATE.has(rawState) ? rawState : "unknown",
      ports: textField(item, "Ports").slice(0, 240),
    });
  }
  return containers;
}

export function parseComposeProjects(files: readonly string[], containersStdout: string): ComposeProject[] {
  const containers = readJsonItems(containersStdout);
  const projects: ComposeProject[] = [];
  for (const file of files) {
    const accepted = acceptComposePath(file);
    if (!accepted || projects.length >= 40) {
      continue;
    }
    const matched = containers.filter((item) => projectMatches(item, accepted));
    const running = matched.filter((item) => {
      const state = textField(item, "State").toLowerCase();
      return state === "running" || state === "restarting";
    }).length;
    projects.push({
      directory: accepted.directory,
      file: accepted.file,
      active: running > 0,
      services: matched.length,
      running,
    });
  }
  return projects;
}

export function systemdWord(stdout: string): string {
  const word = stdout.trim().split(/\s+/)[0] ?? "";
  return ENABLED_STATE.has(word) || word === "active" || word === "inactive" || word === "failed" ? word : "unknown";
}

function projectMatches(item: Record<string, unknown>, project: { directory: string; file: string }): boolean {
  const labels = labelsOf(item.Labels);
  const directory = labels.get("com.docker.compose.project.working_dir");
  const configFile = labels.get("com.docker.compose.project.config_files");
  return directory === project.directory || configFile === `${project.directory}/${project.file}`;
}

function labelsOf(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof value !== "string") {
    return map;
  }
  for (const part of value.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      map.set(part.slice(0, eq), part.slice(eq + 1));
    }
  }
  return map;
}

function readJsonItems(stdout: string): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[")) {
    return arrayRecords(trimmed);
  }
  for (const line of stdout.split("\n")) {
    const record = oneRecord(line.trim());
    if (record) {
      items.push(record);
    }
  }
  return items;
}

function arrayRecords(text: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  } catch {
    return [];
  }
}

function oneRecord(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function textField(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  return typeof value === "string" ? value.trim() : "";
}

function splitEndpoint(value: string): { address: string; port: number } | null {
  let address = "";
  let portText = "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 1 || value[end + 1] !== ":") {
      return null;
    }
    address = value.slice(1, end);
    portText = value.slice(end + 2);
  } else {
    const colon = value.lastIndexOf(":");
    if (colon <= 0) {
      return null;
    }
    address = value.slice(0, colon);
    portText = value.slice(colon + 1);
  }
  if (!/^\d+$/.test(portText) || address.length === 0 || address.length > 80) {
    return null;
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { address, port };
}
