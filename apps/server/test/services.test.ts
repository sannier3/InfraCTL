import { describe, expect, it } from "vitest";
import { aggregateSurveys } from "../src/runtime/survey.js";

describe("relevé des services", () => {
  it("regroupe les ports et signale un projet Compose arrêté", () => {
    const view = aggregateSurveys([
      {
        machineId: "machine-a",
        result: {
          listeners: [
            { protocol: "tcp", address: "0.0.0.0", port: 22 },
            { protocol: "tcp", address: "127.0.0.1", port: 8080 },
          ],
          docker: {
            installed: true,
            active: true,
            enabled: true,
            containers: [{ id: "abcdef123456", name: "web", image: "nginx", state: "running", ports: "8080/tcp" }],
          },
          projects: [{ directory: "/opt/idle", file: "compose.yml", active: false, services: 0, running: 0 }],
        },
      },
      {
        machineId: "machine-b",
        result: {
          listeners: [{ protocol: "tcp", address: "0.0.0.0", port: 22 }],
          docker: { installed: false, active: false, enabled: false, containers: [] },
          projects: [],
        },
      },
    ]);
    expect(view.ports[0]).toMatchObject({ protocol: "tcp", port: 22, machineCount: 2 });
    expect(view.hosts).toHaveLength(2);
    expect(view.projects).toEqual([
      { machineId: "machine-a", directory: "/opt/idle", file: "compose.yml", active: false, services: 0, running: 0 },
    ]);
  });
});
