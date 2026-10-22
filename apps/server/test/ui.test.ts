import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import { MemoryStore } from "../src/database/memory-store.js";
import { testConfig } from "./helpers.js";

const PASSWORD = "dev-ui-password";

describe("interface interne", () => {
  it("reste fermée sans configuration", async () => {
    const built = await buildApp({ config: testConfig(), store: new MemoryStore(), startScheduler: false });
    const base = await listen(built.app);
    expect((await fetch(`${base}/ui/login`)).status).toBe(404);
    await built.app.close();
  });

  it("ouvre une session avec le mot de passe et refuse le jeton dans la page", async () => {
    const config = testConfig();
    config.ui = { enabled: true, password: PASSWORD, sessionHours: 12, noCache: true };
    const built = await buildApp({ config, store: new MemoryStore(), startScheduler: false });
    const base = await listen(built.app);

    const page = await fetch(`${base}/ui/login`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-cache");
    const html = await page.text();
    expect(html).toContain("Mot de passe");
    expect(html).not.toContain(PASSWORD);
    expect(html).not.toContain(config.auth.apiToken);

    const locked = await fetch(`${base}/ui`, { redirect: "manual" });
    expect(locked.status).toBe(302);

    const denied = await fetch(`${base}/ui/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=not-the-password",
      redirect: "manual",
    });
    expect(denied.status).toBe(303);

    const accepted = await fetch(`${base}/ui/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${PASSWORD}`,
      redirect: "manual",
    });
    expect(accepted.status).toBe(303);
    const cookie = accepted.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("infra_session=");
    expect(cookie).not.toContain(PASSWORD);

    const home = await fetch(`${base}/ui`, { headers: { cookie: cookie.split(";")[0] ?? "" } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Infra Manager");

    const agents = await fetch(`${base}/api/v1/agents`, { headers: { cookie: cookie.split(";")[0] ?? "" } });
    expect(agents.status).toBe(200);

    const blocked = await fetch(`${base}/api/v1/agents`, {
      method: "POST",
      headers: { cookie: cookie.split(";")[0] ?? "", "content-type": "application/json" },
      body: JSON.stringify({ id: "edge-01", type: "linux-node", secret: "agent-secret-value-1" }),
    });
    expect(blocked.status).toBe(403);

    const created = await fetch(`${base}/api/v1/agents`, {
      method: "POST",
      headers: {
        cookie: cookie.split(";")[0] ?? "",
        "content-type": "application/json",
        "x-infra-request": "1",
      },
      body: JSON.stringify({ id: "edge-01", type: "linux-node", secret: "agent-secret-value-1" }),
    });
    expect(created.status).toBe(200);
    expect(JSON.stringify(await created.json())).not.toContain("agent-secret-value-1");
    await built.app.close();
  });
});

async function listen(app: {
  listen: (options: { host: string; port: number }) => Promise<string>;
  server: { address: () => string | { port: number } | null };
}): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("port introuvable");
  }
  return `http://127.0.0.1:${address.port}`;
}
