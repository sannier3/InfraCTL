import { describe, expect, it } from "vitest";
import {
  ACTION_CATALOG,
  ACTION_NAMES,
  JOB_TRANSITIONS,
  canTransition,
  isTerminalStatus,
} from "../src/index.js";

describe("catalogue d'actions", () => {
  it("ne contient aucun champ de commande", () => {
    for (const name of ACTION_NAMES) {
      const definition = ACTION_CATALOG[name];
      expect(definition.name).toBe(name);
      expect(Object.keys(definition)).not.toContain("command");
      expect(Object.keys(definition)).not.toContain("shell");
      expect(definition.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("active system.info, apt.check et apt.upgrade sur hôte, LXC et VM", () => {
    const enabled = ACTION_NAMES.filter((name) => ACTION_CATALOG[name].enabled);
    expect(enabled.sort()).toEqual(["apt.check", "apt.upgrade", "system.info"]);
    for (const name of ["system.info", "apt.check", "apt.upgrade"] as const) {
      expect(ACTION_CATALOG[name].supportedTargets).toEqual(
        expect.arrayContaining(["PROXMOX_NODE", "LXC", "VM", "PHYSICAL"]),
      );
    }
  });

  it("marque les actions mutantes comme non rejouables automatiquement", () => {
    for (const name of ACTION_NAMES) {
      const definition = ACTION_CATALOG[name];
      if (definition.mutating) {
        expect(definition.neverAutoRetry).toBe(true);
      }
    }
  });
});

describe("transitions de jobs", () => {
  it("laisse UNKNOWN terminal", () => {
    expect(isTerminalStatus("UNKNOWN")).toBe(true);
    expect(JOB_TRANSITIONS.UNKNOWN).toEqual([]);
    expect(canTransition("UNKNOWN", "QUEUED")).toBe(false);
    expect(canTransition("UNKNOWN", "RUNNING")).toBe(false);
    expect(canTransition("UNKNOWN", "FAILED")).toBe(false);
  });

  it("autorise le cycle nominal", () => {
    expect(canTransition("QUEUED", "ASSIGNED")).toBe(true);
    expect(canTransition("ASSIGNED", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "SUCCESS")).toBe(true);
    expect(canTransition("RUNNING", "UNKNOWN")).toBe(true);
    expect(canTransition("SUCCESS", "QUEUED")).toBe(false);
  });
});
