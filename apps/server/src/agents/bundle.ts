import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packTar, type TarFile } from "@infra/utils";
import { ERROR_CODES } from "@infra/types";
import { AppError } from "../errors.js";

const PREFIXES = [
  "apps/agent/dist",
  "packages/types/dist",
  "packages/schemas/dist",
  "packages/protocol/dist",
  "packages/utils/dist",
] as const;

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function readAgentBundle(root: string): Promise<Buffer> {
  const files: TarFile[] = [];
  for (const prefix of PREFIXES) {
    await collect(join(root, prefix), prefix, files);
  }
  if (!files.some((file) => file.name === "apps/agent/dist/index.js")) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "code agent compilé introuvable");
  }
  try {
    return packTar(files);
  } catch (error) {
    throw new AppError(500, "INTERNAL", error instanceof Error ? error.message : "archive impossible");
  }
}

async function collect(directory: string, prefix: string, files: TarFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !FILE_NAME.test(entry.name)) {
      continue;
    }
    const relative = `${prefix}/${entry.name}`;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(full, relative, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push({ name: relative, data: await readFile(full) });
  }
}
