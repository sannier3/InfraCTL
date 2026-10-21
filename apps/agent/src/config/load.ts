import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { agentConfigSchema, formatConfigIssues, type AgentConfig } from "@infra/schemas";

export function resolveAgentConfigPath(): string {
  if (process.env.CONFIG_PATH && process.env.CONFIG_PATH.length > 0) {
    return process.env.CONFIG_PATH;
  }
  const candidates = [
    resolve(process.cwd(), "config.yaml"),
    resolve(process.cwd(), "apps/agent/config.yaml"),
    resolve(process.cwd(), "../../apps/agent/config.yaml"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? "config.yaml";
}

export function loadAgentConfig(filePath: string): AgentConfig {
  let document: unknown;
  try {
    document = parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "lecture impossible";
    throw new Error(`configuration illisible (${filePath}) : ${message}`);
  }
  const parsed = agentConfigSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`configuration invalide\n${formatConfigIssues(parsed.error)}`);
  }
  return parsed.data;
}
