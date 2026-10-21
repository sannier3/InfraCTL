import { describe, expect, it } from "vitest";
import { actionRequestSchema, agentJobSchema, systemdUnitSchema, vmidSchema } from "../src/index.js";

describe("validation des requêtes", () => {
  it("refuse une commande shell dans une demande d'action", () => {
    const parsed = actionRequestSchema.safeParse({
      action: "apt.check",
      selector: { type: "fleet" },
      command: "apt-get update",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuse un job agent qui transporte une commande", () => {
    const parsed = agentJobSchema.safeParse({
      jobId: "5f0b6b0a-2a7e-4c1d-9c2a-1b0d5e6f7a8b",
      action: "system.info",
      category: "READ",
      target: {
        machineId: "5f0b6b0a-2a7e-4c1d-9c2a-1b0d5e6f7a8c",
        machineType: "PHYSICAL",
        hostname: "host",
      },
      command: "uname -a",
    });
    expect(parsed.success).toBe(false);
  });

  it("valide les VMID comme des entiers", () => {
    expect(vmidSchema.safeParse(101).success).toBe(true);
    expect(vmidSchema.safeParse(101.5).success).toBe(false);
    expect(vmidSchema.safeParse(0).success).toBe(false);
    expect(vmidSchema.safeParse("101").success).toBe(false);
  });

  it("valide les noms d'unités systemd", () => {
    expect(systemdUnitSchema.safeParse("nginx.service").success).toBe(true);
    expect(systemdUnitSchema.safeParse("nginx;reboot").success).toBe(false);
    expect(systemdUnitSchema.safeParse("-bad").success).toBe(false);
    expect(systemdUnitSchema.safeParse("foo bar").success).toBe(false);
  });
});
