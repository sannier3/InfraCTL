import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "apps/server/src/generated/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='exec']",
          message: "exec() est interdit. Utiliser spawn avec un tableau d'arguments.",
        },
        {
          selector: "CallExpression[callee.name='execSync']",
          message: "execSync() est interdit.",
        },
      ],
    },
  },
  {
    files: ["apps/server/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              message: "Le serveur ne lance aucun processus système.",
            },
            {
              name: "child_process",
              message: "Le serveur ne lance aucun processus système.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/agent/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              message: "child_process est réservé à SpawnProcessRunner.",
            },
            {
              name: "child_process",
              message: "child_process est réservé à SpawnProcessRunner.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/agent/src/process/spawn-runner.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
