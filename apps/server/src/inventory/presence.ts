import type { AgentPresence, MachineStatus } from "@infra/types";

export function presenceFromLastSeen(
  lastSeenAt: Date | null,
  now: Date,
  unreachableAfterSeconds: number,
  offlineAfterSeconds: number,
): AgentPresence {
  if (!lastSeenAt) {
    return "OFFLINE";
  }
  const ageSeconds = (now.getTime() - lastSeenAt.getTime()) / 1000;
  if (ageSeconds < unreachableAfterSeconds) {
    return "ONLINE";
  }
  if (ageSeconds < offlineAfterSeconds) {
    return "UNREACHABLE";
  }
  return "OFFLINE";
}

export function shouldHideStopped(
  status: MachineStatus,
  lastStateChangeAt: Date,
  now: Date,
  hideStoppedAfterSeconds: number,
): boolean {
  if (status !== "STOPPED") {
    return false;
  }
  return now.getTime() - lastStateChangeAt.getTime() >= hideStoppedAfterSeconds * 1000;
}
