import type { AgentRuntime } from "../config/agent-settings.js";
import { stringify } from "yaml";

export type AgentConfigEndpoint = {
  protocol: "http" | "https";
  host: string;
  port: number;
};

export type AgentConfigSource = {
  agent: {
    id: string;
    name: string;
    type: "linux-node" | "proxmox-node";
    maxConcurrency: number;
  };
  secret: string;
  runtime: AgentRuntime | null;
  endpoint: AgentConfigEndpoint;
  clusterSlug: string | null;
};

export function endpointFromRequest(
  hostHeader: string | undefined,
  protocol: string,
  forwardedProto: string | undefined,
  listenPort: number,
): AgentConfigEndpoint {
  const forwarded = forwardedProto?.split(",")[0]?.trim();
  const resolvedProtocol = forwarded === "https" || protocol === "https" ? "https" : "http";
  const header = hostHeader?.trim() || "127.0.0.1";
  let host = header;
  let port: number | null = null;
  if (header.startsWith("[")) {
    const end = header.indexOf("]");
    host = end > 1 ? header.slice(1, end) : header;
    const rest = end >= 0 ? header.slice(end + 1) : "";
    if (rest.startsWith(":")) port = Number(rest.slice(1));
  } else {
    const colon = header.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(header.slice(colon + 1))) {
      host = header.slice(0, colon);
      port = Number(header.slice(colon + 1));
    }
  }
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    if (forwarded === "https") port = 443;
    else if (forwarded === "http") port = 80;
    else port = listenPort;
  }
  return { protocol: resolvedProtocol, host, port };
}

export function renderAgentConfig(input: AgentConfigSource): { yaml: string; warnings: string[] } {
  const warnings: string[] = [];
  const runtime = input.runtime;
  const proxmoxNode = input.agent.type === "proxmox-node";
  const total = runtime?.concurrency?.total ?? Math.max(1, input.agent.maxConcurrency);
  const requestedApt = runtime?.concurrency?.apt ?? Math.min(2, total);
  const apt = Math.min(requestedApt, total);
  const metricsSource = runtime?.metrics?.source ?? "LOCAL_AGENT";
  const clusterId = runtime?.proxmox?.clusterId ?? input.clusterSlug;
  const vmid = runtime?.proxmox?.vmid;
  const metricsFromProxmox = metricsSource === "PROXMOX" && !proxmoxNode;
  let source = metricsSource;
  if (metricsFromProxmox && (!clusterId || vmid === undefined)) {
    source = "LOCAL_AGENT";
    warnings.push("Les métriques Proxmox exigent un cluster et un VMID. Le fichier utilise la source locale.");
  }
  let resolvedCluster = clusterId;
  if (proxmoxNode && !resolvedCluster) {
    resolvedCluster = "a-remplir";
    warnings.push("Indiquez proxmox.clusterId avant de déposer ce fichier.");
  }
  const machineType = proxmoxNode ? "PHYSICAL" : (runtime?.machine?.type ?? "VM");
  const document: Record<string, unknown> = {
    server: {
      protocol: runtime?.server?.protocol ?? input.endpoint.protocol,
      host: runtime?.server?.host ?? input.endpoint.host,
      port: runtime?.server?.port ?? input.endpoint.port,
      requestTimeoutMs: runtime?.server?.requestTimeoutMs ?? 30_000,
      longPollTimeoutMs: runtime?.server?.longPollTimeoutMs ?? 45_000,
    },
    agent: {
      id: input.agent.id,
      name: input.agent.name,
      type: input.agent.type,
      secret: input.secret,
      version: runtime?.version ?? "1.0.0",
    },
    machine: {
      type: machineType,
      displayName: runtime?.machine?.displayName ?? input.agent.name,
    },
    intervals: {
      heartbeatSeconds: runtime?.intervals?.heartbeatSeconds ?? 10,
      inventorySeconds: runtime?.intervals?.inventorySeconds ?? 30,
      resourcesSeconds: runtime?.intervals?.resourcesSeconds ?? 30,
    },
    concurrency: { total, apt },
    metrics: { source },
    proxmox: {
      enabled: proxmoxNode,
      ...(resolvedCluster && (proxmoxNode || source === "PROXMOX") ? { clusterId: resolvedCluster } : {}),
      ...(vmid !== undefined && (proxmoxNode || source === "PROXMOX") ? { vmid } : {}),
    },
    logLevel: runtime?.logLevel ?? "info",
  };
  const yaml = `# Déposer ce fichier dans /etc/infra-agent/config.yaml\n# Puis redémarrer le service : systemctl restart infra-agent\n${stringify(document)}`;
  return { yaml, warnings };
}

export function installScriptUrl(endpoint: AgentConfigEndpoint): string {
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  const implied = endpoint.protocol === "https" ? 443 : 80;
  const port = endpoint.port === implied ? "" : `:${endpoint.port}`;
  return `${endpoint.protocol}://${host}${port}/install/run-infractl.sh`;
}

export function renderAgentInstallCommand(yaml: string, scriptUrl: string): string {
  let marker = "INFRACL_CONFIG";
  while (yaml.split("\n").includes(marker)) marker = `${marker}_X`;
  const body = yaml.endsWith("\n") ? yaml.slice(0, -1) : yaml;
  const quoted = `'${scriptUrl.replaceAll("'", `'\\''`)}'`;
  return [
    `curl -fsSL ${quoted} -o /tmp/run-infractl.sh && sudo bash /tmp/run-infractl.sh --mode agent --install --config - <<'${marker}'`,
    body,
    marker,
  ].join("\n");
}
