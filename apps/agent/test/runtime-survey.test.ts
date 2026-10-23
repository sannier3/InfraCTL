import { describe, expect, it } from "vitest";
import type { AgentJob } from "@infra/schemas";
import { agentConfigSchema } from "@infra/schemas";
import { runRegisteredAction } from "../src/actions/registry.js";
import { acceptComposePath, parseListeners } from "../src/actions/runtime/survey.js";
import type { SystemProbe } from "../src/adapters/local-linux/probe.js";
import { FakeProcessRunner } from "../src/process/fake-runner.js";
import type { ProcessRequest, ProcessResult } from "../src/process/types.js";

const config = agentConfigSchema.parse({
  server: { protocol: "http", host: "10.0.0.10", port: 8080 },
  agent: { id: "vm-web-01", type: "linux-node", secret: "change-me-please-now" },
  metrics: { source: "LOCAL_AGENT" },
});

describe("runtime.survey", () => {
  it("ignore un chemin Compose qui sort de /opt", () => {
    expect(acceptComposePath("/opt/web/docker-compose.yml")).toEqual({ directory: "/opt/web", file: "docker-compose.yml" });
    expect(acceptComposePath("/opt/../etc/compose.yml")).toBeNull();
    expect(acceptComposePath("/tmp/compose.yml")).toBeNull();
  });

  it("lit les ports en écoute", () => {
    expect(parseListeners("tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nudp UNCONN 0 0 127.0.0.1:68 0.0.0.0:*\n")).toEqual([
      { protocol: "tcp", address: "0.0.0.0", port: 22 },
      { protocol: "udp", address: "127.0.0.1", port: 68 },
    ]);
  });

  it("relève les ports, Docker et les projets déjà actifs", async () => {
    const runner = new FakeProcessRunner(async (request) => answer(request));
    const outcome = await runRegisteredAction({
      job: { ...job(), action: "runtime.survey", category: "READ" },
      runner,
      probe: probe(),
      config,
      signal: new AbortController().signal,
      log: () => undefined,
    });
    expect(outcome.status).toBe("SUCCESS");
    expect(outcome.result).toMatchObject({
      listeners: [{ protocol: "tcp", address: "0.0.0.0", port: 22 }],
      docker: { installed: true, active: true, enabled: true },
      projects: [{ directory: "/opt/web", file: "docker-compose.yml", active: true, services: 1, running: 1 }],
    });
    expect(JSON.stringify(outcome.result)).not.toContain("/opt/../");
  });
});

function answer(request: ProcessRequest): ProcessResult {
  const base = { stderr: "", durationMs: 1, timedOut: false, signal: null as NodeJS.Signals | null };
  if (request.executable === "ss") {
    return { ...base, exitCode: 0, stdout: "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n" };
  }
  if (request.executable === "systemctl" && request.args[0] === "is-active") {
    return { ...base, exitCode: 0, stdout: "active\n" };
  }
  if (request.executable === "systemctl") {
    return { ...base, exitCode: 0, stdout: "enabled\n" };
  }
  if (request.executable === "docker" && request.args[0] === "version") {
    return { ...base, exitCode: 0, stdout: "27.0.0\n" };
  }
  if (request.executable === "docker") {
    return {
      ...base,
      exitCode: 0,
      stdout: `${JSON.stringify({
        ID: "abcdef1234567890",
        Names: "web",
        Image: "nginx:1",
        State: "running",
        Ports: "0.0.0.0:8080->80/tcp",
        Labels: "com.docker.compose.project.working_dir=/opt/web",
      })}\n`,
    };
  }
  return { ...base, exitCode: 0, stdout: "/opt/web/docker-compose.yml\n/opt/../etc/compose.yml\n" };
}

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
    addresses: () => [],
    async inspect() {
      return {
        hostname: "vm-web-01",
        kernel: "6.1.0",
        arch: "x64",
        platform: "linux",
        uptimeSeconds: 10,
        os: { id: "debian", prettyName: "Debian" },
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
  };
}
