import { createLogger } from "@infra/utils";
import { LinuxSystemProbe } from "./adapters/local-linux/probe.js";
import { loadAgentConfig, resolveAgentConfigPath } from "./config/load.js";
import { SpawnProcessRunner } from "./process/spawn-runner.js";
import { runAgent } from "./runtime.js";
import { ServerClient } from "./transport/client.js";

const configPath = resolveAgentConfigPath();

let config: ReturnType<typeof loadAgentConfig>;
try {
  config = loadAgentConfig(configPath);
} catch (error) {
  const message = error instanceof Error ? error.message : "configuration invalide";
  process.stderr.write(`${JSON.stringify({ level: "error", message })}\n`);
  process.exit(1);
}

const logger = createLogger({
  level: config.logLevel,
  base: { agentId: config.agent.id },
  secrets: [config.agent.secret],
});
const controller = new AbortController();
const stop = (): void => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const client = new ServerClient(config);
const runner = new SpawnProcessRunner();
const probe = new LinuxSystemProbe();

logger.info({ type: config.agent.type, server: client.baseUrl() }, "agent démarré");
if (process.getuid?.() !== 0) {
  logger.warn({}, "apt-get exige root dans cette version ; l'agent n'est pas root");
}

try {
  await runAgent({ config, client, runner, probe, logger, signal: controller.signal });
} catch (error) {
  logger.error({ name: error instanceof Error ? error.name : "Error" }, "agent arrêté");
  process.exit(1);
}
