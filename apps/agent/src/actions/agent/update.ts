import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { unpackTar } from "@infra/utils";
import { SAFE_PROCESS_ENV } from "../../adapters/local-linux/apt.js";
import type { ProcessRunner } from "../../process/types.js";

const PREFIXES = [
  "apps/agent/dist",
  "packages/types/dist",
  "packages/schemas/dist",
  "packages/protocol/dist",
  "packages/utils/dist",
] as const;

const UPDATE_ENV: NodeJS.ProcessEnv = {
  ...SAFE_PROCESS_ENV,
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: homedir(),
  GIT_TERMINAL_PROMPT: "0",
  NEEDRESTART_MODE: "l",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

export type AgentUpdateOutcome = {
  status: "SUCCESS" | "FAILED" | "INTERRUPTED";
  exitCode: number | null;
  errorCode?: string;
  errorMessage?: string;
  result?: Record<string, unknown>;
  executable: string | null;
  args: string[] | null;
};

export function scriptUpdateCommand(root: string): { executable: string; args: string[] } {
  return {
    executable: join(root, "run-infractl.sh"),
    args: ["--mode", "agent", "--update", "--no-restart", "--root", root],
  };
}

export async function detectInstallRoot(start: string): Promise<string> {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await access(join(dir, "run-infractl.sh"));
      await access(join(dir, "apps", "agent", "package.json"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  throw new Error("installation de l'agent introuvable");
}

export async function performAgentUpdate(input: {
  mode: "script" | "server";
  root: string;
  runner: ProcessRunner;
  signal: AbortSignal;
  log: (stream: "stdout" | "stderr" | "system", data: string) => void;
  timeoutMs: number;
  download: () => Promise<Uint8Array>;
}): Promise<AgentUpdateOutcome> {
  if (input.mode === "server") {
    return updateFromServer(input);
  }
  return updateFromScript(input);
}

async function updateFromScript(input: {
  root: string;
  runner: ProcessRunner;
  signal: AbortSignal;
  log: (stream: "stdout" | "stderr" | "system", data: string) => void;
  timeoutMs: number;
}): Promise<AgentUpdateOutcome> {
  const command = scriptUpdateCommand(input.root);
  try {
    await access(command.executable);
    await chmod(command.executable, 0o755);
  } catch {
    return failed(command, "le script run-infractl.sh est absent de l'installation");
  }
  input.log("system", "mise à jour par le script");
  const result = await input.runner.run({
    executable: command.executable,
    args: command.args,
    cwd: input.root,
    timeoutMs: input.timeoutMs,
    env: UPDATE_ENV,
    allowSigkill: true,
    sigkillAfterMs: 5_000,
    signal: input.signal,
    onChunk: (chunk) => input.log(chunk.stream, chunk.data),
  });
  if (input.signal.aborted) {
    return {
      status: "INTERRUPTED",
      exitCode: result.exitCode,
      errorCode: "AGENT_SHUTDOWN",
      errorMessage: "agent arrêté pendant la mise à jour",
      executable: command.executable,
      args: command.args,
    };
  }
  if (result.timedOut) {
    return {
      status: "INTERRUPTED",
      exitCode: result.exitCode,
      errorCode: "TIMEOUT",
      errorMessage: "la mise à jour a dépassé son délai",
      executable: command.executable,
      args: command.args,
    };
  }
  if (result.exitCode !== 0) {
    return failed(command, "la mise à jour par le script a échoué", result.exitCode);
  }
  return {
    status: "SUCCESS",
    exitCode: 0,
    executable: command.executable,
    args: command.args,
    result: { mode: "script" },
  };
}

async function updateFromServer(input: {
  root: string;
  log: (stream: "stdout" | "stderr" | "system", data: string) => void;
  download: () => Promise<Uint8Array>;
}): Promise<AgentUpdateOutcome> {
  input.log("system", "téléchargement du code depuis le serveur");
  let bytes: Uint8Array;
  try {
    bytes = await input.download();
  } catch (error) {
    return failed(null, error instanceof Error ? error.message : "téléchargement impossible");
  }
  try {
    const files = await applyServerBundle(input.root, bytes);
    input.log("system", `${files} fichiers reçus`);
    return {
      status: "SUCCESS",
      exitCode: 0,
      executable: null,
      args: null,
      result: { mode: "server", files },
    };
  } catch (error) {
    return failed(null, error instanceof Error ? error.message : "installation du code impossible");
  }
}

export async function applyServerBundle(root: string, bytes: Uint8Array): Promise<number> {
  const files = unpackTar(bytes);
  if (!files.some((file) => file.name === "apps/agent/dist/index.js")) {
    throw new Error("archive sans le programme de l'agent");
  }
  const present = new Set<string>();
  for (const file of files) {
    const prefix = PREFIXES.find((item) => file.name.startsWith(`${item}/`));
    if (!prefix) {
      throw new Error("fichier hors du code agent");
    }
    assertInside(root, file.name);
    present.add(prefix);
  }
  const staging = join(root, ".agent-update");
  await rm(staging, { recursive: true, force: true });
  for (const file of files) {
    const destination = join(staging, file.name);
    assertInside(staging, file.name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.data, { mode: 0o644 });
  }
  for (const prefix of PREFIXES) {
    if (!present.has(prefix)) {
      continue;
    }
    const current = join(root, prefix);
    const staged = join(staging, prefix);
    const backup = `${current}.previous`;
    await rm(backup, { recursive: true, force: true });
    let moved = false;
    try {
      await rename(current, backup);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    try {
      await mkdir(dirname(current), { recursive: true });
      await rename(staged, current);
    } catch (error) {
      if (moved) {
        await rename(backup, current).catch(() => undefined);
      }
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  }
  await rm(staging, { recursive: true, force: true });
  return files.length;
}

function assertInside(root: string, name: string): void {
  const resolved = resolve(root, name);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("chemin d'archive refusé");
  }
}

function failed(
  command: { executable: string; args: string[] } | null,
  message: string,
  exitCode: number | null = null,
): AgentUpdateOutcome {
  return {
    status: "FAILED",
    exitCode,
    errorCode: "PROCESS_FAILED",
    errorMessage: message.slice(0, 500),
    executable: command?.executable ?? null,
    args: command?.args ?? null,
  };
}
