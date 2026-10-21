import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");

describe("absence de shell arbitraire", () => {
  it("n'expose pas de shell et réserve child_process au runner", () => {
    const files = walk(join(root, "apps")).concat(walk(join(root, "packages")));
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      if (/shell:\s*true/.test(source) || /child_process\.exec/.test(source) || /\bexecSync\s*\(/.test(source)) {
        offenders.push(file);
      }
      if (/spawn\(\s*["'](?:bash|sh)["']/.test(source)) {
        offenders.push(file);
      }
      if (source.includes("node:child_process") && !file.endsWith("spawn-runner.ts")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function walk(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else {
      files.push(path);
    }
  }
  return files;
}
