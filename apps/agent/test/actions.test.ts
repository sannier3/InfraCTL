import { describe, expect, it } from "vitest";
import type { AgentJob } from "@infra/schemas";
import { agentConfigSchema } from "@infra/schemas";
import { FakeProcessRunner } from "../src/process/fake-runner.js";
import { runRegisteredAction } from "../src/actions/registry.js";
import { parseAptSimulation } from "../src/actions/apt/parse.js";
import { APT_CHECK_ARGS, APT_CHECK_EXECUTABLE, APT_UPGRADE_ARGS, APT_UPGRADE_EXECUTABLE } from "../src/adapters/local-linux/apt.js";
import { cpuPercent, parseOsRelease, parseProcNetDev, parseProcStat } from "../src/adapters/local-linux/system.js";
import type { SystemProbe } from "../src/adapters/local-linux/probe.js";
import { interpretPctStatus, parseGuestList, parsePveVersion, pctStatusArgs } from "../src/proxmox/parse.js";

const config = agentConfigSchema.parse({
  server: { protocol: "http", host: "10.0.0.10", port: 8080 },
  agent: { id: "vm-web-01", type: "linux-node", secret: "change-me-please-now" },
  metrics: { source: "LOCAL_AGENT" },
});

const proxmoxConfig = agentConfigSchema.parse({
  server: { protocol: "http", host: "10.0.0.10", port: 8080 },
  agent: { id: "pve-r730", type: "proxmox-node", secret: "change-me-please-now" },
  proxmox: { enabled: true, clusterId: "pve" },
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

describe("apt.upgrade", () => {
  it("installe après simulation sur une VM et sur un hôte", async () => {
    for (const machineType of ["VM", "PROXMOX_NODE"] as const) {
      const runner = new FakeProcessRunner(async (request) => ({
        exitCode: 0,
        stdout: request.args.includes("-s") ? "Inst bash [1] (2 Debian:12/stable [amd64])\n" : "",
        stderr: "",
        durationMs: 4,
        timedOut: false,
        signal: null,
      }));
      const outcome = await runRegisteredAction({
        job: { ...job(), action: "apt.upgrade", category: "WRITE", target: { ...job().target, machineType } },
        runner,
        probe: probe(),
        config,
        signal: new AbortController().signal,
        log: () => undefined,
      });
      expect(outcome.status).toBe("SUCCESS");
      expect(runner.calls.map((call) => call.args)).toEqual([[...APT_CHECK_ARGS], [...APT_UPGRADE_ARGS]]);
      expect(runner.calls.every((call) => call.executable === APT_UPGRADE_EXECUTABLE || call.executable === APT_CHECK_EXECUTABLE)).toBe(true);
      expect(outcome.executable).toBe(APT_UPGRADE_EXECUTABLE);
      expect(outcome.args).toEqual([...APT_UPGRADE_ARGS]);
    }
  });

  it("n'installe pas si la simulation retire un paquet", async () => {
    const runner = new FakeProcessRunner(async () => ({
      exitCode: 0,
      stdout: "Inst bash [1] (2 Debian:12/stable [amd64])\nRemv old [1]\n",
      stderr: "",
      durationMs: 4,
      timedOut: false,
      signal: null,
    }));
    const outcome = await runRegisteredAction({
      job: { ...job(), action: "apt.upgrade", category: "WRITE" },
      runner,
      probe: probe(),
      config,
      signal: new AbortController().signal,
      log: () => undefined,
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toEqual([...APT_CHECK_ARGS]);
    expect(outcome.errorCode).toBe("REQUIRES_CONFIRMATION");
    expect(outcome.result).toMatchObject({ requiresConfirmation: true });
  });

  it("refuse une cible LXC sans lancer apt-get", async () => {
    const runner = new FakeProcessRunner(async () => {
      throw new Error("ne doit pas être appelé");
    });
    const outcome = await runRegisteredAction({
      job: {
        ...job(),
        action: "apt.upgrade",
        category: "WRITE",
        target: { ...job().target, machineType: "LXC", guest: { vmid: 101, guestType: "LXC", clusterId: "production" } },
      },
      runner,
      probe: probe(),
      config,
      signal: new AbortController().signal,
      log: () => undefined,
    });
    expect(runner.calls).toHaveLength(0);
    expect(outcome.status).toBe("SKIPPED");
    expect(outcome.errorCode).toBe("INCOMPATIBLE_TARGET");
  });

  it("passe par pct exec sur un LXC quand l'agent est proxmox-node", async () => {
    const runner = new FakeProcessRunner(async (request) => ({
      exitCode: 0,
      stdout: request.args[0] === "status" ? "status: running\n" : request.args.includes("-s") ? "Inst bash [1] (2 Debian:12/stable [amd64])\n" : "",
      stderr: "",
      durationMs: 4,
      timedOut: false,
      signal: null,
    }));
    const outcome = await runRegisteredAction({
      job: {
        ...job(),
        action: "apt.upgrade",
        category: "WRITE",
        target: {
          ...job().target,
          machineType: "LXC",
          guest: { vmid: 101, guestType: "LXC", clusterId: "5f0b6b0a-2a7e-4c1d-9c2a-1b0d5e6f7a8d" },
        },
      },
      runner,
      probe: probe(),
      config: proxmoxConfig,
      signal: new AbortController().signal,
      log: () => undefined,
    });
    expect(outcome.status).toBe("SUCCESS");
    expect(runner.calls[0]?.args).toEqual(["status", "101"]);
    const simulation = runner.calls.find((call) => call.args.includes("-s"));
    const upgrade = runner.calls.find((call) => call.args.includes("upgrade") && !call.args.includes("-s"));
    expect(simulation?.args.slice(0, 4)).toEqual(["exec", "101", "--", "apt-get"]);
    expect(upgrade?.args.slice(0, 4)).toEqual(["exec", "101", "--", "apt-get"]);
    expect(runner.calls.every((call) => call.executable === "pct")).toBe(true);
  });

  it("refuse une unité systemd invalide sans lancer de processus", async () => {
    const runner = new FakeProcessRunner(async () => {
      throw new Error("ne doit pas être appelé");
    });
    const outcome = await runRegisteredAction({
      job: { ...job(), action: "systemd.restart", category: "WRITE", target: { ...job().target, parameters: { unit: "nginx;reboot" } } },
      runner,
      probe: probe(),
      config,
      signal: new AbortController().signal,
      log: () => undefined,
    });
    expect(runner.calls).toHaveLength(0);
    expect(outcome.errorCode).toBe("VALIDATION_ERROR");
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
    expect(parsePveVersion("pve-manager/9.0.11/abc123 (running kernel: 7.0.14-11-pve)\n")).toBe("9.0.11");
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
    expect(parseGuestList(`[{"vmid":200,"status":"stopped","mem":0,"maxmem":2048,"cpu":1,"maxcpu":2}]`)).toEqual([
      { vmid: 200, name: "200", status: "stopped", lock: null, cpu: 50, memoryUsed: 0, memoryTotal: 2048 },
    ]);
  });

  it("inventorie les LXC et les VM via pvesh", async () => {
    const runner = new FakeProcessRunner(async (request) => {
      const path = request.args[1];
      const stdout =
        request.executable === "pveversion"
          ? "pve-manager/9.2.21/abc123\n"
          : path === "/nodes/localhost/lxc"
            ? `[{"vmid":11401,"status":"running","name":"ct-a","mem":10,"maxmem":20,"cpu":0.5,"maxcpu":2}]`
            : path === "/nodes/localhost/qemu"
              ? `[{"vmid":200,"status":"stopped","name":"vm-b"}]`
              : "";
      return { exitCode: stdout.length > 0 ? 0 : 1, stdout, stderr: "", durationMs: 1, timedOut: false, signal: null };
    });
    const outcome = await runRegisteredAction({
      job: {
        ...job(),
        action: "proxmox.inventory",
        category: "READ",
        target: { ...job().target, machineType: "PROXMOX_NODE", hostname: "pve-r730" },
      },
      runner,
      probe: probe(),
      config: proxmoxConfig,
      signal: new AbortController().signal,
      log: () => undefined,
    });
    expect(outcome.status).toBe("SUCCESS");
    expect(outcome.executable).toBe("pvesh");
    expect(outcome.args).toEqual(["get", "/nodes/localhost/lxc", "--output-format", "json"]);
    expect(runner.calls.some((call) => call.args[1] === "/nodes/localhost/qemu")).toBe(true);
    expect(outcome.result).toMatchObject({
      node: { clusterId: "pve", name: "vm-web-01", version: "9.2.21" },
      guests: [
        { vmid: 11401, guestType: "LXC", name: "ct-a", status: "running", cpu: 25, memoryUsed: 10, memoryTotal: 20 },
        { vmid: 200, guestType: "QEMU", name: "vm-b", status: "stopped" },
      ],
    });
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
