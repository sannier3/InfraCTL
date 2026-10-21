import { PrismaClient } from "@prisma/client";
import { DEFAULT_CAPABILITIES, type Capability } from "@infra/types";
import { agentIdSchema, agentTypeSchema, capabilitySchema } from "@infra/schemas";
import { loadServerConfig, resolveServerConfigPath } from "../config/load.js";
import { encryptSecret, decodeCredentialsKey } from "../crypto/secrets.js";
import { PrismaStore } from "../database/prisma-store.js";

const args = parseArgs(process.argv.slice(2));
const configPath = args.config ?? resolveServerConfigPath();

let config: ReturnType<typeof loadServerConfig>;
try {
  config = loadServerConfig(configPath);
} catch (error) {
  const message = error instanceof Error ? error.message : "configuration invalide";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const id = required(args.id, "--id");
const type = agentTypeSchema.parse(required(args.type, "--type"));
const secret = args.secret ?? process.env.AGENT_SECRET;
if (!secret || secret.length < 16) {
  process.stderr.write("secret manquant : --secret ou AGENT_SECRET (16 caractères minimum)\n");
  process.exit(1);
}
const parsedId = agentIdSchema.safeParse(id);
if (!parsedId.success) {
  process.stderr.write("identifiant d'agent invalide\n");
  process.exit(1);
}

process.env.DATABASE_URL = config.database.url;
const prisma = new PrismaClient();
const store = new PrismaStore(prisma);
const now = new Date();
const capabilities = (args.capabilities ? args.capabilities.split(",").map((item) => capabilitySchema.parse(item.trim())) : [...DEFAULT_CAPABILITIES[type]]) as Capability[];
const ciphertext = encryptSecret(secret, decodeCredentialsKey(config.security.credentialsKey));

try {
  if (args.rotate) {
    const rotated = await store.rotateAgentSecret(parsedId.data, ciphertext);
    if (!rotated) {
      process.stderr.write("agent introuvable\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(`secret renouvelé pour ${parsedId.data}\n`);
    }
  } else {
    const result = await store.insertAgent({
      secretCiphertext: ciphertext,
      agent: {
        id: parsedId.data,
        name: args.name ?? parsedId.data,
        type,
        version: "0.0.0",
        presence: "OFFLINE",
        lastSeenAt: null,
        registeredAt: now,
        maxConcurrency: numberArg(args.maxConcurrency, 4),
        capabilities,
        reportedRunning: 0,
        reportedQueued: 0,
        reportedCapacity: 0,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (result === "exists") {
      process.stderr.write("agent déjà enregistré ; utiliser --rotate-secret pour changer le secret\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(`agent ${parsedId.data} enregistré\n`);
    }
  }
} finally {
  await prisma.$disconnect();
}

function required(value: string | undefined, flag: string): string {
  if (!value) {
    process.stderr.write(`${flag} est obligatoire\n`);
    process.exit(1);
  }
  return value;
}

function numberArg(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    process.stderr.write("--max-concurrency doit être un entier positif\n");
    process.exit(1);
  }
  return parsed;
}

function parseArgs(argv: string[]): {
  id?: string;
  name?: string;
  type?: string;
  secret?: string;
  config?: string;
  capabilities?: string;
  maxConcurrency?: string;
  rotate: boolean;
} {
  const result: {
    id?: string;
    name?: string;
    type?: string;
    secret?: string;
    config?: string;
    capabilities?: string;
    maxConcurrency?: string;
    rotate: boolean;
  } = { rotate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--rotate-secret") {
      result.rotate = true;
      continue;
    }
    if (token === "--id" && next) {
      result.id = next;
      index += 1;
    } else if (token === "--name" && next) {
      result.name = next;
      index += 1;
    } else if (token === "--type" && next) {
      result.type = next;
      index += 1;
    } else if (token === "--secret" && next) {
      result.secret = next;
      index += 1;
    } else if (token === "--config" && next) {
      result.config = next;
      index += 1;
    } else if (token === "--capabilities" && next) {
      result.capabilities = next;
      index += 1;
    } else if (token === "--max-concurrency" && next) {
      result.maxConcurrency = next;
      index += 1;
    }
  }
  return result;
}
