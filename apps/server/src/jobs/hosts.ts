import type { MachineRecord } from "../database/records.js";

const HOST_RANK: Record<string, number> = {
  PROXMOX_NODE: 0,
  PHYSICAL: 1,
  VM: 2,
};

export function chooseAgentHost(machines: readonly MachineRecord[], agentId: string): MachineRecord | null {
  const owned = machines.filter(
    (machine) => machine.agentId === agentId && machine.hiddenAt === null && machine.type !== "LXC",
  );
  owned.sort(
    (left, right) =>
      (HOST_RANK[left.type] ?? 9) - (HOST_RANK[right.type] ?? 9) || left.displayName.localeCompare(right.displayName, "fr"),
  );
  return owned[0] ?? null;
}
