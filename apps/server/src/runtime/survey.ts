export type SurveyPort = {
  protocol: "tcp" | "udp";
  port: number;
  machineCount: number;
  machines: Array<{ id: string; address: string }>;
};

export type SurveyContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  ports: string;
};

export type SurveyHost = {
  machineId: string;
  installed: boolean;
  active: boolean;
  enabled: boolean;
  containers: SurveyContainer[];
};

export type SurveyProject = {
  machineId: string;
  directory: string;
  file: string;
  active: boolean;
  services: number;
  running: number;
};

export type SurveyView = {
  ports: SurveyPort[];
  hosts: SurveyHost[];
  projects: SurveyProject[];
};

export function aggregateSurveys(results: Array<{ machineId: string; result: unknown }>): SurveyView {
  const ports = new Map<string, { protocol: "tcp" | "udp"; port: number; machines: Map<string, string> }>();
  const hosts: SurveyHost[] = [];
  const projects: SurveyProject[] = [];
  for (const row of results) {
    const parsed = readSurvey(row.result);
    if (!parsed) {
      continue;
    }
    for (const listener of parsed.listeners) {
      const key = `${listener.protocol}:${listener.port}`;
      const group = ports.get(key) ?? { protocol: listener.protocol, port: listener.port, machines: new Map<string, string>() };
      if (!group.machines.has(row.machineId)) {
        group.machines.set(row.machineId, listener.address);
      }
      ports.set(key, group);
    }
    hosts.push({ machineId: row.machineId, ...parsed.docker });
    for (const project of parsed.projects) {
      projects.push({ machineId: row.machineId, ...project });
    }
  }
  return {
    ports: [...ports.values()]
      .map((group) => ({
        protocol: group.protocol,
        port: group.port,
        machineCount: group.machines.size,
        machines: [...group.machines.entries()].map(([id, address]) => ({ id, address })),
      }))
      .sort((left, right) => right.machineCount - left.machineCount || left.port - right.port),
    hosts: hosts.sort((left, right) => Number(right.active) - Number(left.active) || left.machineId.localeCompare(right.machineId)),
    projects: projects.sort((left, right) => Number(left.active) - Number(right.active) || left.directory.localeCompare(right.directory, "fr")),
  };
}

function readSurvey(result: unknown): { listeners: Array<{ protocol: "tcp" | "udp"; address: string; port: number }>; docker: Omit<SurveyHost, "machineId">; projects: Array<Omit<SurveyProject, "machineId">> } | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const record = result as { listeners?: unknown; docker?: unknown; projects?: unknown };
  const docker = record.docker;
  if (!docker || typeof docker !== "object") {
    return null;
  }
  const engine = docker as { installed?: unknown; active?: unknown; enabled?: unknown; containers?: unknown };
  return {
    listeners: readListeners(record.listeners),
    docker: {
      installed: engine.installed === true,
      active: engine.active === true,
      enabled: engine.enabled === true,
      containers: readContainers(engine.containers),
    },
    projects: readProjects(record.projects),
  };
}

function readListeners(value: unknown): Array<{ protocol: "tcp" | "udp"; address: string; port: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const listeners = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const protocol = "protocol" in item ? item.protocol : "";
    const address = "address" in item && typeof item.address === "string" ? item.address : "";
    const port = "port" in item && typeof item.port === "number" ? item.port : 0;
    if ((protocol === "tcp" || protocol === "udp") && address.length > 0 && Number.isInteger(port) && port >= 1 && port <= 65535) {
      listeners.push({ protocol, address, port });
    }
  }
  return listeners;
}

function readContainers(value: unknown): SurveyContainer[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const containers: SurveyContainer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const id = text(item, "id");
    const name = text(item, "name");
    const image = text(item, "image");
    const state = text(item, "state");
    if (id.length === 0 || name.length === 0) {
      continue;
    }
    containers.push({ id, name, image, state, ports: text(item, "ports") });
  }
  return containers;
}

function readProjects(value: unknown): Array<Omit<SurveyProject, "machineId">> {
  if (!Array.isArray(value)) {
    return [];
  }
  const projects = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const directory = text(item, "directory");
    const file = text(item, "file");
    const services = "services" in item && typeof item.services === "number" ? item.services : 0;
    const running = "running" in item && typeof item.running === "number" ? item.running : 0;
    if (!directory.startsWith("/opt/") || file.length === 0) {
      continue;
    }
    projects.push({
      directory,
      file,
      active: "active" in item && item.active === true,
      services: Number.isInteger(services) ? services : 0,
      running: Number.isInteger(running) ? running : 0,
    });
  }
  return projects;
}

function text(item: object, key: string): string {
  const value = (item as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}
