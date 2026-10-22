import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serverConfigSchema } from "@infra/schemas";
import { applySettingsPatch, publicSettings, writeServerConfig } from "../src/config/settings.js";

const config = serverConfigSchema.parse({
  server: {},
  database: { url: "mysql://infra:secret@127.0.0.1:3306/infra_manager" },
  auth: { apiToken: "dev-admin-token-change", readToken: "dev-reader-token-change" },
  security: { credentialsKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=" },
  agents: {},
  inventory: {},
  metrics: {},
  concurrency: {},
  scheduler: {},
  ui: { enabled: true, password: "dev-ui-password-change", sessionHours: 12, noCache: true },
});

describe("paramètres", () => {
  it("n'expose aucun secret et applique un délai", () => {
    const view = publicSettings(config);
    expect(JSON.stringify(view)).not.toContain("dev-ui-password-change");
    expect(JSON.stringify(view)).not.toContain("mysql://");
    expect(JSON.stringify(view)).not.toContain("BwcH");
    expect(view.secrets.credentialsKey).toBe(true);
    expect(view.restart).toContain("database.url");
    const next = applySettingsPatch(config, { agents: { offlineAfterSeconds: 90 } });
    expect(next.agents.offlineAfterSeconds).toBe(90);
    expect(next.security.credentialsKey).toBe(config.security.credentialsKey);
    expect(next.ui.password).toBe(config.ui.password);
    expect(applySettingsPatch(config, { secrets: { readToken: null } }).auth.readToken).toBeUndefined();
    expect(() => applySettingsPatch(config, { agents: { offlineAfterSeconds: 10 } })).toThrow();
  });

  it("écrit le fichier sans remplacer la clé de chiffrement", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-settings-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, "database:\n  url: mysql://infra:secret@127.0.0.1:3306/infra_manager\nauth:\n  apiToken: dev-admin-token-change\nsecurity:\n  credentialsKey: \"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=\"\nui:\n  enabled: true\n  password: dev-ui-password-change\n");
    const next = applySettingsPatch(config, { server: { port: 8085 }, secrets: { uiPassword: "nouveau-mot-de-passe" } });
    writeServerConfig(file, next);
    const written = readFileSync(file, "utf8");
    expect(written).toContain("8085");
    expect(written).toContain("nouveau-mot-de-passe");
    expect(written).toContain("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=");
  });
});
