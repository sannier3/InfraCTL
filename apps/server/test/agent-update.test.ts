import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unpackTar } from "@infra/utils";
import type { MachineRecord } from "../src/database/records.js";
import { readAgentBundle } from "../src/agents/bundle.js";
import { chooseAgentHost } from "../src/jobs/hosts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hôte d'un agent", () => {
  it("choisit le nœud plutôt qu'un invité qui partage le même agent", () => {
    const node = machine("node", "PROXMOX_NODE", "pve-r730");
    const guest = machine("guest", "LXC", "pve-r730");
    const vm = machine("vm", "VM", "pve-r730");
    expect(chooseAgentHost([guest, vm, node], "pve-r730")?.id).toBe("node");
    expect(chooseAgentHost([guest], "pve-r730")).toBeNull();
    expect(chooseAgentHost([machine("hidden", "VM", "linux", { hiddenAt: new Date() }), machine("visible", "VM", "linux")], "linux")?.id).toBe("visible");
  });
});

describe("code agent servi par le serveur", () => {
  it("empaquette le code compilé et laisse le reste du dépôt", async () => {
    const root = await mkdtemp(join(tmpdir(), "infra-bundle-"));
    roots.push(root);
    await mkdir(join(root, "apps", "agent", "dist"), { recursive: true });
    await mkdir(join(root, "apps", "agent"), { recursive: true });
    await writeFile(join(root, "apps", "agent", "dist", "index.js"), "agent", "utf8");
    await writeFile(join(root, "apps", "agent", "secret.txt"), "secret", "utf8");
    await writeFile(join(root, "apps", "agent", "dist", "note temporaire.js"), "ignore", "utf8");
    const packed = await readAgentBundle(root);
    const names = unpackTar(packed).map((file) => file.name);
    expect(names).toContain("apps/agent/dist/index.js");
    expect(names).not.toContain("apps/agent/secret.txt");
    expect(names.some((name) => name.includes(" "))).toBe(false);
    expect(unpackTar(packed).find((file) => file.name === "apps/agent/dist/index.js")?.data.toString()).toBe("agent");
  });
});

function machine(
  id: string,
  type: MachineRecord["type"],
  agentId: string,
  extra: Partial<MachineRecord> = {},
): MachineRecord {
  const now = new Date(0);
  return {
    id,
    hostname: id,
    displayName: id,
    type,
    status: "RUNNING",
    metricsSource: "LOCAL_AGENT",
    agentId,
    lastSeenAt: null,
    lastStateChangeAt: now,
    hiddenAt: null,
    details: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}
