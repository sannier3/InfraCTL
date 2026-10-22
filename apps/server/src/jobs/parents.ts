import type { JobStatus } from "@infra/types";

/**
 * Le statut d'un parent est dérivé. Il ne suit pas la machine à états des feuilles :
 * un enfant SKIPPED ne fait pas échouer le lot, un UNKNOWN reste visible.
 */
export function aggregateParentStatus(children: readonly JobStatus[]): JobStatus {
  if (children.length === 0) {
    return "SUCCESS";
  }
  if (children.some((status) => status === "RUNNING" || status === "ASSIGNED")) {
    return "RUNNING";
  }
  if (children.every((status) => status === "QUEUED")) {
    return "QUEUED";
  }
  if (children.some((status) => status === "QUEUED")) {
    return "RUNNING";
  }
  if (children.some((status) => status === "UNKNOWN")) {
    return "UNKNOWN";
  }
  if (children.some((status) => status === "INTERRUPTED")) {
    return "INTERRUPTED";
  }
  if (children.some((status) => status === "REQUIRES_CONFIRMATION")) {
    return "REQUIRES_CONFIRMATION";
  }
  if (children.some((status) => status === "FAILED")) {
    return "FAILED";
  }
  if (children.some((status) => status === "SUCCESS")) {
    return "SUCCESS";
  }
  if (children.every((status) => status === "SKIPPED")) {
    return "SKIPPED";
  }
  if (children.every((status) => status === "CANCELLED")) {
    return "CANCELLED";
  }
  return "FAILED";
}

export function parentOutcome(children: readonly { exitCode: number | null; agentId: string | null }[]): {
  exitCode: number | null;
  agentId: string | null;
} {
  const codes = children.flatMap((child) => (child.exitCode === null ? [] : [child.exitCode]));
  const agents = [...new Set(children.flatMap((child) => (child.agentId ? [child.agentId] : [])))];
  return {
    exitCode: codes.find((code) => code !== 0) ?? (codes.length > 0 ? 0 : null),
    agentId: agents.length === 1 ? agents[0] ?? null : null,
  };
}

export function elapsedMs(startedAt: Date | null, finishedAt: Date | null): number | null {
  if (!startedAt || !finishedAt) {
    return null;
  }
  return Math.min(Math.max(0, finishedAt.getTime() - startedAt.getTime()), 2_147_483_647);
}

export function parentCounts(children: readonly JobStatus[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of children) {
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}
