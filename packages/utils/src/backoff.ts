export const BACKOFF_STEPS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export const BACKOFF_MAX_MS = 30_000;

/**
 * Délai de reconnexion avec jitter de 0 à 20 %.
 * Les paliers sont 1 s, 2 s, 5 s, 10 s puis 30 s maximum.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(0, attempt), BACKOFF_STEPS_MS.length - 1);
  const base = BACKOFF_STEPS_MS[index] ?? BACKOFF_MAX_MS;
  const jitter = Math.round(base * 0.2 * Math.min(1, Math.max(0, random())));
  return Math.min(BACKOFF_MAX_MS, base + jitter);
}
