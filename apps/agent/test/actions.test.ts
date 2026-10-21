import { describe, expect, it } from "vitest";
import type { AgentJob } from "@infra/schemas";
import { agentConfigSchema } from "@infra/schemas";
import { FakeProcessRunner } from "../src/process/fake-runner.js";
import { runRegisteredAction } from "../src/actions/registry.js";
import { parseAptSimulation } from "../src/actions/apt/parse.js";
import { APT_CHECK_ARGS, APT_CHECK_EXECUTABLE } from "../src/adapters/local-linux/apt.js";
import { cpuPercent, parseOsRelease, parseProcNetDev, parseProcStat } from "../src/adapters/local-linux/system.js";
import type { SystemProbe } from "../src/adapters/local-linux/probe.js";
import { interpretPctStatus, parseGuestList, pctStatusArgs } from "../src/proxmox/parse.js";

const config = agentConfigSchema.parse({
  server: { protocol: "http", host: "10.0.0.10", port: 8080 },
  agent: { id: "vm-web-01", type: "linux-node", secret: "change-me-please-now" },
  metrics: { source: "LOCAL_AGENT" },
});

describe("apt.check", () => {
  it("parse une simulation et signale une suppression", () => {
    const parsed = parseAptSimulation(`
Inst bash [5.2.15-2+b7] (5.2.15-2+b8 Debian:12.8/stable-security [amd64])
Inst curl (8.14.1-2 Debian:12.8/stable [amd64])
Remv useless [1.0-1]
Conf bash (5.2.15-2+b8 Debian:12.8/stable-security [amd64])
`);
    expect(parsed.availableCount).toBe(2);
    expect(parsed.securityCount).toBe(1);
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.packages.map((pkg) => pkg.action)).toEqual(["upgrade", "install", "remove"]);
  });

  it("lance apt-get avec des arguments fixes et sans shell", async () => {
    const runner = new FakeProcessRunner(async () => ({
      exitCode: 0,
      stdout: "Inst bash [1] (2 Debian:12/stable [amd64])\n",
      stderr: "",
      durationMs: 4,
      timedOut: false,
      signal: null,
    }));
    const outcome = await runRegisteredAction({
      job: job(),
      runner,
      probe: probe(),
      config,
      signal: new AbortController().signal,
      log: () => undefined,
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      executable: APT_CHECK_EXECUTABLE,
      args: [...APT_CHECK_ARGS],
    });
    expect(runner.calls[0]).not.toHaveProperty("shell");
    expect(outcome.status).toBe("SUCCESS");
    expect(outcome.executable).toBe("apt-get");
    expect(outcome.args).toEqual([...APT_CHECK_ARGS]);
  });

  it("n'exécute pas system.info via un processus", async () => {
    const runner = new FakeProcessRunner(async () => {
      throw new Error("ne doit pas être appelé");
    });
    const outcome = await runRegisteredAction({
      job: { ...job(), action: "system.info", category: "READ" },
      runner,
      probe: probe(),
      config,
      signal: new AbortController().signal,
      log: () => undefined,
    });
    expect(runner.calls).toHaveLength(0);
    expect(outcome.status).toBe("SUCCESS");
    expect(outcome.result).toMatchObject({ hostname: "vm-web-01" });
  });
});

describe("collecteurs locaux et Proxmox", () => {
  it("lit os-release, /proc/stat et /proc/net/dev", () => {
    expect(parseOsRelease('ID=debian\nPRETTY_NAME="Debian GNU/Linux 12"\n')).toMatchObject({
      id: "debian",
      prettyName: "Debian GNU/Linux 12",
    });
    const previous = parseProcStat("cpu  10 0 10 80 0 0 0 0");
    const next = parseProcStat("cpu  20 0 20 80 0 0 0 0");
    expect(previous && next && cpuPercent(previous, next)).toBeGreaterThan(0);
    expect(parseProcNetDev("eth0: 100 0 0 0 0 0 0 0 40 0\nlo: 9 0 0 0 0 0 0 0 9 0\n")).toEqual({
      rx: 100,
      tx: 40,
    });
  });

  it("parse pct list et pct status sans shell interactif", () => {
    expect(pctStatusArgs(101)).toEqual(["status", "101"]);
    expect(() => pctStatusArgs(1.5)).toThrow(/vmid/);
    expect(interpretPctStatus("status: running\n", "", 0)).toBe("running");
    expect(interpretPctStatus("status: stopped\n", "", 0)).toBe("stopped");
    expect(interpretPctStatus("", "Configuration file 'nodes/pve/lxc/101.conf' does not exist", 2)).toBe("missing");
    expect(
      parseGuestList(`[{"vmid":101,"status":"running","name":"ct-web"},{"vmid":102,"status":"stopped","name":"ct-db","lock":"backup"}]`),
    ).toEqual([
      { vmid: 101, name: "ct-web", status: "running", lock: null },
      { vmid: 102, name: "ct-db", status: "stopped", lock: "backup" },
    ]);
    expect(parseGuestList("VMID Status Lock Name\n101 running ct-web\n102 stopped backup ct-db\n")).toEqual([
      { vmid: 101, name: "ct-web", status: "running", lock: null },
      { vmid: 102, name: "ct-db", status: "stopped", lock: "backup" },
    ]);
  });
});

function job(): AgentJob {
  return {
    jobId: "5f0b6b0a-2a7e-4c1d-9c2a-1b0d5e6f7a8b",
    action: "apt.check",
    category: "READ",
    target: {
      machineId: "5f0b6b0a-2a7e-4c1d-9c2a-1b0d5e6f7a8c",
      machineType: "VM",
      hostname: "vm-web-01",
    },
  };
}

function probe(): SystemProbe {
  return {
    async inspect() {
      return {
        hostname: "vm-web-01",
        kernel: "6.1.0",
        arch: "x64",
        platform: "linux",
        uptimeSeconds: 10,
        os: { id: "debian", prettyName: "Debian GNU/Linux 12" },
        cpu: { model: "test", cores: 2 },
        memory: { totalBytes: 1000, freeBytes: 400 },
        rebootRequired: false,
      };
    },
    async rebootRequired() {
      return false;
    },
    async readCpu() {
      return { idle: 1, total: 2 };
    },
    async readNetwork() {
      return { rx: 1, tx: 2 };
    },
    async readDisk() {
      return null;
    },
  };
}
