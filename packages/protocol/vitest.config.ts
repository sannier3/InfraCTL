import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    alias: {
      "@infra/types": fileURLToPath(new URL("../types/src/index.ts", import.meta.url)),
    },
  },
});
