import { PrismaClient } from "@prisma/client";
import { buildApp } from "./api/app.js";
import { loadServerConfig, resolveServerConfigPath } from "./config/load.js";
import { ensureNodeScopedGuests, PrismaStore } from "./database/prisma-store.js";

const configPath = resolveServerConfigPath();

let config: ReturnType<typeof loadServerConfig>;
try {
  config = loadServerConfig(configPath);
} catch (error) {
  const message = error instanceof Error ? error.message : "configuration invalide";
  process.stderr.write(`${JSON.stringify({ level: "error", message })}\n`);
  process.exit(1);
}

process.env.DATABASE_URL = config.database.url;
const prisma = new PrismaClient();
await ensureNodeScopedGuests(prisma);
const store = new PrismaStore(prisma);
const built = await buildApp({ config, store, startScheduler: true, configPath });

const shutdown = async (): Promise<void> => {
  built.scheduler.stop();
  await built.app.close();
  await prisma.$disconnect();
};

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

await built.app.listen({ host: config.server.bind, port: config.server.port });
built.app.log.info(
  { bind: config.server.bind, port: config.server.port },
  "serveur prêt ; les agents se connectent en sortie uniquement",
);
