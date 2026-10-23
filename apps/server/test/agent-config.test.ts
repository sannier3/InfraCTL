import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { agentConfigSchema } from "@infra/schemas";
import { buildApp } from "../src/api/app.js";
import { endpointFromRequest, installScriptUrl, renderAgentConfig, renderAgentInstallCommand } from "../src/agents/config-file.js";
import { MemoryStore } from "../src/database/memory-store.js";
import { testConfig } from "./helpers.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");
const ADMIN = { authorization: "Bearer dev-admin-token-change" };
const READER = { authorization: "Bearer dev-reader-token-change" };
const SECRET = "agent-secret-value-1";

describe("configuration agent", () => {
  it("reprend l'adresse du site quand l'agent n'a pas encore la sienne", () => {
    const endpoint = endpointFromRequest("infra.exemple.fr", "http", "https", 8085);
    expect(endpoint).toEqual({ protocol: "https", host: "infra.exemple.fr", port: 443 });
    expect(endpointFromRequest("192.168.100.30:8085", "http", undefined, 8080)).toEqual({
      protocol: "http",
      host: "192.168.100.30",
      port: 8085,
    });
  });

  it("produit un fichier accepté par l'agent, avec le secret", () => {
    const rendered = renderAgentConfig({
      agent: { id: "pve-01", name: "PVE", type: "proxmox-node", maxConcurrency: 7 },
      secret: SECRET,
      runtime: { concurrency: { total: 7, apt: 7 }, proxmox: { enabled: true, clusterId: "pve" } },
      endpoint: { protocol: "http", host: "10.0.0.10", port: 8080 },
      clusterSlug: null,
    });
    const parsed = agentConfigSchema.parse(parse(rendered.yaml));
    expect(parsed.agent).toMatchObject({ id: "pve-01", type: "proxmox-node", secret: SECRET });
    expect(parsed.proxmox).toMatchObject({ enabled: true, clusterId: "pve" });
    expect(parsed.concurrency).toEqual({ total: 7, apt: 7 });
    expect(parsed.machine.type).toBe("PHYSICAL");
    const command = renderAgentInstallCommand(`${rendered.yaml}\nINFRACL_CONFIG\n`, installScriptUrl({ protocol: "https", host: "infra.exemple.fr", port: 443 }));
    expect(command).toContain("curl -fsSL 'https://infra.exemple.fr/install/run-infractl.sh'");
    expect(command).toContain("--config -");
    expect(command).toContain(SECRET);
    expect(command.trimEnd().endsWith("INFRACL_CONFIG_X")).toBe(true);
  });

  it("réserve le fichier à un administrateur", async () => {
    const store = new MemoryStore();
    const built = await buildApp({ config: testConfig(), store, now: () => NOW, startScheduler: false });
    const base = await listen(built.app);
    await fetch(`${base}/api/v1/agents`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ id: "edge-01", type: "linux-node", secret: SECRET, name: "Bordure" }),
    });
    const reader = await fetch(`${base}/api/v1/agents/edge-01/config`, { headers: READER });
    expect(reader.status).toBe(403);
    const response = await fetch(`${base}/api/v1/agents/edge-01/config`, { headers: ADMIN });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { yaml: string; warnings: string[]; command: string };
    const parsed = agentConfigSchema.parse(parse(body.yaml));
    expect(parsed.agent.secret).toBe(SECRET);
    expect(parsed.server.host).toBe("127.0.0.1");
    expect(parsed.machine.type).toBe("VM");
    expect(body.command).toContain(`http://127.0.0.1:${new URL(base).port}/install/run-infractl.sh`);
    expect(body.command).toContain("--mode agent --install --config -");
    const script = await fetch(`${base}/install/run-infractl.sh`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("--config FICHIER");
    const listed = await fetch(`${base}/api/v1/agents/edge-01`, { headers: ADMIN });
    expect(JSON.stringify(await listed.json())).not.toContain(SECRET);
    await built.app.close();
  });
});

async function listen(app: {
  listen: (options: { host: string; port: number }) => Promise<string>;
  server: { address: () => string | { port: number } | null };
}): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("port introuvable");
  return `http://127.0.0.1:${address.port}`;
}
