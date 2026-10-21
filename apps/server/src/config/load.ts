import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { formatConfigIssues, serverConfigSchema, type ServerConfig } from "@infra/schemas";
import { decodeCredentialsKey } from "../crypto/secrets.js";

export function resolveServerConfigPath(): string {
  if (process.env.CONFIG_PATH && process.env.CONFIG_PATH.length > 0) {
    return process.env.CONFIG_PATH;
  }
  const candidates = [resolve(process.cwd(), "config.yaml"), resolve(process.cwd(), "../../config.yaml")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? "config.yaml";
}

export function loadServerConfig(filePath: string): ServerConfig {
  let document: unknown;
  try {
    document = parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "lecture impossible";
    throw new Error(`configuration illisible (${filePath}) : ${message}`);
  }
  const parsed = serverConfigSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`configuration invalide\n${formatConfigIssues(parsed.error)}`);
  }
  decodeCredentialsKey(parsed.data.security.credentialsKey);
  const override = process.env.DATABASE_URL;
  if (override && override.length > 0) {
    parsed.data.database.url = override;
  }
  return parsed.data;
}
