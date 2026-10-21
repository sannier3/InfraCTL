import { spawn } from "node:child_process";
import { assertProcessRequest, type ProcessRequest, type ProcessResult, type ProcessRunner } from "./types.js";

const OUTPUT_LIMIT = 1_000_000;

export class SpawnProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    assertProcessRequest(request);
    const started = Date.now();
    return await new Promise((resolve) => {
      const child = spawn(request.executable, [...request.args], {
        shell: false,
        windowsHide: true,
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (request.allowSigkill) {
            child.kill("SIGKILL");
          } else if (!settled) {
            finish(null, "SIGTERM");
          }
        }, request.sigkillAfterMs ?? 5_000);
      }, request.timeoutMs);

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (request.signal) {
          request.signal.removeEventListener("abort", onAbort);
        }
        resolve({
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
          signal,
        });
      };

      const onAbort = (): void => {
        child.kill("SIGTERM");
      };
      if (request.signal) {
        if (request.signal.aborted) {
          onAbort();
        } else {
          request.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        const data = chunk.toString("utf8");
        if (stdout.length < OUTPUT_LIMIT) {
          stdout += data.slice(0, OUTPUT_LIMIT - stdout.length);
        }
        request.onChunk?.({ stream: "stdout", data });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const data = chunk.toString("utf8");
        if (stderr.length < OUTPUT_LIMIT) {
          stderr += data.slice(0, OUTPUT_LIMIT - stderr.length);
        }
        request.onChunk?.({ stream: "stderr", data });
      });
      child.once("error", (error) => {
        stderr += error.message;
        finish(null, null);
      });
      child.once("close", (code, signal) => {
        finish(code, signal);
      });
    });
  }
}
