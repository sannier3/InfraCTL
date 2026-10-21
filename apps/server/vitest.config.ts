import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (name: string): string =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    alias: {
      "@infra/types": source("types"),
      "@infra/schemas": source("schemas"),
      "@infra/protocol": source("protocol"),
      "@infra/utils": source("utils"),
    },
  },
});
