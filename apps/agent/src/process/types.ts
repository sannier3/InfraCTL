export type ProcessChunk = {
  stream: "stdout" | "stderr";
  data: string;
};

/**
 * L'appelant ne peut pas demander un shell.
 * `shell: false` est imposé par SpawnProcessRunner.
 */
export type ProcessRequest = {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowSigkill: boolean;
  sigkillAfterMs?: number;
  onChunk?: (chunk: ProcessChunk) => void;
  signal?: AbortSignal;
};

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
};

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

const EXECUTABLE = /^[A-Za-z0-9_./+-]+$/;

export function assertProcessRequest(request: ProcessRequest): void {
  if (!EXECUTABLE.test(request.executable)) {
    throw new Error("exécutable refusé");
  }
  for (const arg of request.args) {
    if (typeof arg !== "string" || arg.includes("\0") || arg.includes("\n") || arg.includes("\r")) {
      throw new Error("argument refusé");
    }
  }
}
